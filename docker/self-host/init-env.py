#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import stat
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def jwt_encode(secret: str, payload: dict[str, object]) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = (
        f"{b64url(json.dumps(header, separators=(',', ':')).encode())}."
        f"{b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    )
    signature = hmac.new(
        secret.encode("utf-8"),
        signing_input.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{signing_input}.{b64url(signature)}"


def derive_base_domain(public_url: str) -> str:
    host = urlparse(public_url).hostname or "localhost"
    if host in {"localhost", "127.0.0.1"}:
        return "localhost"
    if host.startswith("api."):
        return host[4:]
    return host


def read_env_value(env_path: Path | None, key: str) -> str | None:
    if env_path is None or not env_path.exists():
        return None
    prefix = f"{key}="
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line.startswith(prefix):
            continue
        candidate = line[len(prefix):].strip()
        if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in {'"', "'"}:
            candidate = candidate[1:-1]
        return candidate or None
    return None


def validate_bff_signing_secret(
    candidate: str,
    master_token: str,
    encryption_key: str,
    legacy_encryption_key: str,
) -> None:
    if len(candidate) < 32:
        raise ValueError("SUPAOAUTH_BFF_SIGNING_SECRET must contain at least 32 characters")
    if candidate in {master_token, encryption_key, legacy_encryption_key}:
        raise ValueError("SUPAOAUTH_BFF_SIGNING_SECRET must be independent from management secrets")
    if any(control in candidate for control in ("\0", "\r", "\n")):
        raise ValueError("SUPAOAUTH_BFF_SIGNING_SECRET must not contain control characters")


def validate_legacy_encryption_key(candidate: str, current_key: str) -> None:
    if not candidate:
        return
    if len(candidate) < 32 or candidate == current_key:
        raise ValueError("LEGACY_SECRETS_ENCRYPTION_KEY must be a distinct value of at least 32 characters")
    if any(control in candidate for control in ("\0", "\r", "\n")):
        raise ValueError("LEGACY_SECRETS_ENCRYPTION_KEY must not contain control characters")


def write_private_env(output_path: Path, env_payload: str) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output_path.name}.", dir=output_path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output_file:
            output_file.write(env_payload)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def prepare_legacy_migration_file(output_path: Path, legacy_key: str) -> None:
    if legacy_key:
        write_private_env(output_path, f"{legacy_key}\n")
        return
    if not output_path.exists():
        write_private_env(output_path, "")
        return
    if output_path.is_symlink() or not output_path.is_file():
        raise ValueError("legacy migration input must be a regular file")
    if stat.S_IMODE(output_path.stat().st_mode) & 0o077:
        raise ValueError("legacy migration input must not be group/world accessible")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate docker/self-host/.env for SupaCloud",
    )
    parser.add_argument(
        "--public-url",
        default="http://localhost:8000",
        help="External API gateway URL",
    )
    parser.add_argument(
        "--studio-url",
        default="http://localhost:9090",
        help="External Studio/console URL",
    )
    parser.add_argument(
        "--postgres-password",
        default=secrets.token_urlsafe(18),
        help="Postgres superuser password",
    )
    parser.add_argument(
        "--ferretdb-password",
        default=secrets.token_urlsafe(18),
        help="FerretDB database user password",
    )
    parser.add_argument(
        "--jwt-secret",
        default=secrets.token_urlsafe(32),
        help="JWT signing secret",
    )
    parser.add_argument(
        "--master-token",
        default=secrets.token_urlsafe(32),
        help="Management API master token",
    )
    parser.add_argument(
        "--secrets-encryption-key",
        default=secrets.token_urlsafe(32),
        help="Management API secret encryption key",
    )
    parser.add_argument(
        "--legacy-secrets-encryption-key",
        default="",
        help="One-shot key for migrating enc:v1 values created before key separation",
    )
    parser.add_argument(
        "--legacy-secrets-output",
        type=Path,
        help="Root-only one-shot migration input file; kept on failure and consumed after checkpoint success",
    )
    parser.add_argument(
        "--supaoauth-bff-signing-secret",
        help="Independent BFF actor-proof signing secret",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Atomically write a private 0600 env file and reuse its existing BFF secret",
    )
    parser.add_argument(
        "--timezone",
        default="Asia/Shanghai",
        help="Container timezone",
    )
    args = parser.parse_args()

    if args.legacy_secrets_encryption_key and not (args.output or args.legacy_secrets_output):
        parser.error("--legacy-secrets-encryption-key requires --output or --legacy-secrets-output")
    legacy_migration_path = args.legacy_secrets_output or (
        args.output.with_name(".legacy-secrets-migration.env")
        if args.output
        else Path("./.legacy-secrets-migration.env")
    )

    bff_signing_secret = (
        args.supaoauth_bff_signing_secret
        or read_env_value(args.output, "SUPAOAUTH_BFF_SIGNING_SECRET")
        or os.environ.get("SUPAOAUTH_BFF_SIGNING_SECRET")
        or secrets.token_urlsafe(32)
    )
    try:
        validate_legacy_encryption_key(
            args.legacy_secrets_encryption_key,
            args.secrets_encryption_key,
        )
        validate_bff_signing_secret(
            bff_signing_secret,
            args.master_token,
            args.secrets_encryption_key,
            args.legacy_secrets_encryption_key,
        )
    except ValueError as error:
        parser.error(str(error))

    now = datetime.now(timezone.utc)
    issued_at = int(now.timestamp())
    expires_at = int((now + timedelta(days=3650)).timestamp())

    anon_key = jwt_encode(
        args.jwt_secret,
        {
            "role": "anon",
            "iss": "supabase",
            "iat": issued_at,
            "exp": expires_at,
        },
    )
    service_role_key = jwt_encode(
        args.jwt_secret,
        {
            "role": "service_role",
            "iss": "supabase",
            "iat": issued_at,
            "exp": expires_at,
        },
    )

    env_lines = [
        "# Generated by docker/self-host/init-env.py",
        f"# Generated at {now.isoformat()}",
        f"TZ={args.timezone}",
        "POSTGRES_USER=postgres",
        f"POSTGRES_PASSWORD={args.postgres_password}",
        "POSTGRES_DB=postgres",
        "POSTGRES_PORT=5432",
        "ENABLE_FERRETDB=false",
        "FERRETDB_IMAGE=ghcr.io/ferretdb/ferretdb:2.7.0",
        "FERRETDB_USER=ferretdb",
        f"FERRETDB_PASSWORD={args.ferretdb_password}",
        "FERRETDB_DATABASE=postgres",
        "FERRETDB_PORT=27017",
        "ENABLE_PGSODIUM=false",
        "PGSODIUM_KEY=",
        "PGSODIUM_KEY_FILE=/run/secrets/pgsodium_key",
        "PGSODIUM_ENABLE_EVENT_TRIGGER=off",
        "ENABLE_SUPABASE_VAULT=false",
        "VAULT_KEY=",
        "VAULT_KEY_FILE=/run/secrets/vault_key",
        f"JWT_SECRET={args.jwt_secret}",
        f"ANON_KEY={anon_key}",
        f"SERVICE_ROLE_KEY={service_role_key}",
        f"MASTER_TOKEN={args.master_token}",
        f"SECRETS_ENCRYPTION_KEY={args.secrets_encryption_key}",
        f"LEGACY_SECRETS_MIGRATION_FILE={legacy_migration_path}",
        f"SUPAOAUTH_BFF_SIGNING_SECRET={bff_signing_secret}",
        f"PUBLIC_URL={args.public_url}",
        f"STUDIO_URL={args.studio_url}",
        f"BASE_DOMAIN={derive_base_domain(args.public_url)}",
        "PGRST_DB_SCHEMAS=public,storage,graphql_public",
        "CADDY_HTTP_PORT=8000",
        "CADDY_HTTPS_PORT=8443",
        "# CADDY_ADMIN_PORT=2019 (internal only)",
        "API_PORT=9090",
        "EDGE_RUNTIME_PORT=9000",
    ]
    env_payload = "\n".join(env_lines) + "\n"
    if args.output:
        try:
            prepare_legacy_migration_file(legacy_migration_path, args.legacy_secrets_encryption_key)
        except ValueError as error:
            parser.error(str(error))
        write_private_env(args.output, env_payload)
        return
    if args.legacy_secrets_output:
        try:
            prepare_legacy_migration_file(legacy_migration_path, args.legacy_secrets_encryption_key)
        except ValueError as error:
            parser.error(str(error))
    print(env_payload, end="")


if __name__ == "__main__":
    main()
