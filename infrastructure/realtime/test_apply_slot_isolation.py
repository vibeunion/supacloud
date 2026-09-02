from __future__ import annotations

import hashlib
import importlib.util
import os
import json
import subprocess
import stat
import tempfile
import unittest
import unittest.mock
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("apply-slot-isolation.py")
SPEC = importlib.util.spec_from_file_location("apply_slot_isolation", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
PATCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATCHER)
VERIFIER_PATH = Path(__file__).with_name("verify_slot_isolation_artifact.py")
VERIFIER_SPEC = importlib.util.spec_from_file_location("verify_slot_isolation_artifact", VERIFIER_PATH)
assert VERIFIER_SPEC is not None and VERIFIER_SPEC.loader is not None
VERIFIER = importlib.util.module_from_spec(VERIFIER_SPEC)
VERIFIER_SPEC.loader.exec_module(VERIFIER)
LAUNCHER_PATH = Path(__file__).with_name("realtime-launcher.sh")
BUILDER_PATH = Path(__file__).with_name("build_realtime_slot_isolation_beam.sh")


UPSTREAM_SOURCE = '''defmodule Realtime.Tenants.ReplicationConnection do
  use Postgrex.ReplicationConnection

  @schema "realtime"
  @table "messages"

  def init(%__MODULE__{tenant_id: tenant_id} = state) do
    slot_name = replication_slot_name(@schema, @table)
    {:ok, %{state | replication_slot_name: slot_name, tenant_id: tenant_id}}
  end

  def handle_connect(state) do
    replication_slot_name = replication_slot_name(@schema, @table)
    {:query, replication_slot_name, state}
  end

  def replication_slot_name(schema, table) do
    "supabase_#{schema}_#{table}_replication_slot_#{slot_suffix()}"
  end

  defp slot_suffix, do: Application.get_env(:realtime, :slot_name_suffix)
end
'''


def expected_tenant_suffix(tenant_id: str) -> str:
    digest = hashlib.sha256(tenant_id.encode()).hexdigest()
    return "tenant_" + digest[:10]


def model_slot_name(prefix: str, configured_suffix: str, tenant_id: str) -> str:
    tenant_suffix = expected_tenant_suffix(tenant_id)
    prefix_budget = PATCHER.REPLICATION_SLOT_NAME_LIMIT - len(tenant_suffix) - 1
    prefix = prefix[: max(prefix_budget, 0)]
    available = PATCHER.REPLICATION_SLOT_NAME_LIMIT - len(prefix) - len(tenant_suffix) - 1
    configured_suffix = configured_suffix[: max(available, 0)]
    suffix = tenant_suffix if configured_suffix == "" else configured_suffix + "_" + tenant_suffix
    return prefix + suffix


class ApplySlotIsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="slot-isolation-test-")
        self.root = Path(self.temp_dir.name)
        self.source_path = self.root / PATCHER.EXPECTED_SOURCE_RELATIVE_PATH
        self.source_path.parent.mkdir(parents=True)
        self.write_project()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_project(self, version: str = "2.133.0") -> None:
        (self.root / "mix.exs").write_text(
            f'defmodule Realtime.MixProject do\n  use Mix.Project\n\n  def project do\n    [\n      app: :realtime,\n      version: "{version}"\n    ]\n  end\nend\n',
            encoding="utf-8",
        )
        self.source_path.write_text(UPSTREAM_SOURCE, encoding="utf-8")

    def test_patches_v2133_source_atomically_and_is_idempotent(self) -> None:
        os.chmod(self.source_path, 0o640)

        self.assertTrue(PATCHER.apply_patch(self.source_path))
        patched = self.source_path.read_text(encoding="utf-8")
        self.assertEqual(stat.S_IMODE(self.source_path.stat().st_mode), 0o640)
        self.assertIn(PATCHER._PATCHED_INIT_CALL, patched)
        self.assertIn(PATCHER._PATCHED_CONNECT_CALL, patched)
        self.assertEqual(patched.count(PATCHER._PATCHED_FUNCTION), 1)
        self.assertIn(r"tenant_id \\ nil", patched)
        self.assertNotIn(r"tenant_id \ nil", patched)
        self.assertEqual(list(self.source_path.parent.glob(f".{self.source_path.name}.*")), [])

        content_after_first_patch = patched
        self.assertFalse(PATCHER.apply_patch(self.source_path))
        self.assertEqual(self.source_path.read_text(encoding="utf-8"), content_after_first_patch)

    def test_long_suffix_and_oversized_prefix_keep_tenant_digest_and_limit(self) -> None:
        tenant = "tenant-a"
        digest = expected_tenant_suffix(tenant)

        long_suffix_name = model_slot_name(
            "supabase_realtime_messages_replication_slot_",
            "x" * 200,
            tenant,
        )
        self.assertEqual(len(long_suffix_name.encode()), PATCHER.REPLICATION_SLOT_NAME_LIMIT)
        self.assertTrue(long_suffix_name.endswith(digest))

        exact_prefix = "supabase_realtime_messages_replication_slot_"
        available = PATCHER.REPLICATION_SLOT_NAME_LIMIT - len(exact_prefix) - len(digest) - 1
        boundary_name = model_slot_name(exact_prefix, "y" * available, tenant)
        self.assertLessEqual(len(boundary_name.encode()), PATCHER.REPLICATION_SLOT_NAME_LIMIT)
        self.assertTrue(boundary_name.endswith(digest))

        oversized_prefix_name = model_slot_name("p" * 200, "suffix", tenant)
        self.assertLessEqual(len(oversized_prefix_name.encode()), PATCHER.REPLICATION_SLOT_NAME_LIMIT)
        self.assertTrue(oversized_prefix_name.endswith(digest))

        empty_suffix_name = model_slot_name(exact_prefix, "", tenant)
        self.assertLessEqual(len(empty_suffix_name.encode()), PATCHER.REPLICATION_SLOT_NAME_LIMIT)
        self.assertTrue(empty_suffix_name.endswith(digest))

        patched = PATCHER.render_source(UPSTREAM_SOURCE)
        self.assertIn("prefix_budget = @replication_slot_name_limit - byte_size(tenant_suffix) - 1", patched)
        self.assertIn("prefix = binary_part(prefix, 0, min(byte_size(prefix), max(prefix_budget, 0)))", patched)
        self.assertIn("min(byte_size(configured_suffix), max(available, 0))", patched)

    def test_rejects_wrong_version_before_mutation(self) -> None:
        self.write_project("2.132.0")
        original = self.source_path.read_text(encoding="utf-8")
        with self.assertRaisesRegex(PATCHER.PatchError, "expected 2.133.0"):
            PATCHER.apply_patch(self.source_path)
        self.assertEqual(self.source_path.read_text(encoding="utf-8"), original)

    def test_rejects_wrong_path_and_partial_patch(self) -> None:
        wrong_path = self.root / "lib/realtime/tenants/other.ex"
        wrong_path.write_text(UPSTREAM_SOURCE, encoding="utf-8")
        with self.assertRaisesRegex(PATCHER.PatchError, "expected lib/realtime/tenants/replication_connection.ex"):
            PATCHER.apply_patch(wrong_path)

        partial = UPSTREAM_SOURCE.replace(PATCHER._INIT_CALL, PATCHER._PATCHED_INIT_CALL, 1)
        with self.assertRaisesRegex(PATCHER.PatchError, "partial slot-isolation patch"):
            PATCHER.render_source(partial)

    def test_atomic_write_failure_leaves_original_untouched(self) -> None:
        original = self.source_path.read_text(encoding="utf-8")
        patched = PATCHER.render_source(original)
        with unittest.mock.patch.object(PATCHER.os, "replace", side_effect=OSError("rename failed")):
            with self.assertRaises(OSError):
                PATCHER.atomic_write(self.source_path, patched, original)
        self.assertEqual(self.source_path.read_text(encoding="utf-8"), original)
        self.assertEqual(list(self.source_path.parent.glob(f".{self.source_path.name}.*")), [])


class SlotIsolationArtifactTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="slot-artifact-test-")
        self.artifact_dir = Path(self.temp_dir.name).resolve() / "artifact"
        self.artifact_dir.mkdir(mode=0o755)
        self.beam_path = self.artifact_dir / VERIFIER.MODULE
        self.manifest_path = self.artifact_dir / "manifest.json"
        self.beam_path.write_bytes(b"reviewed deterministic beam fixture")
        os.chmod(self.beam_path, 0o444)
        self.write_manifest(VERIFIER.expected_manifest(self.architecture, self.beam_sha))
        os.chmod(self.manifest_path, 0o444)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @property
    def architecture(self) -> str:
        machine = os.uname().machine
        return "arm64" if machine in {"arm64", "aarch64"} else "amd64"

    @property
    def beam_sha(self) -> str:
        return hashlib.sha256(self.beam_path.read_bytes()).hexdigest()

    def write_manifest(self, payload: dict[str, object]) -> None:
        self.manifest_path.chmod(0o644) if self.manifest_path.exists() else None
        self.manifest_path.write_text(json.dumps(payload), encoding="utf-8")

    def verify(self) -> dict[str, object]:
        return VERIFIER.verify_artifact(
            self.artifact_dir,
            self.manifest_path,
            self.beam_path,
            self.architecture,
            os.getuid(),
        )

    def run_launcher(self, **extra_env: str) -> subprocess.CompletedProcess[str]:
        env = {
            **os.environ,
            "REALTIME_SLOT_ISOLATION_ARTIFACT_DIR": str(self.artifact_dir),
            "REALTIME_SLOT_ISOLATION_MANIFEST": str(self.manifest_path),
            "REALTIME_SLOT_ISOLATION_BEAM": str(self.beam_path),
            "REALTIME_SLOT_ISOLATION_TEST_ALLOW_UID_OVERRIDE": "true",
            "REALTIME_SLOT_ISOLATION_EXPECTED_UID": str(os.getuid()),
            **extra_env,
        }
        return subprocess.run(
            ["bash", str(LAUNCHER_PATH), "--validate-only"],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )

    def test_accepts_exact_pinned_manifest_and_nonroot_test_owner(self) -> None:
        self.assertEqual(self.verify()["resolvedImageReference"], VERIFIER.REALTIME_RESOLVED_IMAGE)
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_self_signed_all_f_image_digest(self) -> None:
        manifest = VERIFIER.expected_manifest(self.architecture, self.beam_sha)
        manifest["resolvedImageReference"] = f"{VERIFIER.REALTIME_IMAGE_REPOSITORY}@sha256:{'f' * 64}"
        manifest["runtimeImageIndexDigest"] = f"sha256:{'f' * 64}"
        self.write_manifest(manifest)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "resolvedImageReference"):
            self.verify()

    def test_rejects_mutable_or_wrong_builder_identity(self) -> None:
        for field, value in (
            ("builderImage", VERIFIER.BUILDER_IMAGE_TAG),
            ("builderImageIndexDigest", f"sha256:{'f' * 64}"),
            ("builderImagePlatformManifestDigest", f"sha256:{'e' * 64}"),
        ):
            with self.subTest(field=field):
                manifest = VERIFIER.expected_manifest(self.architecture, self.beam_sha)
                manifest[field] = value
                self.write_manifest(manifest)
                with self.assertRaisesRegex(VERIFIER.VerificationError, field):
                    self.verify()

    def test_rejects_writable_directory_and_files(self) -> None:
        os.chmod(self.artifact_dir, 0o775)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "writable by group/other"):
            self.verify()

    def test_rejects_writable_artifact_parent(self) -> None:
        parent = self.artifact_dir.parent
        original_mode = stat.S_IMODE(parent.stat().st_mode)
        try:
            os.chmod(parent, 0o775)
            with self.assertRaisesRegex(VERIFIER.VerificationError, "parent is writable"):
                self.verify()
        finally:
            os.chmod(parent, original_mode)
        os.chmod(self.artifact_dir, 0o755)
        os.chmod(self.beam_path, 0o664)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "writable by group/other"):
            self.verify()

    def test_rejects_wrong_owner(self) -> None:
        with self.assertRaisesRegex(VERIFIER.VerificationError, "owner"):
            VERIFIER.verify_artifact(
                self.artifact_dir,
                self.manifest_path,
                self.beam_path,
                self.architecture,
                os.getuid() + 1,
            )

    def test_rejects_manifest_or_beam_outside_artifact_directory(self) -> None:
        outside_manifest = self.artifact_dir.parent / "manifest.json"
        outside_manifest.write_text(self.manifest_path.read_text(encoding="utf-8"), encoding="utf-8")
        with self.assertRaisesRegex(VERIFIER.VerificationError, "manifest is outside"):
            VERIFIER.verify_artifact(
                self.artifact_dir,
                outside_manifest,
                self.beam_path,
                self.architecture,
                os.getuid(),
            )

        outside_beam = self.artifact_dir.parent / VERIFIER.MODULE
        outside_beam.write_bytes(self.beam_path.read_bytes())
        with self.assertRaisesRegex(VERIFIER.VerificationError, "BEAM is outside"):
            VERIFIER.verify_artifact(
                self.artifact_dir,
                self.manifest_path,
                outside_beam,
                self.architecture,
                os.getuid(),
            )

    def test_rejects_manifest_source_image_module_and_path_mismatch(self) -> None:
        cases = {
            "sourceCommit": "0" * 40,
            "sourceFileSha256": "f" * 64,
            "patchedSourceFileSha256": "e" * 64,
            "runtimeImagePlatformManifestDigest": f"sha256:{'d' * 64}",
            "runtimeImageConfigDigest": f"sha256:{'c' * 64}",
            "module": "Elixir.Attacker.beam",
            "containerPath": "/tmp/attacker.beam",
        }
        for field, value in cases.items():
            with self.subTest(field=field):
                manifest = VERIFIER.expected_manifest(self.architecture, self.beam_sha)
                manifest[field] = value
                self.write_manifest(manifest)
                with self.assertRaisesRegex(VERIFIER.VerificationError, field):
                    self.verify()

    def test_rejects_beam_mismatch_even_when_manifest_is_otherwise_pinned(self) -> None:
        self.beam_path.chmod(0o644)
        self.beam_path.write_bytes(b"modified beam")
        self.beam_path.chmod(0o444)
        with self.assertRaisesRegex(VERIFIER.VerificationError, "beamSha256"):
            self.verify()

    def test_launcher_rejects_arbitrary_image_and_production_owner_override(self) -> None:
        arbitrary = self.run_launcher(REALTIME_IMAGE=f"{VERIFIER.REALTIME_IMAGE_REPOSITORY}@sha256:{'f' * 64}")
        self.assertNotEqual(arbitrary.returncode, 0)
        self.assertIn("outside the pinned trust root", arbitrary.stderr)

        env = {
            **os.environ,
            "REALTIME_SLOT_ISOLATION_ARTIFACT_DIR": str(self.artifact_dir),
            "REALTIME_SLOT_ISOLATION_MANIFEST": str(self.manifest_path),
            "REALTIME_SLOT_ISOLATION_BEAM": str(self.beam_path),
            "REALTIME_SLOT_ISOLATION_EXPECTED_UID": str(os.getuid()),
        }
        production = subprocess.run(
            ["bash", str(LAUNCHER_PATH)],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        self.assertNotEqual(production.returncode, 0)
        self.assertIn("owner override is only allowed", production.stderr)

    def test_builder_rejects_unpinned_inputs_before_container_runtime_use(self) -> None:
        cases = (
            (
                {"REALTIME_IMAGE": f"{VERIFIER.REALTIME_IMAGE_REPOSITORY}@sha256:{'f' * 64}"},
                "requires the pinned official image",
            ),
            (
                {"REALTIME_SLOT_ISOLATION_BUILDER_IMAGE": VERIFIER.BUILDER_IMAGE_TAG},
                "requires the pinned builder image",
            ),
            (
                {"REALTIME_SLOT_ISOLATION_SOURCE_COMMIT": "0" * 40},
                "requires the pinned Realtime source commit",
            ),
            (
                {"REALTIME_SLOT_ISOLATION_VERIFY_SCRIPT": "/tmp/untrusted-verifier.py"},
                "verifier override is not allowed",
            ),
            (
                {"REALTIME_SLOT_ISOLATION_EXPECTED_UID": str(os.getuid())},
                "owner override is only allowed for tests",
            ),
        )
        for extra_env, expected_error in cases:
            with self.subTest(extra_env=extra_env):
                result = subprocess.run(
                    ["bash", str(BUILDER_PATH), str(self.artifact_dir / "output")],
                    text=True,
                    capture_output=True,
                    env={**os.environ, "CONTAINER_RUNTIME": "/definitely/not/a/runtime", **extra_env},
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected_error, result.stderr)


if __name__ == "__main__":
    unittest.main()
