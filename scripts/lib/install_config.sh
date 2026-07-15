#!/usr/bin/env bash

# Merge installer-owned environment keys without deleting operator-owned keys.
# The replacement is written beside the target and atomically renamed so a
# failed install cannot leave a partially written credential file behind.
supacloud_atomic_merge_env() {
    local target_file="$1"
    local desired_file="$2"

    python3 - "$target_file" "$desired_file" <<'PY'
import os
import re
import sys
import tempfile
from pathlib import Path

target = Path(sys.argv[1])
desired_path = Path(sys.argv[2])
key_pattern = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")

desired_lines = {}
desired_order = []
for line in desired_path.read_text().splitlines():
    match = key_pattern.match(line)
    if not match:
        continue
    key = match.group(1)
    if key not in desired_lines:
        desired_order.append(key)
    desired_lines[key] = line

existing_lines = target.read_text().splitlines() if target.exists() else []
merged = []
emitted = set()
for line in existing_lines:
    match = key_pattern.match(line)
    key = match.group(1) if match else None
    if key in desired_lines:
        if key not in emitted:
            merged.append(desired_lines[key])
            emitted.add(key)
        continue
    merged.append(line)

for key in desired_order:
    if key not in emitted:
        merged.append(desired_lines[key])

target.parent.mkdir(parents=True, exist_ok=True)
payload = "\n".join(merged) + ("\n" if merged else "")
fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as temporary:
        temporary.write(payload)
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary_name, target)
    directory_fd = os.open(target.parent, os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
PY
}

supacloud_env_value() {
    local env_file="$1"
    local key="$2"

    python3 - "$env_file" "$key" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
key = sys.argv[2]
if not path.exists():
    raise SystemExit(0)

pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}=(.*)$")
for line in path.read_text().splitlines():
    match = pattern.match(line)
    if not match:
        continue
    value = match.group(1).strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        encoded = value[1:-1]
        decoded = []
        index = 0
        while index < len(encoded):
            if encoded[index] == "\\" and index + 1 < len(encoded) and encoded[index + 1] in '\\"`$':
                decoded.append(encoded[index + 1])
                index += 2
                continue
            decoded.append(encoded[index])
            index += 1
        value = "".join(decoded)
    elif len(value) >= 2 and value[0] == value[-1] == "'":
        value = value[1:-1]
    print(value, end="")
    break
PY
}

# Read an installer-owned Bash env file written with printf %q. Keep this
# separate from systemd EnvironmentFile parsing because ANSI-C quoting is a
# Bash feature and is intentionally not used for service environment files.
supacloud_shell_env_value() (
    local env_file="$1"
    local key="$2"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
    [[ -f "$env_file" ]] || return 0
    # shellcheck disable=SC1090
    source "$env_file"
    printf '%s' "${!key}"
)

# Write a Bash-sourced env file. printf %q keeps command substitutions inert
# and round-trips spaces, quotes, backslashes, and embedded newlines.
supacloud_write_shell_env_pairs() (
    local target_file="$1"
    shift
    local desired_file key value
    if (( $# % 2 != 0 )); then
        return 1
    fi
    desired_file=$(mktemp)
    chmod 600 "$desired_file"
    trap 'rm -f "$desired_file"' EXIT HUP INT TERM
    while [[ $# -gt 0 ]]; do
        key="$1"
        value="$2"
        shift 2
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
        printf '%s=%q\n' "$key" "$value" >> "$desired_file"
    done
    supacloud_atomic_merge_env "$target_file" "$desired_file"
)

# Validate and parse the root-only installation input without sourcing it.
# Output is key<TAB>base64(value), so callers can assign decoded values without
# evaluating any operator-controlled shell syntax.
supacloud_parse_install_input() {
    local input_file="$1"
    shift
    [[ -f "$input_file" ]] || return 0
    if ! bash -n "$input_file" >/dev/null 2>&1; then
        printf 'Install input has invalid Bash syntax: %s\n' "$input_file" >&2
        return 1
    fi

    python3 - "$input_file" "$@" <<'PY'
import base64
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
allowed = set(sys.argv[2:])
raw = path.read_bytes()
if b"\0" in raw:
    raise SystemExit("install input contains NUL")
if b"\r" in raw:
    raise SystemExit("install input contains CR/CRLF")
try:
    text = raw.decode("utf-8")
except UnicodeDecodeError as error:
    raise SystemExit(f"install input is not valid UTF-8: {error}")

assignment = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
seen = set()

def fail(line_number, message):
    raise SystemExit(f"install input line {line_number}: {message}")

def decode_ansi(source, start, line_number):
    output = []
    index = start
    simple = {
        "a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b",
        "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v",
        "\\": "\\", "'": "'", '"': '"', "?": "?",
    }
    while index < len(source):
        character = source[index]
        if character == "'":
            return "".join(output), index + 1
        if character != "\\":
            output.append(character)
            index += 1
            continue
        index += 1
        if index >= len(source):
            fail(line_number, "trailing backslash in ANSI-C quote")
        escaped = source[index]
        if escaped in simple:
            output.append(simple[escaped])
            index += 1
            continue
        if escaped in "01234567":
            end = index
            while end < len(source) and end < index + 3 and source[end] in "01234567":
                end += 1
            output.append(chr(int(source[index:end], 8)))
            index = end
            continue
        if escaped == "x":
            digits = source[index + 1:index + 3]
            if not digits or not all(char in "0123456789abcdefABCDEF" for char in digits):
                fail(line_number, "invalid hexadecimal ANSI-C escape")
            output.append(chr(int(digits, 16)))
            index += 1 + len(digits)
            continue
        if escaped in {"u", "U"}:
            width = 4 if escaped == "u" else 8
            digits = source[index + 1:index + 1 + width]
            if len(digits) != width or not all(char in "0123456789abcdefABCDEF" for char in digits):
                fail(line_number, "invalid Unicode ANSI-C escape")
            output.append(chr(int(digits, 16)))
            index += 1 + width
            continue
        # Bash preserves the backslash for unknown ANSI-C escapes.
        output.extend(("\\", escaped))
        index += 1
    fail(line_number, "unterminated ANSI-C quote")

def parse_value(source, line_number):
    output = []
    index = 0
    while index < len(source):
        character = source[index]
        if character == "\\":
            if index + 1 >= len(source):
                fail(line_number, "trailing backslash")
            output.append(source[index + 1])
            index += 2
            continue
        if character == "'":
            end = source.find("'", index + 1)
            if end < 0:
                fail(line_number, "unterminated single quote")
            output.append(source[index + 1:end])
            index = end + 1
            continue
        if character == '"':
            index += 1
            quoted = []
            while index < len(source) and source[index] != '"':
                if source[index] == "\\":
                    if index + 1 >= len(source):
                        fail(line_number, "trailing backslash in double quote")
                    following = source[index + 1]
                    if following in '\\"`$':
                        quoted.append(following)
                    else:
                        quoted.extend(("\\", following))
                    index += 2
                    continue
                if source[index] in {"$", "`"}:
                    fail(line_number, "unescaped expansion is not allowed")
                quoted.append(source[index])
                index += 1
            if index >= len(source):
                fail(line_number, "unterminated double quote")
            output.extend(quoted)
            index += 1
            continue
        if character == "$" and index + 1 < len(source) and source[index + 1] == "'":
            decoded, index = decode_ansi(source, index + 2, line_number)
            output.append(decoded)
            continue
        if character in {"$", "`"}:
            fail(line_number, "unescaped expansion is not allowed")
        if character.isspace() or character in ";&|<>()":
            fail(line_number, "unescaped shell metacharacter is not allowed")
        output.append(character)
        index += 1
    value = "".join(output)
    if "\0" in value or "\r" in value:
        fail(line_number, "decoded value contains NUL or CR")
    return value

for line_number, line in enumerate(text.split("\n"), 1):
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    match = assignment.fullmatch(line)
    if not match:
        fail(line_number, "only assignments, comments, and blank lines are allowed")
    key, encoded_value = match.groups()
    if key not in allowed:
        fail(line_number, f"unsupported key: {key}")
    if key in seen:
        fail(line_number, f"duplicate key: {key}")
    seen.add(key)
    value = parse_value(encoded_value, line_number)
    rendered = base64.b64encode(value.encode("utf-8")).decode("ascii")
    print(f"{key}\t{rendered}")
PY
}

# Validate and consume the one-shot root-only input uploaded by an Admin SSH
# bootstrap. The caller must establish a trusted checkout before sourcing this
# helper. Values are merged atomically into the canonical idempotent input and
# the one-shot file is deleted only after a successful merge.
supacloud_consume_protected_install_input() (
    local source_file="$1"
    local target_file="$2"
    local owner mode numeric_mode
    local allowed_keys=(
        INTERNAL_IP SUPABASE_PUBLIC_DOMAIN SUPABASE_STUDIO_DOMAIN SUPABASE_DOMAIN
        DASHBOARD_USERNAME DASHBOARD_PASSWORD POSTGRES_PASSWORD GRAFANA_PASSWORD
        JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY
        SWAP_SIZE_GB PG_VERSION PIGSTY_VERSION
        TIMEZONE PIGSTY_CONFIG_TEMPLATE SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK
        SUPACLOUD_MIGRATE_LEGACY_SUPABASE_COMPOSE S3_STORAGE_TYPE JUICEFS_BACKEND
        S3_ENDPOINT S3_PROTOCOL S3_REGION S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY
        S3_FORCE_PATH_STYLE EXTERNAL_S3_ENDPOINT EXTERNAL_S3_REGION EXTERNAL_S3_BUCKET
        EXTERNAL_S3_ACCESS_KEY EXTERNAL_S3_SECRET_KEY IMAGINARY_IMAGE EDGE_RUNTIME
        ENABLE_ANALYTICS ANALYTICS_BACKEND LOGFLARE_DB LOGFLARE_SCHEMA LOGFLARE_ERL_FLAGS
    )

    [[ -f "$source_file" && ! -L "$source_file" ]] || {
        printf 'Protected setup input must be a regular file: %s\n' "$source_file" >&2
        return 1
    }
    if owner=$(stat -c '%u' "$source_file" 2>/dev/null); then
        mode=$(stat -c '%a' "$source_file") || return 1
    else
        owner=$(stat -f '%u' "$source_file") || return 1
        mode=$(stat -f '%Lp' "$source_file") || return 1
    fi
    [[ "$owner" == "$EUID" ]] || {
        printf 'Protected setup input has unexpected owner: %s\n' "$source_file" >&2
        return 1
    }
    numeric_mode=$((8#$mode))
    (( (numeric_mode & 077) == 0 )) || {
        printf 'Protected setup input must not be group/world accessible: %s\n' "$source_file" >&2
        return 1
    }
    supacloud_parse_install_input "$source_file" "${allowed_keys[@]}" >/dev/null || return 1
    umask 077
    supacloud_atomic_merge_env "$target_file" "$source_file" || return 1
    chmod 600 "$target_file"
    rm -f "$source_file"
)

# Write values accepted by both systemd EnvironmentFile= and Bash `source`.
# Newlines are rejected so one value cannot create an additional assignment.
# NUL cannot be represented in a Bash variable; the remaining shell-active
# characters are escaped inside a double-quoted value.
supacloud_write_service_env_pairs() (
    local target_file="$1"
    shift
    local desired_file key value escaped
    if (( $# % 2 != 0 )); then
        return 1
    fi
    desired_file=$(mktemp)
    chmod 600 "$desired_file"
    trap 'rm -f "$desired_file"' EXIT HUP INT TERM
    while [[ $# -gt 0 ]]; do
        key="$1"
        value="$2"
        shift 2
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
        if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
            printf 'Environment value %s must be a single line\n' "$key" >&2
            return 1
        fi
        escaped=${value//\\/\\\\}
        escaped=${escaped//\"/\\\"}
        escaped=${escaped//\$/\\\$}
        escaped=${escaped//\`/\\\`}
        printf '%s="%s"\n' "$key" "$escaped" >> "$desired_file"
    done
    supacloud_atomic_merge_env "$target_file" "$desired_file"
)

# Write env files for consumers such as Podman or legacy Compose that expect
# the bytes after '=' verbatim. Values remain single-line to prevent assignment
# injection; the protected temporary file is removed on every exit path.
supacloud_write_raw_env_pairs() (
    local target_file="$1"
    shift
    local desired_file key value
    if (( $# % 2 != 0 )); then
        return 1
    fi
    desired_file=$(mktemp)
    chmod 600 "$desired_file"
    trap 'rm -f "$desired_file"' EXIT HUP INT TERM
    while [[ $# -gt 0 ]]; do
        key="$1"
        value="$2"
        shift 2
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
        if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
            printf 'Environment value %s must be a single line\n' "$key" >&2
            return 1
        fi
        printf '%s=%s\n' "$key" "$value" >> "$desired_file"
    done
    supacloud_atomic_merge_env "$target_file" "$desired_file"
)

supacloud_urlencode_stdin() {
    python3 -c '
import sys
from urllib.parse import quote_from_bytes

print(quote_from_bytes(sys.stdin.buffer.read(), safe=b""), end="")
'
}

supacloud_stable_secret() {
    local env_file="$1"
    local key="$2"
    local generated_value="$3"
    local existing_value
    existing_value=$(supacloud_env_value "$env_file" "$key")
    printf '%s' "${existing_value:-$generated_value}"
}

supacloud_postgres_scram_verifier() {
    python3 -c '
import base64
import hashlib
import hmac
import os
import sys

password = sys.stdin.buffer.read()
if not password:
    raise SystemExit("password input is empty")
iterations = 4096
salt = os.urandom(16)
salted = hashlib.pbkdf2_hmac("sha256", password, salt, iterations)
client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
stored_key = hashlib.sha256(client_key).digest()
server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
encode = lambda value: base64.b64encode(value).decode("ascii")
print(f"SCRAM-SHA-256${iterations}:{encode(salt)}${encode(stored_key)}:{encode(server_key)}", end="")
'
}

supacloud_hs256_signature() {
    local secret="$1"
    local message="$2"
    printf '%s\0%s' "$secret" "$message" | python3 -c '
import base64
import hashlib
import hmac
import sys

secret, message = sys.stdin.buffer.read().split(b"\0", 1)
signature = hmac.new(secret, message, hashlib.sha256).digest()
print(base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii"), end="")
'
}

supacloud_patch_pigsty_secrets() (
    local target_file="$1"
    shift
    local secret_input
    secret_input=$(mktemp)
    chmod 600 "$secret_input"
    trap 'rm -f "$secret_input"' EXIT HUP INT TERM
    printf '%s\0' "$@" > "$secret_input"
    python3 - "$target_file" "$secret_input" <<'PY'
import json
import os
import re
import sys
import tempfile
from pathlib import Path

target = Path(sys.argv[1])
secret_file = Path(sys.argv[2])
raw = secret_file.read_bytes().split(b"\0")
values = [value.decode("utf-8") for value in raw[:8]]
values.extend([""] * (8 - len(values)))
dashboard, postgres, grafana, jwt_secret, anon_key, service_role_key, publishable_key, secret_key = values
text = target.read_text()

def replace_scalar(pattern: str, value: str, source: str) -> str:
    if not value:
        return source
    rendered = json.dumps(value, ensure_ascii=False)
    return re.sub(pattern, lambda match: f"{match.group(1)}{rendered}", source, flags=re.MULTILINE)

text = replace_scalar(r"^(\s*DASHBOARD_PASSWORD:\s*).*$", dashboard, text)
text = replace_scalar(r"^(\s*POSTGRES_PASSWORD:\s*).*$", postgres, text)
if postgres:
    text = re.sub(
        r"^(\s*password:\s*)['\"]?DBUser\.Supa['\"]?\s*$",
        lambda match: f"{match.group(1)}{json.dumps(postgres, ensure_ascii=False)}",
        text,
        flags=re.MULTILINE,
    )
text = replace_scalar(r"^(\s*grafana_admin_password:\s*).*$", grafana, text)
text = replace_scalar(r"^(\s*JWT_SECRET:\s*).*$", jwt_secret, text)
text = replace_scalar(r"^(\s*ANON_KEY:\s*).*$", anon_key, text)
text = replace_scalar(r"^(\s*SERVICE_ROLE_KEY:\s*).*$", service_role_key, text)
text = replace_scalar(r"^(\s*SUPABASE_PUBLISHABLE_KEY:\s*).*$", publishable_key, text)
text = replace_scalar(r"^(\s*SUPABASE_SECRET_KEY:\s*).*$", secret_key, text)

mode = target.stat().st_mode & 0o777
fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    os.fchmod(fd, mode)
    with os.fdopen(fd, "w") as temporary:
        temporary.write(text)
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary_name, target)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
PY
)

supacloud_write_install_input_config() (
    local target_file="$1"
    local desired_file
    desired_file=$(mktemp)
    chmod 600 "$desired_file"
    trap 'rm -f "$desired_file"' EXIT HUP INT TERM
    {
        printf '%s=%q\n' INTERNAL_IP "${INTERNAL_IP:-}"
        printf '%s=%q\n' SUPABASE_PUBLIC_DOMAIN "${SUPABASE_PUBLIC_DOMAIN:-}"
        printf '%s=%q\n' SUPABASE_STUDIO_DOMAIN "${SUPABASE_STUDIO_DOMAIN:-}"
        printf '%s=%q\n' DASHBOARD_USERNAME "${DASHBOARD_USERNAME:-admin}"
        printf '%s=%q\n' DASHBOARD_PASSWORD "${DASHBOARD_PASSWORD:-}"
        printf '%s=%q\n' POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-}"
        printf '%s=%q\n' GRAFANA_PASSWORD "${GRAFANA_PASSWORD:-}"
        printf '%s=%q\n' SWAP_SIZE_GB "${SWAP_SIZE_GB:-4}"
        printf '%s=%q\n' PG_VERSION "${PG_VERSION:-18}"
        printf '%s=%q\n' PIGSTY_VERSION "${PIGSTY_VERSION:-v4.4.0}"
        printf '%s=%q\n' TIMEZONE "${TIMEZONE:-Asia/Shanghai}"
        printf '%s=%q\n' PIGSTY_CONFIG_TEMPLATE "${PIGSTY_CONFIG_TEMPLATE:-supabase}"
        printf '%s=%q\n' SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK "${SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:-false}"
        printf '%s=%q\n' SUPACLOUD_MIGRATE_LEGACY_SUPABASE_COMPOSE "${SUPACLOUD_MIGRATE_LEGACY_SUPABASE_COMPOSE:-false}"
        printf '%s=%q\n' S3_STORAGE_TYPE "${S3_STORAGE_TYPE:-juicefs}"
        printf '%s=%q\n' JUICEFS_BACKEND "${JUICEFS_BACKEND:-postgres}"
        printf '%s=%q\n' S3_ENDPOINT "${S3_ENDPOINT:-}"
        printf '%s=%q\n' S3_PROTOCOL "${S3_PROTOCOL:-}"
        printf '%s=%q\n' S3_REGION "${S3_REGION:-}"
        printf '%s=%q\n' S3_BUCKET "${S3_BUCKET:-}"
        printf '%s=%q\n' S3_ACCESS_KEY "${S3_ACCESS_KEY:-}"
        printf '%s=%q\n' S3_SECRET_KEY "${S3_SECRET_KEY:-}"
        printf '%s=%q\n' S3_FORCE_PATH_STYLE "${S3_FORCE_PATH_STYLE:-}"
        printf '%s=%q\n' EXTERNAL_S3_ENDPOINT "${EXTERNAL_S3_ENDPOINT:-}"
        printf '%s=%q\n' EXTERNAL_S3_REGION "${EXTERNAL_S3_REGION:-}"
        printf '%s=%q\n' EXTERNAL_S3_BUCKET "${EXTERNAL_S3_BUCKET:-}"
        printf '%s=%q\n' EXTERNAL_S3_ACCESS_KEY "${EXTERNAL_S3_ACCESS_KEY:-}"
        printf '%s=%q\n' EXTERNAL_S3_SECRET_KEY "${EXTERNAL_S3_SECRET_KEY:-}"
        printf '%s=%q\n' EDGE_RUNTIME "${EDGE_RUNTIME:-bun}"
        printf '%s=%q\n' ENABLE_ANALYTICS "${ENABLE_ANALYTICS:-true}"
        printf '%s=%q\n' ANALYTICS_BACKEND "${ANALYTICS_BACKEND:-postgres}"
        printf '%s=%q\n' LOGFLARE_DB "${LOGFLARE_DB:-_supabase}"
        printf '%s=%q\n' LOGFLARE_SCHEMA "${LOGFLARE_SCHEMA:-_analytics}"
    } > "$desired_file"
    supacloud_atomic_merge_env "$target_file" "$desired_file"
)

supacloud_write_pgpass() (
    local target_file="$1"
    local host="$2"
    local port="$3"
    local database="$4"
    local username="$5"
    local password="$6"
    local escaped_password temporary_file
    escaped_password=${password//\\/\\\\}
    escaped_password=${escaped_password//:/\\:}
    mkdir -p "$(dirname "$target_file")"
    temporary_file=$(mktemp "${target_file}.tmp.XXXXXX")
    trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
    (umask 077; printf '%s:%s:%s:%s:%s\n' "$host" "$port" "$database" "$username" "$escaped_password" > "$temporary_file")
    chmod 600 "$temporary_file"
    mv -f "$temporary_file" "$target_file"
)

supacloud_atomic_remove_env_key() {
    local target_file="$1"
    shift
    python3 - "$target_file" "$@" <<'PY'
import os
import re
import sys
import tempfile
from pathlib import Path

target = Path(sys.argv[1])
keys = set(sys.argv[2:])
if not target.exists():
    raise SystemExit(0)

pattern = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
lines = []
for line in target.read_text().splitlines():
    match = pattern.match(line)
    if match and match.group(1) in keys:
        continue
    lines.append(line)
payload = "\n".join(lines) + ("\n" if lines else "")
fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as temporary:
        temporary.write(payload)
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary_name, target)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
PY
}

supacloud_write_cli_profile() {
    local profile_file="$1"
    local desired_file
    mkdir -p "$(dirname "$profile_file")"
    desired_file=$(mktemp)
    printf 'export MANAGEMENT_API_URL=http://localhost:9090\n' > "$desired_file"
    supacloud_atomic_merge_env "$profile_file" "$desired_file"
    rm -f "$desired_file"
    supacloud_atomic_remove_env_key "$profile_file" MASTER_TOKEN
    # Older releases installed `sc -> supacloud`, which is ambiguous now that
    # the user CLI and server daemon have distinct names. Remove it instead of
    # silently keeping a command that may target the wrong executable.
    python3 - "$profile_file" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
lines = [
    line for line in path.read_text().splitlines()
    if line.strip() not in {"alias sc='supacloud'", 'alias sc="supacloud"'}
]
path.write_text("\n".join(lines) + ("\n" if lines else ""))
PY
    chmod 644 "$profile_file"
}
