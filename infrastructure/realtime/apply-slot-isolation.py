#!/usr/bin/env python3
"""Patch the pinned Supabase Realtime 2.133.0 source for tenant slot isolation.

The patch is intentionally narrow: it only accepts the reviewed upstream
``replication_connection.ex`` from a Realtime 2.133.0 checkout, and it writes
the result atomically. Refusing an unknown source is important here because
silently applying a text patch to a later Realtime release can produce a BEAM
module whose ABI no longer matches the runtime image.
"""

from __future__ import annotations

import os
import re
import stat
import sys
import tempfile
from pathlib import Path


EXPECTED_REALTIME_VERSION = "2.133.0"
EXPECTED_SOURCE_RELATIVE_PATH = Path("lib/realtime/tenants/replication_connection.ex")
REPLICATION_SLOT_NAME_LIMIT = 63

_MODULE_MARKER = "defmodule Realtime.Tenants.ReplicationConnection do"
_SOURCE_MARKERS = (
    "use Postgrex.ReplicationConnection",
    '  @schema "realtime"',
    '  @table "messages"',
    "  defp slot_suffix, do: Application.get_env(:realtime, :slot_name_suffix)",
)
_INIT_CALL = "    slot_name = replication_slot_name(@schema, @table)"
_CONNECT_CALL = "    replication_slot_name = replication_slot_name(@schema, @table)"
_PATCHED_INIT_CALL = "    slot_name = replication_slot_name(@schema, @table, tenant_id)"
_PATCHED_CONNECT_CALL = (
    "    replication_slot_name = replication_slot_name(@schema, @table, state.tenant_id)"
)

_UPSTREAM_FUNCTION = '''  def replication_slot_name(schema, table) do
    "supabase_#{schema}_#{table}_replication_slot_#{slot_suffix()}"
  end
'''

# Keep this as a raw string so the generated Elixir source contains the two
# backslashes required by the default argument (``tenant_id \\ nil``).
_PATCHED_FUNCTION = r'''  @replication_slot_name_limit 63

  @doc """
  Builds a cluster-unique logical replication slot name for Broadcast Changes.

  PostgreSQL replication slots are scoped to a cluster rather than a database.
  Realtime serves multiple tenant databases from one cluster, so the official
  global slot name can collide when two tenants stream Broadcast Changes at
  the same time. Keep the configured suffix for release/test isolation and add
  a deterministic tenant digest while respecting PostgreSQL's 63-byte limit.
  """
  def replication_slot_name(schema, table, tenant_id \\ nil) do
    prefix = "supabase_#{schema}_#{table}_replication_slot_"
    configured_suffix =
      case slot_suffix() do
        suffix when is_binary(suffix) -> suffix
        _ -> ""
      end

    tenant_suffix =
      case tenant_id do
        tenant_id when is_binary(tenant_id) and tenant_id != "" ->
          digest = :crypto.hash(:sha256, tenant_id) |> Base.encode16(case: :lower)
          "tenant_" <> binary_part(digest, 0, 10)

        _ ->
          nil
      end

    case tenant_suffix do
      nil ->
        candidate = prefix <> configured_suffix
        binary_part(candidate, 0, min(byte_size(candidate), @replication_slot_name_limit))

      tenant_suffix ->
        # Keep the tenant identity suffix intact. PostgreSQL truncates names at
        # 63 bytes, so only the optional configured suffix and the descriptive
        # prefix may be shortened.
        prefix_budget = @replication_slot_name_limit - byte_size(tenant_suffix) - 1
        prefix = binary_part(prefix, 0, min(byte_size(prefix), max(prefix_budget, 0)))
        available = @replication_slot_name_limit - byte_size(prefix) - byte_size(tenant_suffix) - 1
        configured_suffix = binary_part(
          configured_suffix,
          0,
          min(byte_size(configured_suffix), max(available, 0))
        )
        suffix = if configured_suffix == "", do: tenant_suffix, else: configured_suffix <> "_" <> tenant_suffix
        prefix <> suffix
    end
  end
'''


class PatchError(ValueError):
    """Raised when the requested source is not the reviewed upstream shape."""


def _read_utf8(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise PatchError(f"cannot read {path}: {error}") from error


def _find_realtime_project(source_path: Path) -> tuple[Path, str]:
    """Find the nearest Realtime checkout root and its declared version."""

    for directory in (source_path.parent, *source_path.parents):
        mix_path = directory / "mix.exs"
        if not mix_path.is_file() or mix_path.is_symlink():
            continue
        mix_source = _read_utf8(mix_path)
        if not re.search(r"(?m)^\s*app:\s*:realtime\b", mix_source):
            continue
        version_match = re.search(r'(?m)^\s*version:\s*"([^"]+)"', mix_source)
        if version_match is None:
            raise PatchError(f"Realtime checkout has no declared version: {mix_path}")
        return directory, version_match.group(1)
    raise PatchError("could not find a Realtime mix.exs for the source file")


def _validate_source_path(source_path: Path) -> tuple[Path, str]:
    try:
        source_stat = os.lstat(source_path)
    except OSError as error:
        raise PatchError(f"cannot inspect {source_path}: {error}") from error
    if stat.S_ISLNK(source_stat.st_mode):
        raise PatchError(f"source file must not be a symbolic link: {source_path}")
    if not stat.S_ISREG(source_stat.st_mode):
        raise PatchError(f"source path is not a regular file: {source_path}")

    absolute_path = source_path.resolve()
    project_root, version = _find_realtime_project(absolute_path)
    try:
        relative_path = absolute_path.relative_to(project_root)
    except ValueError as error:
        raise PatchError(f"source is outside the Realtime checkout: {source_path}") from error
    if relative_path != EXPECTED_SOURCE_RELATIVE_PATH:
        raise PatchError(
            f"unexpected Realtime source path {relative_path}; "
            f"expected {EXPECTED_SOURCE_RELATIVE_PATH}"
        )
    if version != EXPECTED_REALTIME_VERSION:
        raise PatchError(
            f"unsupported Realtime version {version}; expected {EXPECTED_REALTIME_VERSION}"
        )
    return absolute_path, version


def _validate_upstream_shape(source: str) -> None:
    if source.count(_MODULE_MARKER) != 1:
        raise PatchError("expected one Realtime ReplicationConnection module")
    missing_markers = [marker for marker in _SOURCE_MARKERS if marker not in source]
    if missing_markers:
        raise PatchError(f"upstream source is missing expected markers: {missing_markers!r}")
    if source.count(_UPSTREAM_FUNCTION) != 1:
        raise PatchError("expected one unpatched replication_slot_name function")
    if source.count(_INIT_CALL) != 1:
        raise PatchError("expected one unpatched ReplicationConnection init call site")
    if source.count(_CONNECT_CALL) != 1:
        raise PatchError("expected one unpatched ReplicationConnection connect call site")


def _validate_patched_shape(source: str) -> None:
    if source.count(_MODULE_MARKER) != 1:
        raise PatchError("patched source has an unexpected module count")
    if source.count(_PATCHED_FUNCTION) != 1:
        raise PatchError("patched source does not match the reviewed slot-isolation function")
    if source.count(_PATCHED_INIT_CALL) != 1 or source.count(_PATCHED_CONNECT_CALL) != 1:
        raise PatchError("patched source has an unexpected call-site count")
    if _UPSTREAM_FUNCTION in source or _INIT_CALL in source or _CONNECT_CALL in source:
        raise PatchError("source contains a partial slot-isolation patch")
    if r"tenant_id \\ nil" not in source:
        raise PatchError("patched source lost the Elixir default-argument escape")
    if r"tenant_id \ nil" in source:
        raise PatchError("patched source contains an invalid Elixir default argument")


def render_source(source: str) -> str:
    """Return a patched source string, or the original for an exact rerun."""

    has_patch_markers = any(
        marker in source
        for marker in (_PATCHED_INIT_CALL, _PATCHED_CONNECT_CALL, _PATCHED_FUNCTION)
    )
    if has_patch_markers:
        if not (
            source.count(_PATCHED_INIT_CALL) == 1
            and source.count(_PATCHED_CONNECT_CALL) == 1
            and source.count(_PATCHED_FUNCTION) == 1
        ):
            raise PatchError("source contains a partial slot-isolation patch")
        _validate_patched_shape(source)
        return source

    _validate_upstream_shape(source)
    source = source.replace(_INIT_CALL, _PATCHED_INIT_CALL, 1)
    source = source.replace(_CONNECT_CALL, _PATCHED_CONNECT_CALL, 1)
    source = source.replace(_UPSTREAM_FUNCTION, _PATCHED_FUNCTION, 1)
    _validate_patched_shape(source)
    return source


def atomic_write(path: Path, content: str, expected_original: str) -> None:
    """Publish ``content`` beside ``path`` and atomically replace the target."""

    try:
        target_stat = os.lstat(path)
    except OSError as error:
        raise PatchError(f"cannot inspect {path} before write: {error}") from error
    if stat.S_ISLNK(target_stat.st_mode) or not stat.S_ISREG(target_stat.st_mode):
        raise PatchError(f"source changed to a non-regular file while patching: {path}")
    if _read_utf8(path) != expected_original:
        raise PatchError(f"source changed while patching: {path}")

    directory = path.parent
    directory_fd = os.open(str(directory), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    temporary_path: str | None = None
    descriptor: int | None = None
    try:
        descriptor, temporary_path = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(directory))
        os.fchmod(descriptor, stat.S_IMODE(target_stat.st_mode))
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
            descriptor = None
            output.write(content)
            output.flush()
            os.fsync(output.fileno())

        # Recheck before rename so a concurrent edit is not silently lost.
        current_stat = os.lstat(path)
        if stat.S_ISLNK(current_stat.st_mode) or not stat.S_ISREG(current_stat.st_mode):
            raise PatchError(f"source changed to a non-regular file while patching: {path}")
        if _read_utf8(path) != expected_original:
            raise PatchError(f"source changed while patching: {path}")
        os.replace(temporary_path, path)
        temporary_path = None
        os.fsync(directory_fd)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                # A concurrent cleanup or failed replace may already remove it.
                pass
        os.close(directory_fd)


def apply_patch(source_path: Path) -> bool:
    """Patch one source file and return whether its contents changed."""

    source_path, _version = _validate_source_path(Path(source_path))
    original = _read_utf8(source_path)
    patched = render_source(original)
    if patched == original:
        return False
    atomic_write(source_path, patched, original)
    return True


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    if len(arguments) != 1:
        print(f"usage: {Path(sys.argv[0]).name} SOURCE", file=sys.stderr)
        return 2
    try:
        changed = apply_patch(Path(arguments[0]))
    except (OSError, PatchError, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(
        "patched Realtime slot-isolation source"
        if changed
        else "Realtime slot-isolation source is current"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
