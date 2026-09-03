#!/usr/bin/env bash

SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME="${SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME:-.supacloud-source-identity.json}"

supacloud_edge_runtime_directory_node() {
    local directory="$1"
    python3 - "$directory" <<'PY'
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
metadata = path.lstat()
if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
    raise SystemExit("Edge Runtime directory must be a real directory")
print(f"{metadata.st_dev}:{metadata.st_ino}", end="")
PY
}

supacloud_edge_runtime_tree_sha256() {
    local source_dir="$1"
    python3 - "$source_dir" <<'PY'
import hashlib
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
metadata = root.lstat()
if not stat.S_ISDIR(metadata.st_mode) or root.is_symlink():
    raise SystemExit("Edge Runtime tree must be a real directory")

entries = [(".", "dir", str(root), metadata)]
pending = [(root, Path("."))]
while pending:
    current, relative_root = pending.pop()
    with os.scandir(current) as directory:
        children = list(directory)
    for child in children:
        relative = (relative_root / child.name) if relative_root != Path(".") else Path(child.name)
        relative_name = relative.as_posix()
        if any(ord(character) < 32 for character in relative_name):
            raise SystemExit("Edge Runtime tree contains a control character in a path")
        child_metadata = child.stat(follow_symlinks=False)
        if stat.S_ISDIR(child_metadata.st_mode):
            entries.append((relative_name, "dir", child.path, child_metadata))
            pending.append((Path(child.path), relative))
        elif stat.S_ISREG(child_metadata.st_mode):
            entries.append((relative_name, "file", child.path, child_metadata))
        elif stat.S_ISLNK(child_metadata.st_mode):
            entries.append((relative_name, "symlink", child.path, child_metadata))
        else:
            raise SystemExit(f"Edge Runtime tree contains a special entry: {relative_name}")

digest = hashlib.sha256()
for relative_name, entry_type, path, entry_metadata in sorted(entries, key=lambda item: item[0]):
    digest.update(entry_type.encode("ascii"))
    digest.update(b"\0")
    digest.update(relative_name.encode("utf-8", "surrogateescape"))
    digest.update(b"\0")
    digest.update(f"{stat.S_IMODE(entry_metadata.st_mode):04o}".encode("ascii"))
    digest.update(b"\0")
    digest.update(str(entry_metadata.st_uid).encode("ascii"))
    digest.update(b"\0")
    digest.update(str(entry_metadata.st_gid).encode("ascii"))
    digest.update(b"\0")
    digest.update(str(entry_metadata.st_nlink).encode("ascii"))
    digest.update(b"\0")
    if entry_type == "file":
        with open(path, "rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    elif entry_type == "symlink":
        digest.update(os.fsencode(os.readlink(path)))
    digest.update(b"\0")
print(digest.hexdigest(), end="")
PY
}

supacloud_prepare_edge_runtime_tree_for_exchange() {
    local source_dir="$1"
    python3 - "$source_dir" <<'PY'
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
root_resolved = root.resolve(strict=True)
expected_uid = os.geteuid()
directories = []

def validate_metadata(path: Path, metadata: os.stat_result, entry_type: str) -> None:
    if metadata.st_uid != expected_uid:
        raise SystemExit(f"Edge Runtime {entry_type} has an unexpected owner: {path}")
    if entry_type != "symlink" and stat.S_IMODE(metadata.st_mode) & 0o022:
        raise SystemExit(f"Edge Runtime {entry_type} is group/other writable: {path}")
    if entry_type in {"file", "symlink"} and metadata.st_nlink != 1:
        raise SystemExit(f"Edge Runtime {entry_type} is hard-linked: {path}")

root_metadata = root.lstat()
if not stat.S_ISDIR(root_metadata.st_mode) or root.is_symlink():
    raise SystemExit("Edge Runtime deployable tree must be a real directory")
validate_metadata(root, root_metadata, "directory")
directories.append(root)

pending = [root]
while pending:
    current = pending.pop()
    with os.scandir(current) as directory:
        children = list(directory)
    for child in children:
        path = Path(child.path)
        metadata = child.stat(follow_symlinks=False)
        if stat.S_ISDIR(metadata.st_mode):
            validate_metadata(path, metadata, "directory")
            directories.append(path)
            pending.append(path)
        elif stat.S_ISREG(metadata.st_mode):
            validate_metadata(path, metadata, "file")
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                    raise SystemExit(f"Edge Runtime file changed during validation: {path}")
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        elif stat.S_ISLNK(metadata.st_mode):
            validate_metadata(path, metadata, "symlink")
            target = os.readlink(path)
            if os.path.isabs(target):
                raise SystemExit(f"Edge Runtime symlink target must be relative: {path}")
            resolved_target = (path.parent / target).resolve(strict=False)
            try:
                resolved_target.relative_to(root_resolved)
            except ValueError:
                raise SystemExit(f"Edge Runtime symlink escapes the runtime tree: {path}")
        else:
            raise SystemExit(f"Edge Runtime tree contains a special entry: {path}")

for directory in sorted(directories, key=lambda path: len(path.parts), reverse=True):
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

supacloud_stable_edge_runtime_tree_sha256() {
    local source_dir="$1"
    local first second
    first=$(supacloud_edge_runtime_tree_sha256 "$source_dir") || return 1
    second=$(supacloud_edge_runtime_tree_sha256 "$source_dir") || return 1
    [[ "$first" == "$second" ]] || {
        printf '%s\n' "Edge Runtime tree changed while calculating its digest" >&2
        return 1
    }
    printf '%s\n' "$first"
}

supacloud_write_edge_runtime_transaction_state() {
    local transaction_dir="$1"
    local state="$2"
    [[ "$state" =~ ^[a-z][a-z-]*$ ]] || return 1
    python3 - "$transaction_dir" "$state" <<'PY'
import os
import stat
import sys
import tempfile
from pathlib import Path

transaction = Path(sys.argv[1])
state = sys.argv[2]
metadata = transaction.lstat()
if not stat.S_ISDIR(metadata.st_mode) or transaction.is_symlink():
    raise SystemExit("Edge Runtime transaction path must be a real directory")
fd, temporary = tempfile.mkstemp(prefix=".state.", dir=transaction)
try:
    with os.fdopen(fd, "w") as handle:
        handle.write(state + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, transaction / "state")
    directory_fd = os.open(transaction, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

supacloud_write_edge_runtime_transaction_identity() {
    local transaction_dir="$1"
    local name="$2"
    local identity="$3"
    [[ "$name" == expected-identity || "$name" == prior-identity ]] || return 1
    [[ "$identity" =~ ^[0-9]+\.[0-9]+\.[0-9]+$'\t'[0-9a-f]{64}$ ]] || return 1
    python3 - "$transaction_dir" "$name" "$identity" <<'PY'
import os
import stat
import sys
import tempfile
from pathlib import Path

transaction = Path(sys.argv[1])
name = sys.argv[2]
identity = sys.argv[3]
metadata = transaction.lstat()
if not stat.S_ISDIR(metadata.st_mode) or transaction.is_symlink():
    raise SystemExit("Edge Runtime transaction path must be a real directory")
fd, temporary = tempfile.mkstemp(prefix=f".{name}.", dir=transaction)
try:
    with os.fdopen(fd, "w") as handle:
        handle.write(identity + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, transaction / name)
    directory_fd = os.open(transaction, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

supacloud_remove_edge_runtime_outcome_writer_temps() {
    local transaction_dir="$1"
    python3 - "$transaction_dir" <<'PY'
import os
import stat
import sys
from pathlib import Path

transaction = Path(sys.argv[1])
parent = transaction.parent
parent_metadata = parent.lstat()
if not stat.S_ISDIR(parent_metadata.st_mode) or parent.is_symlink():
    raise SystemExit("Edge Runtime transaction parent is unsafe")
prefix = f".{transaction.name}.outcome."
removed = False
for entry in parent.iterdir():
    if not entry.name.startswith(prefix):
        continue
    metadata = entry.lstat()
    if not stat.S_ISREG(metadata.st_mode) or entry.is_symlink() \
            or metadata.st_uid != os.geteuid() or metadata.st_gid != os.getegid() \
            or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1:
        raise SystemExit("Edge Runtime transaction outcome temporary file is unsafe")
    entry.unlink()
    removed = True
if removed:
    parent_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
PY
}

supacloud_remove_edge_runtime_source_transaction() {
    local transaction_dir="$1"
    local expected_outcome="$2"
    local target_dir="$3"
    local cleanup_dir="${transaction_dir}.cleanup"
    local active="$transaction_dir"
    local outcome_file="${transaction_dir}.outcome"
    [[ "$expected_outcome" == commit || "$expected_outcome" == rollback ]] || return 1
    [[ -n "$target_dir" ]] || return 1
    supacloud_remove_edge_runtime_outcome_writer_temps "$transaction_dir" || return 1
    local target_state target_tree target_node target_path expected_identity prior_identity
    target_path=$(python3 - "$target_dir" <<'PY'
import sys
from pathlib import Path
print(str(Path(sys.argv[1]).absolute()), end="")
PY
    ) || return 1
    if [[ -e "$target_dir" || -L "$target_dir" ]]; then
        [[ -d "$target_dir" && ! -L "$target_dir" ]] || return 1
        target_state=present
        target_tree=$(supacloud_stable_edge_runtime_tree_sha256 "$target_dir") || return 1
        target_node=$(supacloud_edge_runtime_directory_node "$target_dir") || return 1
    else
        target_state=absent
        target_tree=absent
        target_node=absent
    fi
    if [[ ! -e "$transaction_dir" && ! -L "$transaction_dir" && -d "$cleanup_dir" && ! -L "$cleanup_dir" ]]; then
        active="$cleanup_dir"
    fi
    expected_identity=$(cat "${active}/expected-identity" 2>/dev/null || true)
    prior_identity=$(cat "${active}/prior-identity" 2>/dev/null || true)
    python3 - "$transaction_dir" "$cleanup_dir" "$outcome_file" "$expected_outcome" \
        "$target_path" "$target_state" "$target_tree" "$target_node" \
        "$expected_identity" "$prior_identity" <<'PY'
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

transaction = Path(sys.argv[1])
cleanup = Path(sys.argv[2])
outcome_file = Path(sys.argv[3])
expected_outcome = sys.argv[4]
target_path = sys.argv[5]
target_state = sys.argv[6]
target_tree = sys.argv[7]
target_node = sys.argv[8]
expected_identity = sys.argv[9] or None
prior_identity = sys.argv[10] or None
parent = transaction.parent

def validate_directory(path: Path) -> str:
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink() \
            or metadata.st_uid != os.geteuid() or metadata.st_gid != os.getegid() \
            or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise SystemExit("Edge Runtime transaction path is unsafe")
    state_path = path / "state"
    state_metadata = state_path.lstat()
    if not stat.S_ISREG(state_metadata.st_mode) or state_path.is_symlink() \
            or state_metadata.st_uid != os.geteuid() or state_metadata.st_gid != os.getegid() \
            or stat.S_IMODE(state_metadata.st_mode) != 0o600 or state_metadata.st_nlink != 1:
        raise SystemExit("Edge Runtime transaction state is unsafe")
    return state_path.read_text().rstrip("\n")

active = transaction
if not transaction.exists() and not transaction.is_symlink():
    active = cleanup
elif cleanup.exists() or cleanup.is_symlink():
    raise SystemExit("Edge Runtime transaction and cleanup tombstone both exist")
state = validate_directory(active)
if expected_outcome == "commit":
    if not state.startswith("commit-intent-"):
        raise SystemExit("Edge Runtime transaction is not committed")
elif state != "prepared" and not state.startswith("rolled-back-"):
    raise SystemExit("Edge Runtime transaction is not rollback-compatible")
intent = None
intent_path = active / "exchange-intent.json"
if intent_path.exists() or intent_path.is_symlink():
    intent_metadata = intent_path.lstat()
    if not stat.S_ISREG(intent_metadata.st_mode) or intent_path.is_symlink() \
            or intent_metadata.st_uid != os.geteuid() or intent_metadata.st_gid != os.getegid() \
            or stat.S_IMODE(intent_metadata.st_mode) != 0o600 or intent_metadata.st_nlink != 1:
        raise SystemExit("Edge Runtime exchange intent is unsafe")
    try:
        intent = json.loads(intent_path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"Edge Runtime exchange intent is invalid: {error}")
    required = {
        "schemaVersion", "targetPath", "expectedIdentity", "priorState", "priorIdentityState",
        "priorIdentity", "stagedTreeSha256", "priorTreeSha256", "stagedNode", "targetNode",
    }
    if set(intent) != required or intent.get("schemaVersion") != 2 \
            or intent.get("targetPath") != target_path:
        raise SystemExit("Edge Runtime exchange intent contract is invalid")
    if intent.get("expectedIdentity") != expected_identity:
        raise SystemExit("Edge Runtime exchange expected identity changed")
    if intent.get("priorIdentity") != (prior_identity or None):
        raise SystemExit("Edge Runtime exchange prior identity changed")
elif expected_outcome == "commit":
    raise SystemExit("Edge Runtime commit requires an exchange intent")

if outcome_file.exists() or outcome_file.is_symlink():
    outcome_metadata = outcome_file.lstat()
    if not stat.S_ISREG(outcome_metadata.st_mode) or outcome_file.is_symlink() \
            or outcome_metadata.st_uid != os.geteuid() or outcome_metadata.st_gid != os.getegid() \
            or stat.S_IMODE(outcome_metadata.st_mode) != 0o600 or outcome_metadata.st_nlink != 1:
        raise SystemExit("Edge Runtime transaction outcome is unsafe or conflicting")
    try:
        receipt = json.loads(outcome_file.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"Edge Runtime transaction outcome is invalid: {error}")
    if receipt.get("outcome") != expected_outcome:
        raise SystemExit("Edge Runtime transaction outcome conflicts")
else:
    fd, temporary = tempfile.mkstemp(prefix=f".{outcome_file.name}.", dir=parent)
    try:
        with os.fdopen(fd, "w") as handle:
            receipt = {
                "schemaVersion": 1,
                "transactionPath": str(transaction.absolute()),
                "outcome": expected_outcome,
                "targetPath": target_path,
                "targetState": target_state,
                "targetTreeSha256": target_tree,
                "targetNode": target_node,
                "expectedIdentity": expected_identity,
                "priorIdentity": prior_identity or None,
                "priorState": intent.get("priorState") if intent else None,
                "stagedTreeSha256": intent.get("stagedTreeSha256") if intent else None,
                "priorTreeSha256": intent.get("priorTreeSha256") if intent else None,
            }
            json.dump(receipt, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, outcome_file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
if active == transaction:
    os.rename(transaction, cleanup)
parent_fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
PY
}

supacloud_edge_runtime_source_transaction_outcome() {
    local transaction_dir="$1"
    local outcome_file="${transaction_dir}.outcome"
    supacloud_remove_edge_runtime_outcome_writer_temps "$transaction_dir" || return 1
    python3 - "$outcome_file" <<'PY'
import json
import os
import re
import stat
import sys
from pathlib import Path

outcome = Path(sys.argv[1])
metadata = outcome.lstat()
if not stat.S_ISREG(metadata.st_mode) or outcome.is_symlink() \
        or metadata.st_uid != os.geteuid() or metadata.st_gid != os.getegid() \
        or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1:
    raise SystemExit("Edge Runtime transaction outcome is unsafe")
try:
    receipt = json.loads(outcome.read_text())
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"Edge Runtime transaction outcome is invalid: {error}")
required = {
    "schemaVersion", "transactionPath", "outcome", "targetPath", "targetState",
    "targetTreeSha256", "targetNode", "expectedIdentity", "priorIdentity", "priorState",
    "stagedTreeSha256", "priorTreeSha256",
}
if set(receipt) != required or receipt.get("schemaVersion") != 1 \
        or receipt.get("outcome") not in {"commit", "rollback"}:
    raise SystemExit("Edge Runtime transaction outcome contract is invalid")
print(receipt["outcome"], end="")
PY
}

supacloud_validate_edge_runtime_source_transaction_outcome() {
    local transaction_dir="$1"
    local target_dir="$2"
    local expected_outcome="$3"
    local outcome_file="${transaction_dir}.outcome"
    local target_path target_state target_tree target_node
    [[ "$expected_outcome" == commit || "$expected_outcome" == rollback ]] || return 1
    [[ -f "$outcome_file" && ! -L "$outcome_file" ]] || return 1
    target_path=$(python3 - "$target_dir" <<'PY'
import sys
from pathlib import Path
print(str(Path(sys.argv[1]).absolute()), end="")
PY
    ) || return 1
    if [[ -e "$target_dir" || -L "$target_dir" ]]; then
        [[ -d "$target_dir" && ! -L "$target_dir" ]] || return 1
        target_state=present
        target_tree=$(supacloud_stable_edge_runtime_tree_sha256 "$target_dir") || return 1
        target_node=$(supacloud_edge_runtime_directory_node "$target_dir") || return 1
    else
        target_state=absent
        target_tree=absent
        target_node=absent
    fi
    python3 - "$outcome_file" "$expected_outcome" "$target_path" "$target_state" \
        "$target_tree" "$target_node" "$transaction_dir" <<'PY'
import json
import os
import stat
import sys
from pathlib import Path

outcome = Path(sys.argv[1])
expected_outcome, target_path, target_state, target_tree, target_node, transaction_path = sys.argv[2:]
metadata = outcome.lstat()
if not stat.S_ISREG(metadata.st_mode) or outcome.is_symlink() \
        or metadata.st_uid != os.geteuid() or metadata.st_gid != os.getegid() \
        or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1:
    raise SystemExit("Edge Runtime transaction outcome is unsafe")
try:
    receipt = json.loads(outcome.read_text())
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"Edge Runtime transaction outcome is invalid: {error}")
required = {
    "schemaVersion", "transactionPath", "outcome", "targetPath", "targetState",
    "targetTreeSha256", "targetNode", "expectedIdentity", "priorIdentity", "priorState",
    "stagedTreeSha256", "priorTreeSha256",
}
if set(receipt) != required or receipt.get("schemaVersion") != 1 \
        or receipt.get("outcome") != expected_outcome \
        or receipt.get("transactionPath") != str(Path(transaction_path).absolute()) \
        or receipt.get("targetPath") != target_path \
        or receipt.get("targetState") != target_state \
        or receipt.get("targetTreeSha256") != target_tree \
        or receipt.get("targetNode") != target_node:
    raise SystemExit("Edge Runtime transaction outcome does not match current target")
PY
    local expected_identity prior_identity version sha256
    expected_identity=$(python3 - "$outcome_file" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1]))["expectedIdentity"] or "", end="")
PY
    ) || return 1
    prior_identity=$(python3 - "$outcome_file" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1]))["priorIdentity"] or "", end="")
PY
    ) || return 1
    if [[ "$expected_outcome" == commit ]]; then
        [[ -n "$expected_identity" ]] || return 1
        IFS=$'\t' read -r version sha256 <<< "$expected_identity"
        supacloud_verify_edge_runtime_source_identity "$target_dir" "$version" "$sha256" || return 1
    elif [[ -n "$prior_identity" ]]; then
        IFS=$'\t' read -r version sha256 <<< "$prior_identity"
        supacloud_verify_edge_runtime_source_identity "$target_dir" "$version" "$sha256" || return 1
    fi
}

supacloud_finalize_edge_runtime_source_transaction() {
    local transaction_dir="$1"
    local expected_outcome="$2"
    local target_dir="$3"
    local cleanup_dir="${transaction_dir}.cleanup"
    supacloud_remove_edge_runtime_source_transaction \
        "$transaction_dir" "$expected_outcome" "$target_dir" || return 1
    rm -rf -- "$cleanup_dir" || return 1
    python3 - "$(dirname "$transaction_dir")" <<'PY'
import os
import sys

directory_fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
}

supacloud_clear_edge_runtime_source_transaction_outcome() {
    local transaction_dir="$1"
    local expected_outcome="$2"
    [[ "$expected_outcome" == commit || "$expected_outcome" == rollback ]] || return 1
    [[ ! -e "$transaction_dir" && ! -L "$transaction_dir" \
        && ! -e "${transaction_dir}.cleanup" && ! -L "${transaction_dir}.cleanup" ]] || return 1
    [[ "$(supacloud_edge_runtime_source_transaction_outcome "$transaction_dir")" == "$expected_outcome" ]] || return 1
    rm -f -- "${transaction_dir}.outcome" || return 1
    python3 - "$(dirname "$transaction_dir")" <<'PY'
import os
import sys

directory_fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
}

supacloud_resolve_edge_runtime_source_transaction() {
    local transaction_dir="$1"
    local cleanup_dir="${transaction_dir}.cleanup"
    if [[ -d "$transaction_dir" && ! -L "$transaction_dir" ]]; then
        [[ ! -e "$cleanup_dir" && ! -L "$cleanup_dir" ]] || return 1
        printf '%s\n' "$transaction_dir"
        return 0
    fi
    if [[ ! -e "$transaction_dir" && ! -L "$transaction_dir" && -d "$cleanup_dir" && ! -L "$cleanup_dir" ]]; then
        printf '%s\n' "$cleanup_dir"
        return 0
    fi
    return 1
}

supacloud_validate_edge_runtime_transaction() {
    local transaction_dir="$1"
    python3 - "$transaction_dir" <<'PY'
import os
import stat
import sys
from pathlib import Path

transaction = Path(sys.argv[1])
metadata = transaction.lstat()
if not stat.S_ISDIR(metadata.st_mode) or transaction.is_symlink():
    raise SystemExit("Edge Runtime transaction must be a real directory")
if metadata.st_uid != os.geteuid() or metadata.st_gid != os.getegid():
    raise SystemExit("Edge Runtime transaction has an unexpected owner")
if stat.S_IMODE(metadata.st_mode) != 0o700:
    raise SystemExit("Edge Runtime transaction has unsafe permissions")
allowed = {"staged", "state", "expected-identity", "prior-identity", "exchange-intent.json"}
temporary_prefixes = (".state.", ".expected-identity.", ".prior-identity.", ".exchange-intent.")
entries = set()
removed_temporary = False
for entry in transaction.iterdir():
    if entry.name.startswith(temporary_prefixes):
        entry_metadata = entry.lstat()
        if not stat.S_ISREG(entry_metadata.st_mode) or entry_metadata.st_uid != os.geteuid() \
                or entry_metadata.st_gid != os.getegid() or stat.S_IMODE(entry_metadata.st_mode) != 0o600 \
                or entry_metadata.st_nlink != 1:
            raise SystemExit(f"Edge Runtime transaction temporary file is unsafe: {entry.name}")
        entry.unlink()
        removed_temporary = True
        continue
    entries.add(entry.name)
if removed_temporary:
    directory_fd = os.open(transaction, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
if not entries.issubset(allowed):
    raise SystemExit("Edge Runtime transaction contains an unexpected entry")
staged = transaction / "staged"
if staged.exists() or staged.is_symlink():
    staged_metadata = staged.lstat()
    if not stat.S_ISDIR(staged_metadata.st_mode) or staged.is_symlink():
        raise SystemExit("Edge Runtime transaction staged path is unsafe")
for name in ("state", "expected-identity", "prior-identity"):
    candidate = transaction / name
    if candidate.exists() or candidate.is_symlink():
        candidate_metadata = candidate.lstat()
        if not stat.S_ISREG(candidate_metadata.st_mode) or candidate_metadata.st_uid != os.geteuid() \
                or candidate_metadata.st_gid != os.getegid() or stat.S_IMODE(candidate_metadata.st_mode) != 0o600 \
                or candidate_metadata.st_nlink != 1:
            raise SystemExit(f"Edge Runtime transaction file is unsafe: {name}")
PY
}

supacloud_edge_runtime_transaction_prior_identity() {
    local transaction_dir="$1"
    transaction_dir=$(supacloud_resolve_edge_runtime_source_transaction "$transaction_dir") || return 1
    [[ -f "${transaction_dir}/prior-identity" && ! -L "${transaction_dir}/prior-identity" ]] || return 1
    cat "${transaction_dir}/prior-identity"
}

supacloud_edge_runtime_identity_or_absent() {
    local source_dir="$1"
    if [[ -e "$source_dir" || -L "$source_dir" ]]; then
        [[ -d "$source_dir" && ! -L "$source_dir" ]] || return 1
        supacloud_read_edge_runtime_source_identity "$source_dir"
    else
        printf '%s\n' absent
    fi
}

supacloud_validate_edge_runtime_source_identity_name() {
    [[ "$SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
        printf '%s\n' "Edge Runtime source identity name must be a safe basename" >&2
        return 1
    }
}

supacloud_stage_edge_runtime_source() {
    local source_dir="$1"
    local target_dir="$2"
    local target_parent transaction_dir staged_dir identity
    supacloud_validate_edge_runtime_source_identity_name || return 1

    target_parent=$(dirname "$target_dir")
    mkdir -p "$target_parent" || return 1
    transaction_dir=$(mktemp -d "${target_parent}/.edge-runtime-source.XXXXXX") || return 1
    chmod 700 "$transaction_dir" || {
        rm -rf -- "$transaction_dir"
        return 1
    }
    staged_dir="${transaction_dir}/staged"

    if ! python3 - "$source_dir" "$staged_dir" "$SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME" <<'PY'
import hashlib
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

source = Path(sys.argv[1])
staged = Path(sys.argv[2])
identity_name = sys.argv[3]
ignored_directories = {"node_modules", ".tmp", "dist"}
stable_version = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")

if not source.is_dir() or source.is_symlink():
    raise SystemExit("Edge Runtime source must be a real directory")

package_path = source / "package.json"
if not package_path.is_file() or package_path.is_symlink():
    raise SystemExit("Edge Runtime source package.json is missing or unsafe")
try:
    package = json.loads(package_path.read_text())
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"Edge Runtime package.json is invalid: {error}")
if package.get("name") != "@supacloud/edge-runtime":
    raise SystemExit("Edge Runtime package name is invalid")
version = package.get("version")
if not isinstance(version, str) or not stable_version.fullmatch(version):
    raise SystemExit("Edge Runtime package version must be an exact stable version")

staged.mkdir(mode=0o700)
for current, directories, files in os.walk(source, topdown=True, followlinks=False):
    current_path = Path(current)
    relative_root = current_path.relative_to(source)
    kept_directories = []
    for name in directories:
        candidate = current_path / name
        if name in ignored_directories:
            continue
        if candidate.is_symlink():
            raise SystemExit(f"Edge Runtime source contains a symbolic link: {candidate.relative_to(source)}")
        if not candidate.is_dir():
            raise SystemExit(f"Edge Runtime source contains a special directory entry: {candidate.relative_to(source)}")
        kept_directories.append(name)
    directories[:] = kept_directories

    destination_root = staged / relative_root
    destination_root.mkdir(parents=True, exist_ok=True)
    for name in files:
        if relative_root == Path(".") and name.startswith("supacloud-edge-runtime-"):
            continue
        if relative_root == Path(".") and name == identity_name:
            continue
        candidate = current_path / name
        metadata = candidate.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise SystemExit(f"Edge Runtime source contains a symbolic link: {candidate.relative_to(source)}")
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit(f"Edge Runtime source contains a special file: {candidate.relative_to(source)}")
        relative = candidate.relative_to(source)
        if any(ord(character) < 32 for character in relative.as_posix()):
            raise SystemExit("Edge Runtime source contains a control character in a path")
        shutil.copy2(candidate, staged / relative, follow_symlinks=False)

def source_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    files = []
    for current, directories, names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        kept_directories = []
        for name in directories:
            candidate = current_path / name
            relative = candidate.relative_to(root)
            if name in ignored_directories:
                continue
            metadata = candidate.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                raise SystemExit(f"Staged Edge Runtime source contains a symbolic link: {relative}")
            if not stat.S_ISDIR(metadata.st_mode):
                raise SystemExit(f"Staged Edge Runtime source contains a special directory entry: {relative}")
            kept_directories.append(name)
        directories[:] = kept_directories
        for name in names:
            candidate = current_path / name
            relative = candidate.relative_to(root)
            if relative == Path(identity_name) or any(part in ignored_directories for part in relative.parts):
                continue
            files.append((relative.as_posix(), candidate))
    for relative_name, candidate in sorted(files):
        relative = Path(relative_name)
        metadata = candidate.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise SystemExit(f"Staged Edge Runtime source contains a symbolic link: {relative}")
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit(f"Staged Edge Runtime source contains a special file: {relative}")
        digest.update(b"file\0")
        digest.update(relative_name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(f"{stat.S_IMODE(metadata.st_mode):04o}".encode("ascii"))
        digest.update(b"\0")
        with candidate.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()

identity = {
    "schemaVersion": 1,
    "packageName": "@supacloud/edge-runtime",
    "packageVersion": version,
    "sourceSha256": source_sha256(staged),
}
identity_path = staged / identity_name
identity_path.write_text(json.dumps(identity, sort_keys=True, indent=2) + "\n")
identity_path.chmod(0o644)
PY
    then
        rm -rf -- "$transaction_dir"
        return 1
    fi

    identity=$(supacloud_read_edge_runtime_source_identity "$staged_dir") || {
        rm -rf -- "$transaction_dir"
        return 1
    }
    supacloud_write_edge_runtime_transaction_identity "$transaction_dir" expected-identity "$identity" || {
        rm -rf -- "$transaction_dir"
        return 1
    }
    supacloud_write_edge_runtime_transaction_state "$transaction_dir" prepared || {
        rm -rf -- "$transaction_dir"
        return 1
    }
    printf '%s\n' "$transaction_dir"
}

supacloud_refresh_edge_runtime_source_identity() {
    local source_dir="$1"
    supacloud_validate_edge_runtime_source_identity_name || return 1
    python3 - "$source_dir" "$SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

root = Path(sys.argv[1])
identity_name = sys.argv[2]
ignored_directories = {"node_modules", ".tmp", "dist"}
stable_version = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
identity_path = root / identity_name
package_path = root / "package.json"

if not root.is_dir() or root.is_symlink() or not package_path.is_file() or package_path.is_symlink():
    raise SystemExit("Edge Runtime source package is missing or unsafe")
try:
    package = json.loads(package_path.read_text())
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"Edge Runtime package.json is invalid: {error}")
if package.get("name") != "@supacloud/edge-runtime":
    raise SystemExit("Edge Runtime package name is invalid")
version = package.get("version")
if not isinstance(version, str) or not stable_version.fullmatch(version):
    raise SystemExit("Edge Runtime package version must be an exact stable version")

files = []
for current, directories, names in os.walk(root, topdown=True, followlinks=False):
    current_path = Path(current)
    kept_directories = []
    for name in directories:
        candidate = current_path / name
        relative = candidate.relative_to(root)
        if name in ignored_directories:
            continue
        metadata = candidate.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise SystemExit(f"Staged Edge Runtime source contains a symbolic link: {relative}")
        if not stat.S_ISDIR(metadata.st_mode):
            raise SystemExit(f"Staged Edge Runtime source contains a special directory entry: {relative}")
        kept_directories.append(name)
    directories[:] = kept_directories
    for name in names:
        candidate = current_path / name
        relative = candidate.relative_to(root)
        if relative == Path(identity_name) or any(part in ignored_directories for part in relative.parts):
            continue
        files.append((relative.as_posix(), candidate))

digest = hashlib.sha256()
for relative_name, candidate in sorted(files):
    relative = Path(relative_name)
    metadata = candidate.lstat()
    if stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(f"Staged Edge Runtime source contains a symbolic link: {relative}")
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"Staged Edge Runtime source contains a special file: {relative}")
    digest.update(b"file\0")
    digest.update(relative_name.encode("utf-8"))
    digest.update(b"\0")
    digest.update(f"{stat.S_IMODE(metadata.st_mode):04o}".encode("ascii"))
    digest.update(b"\0")
    with candidate.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    digest.update(b"\0")

identity = {
    "schemaVersion": 1,
    "packageName": "@supacloud/edge-runtime",
    "packageVersion": version,
    "sourceSha256": digest.hexdigest(),
}
identity_path.parent.mkdir(parents=True, exist_ok=True)
fd, temporary_name = tempfile.mkstemp(prefix=f".{identity_name}.", dir=identity_path.parent)
try:
    with os.fdopen(fd, "w") as handle:
        json.dump(identity, handle, sort_keys=True, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary_name, 0o644)
    os.replace(temporary_name, identity_path)
    directory_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
print(f"{version}\t{identity['sourceSha256']}", end="")
PY
}

supacloud_read_edge_runtime_source_identity() {
    local source_dir="$1"
    supacloud_validate_edge_runtime_source_identity_name || return 1
    python3 - "$source_dir" "$SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
identity_name = sys.argv[2]
ignored_directories = {"node_modules", ".tmp", "dist"}
stable_version = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
identity_path = root / identity_name

if not root.is_dir() or root.is_symlink() or not identity_path.is_file() or identity_path.is_symlink():
    raise SystemExit("Edge Runtime source identity is missing or unsafe")
identity_metadata = identity_path.lstat()
if not stat.S_ISREG(identity_metadata.st_mode) or identity_path.is_symlink() \
        or stat.S_IMODE(identity_metadata.st_mode) & 0o022 \
        or identity_metadata.st_nlink != 1:
    raise SystemExit("Edge Runtime source identity metadata is unsafe")
try:
    identity = json.loads(identity_path.read_text())
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"Edge Runtime source identity is invalid: {error}")
if set(identity) != {"schemaVersion", "packageName", "packageVersion", "sourceSha256"}:
    raise SystemExit("Edge Runtime source identity fields are invalid")
version = identity.get("packageVersion")
expected_sha256 = identity.get("sourceSha256")
if identity.get("schemaVersion") != 1 or identity.get("packageName") != "@supacloud/edge-runtime":
    raise SystemExit("Edge Runtime source identity contract is invalid")
if not isinstance(version, str) or not stable_version.fullmatch(version):
    raise SystemExit("Edge Runtime source identity version is invalid")
if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
    raise SystemExit("Edge Runtime source identity digest is invalid")

package_path = root / "package.json"
if not package_path.is_file() or package_path.is_symlink():
    raise SystemExit("Deployed Edge Runtime package.json is missing or unsafe")
try:
    package = json.loads(package_path.read_text())
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"Deployed Edge Runtime package.json is invalid: {error}")
if package.get("name") != identity["packageName"] or package.get("version") != version:
    raise SystemExit("Deployed Edge Runtime package identity does not match its source identity")

files = []
for current, directories, names in os.walk(root, topdown=True, followlinks=False):
    current_path = Path(current)
    kept_directories = []
    for name in directories:
        candidate = current_path / name
        relative = candidate.relative_to(root)
        if name in ignored_directories:
            continue
        metadata = candidate.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise SystemExit(f"Deployed Edge Runtime source contains a symbolic link: {relative}")
        if not stat.S_ISDIR(metadata.st_mode):
            raise SystemExit(f"Deployed Edge Runtime source contains a special directory entry: {relative}")
        kept_directories.append(name)
    directories[:] = kept_directories
    for name in names:
        candidate = current_path / name
        relative = candidate.relative_to(root)
        if relative == Path(identity_name) or any(part in ignored_directories for part in relative.parts):
            continue
        files.append((relative.as_posix(), candidate))

digest = hashlib.sha256()
for relative_name, candidate in sorted(files):
    relative = Path(relative_name)
    metadata = candidate.lstat()
    if stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(f"Deployed Edge Runtime source contains a symbolic link: {relative}")
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"Deployed Edge Runtime source contains a special file: {relative}")
    digest.update(b"file\0")
    digest.update(relative_name.encode("utf-8"))
    digest.update(b"\0")
    digest.update(f"{stat.S_IMODE(metadata.st_mode):04o}".encode("ascii"))
    digest.update(b"\0")
    with candidate.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    digest.update(b"\0")
actual_sha256 = digest.hexdigest()
if actual_sha256 != expected_sha256:
    raise SystemExit("Deployed Edge Runtime source digest does not match its identity")
print(f"{version}\t{actual_sha256}", end="")
PY
}

supacloud_verify_edge_runtime_source_identity() {
    local source_dir="$1"
    local expected_version="$2"
    local expected_sha256="$3"
    local actual version sha256
    actual=$(supacloud_read_edge_runtime_source_identity "$source_dir") || return 1
    IFS=$'\t' read -r version sha256 <<< "$actual"
    [[ "$version" == "$expected_version" && "$sha256" == "$expected_sha256" ]]
}

supacloud_edge_runtime_transaction_identity() {
    local transaction_dir="$1"
    transaction_dir=$(supacloud_resolve_edge_runtime_source_transaction "$transaction_dir") || return 1
    supacloud_validate_edge_runtime_transaction "$transaction_dir" || return 1
    [[ -f "${transaction_dir}/expected-identity" && ! -L "${transaction_dir}/expected-identity" ]] || return 1
    cat "${transaction_dir}/expected-identity"
}

supacloud_prepare_edge_runtime_source_exchange() {
    local transaction_dir="$1"
    local target_dir="$2"
    local staged_dir="${transaction_dir}/staged"
    local expected version sha256 staged_tree_sha256
    local prior_identity="" prior_identity_state prior_state prior_tree_sha256

    [[ -d "$transaction_dir" && ! -L "$transaction_dir" && ! -e "${transaction_dir}.cleanup" && ! -L "${transaction_dir}.cleanup" ]] || return 1
    supacloud_validate_edge_runtime_transaction "$transaction_dir" || return 1
    [[ ! -e "${transaction_dir}/exchange-intent.json" && ! -L "${transaction_dir}/exchange-intent.json" ]] || return 1
    expected=$(supacloud_edge_runtime_transaction_identity "$transaction_dir") || return 1
    IFS=$'\t' read -r version sha256 <<< "$expected"
    supacloud_verify_edge_runtime_source_identity "$staged_dir" "$version" "$sha256" || return 1
    supacloud_prepare_edge_runtime_tree_for_exchange "$staged_dir" || return 1
    staged_tree_sha256=$(supacloud_stable_edge_runtime_tree_sha256 "$staged_dir") || return 1

    if [[ -e "$target_dir" || -L "$target_dir" ]]; then
        [[ -d "$target_dir" && ! -L "$target_dir" ]] || return 1
        prior_state=present
        prior_tree_sha256=$(supacloud_stable_edge_runtime_tree_sha256 "$target_dir") || return 1
        prior_identity=$(supacloud_read_edge_runtime_source_identity "$target_dir" 2>/dev/null) || return 1
        prior_identity_state=verified
        supacloud_write_edge_runtime_transaction_identity \
            "$transaction_dir" prior-identity "$prior_identity" || return 1
    else
        prior_state=absent
        prior_identity_state=absent
        prior_tree_sha256=absent
    fi

    python3 - "$transaction_dir" "$target_dir" "$expected" "$prior_state" \
        "$prior_identity_state" "$prior_identity" "$staged_tree_sha256" "$prior_tree_sha256" <<'PY'
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

transaction = Path(sys.argv[1])
target = Path(sys.argv[2])
expected_identity = sys.argv[3]
prior_state = sys.argv[4]
prior_identity_state = sys.argv[5]
prior_identity = sys.argv[6] or None
staged_tree_sha256 = sys.argv[7]
prior_tree_sha256 = sys.argv[8]
staged = transaction / "staged"

def directory_node(path: Path) -> dict[str, int]:
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise SystemExit(f"Edge Runtime exchange path must be a real directory: {path}")
    return {"dev": metadata.st_dev, "ino": metadata.st_ino}

staged_node = directory_node(staged)
target_node = None
if prior_state == "present":
    target_node = directory_node(target)
    if target_node == staged_node:
        raise SystemExit("Edge Runtime target and staged directories must be distinct")
elif prior_state == "absent":
    if target.exists() or target.is_symlink():
        raise SystemExit("Edge Runtime target appeared during exchange preparation")
    parent_node = directory_node(target.parent)
    if parent_node["dev"] != staged_node["dev"]:
        raise SystemExit("Edge Runtime first install must remain on one filesystem")
else:
    raise SystemExit("Edge Runtime exchange prior state is invalid")
if (prior_state, prior_identity_state) not in {
        ("present", "verified"), ("absent", "absent")
}:
    raise SystemExit("Edge Runtime exchange prior identity state is invalid")
if not re.fullmatch(r"[0-9a-f]{64}", staged_tree_sha256):
    raise SystemExit("Edge Runtime staged tree digest is invalid")
if prior_state == "present":
    if not re.fullmatch(r"[0-9a-f]{64}", prior_tree_sha256):
        raise SystemExit("Edge Runtime prior tree digest is invalid")
else:
    if prior_tree_sha256 != "absent":
        raise SystemExit("Edge Runtime absent prior tree digest is invalid")
    prior_tree_sha256 = None
if prior_identity_state == "verified":
    if not isinstance(prior_identity, str) or not re.fullmatch(
            r"[0-9]+\.[0-9]+\.[0-9]+\t[0-9a-f]{64}", prior_identity):
        raise SystemExit("Edge Runtime prior identity is invalid")
elif prior_identity is not None:
    raise SystemExit("Absent prior identity must be empty")

payload = {
    "schemaVersion": 2,
    "targetPath": str(target.absolute()),
    "expectedIdentity": expected_identity,
    "priorState": prior_state,
    "priorIdentityState": prior_identity_state,
    "priorIdentity": prior_identity,
    "stagedTreeSha256": staged_tree_sha256,
    "priorTreeSha256": prior_tree_sha256,
    "stagedNode": staged_node,
    "targetNode": target_node,
}
fd, temporary = tempfile.mkstemp(prefix=".exchange-intent.", dir=transaction)
try:
    with os.fdopen(fd, "w") as handle:
        json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, transaction / "exchange-intent.json")
    directory_fd = os.open(transaction, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
    supacloud_write_edge_runtime_transaction_state \
        "$transaction_dir" "exchange-intent-${prior_state}"
}

supacloud_edge_runtime_exchange_position() {
    local transaction_dir="$1"
    local target_dir="$2"
    transaction_dir=$(supacloud_resolve_edge_runtime_source_transaction "$transaction_dir") || return 1
    supacloud_validate_edge_runtime_transaction "$transaction_dir" || return 1
    python3 - "$transaction_dir" "$target_dir" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

transaction = Path(sys.argv[1])
target = Path(sys.argv[2])
intent_path = transaction / "exchange-intent.json"
intent_metadata = intent_path.lstat()
if not stat.S_ISREG(intent_metadata.st_mode) or intent_path.is_symlink() \
        or intent_metadata.st_uid != os.geteuid() or intent_metadata.st_gid != os.getegid() \
        or stat.S_IMODE(intent_metadata.st_mode) != 0o600 or intent_metadata.st_nlink != 1:
    raise SystemExit("Edge Runtime exchange intent is unsafe")
try:
    intent = json.loads(intent_path.read_text())
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"Edge Runtime exchange intent is invalid: {error}")
expected_fields = {
    "schemaVersion", "targetPath", "expectedIdentity", "priorState", "priorIdentityState",
    "priorIdentity", "stagedTreeSha256", "priorTreeSha256", "stagedNode", "targetNode",
}
if set(intent) != expected_fields or intent.get("schemaVersion") != 2 \
        or intent.get("targetPath") != str(target.absolute()):
    raise SystemExit("Edge Runtime exchange intent contract is invalid")
if intent.get("priorState") not in {"present", "absent"}:
    raise SystemExit("Edge Runtime exchange intent prior state is invalid")
if (intent.get("priorState"), intent.get("priorIdentityState")) not in {
        ("present", "verified"), ("absent", "absent")
}:
    raise SystemExit("Edge Runtime exchange intent prior identity state is invalid")
expected_identity_path = transaction / "expected-identity"
expected_identity = intent.get("expectedIdentity")
if not isinstance(expected_identity, str) or not re.fullmatch(
        r"[0-9]+\.[0-9]+\.[0-9]+\t[0-9a-f]{64}", expected_identity):
    raise SystemExit("Edge Runtime exchange intent expected identity is invalid")
if expected_identity != expected_identity_path.read_text().rstrip("\n"):
    raise SystemExit("Edge Runtime exchange intent identity changed")
staged_tree_sha256 = intent.get("stagedTreeSha256")
prior_tree_sha256 = intent.get("priorTreeSha256")
if not isinstance(staged_tree_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", staged_tree_sha256):
    raise SystemExit("Edge Runtime exchange intent staged tree digest is invalid")
prior_identity_path = transaction / "prior-identity"
if intent["priorState"] == "present":
    if not isinstance(prior_tree_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", prior_tree_sha256):
        raise SystemExit("Edge Runtime exchange intent prior tree digest is invalid")
    prior_identity = intent.get("priorIdentity")
    if not isinstance(prior_identity, str) or not re.fullmatch(
            r"[0-9]+\.[0-9]+\.[0-9]+\t[0-9a-f]{64}", prior_identity):
        raise SystemExit("Edge Runtime exchange intent prior identity is invalid")
    try:
        recorded_prior_identity = prior_identity_path.read_text().rstrip("\n")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        raise SystemExit("Edge Runtime transaction prior identity is missing or unreadable")
    if recorded_prior_identity != prior_identity:
        raise SystemExit("Edge Runtime exchange intent prior identity changed")
else:
    if intent.get("priorIdentity") is not None or prior_tree_sha256 is not None:
        raise SystemExit("Edge Runtime exchange intent absent prior contract is invalid")
    if prior_identity_path.exists() or prior_identity_path.is_symlink():
        raise SystemExit("Edge Runtime absent transaction unexpectedly has a prior identity")

def node(path: Path):
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise SystemExit(f"Edge Runtime exchange path is unsafe: {path}")
    return {"dev": metadata.st_dev, "ino": metadata.st_ino}

def tree_sha256(root: Path):
    if root is None:
        return None
    try:
        metadata = root.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(metadata.st_mode) or root.is_symlink():
        raise SystemExit(f"Edge Runtime exchange tree is unsafe: {root}")
    entries = [(".", "dir", root, metadata)]
    pending = [(root, Path("."))]
    while pending:
        current, relative_root = pending.pop()
        with os.scandir(current) as directory:
            children = list(directory)
        for child in children:
            relative = (relative_root / child.name) if relative_root != Path(".") else Path(child.name)
            relative_name = relative.as_posix()
            child_metadata = child.stat(follow_symlinks=False)
            if stat.S_ISDIR(child_metadata.st_mode):
                entries.append((relative_name, "dir", Path(child.path), child_metadata))
                pending.append((Path(child.path), relative))
            elif stat.S_ISREG(child_metadata.st_mode):
                entries.append((relative_name, "file", Path(child.path), child_metadata))
            elif stat.S_ISLNK(child_metadata.st_mode):
                entries.append((relative_name, "symlink", Path(child.path), child_metadata))
            else:
                raise SystemExit(f"Edge Runtime exchange tree contains a special entry: {relative_name}")
    digest = hashlib.sha256()
    for relative_name, entry_type, path, entry_metadata in sorted(entries, key=lambda item: item[0]):
        digest.update(entry_type.encode("ascii"))
        digest.update(b"\0")
        digest.update(relative_name.encode("utf-8", "surrogateescape"))
        digest.update(b"\0")
        digest.update(f"{stat.S_IMODE(entry_metadata.st_mode):04o}".encode("ascii"))
        digest.update(b"\0")
        digest.update(str(entry_metadata.st_uid).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(entry_metadata.st_gid).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(entry_metadata.st_nlink).encode("ascii"))
        digest.update(b"\0")
        if entry_type == "file":
            with path.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    digest.update(chunk)
        elif entry_type == "symlink":
            digest.update(os.fsencode(os.readlink(path)))
        digest.update(b"\0")
    first = digest.hexdigest()
    # Recompute immediately so a concurrent mutation cannot be accepted.
    second_entries = []
    pending = [(root, Path("."))]
    root_metadata = root.lstat()
    second_entries.append((".", "dir", root, root_metadata))
    while pending:
        current, relative_root = pending.pop()
        with os.scandir(current) as directory:
            children = list(directory)
        for child in children:
            relative = (relative_root / child.name) if relative_root != Path(".") else Path(child.name)
            child_metadata = child.stat(follow_symlinks=False)
            if stat.S_ISDIR(child_metadata.st_mode):
                second_entries.append((relative.as_posix(), "dir", Path(child.path), child_metadata))
                pending.append((Path(child.path), relative))
            elif stat.S_ISREG(child_metadata.st_mode):
                second_entries.append((relative.as_posix(), "file", Path(child.path), child_metadata))
            elif stat.S_ISLNK(child_metadata.st_mode):
                second_entries.append((relative.as_posix(), "symlink", Path(child.path), child_metadata))
            else:
                raise SystemExit("Edge Runtime exchange tree changed to a special entry")
    second_digest = hashlib.sha256()
    for relative_name, entry_type, path, entry_metadata in sorted(second_entries, key=lambda item: item[0]):
        second_digest.update(entry_type.encode("ascii")); second_digest.update(b"\0")
        second_digest.update(relative_name.encode("utf-8", "surrogateescape")); second_digest.update(b"\0")
        second_digest.update(f"{stat.S_IMODE(entry_metadata.st_mode):04o}".encode("ascii")); second_digest.update(b"\0")
        second_digest.update(str(entry_metadata.st_uid).encode("ascii")); second_digest.update(b"\0")
        second_digest.update(str(entry_metadata.st_gid).encode("ascii")); second_digest.update(b"\0")
        second_digest.update(str(entry_metadata.st_nlink).encode("ascii")); second_digest.update(b"\0")
        if entry_type == "file":
            with path.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    second_digest.update(chunk)
        elif entry_type == "symlink":
            second_digest.update(os.fsencode(os.readlink(path)))
        second_digest.update(b"\0")
    if first != second_digest.hexdigest():
        raise SystemExit("Edge Runtime exchange tree changed while hashing")
    return first

staged_node = node(transaction / "staged")
target_node = node(target)
staged_tree = tree_sha256(transaction / "staged")
target_tree = tree_sha256(target)
prior_state = intent["priorState"]
before = target_node == intent["targetNode"] and staged_node == intent["stagedNode"]
if prior_state == "present":
    after = target_node == intent["stagedNode"] and staged_node == intent["targetNode"]
else:
    after = target_node == intent["stagedNode"] and staged_node is None
if staged_tree is not None and staged_tree not in {staged_tree_sha256, prior_tree_sha256}:
    raise SystemExit("Edge Runtime staged tree digest does not match transaction intent")
if target_tree is not None and target_tree not in {staged_tree_sha256, prior_tree_sha256}:
    raise SystemExit("Edge Runtime target tree digest does not match transaction intent")
if prior_state == "present":
    if before and (staged_tree != staged_tree_sha256 or target_tree != prior_tree_sha256):
        raise SystemExit("Edge Runtime pre-exchange tree digest does not match transaction intent")
    if after and (target_tree != staged_tree_sha256 or staged_tree != prior_tree_sha256):
        raise SystemExit("Edge Runtime post-exchange tree digest does not match transaction intent")
else:
    if before and (staged_tree != staged_tree_sha256 or target_tree is not None):
        raise SystemExit("Edge Runtime pre-exchange first-install tree digest is invalid")
    if after and (target_tree != staged_tree_sha256 or staged_tree is not None):
        raise SystemExit("Edge Runtime post-exchange first-install tree digest is invalid")
if before == after:
    raise SystemExit("Edge Runtime exchange position is ambiguous")
print(f"{prior_state}\t{'after' if after else 'before'}", end="")
PY
}

supacloud_exchange_edge_runtime_directories() {
    local first="$1"
    local second="$2"
    python3 - "$first" "$second" <<'PY'
import ctypes
import os
import sys

first = os.fsencode(sys.argv[1])
second = os.fsencode(sys.argv[2])
libc = ctypes.CDLL(None, use_errno=True)

if sys.platform.startswith("linux"):
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise SystemExit("renameat2 is unavailable")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(-100, first, -100, second, 2)
elif sys.platform == "darwin":
    renamex_np = getattr(libc, "renamex_np", None)
    if renamex_np is None:
        raise SystemExit("renamex_np is unavailable")
    renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    renamex_np.restype = ctypes.c_int
    result = renamex_np(first, second, 2)
else:
    raise SystemExit(f"Atomic directory exchange is unsupported on {sys.platform}")

if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
for parent in sorted({os.path.dirname(first), os.path.dirname(second)}):
    descriptor = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

supacloud_move_edge_runtime_directory() {
    local source_dir="$1"
    local target_dir="$2"
    python3 - "$source_dir" "$target_dir" <<'PY'
import os
import sys

source = os.fsencode(sys.argv[1])
target = os.fsencode(sys.argv[2])
os.rename(source, target)
for parent in sorted({os.path.dirname(source), os.path.dirname(target)}):
    descriptor = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

supacloud_activate_edge_runtime_source() {
    local transaction_dir="$1"
    local target_dir="$2"
    local staged_dir="${transaction_dir}/staged"
    local expected version sha256 state position prior_state placement

    [[ -d "$transaction_dir" && ! -L "$transaction_dir" && ! -e "${transaction_dir}.cleanup" && ! -L "${transaction_dir}.cleanup" ]] || return 1
    expected=$(supacloud_edge_runtime_transaction_identity "$transaction_dir") || return 1
    IFS=$'\t' read -r version sha256 <<< "$expected"
    [[ -f "${transaction_dir}/state" && ! -L "${transaction_dir}/state" ]] || return 1
    state=$(<"${transaction_dir}/state") || return 1
    if [[ ! -e "${transaction_dir}/exchange-intent.json" && ! -L "${transaction_dir}/exchange-intent.json" ]]; then
        [[ "$state" == prepared ]] || return 1
        supacloud_prepare_edge_runtime_source_exchange "$transaction_dir" "$target_dir" || return 1
        state=$(<"${transaction_dir}/state")
    fi

    position=$(supacloud_edge_runtime_exchange_position "$transaction_dir" "$target_dir") || return 1
    IFS=$'\t' read -r prior_state placement <<< "$position"
    case "$state" in
        prepared|exchange-intent-present|exchange-intent-absent)
            [[ "$state" == prepared || "$state" == "exchange-intent-${prior_state}" ]] || return 1
            if [[ "$placement" == before ]]; then
                supacloud_verify_edge_runtime_source_identity "$staged_dir" "$version" "$sha256" || return 1
                if [[ "$prior_state" == present ]]; then
                    supacloud_exchange_edge_runtime_directories "$staged_dir" "$target_dir" || return 1
                else
                    supacloud_move_edge_runtime_directory "$staged_dir" "$target_dir" || return 1
                fi
            fi
            position=$(supacloud_edge_runtime_exchange_position "$transaction_dir" "$target_dir") || return 1
            [[ "$position" == "${prior_state}"$'\t'after ]] || return 1
            supacloud_prepare_edge_runtime_tree_for_exchange "$target_dir" || return 1
            supacloud_write_edge_runtime_transaction_state "$transaction_dir" "activated-${prior_state}" || return 1
            ;;
        activated-present|activated-absent)
            [[ "$state" == "activated-${prior_state}" && "$placement" == after ]] || return 1
            supacloud_prepare_edge_runtime_tree_for_exchange "$target_dir" || return 1
            ;;
        *)
            return 1
            ;;
    esac

    if ! supacloud_verify_edge_runtime_source_identity "$target_dir" "$version" "$sha256"; then
        supacloud_rollback_edge_runtime_source "$transaction_dir" "$target_dir" || true
        return 1
    fi
}

supacloud_rollback_edge_runtime_source() {
    local requested_transaction_dir="$1"
    local target_dir="$2"
    local transaction_dir cleanup_dir staged_dir
    local state position prior_state placement prior_identity
    if [[ ! -e "$requested_transaction_dir" && ! -L "$requested_transaction_dir" ]]; then
        cleanup_dir="${requested_transaction_dir}.cleanup"
        if [[ -d "$cleanup_dir" && ! -L "$cleanup_dir" ]]; then
            transaction_dir="$cleanup_dir"
        elif [[ -f "${requested_transaction_dir}.outcome" && ! -L "${requested_transaction_dir}.outcome" ]]; then
            supacloud_validate_edge_runtime_source_transaction_outcome \
                "$requested_transaction_dir" "$target_dir" rollback || return 1
            return
        else
            return 0
        fi
    else
        transaction_dir="$requested_transaction_dir"
    fi
    if ! supacloud_validate_edge_runtime_transaction "$transaction_dir"; then
        if [[ -f "${requested_transaction_dir}.outcome" && ! -L "${requested_transaction_dir}.outcome" ]] \
            && supacloud_validate_edge_runtime_source_transaction_outcome \
                "$requested_transaction_dir" "$target_dir" rollback; then
            rm -rf -- "$transaction_dir" || return 1
            python3 - "$(dirname "$requested_transaction_dir")" <<'PY'
import os
import sys
descriptor = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
            return
        fi
        return 1
    fi
    [[ -f "${transaction_dir}/state" && ! -L "${transaction_dir}/state" ]] || return 1
    state=$(<"${transaction_dir}/state")
    if [[ "$transaction_dir" == *.cleanup ]]; then
        case "$state" in
            commit-intent-*)
                return 1
                ;;
            prepared)
                [[ ! -e "${transaction_dir}/exchange-intent.json" \
                    && ! -L "${transaction_dir}/exchange-intent.json" ]] || return 1
                supacloud_finalize_edge_runtime_source_transaction "$requested_transaction_dir" rollback "$target_dir"
                return
                ;;
            rolled-back-*)
                position=$(supacloud_edge_runtime_exchange_position "$requested_transaction_dir" "$target_dir") || return 1
                [[ "$position" == "${state#rolled-back-}"$'\t'before ]] || return 1
                supacloud_finalize_edge_runtime_source_transaction "$requested_transaction_dir" rollback "$target_dir"
                return
                ;;
            *)
                return 1
                ;;
        esac
    fi
    staged_dir="${transaction_dir}/staged"
    if [[ ! -e "${transaction_dir}/exchange-intent.json" && ! -L "${transaction_dir}/exchange-intent.json" ]]; then
        [[ "$state" == prepared ]] || return 1
        supacloud_finalize_edge_runtime_source_transaction "$transaction_dir" rollback "$target_dir"
        return
    fi

    position=$(supacloud_edge_runtime_exchange_position "$transaction_dir" "$target_dir") || return 1
    IFS=$'\t' read -r prior_state placement <<< "$position"
    case "$state" in
        prepared|exchange-intent-present|exchange-intent-absent)
            [[ "$state" == prepared || "$state" == "exchange-intent-${prior_state}" ]] || return 1
            if [[ "$placement" == before ]]; then
                supacloud_write_edge_runtime_transaction_state \
                    "$transaction_dir" "rollback-intent-${prior_state}" || return 1
                state="rollback-intent-${prior_state}"
            else
                supacloud_write_edge_runtime_transaction_state \
                    "$transaction_dir" "activated-${prior_state}" || return 1
                state="activated-${prior_state}"
            fi
            ;;
        activated-present|activated-absent)
            [[ "$state" == "activated-${prior_state}" && "$placement" == after ]] || return 1
            ;;
        rollback-intent-present|rollback-intent-absent)
            [[ "$state" == "rollback-intent-${prior_state}" ]] || return 1
            ;;
        rolled-back-present|rolled-back-absent)
            [[ "$state" == "rolled-back-${prior_state}" && "$placement" == before ]] || return 1
            ;;
        *)
            return 1
            ;;
    esac

    if [[ "$state" != rolled-back-* ]]; then
        supacloud_write_edge_runtime_transaction_state "$transaction_dir" "rollback-intent-${prior_state}" || return 1
        if [[ "$placement" == after ]]; then
            if [[ "$prior_state" == present ]]; then
                [[ -d "$target_dir" && ! -L "$target_dir" && -d "$staged_dir" && ! -L "$staged_dir" ]] || return 1
                supacloud_exchange_edge_runtime_directories "$target_dir" "$staged_dir" || return 1
            else
                [[ -d "$target_dir" && ! -L "$target_dir" && ! -e "$staged_dir" && ! -L "$staged_dir" ]] || return 1
                supacloud_move_edge_runtime_directory "$target_dir" "$staged_dir" || return 1
            fi
        fi
        supacloud_write_edge_runtime_transaction_state "$transaction_dir" "rolled-back-${prior_state}" || return 1
    fi

    position=$(supacloud_edge_runtime_exchange_position "$transaction_dir" "$target_dir") || return 1
    [[ "$position" == "${prior_state}"$'\t'before ]] || return 1
    if [[ "$prior_state" == present ]]; then
        [[ -d "$target_dir" && ! -L "$target_dir" ]] || return 1
        if [[ -f "${transaction_dir}/prior-identity" ]]; then
            prior_identity=$(supacloud_edge_runtime_transaction_prior_identity "$transaction_dir") || return 1
            [[ "$(supacloud_read_edge_runtime_source_identity "$target_dir")" == "$prior_identity" ]] || return 1
        fi
    else
        [[ ! -e "$target_dir" && ! -L "$target_dir" ]] || return 1
    fi
    supacloud_finalize_edge_runtime_source_transaction "$transaction_dir" rollback "$target_dir"
}

supacloud_commit_edge_runtime_source() {
    local requested_transaction_dir="$1"
    local target_dir="$2"
    local transaction_dir cleanup_dir expected version sha256 state position prior_state placement
    if [[ ! -e "$requested_transaction_dir" && ! -L "$requested_transaction_dir" ]]; then
        cleanup_dir="${requested_transaction_dir}.cleanup"
        if [[ -d "$cleanup_dir" && ! -L "$cleanup_dir" ]]; then
            transaction_dir="$cleanup_dir"
        elif [[ -f "${requested_transaction_dir}.outcome" && ! -L "${requested_transaction_dir}.outcome" ]]; then
            supacloud_validate_edge_runtime_source_transaction_outcome \
                "$requested_transaction_dir" "$target_dir" commit || return 1
            return
        else
            return 1
        fi
    else
        transaction_dir="$requested_transaction_dir"
    fi
    if [[ "$transaction_dir" == *.cleanup ]]; then
        if ! supacloud_validate_edge_runtime_transaction "$transaction_dir"; then
            if [[ -f "${requested_transaction_dir}.outcome" && ! -L "${requested_transaction_dir}.outcome" ]] \
                && supacloud_validate_edge_runtime_source_transaction_outcome \
                    "$requested_transaction_dir" "$target_dir" commit; then
                rm -rf -- "$transaction_dir" || return 1
                python3 - "$(dirname "$requested_transaction_dir")" <<'PY'
import os
import sys
descriptor = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
                return
            fi
            return 1
        fi
        state=$(<"${transaction_dir}/state")
        [[ "$state" == commit-intent-* ]] || return 1
        position=$(supacloud_edge_runtime_exchange_position "$requested_transaction_dir" "$target_dir") || return 1
        [[ "$position" == "${state#commit-intent-}"$'\t'after ]] || return 1
        expected=$(cat "${transaction_dir}/expected-identity") || return 1
        IFS=$'\t' read -r version sha256 <<< "$expected"
        supacloud_verify_edge_runtime_source_identity "$target_dir" "$version" "$sha256" || return 1
        supacloud_prepare_edge_runtime_tree_for_exchange "$target_dir" || return 1
        supacloud_finalize_edge_runtime_source_transaction "$requested_transaction_dir" commit "$target_dir"
        return
    fi
    expected=$(supacloud_edge_runtime_transaction_identity "$transaction_dir") || return 1
    IFS=$'\t' read -r version sha256 <<< "$expected"
    state=$(<"${transaction_dir}/state")
    [[ -f "${transaction_dir}/exchange-intent.json" && ! -L "${transaction_dir}/exchange-intent.json" ]] || return 1
    position=$(supacloud_edge_runtime_exchange_position "$transaction_dir" "$target_dir") || return 1
    IFS=$'\t' read -r prior_state placement <<< "$position"
    [[ "$placement" == after ]] || return 1
    case "$state" in
        prepared|exchange-intent-present|exchange-intent-absent|activated-present|activated-absent|commit-intent-present|commit-intent-absent)
            [[ "$state" == prepared || "$state" == *"-${prior_state}" ]] || return 1
            ;;
        *)
            return 1
            ;;
    esac
    supacloud_verify_edge_runtime_source_identity "$target_dir" "$version" "$sha256" || return 1
    supacloud_prepare_edge_runtime_tree_for_exchange "$target_dir" || return 1
    supacloud_write_edge_runtime_transaction_state "$transaction_dir" "commit-intent-${prior_state}" || return 1
    supacloud_finalize_edge_runtime_source_transaction "$transaction_dir" commit "$target_dir"
}

supacloud_wait_edge_runtime_source_identity() {
    local url="$1"
    local expected_version="$2"
    local expected_sha256="$3"
    local attempts="${4:-30}"
    local delay_seconds="${5:-1}"
    local attempt response
    [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || return 1
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        response=$(curl -fsS "$url" 2>/dev/null || true)
        if [[ -n "$response" ]] && python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
expected_version, expected_sha256 = sys.argv[1:]
if payload.get("status") != "ok":
    raise SystemExit(1)
if payload.get("packageVersion") != expected_version:
    raise SystemExit(1)
if payload.get("sourceSha256") != expected_sha256:
    raise SystemExit(1)
' "$expected_version" "$expected_sha256" <<< "$response"; then
            return 0
        fi
        sleep "$delay_seconds"
    done
    return 1
}

supacloud_wait_edge_runtime_compiled_identity() {
    local url="$1"
    local expected_version="$2"
    local attempts="${3:-30}"
    local delay_seconds="${4:-1}"
    local attempt response
    [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || return 1
    for ((attempt = 1; attempt <= attempts; attempt++)); do
        response=$(curl -fsS "$url" 2>/dev/null || true)
        if [[ -n "$response" ]] && python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
expected_version = sys.argv[1]
if payload.get("status") != "ok":
    raise SystemExit(1)
if payload.get("packageVersion") != expected_version:
    raise SystemExit(1)
source_sha256 = payload.get("sourceSha256")
if source_sha256 not in (None, ""):
    raise SystemExit(1)
' "$expected_version" <<< "$response"; then
            return 0
        fi
        sleep "$delay_seconds"
    done
    return 1
}
