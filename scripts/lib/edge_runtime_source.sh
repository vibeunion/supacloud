#!/usr/bin/env bash

SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME="${SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_NAME:-.supacloud-source-identity.json}"

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
        if name == identity_name:
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
            if identity_name in relative.parts:
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
            if identity_name in relative.parts or any(part in ignored_directories for part in relative.parts):
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
    printf '%s\n' "$identity" > "${transaction_dir}/expected-identity"
    chmod 600 "${transaction_dir}/expected-identity"
    printf 'prepared\n' > "${transaction_dir}/state"
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
        if name in ignored_directories or identity_name in relative.parts:
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
        if identity_name in relative.parts or any(part in ignored_directories for part in relative.parts):
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
        if name in ignored_directories or identity_name in relative.parts:
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
        if identity_name in relative.parts or any(part in ignored_directories for part in relative.parts):
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
    [[ -f "${transaction_dir}/expected-identity" ]] || return 1
    cat "${transaction_dir}/expected-identity"
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
PY
}

supacloud_activate_edge_runtime_source() {
    local transaction_dir="$1"
    local target_dir="$2"
    local staged_dir="${transaction_dir}/staged"
    local expected version sha256 prior_state

    expected=$(supacloud_edge_runtime_transaction_identity "$transaction_dir") || return 1
    IFS=$'\t' read -r version sha256 <<< "$expected"
    supacloud_verify_edge_runtime_source_identity "$staged_dir" "$version" "$sha256" || return 1

    if [[ -e "$target_dir" || -L "$target_dir" ]]; then
        [[ -d "$target_dir" && ! -L "$target_dir" ]] || return 1
        prior_state="present"
        supacloud_exchange_edge_runtime_directories "$staged_dir" "$target_dir" || return 1
    else
        prior_state="absent"
        mv "$staged_dir" "$target_dir" || return 1
    fi
    printf 'activated-%s\n' "$prior_state" > "${transaction_dir}/state"

    if ! supacloud_verify_edge_runtime_source_identity "$target_dir" "$version" "$sha256"; then
        supacloud_rollback_edge_runtime_source "$transaction_dir" "$target_dir" || true
        return 1
    fi
}

supacloud_rollback_edge_runtime_source() {
    local transaction_dir="$1"
    local target_dir="$2"
    local staged_dir="${transaction_dir}/staged"
    local state
    [[ -d "$transaction_dir" && -f "${transaction_dir}/state" ]] || return 0
    state=$(<"${transaction_dir}/state")
    case "$state" in
        prepared)
            rm -rf -- "$transaction_dir"
            ;;
        activated-present)
            [[ -d "$target_dir" && ! -L "$target_dir" && -d "$staged_dir" && ! -L "$staged_dir" ]] || return 1
            supacloud_exchange_edge_runtime_directories "$target_dir" "$staged_dir" || return 1
            rm -rf -- "$transaction_dir"
            ;;
        activated-absent)
            [[ -d "$target_dir" && ! -L "$target_dir" ]] || return 1
            rm -rf -- "$target_dir"
            rm -rf -- "$transaction_dir"
            ;;
        *)
            return 1
            ;;
    esac
}

supacloud_commit_edge_runtime_source() {
    local transaction_dir="$1"
    local target_dir="$2"
    local expected version sha256 state
    expected=$(supacloud_edge_runtime_transaction_identity "$transaction_dir") || return 1
    IFS=$'\t' read -r version sha256 <<< "$expected"
    state=$(<"${transaction_dir}/state")
    [[ "$state" == activated-present || "$state" == activated-absent ]] || return 1
    supacloud_verify_edge_runtime_source_identity "$target_dir" "$version" "$sha256" || return 1
    rm -rf -- "$transaction_dir"
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
