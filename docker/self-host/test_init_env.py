from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, cast


SELF_HOST_DIR = Path(__file__).resolve().parent
REPO_ROOT = SELF_HOST_DIR.parents[1]
INIT_ENV = SELF_HOST_DIR / "init-env.py"
MANAGEMENT_ENTRYPOINT = SELF_HOST_DIR / "management-api-entrypoint.sh"


def parsed_env(env_path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        if not raw_line or raw_line.startswith("#") or "=" not in raw_line:
            continue
        key, entry = raw_line.split("=", 1)
        entries[key] = entry
    return entries


def compose_config(env_path: Path, overrides: dict[str, str] | None = None) -> dict[str, object]:
    command_environment = os.environ.copy()
    command_environment.update(overrides or {})
    completed = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(env_path),
            "-f",
            str(SELF_HOST_DIR / "docker-compose.yml"),
            "config",
            "--format",
            "json",
        ],
        check=True,
        capture_output=True,
        text=True,
        env=command_environment,
    )
    return json.loads(completed.stdout)


class InitEnvTests(unittest.TestCase):
    def test_output_is_private_and_reuses_the_bff_signing_secret(self) -> None:
        master_token = "master-token-0123456789abcdef0123456789abcdef"
        encryption_key = "encryption-key-0123456789abcdef0123456789abcdef"
        with tempfile.TemporaryDirectory() as temporary_directory:
            env_path = Path(temporary_directory) / ".env"
            command = [
                "python3",
                str(INIT_ENV),
                "--master-token",
                master_token,
                "--secrets-encryption-key",
                encryption_key,
                "--output",
                str(env_path),
            ]

            first_run = subprocess.run(command, check=True, capture_output=True, text=True)
            first_secret = parsed_env(env_path)["SUPAOAUTH_BFF_SIGNING_SECRET"]
            first_pgredis_token = parsed_env(env_path)["PGREDIS_RUNTIME_INTERNAL_TOKEN"]
            second_run = subprocess.run(command, check=True, capture_output=True, text=True)
            second_secret = parsed_env(env_path)["SUPAOAUTH_BFF_SIGNING_SECRET"]
            second_pgredis_token = parsed_env(env_path)["PGREDIS_RUNTIME_INTERNAL_TOKEN"]

            self.assertEqual(first_run.stdout, "")
            self.assertEqual(second_run.stdout, "")
            self.assertEqual(stat.S_IMODE(env_path.stat().st_mode), 0o600)
            self.assertGreaterEqual(len(first_secret), 32)
            self.assertNotIn(first_secret, {master_token, encryption_key})
            self.assertEqual(second_secret, first_secret)
            self.assertGreaterEqual(len(first_pgredis_token), 32)
            self.assertNotIn(first_pgredis_token, {master_token, encryption_key, first_secret})
            self.assertEqual(second_pgredis_token, first_pgredis_token)
            generated = parsed_env(env_path)
            self.assertRegex(generated["GOTRUE_DB_ENCRYPTION_KEY_ID"], r"^supacloud-[0-9a-f]{16}$")
            self.assertRegex(generated["GOTRUE_DB_ENCRYPTION_KEY"], r"^[A-Za-z0-9_-]{43}$")
            self.assertEqual(
                generated["GOTRUE_DB_DECRYPTION_KEYS"],
                f'{generated["GOTRUE_DB_ENCRYPTION_KEY_ID"]}:{generated["GOTRUE_DB_ENCRYPTION_KEY"]}',
            )
            self.assertNotIn("LEGACY_SECRETS_ENCRYPTION_KEY", parsed_env(env_path))
            migration_path = Path(parsed_env(env_path)["LEGACY_SECRETS_MIGRATION_FILE"])
            self.assertTrue(migration_path.exists())
            self.assertEqual(migration_path.read_text(encoding="utf-8"), "")
            self.assertEqual(stat.S_IMODE(migration_path.stat().st_mode), 0o600)

    def test_rejects_a_shared_management_secret(self) -> None:
        shared_secret = "shared-secret-0123456789abcdef0123456789abcdef"
        with tempfile.TemporaryDirectory() as temporary_directory:
            env_path = Path(temporary_directory) / ".env"
            completed = subprocess.run(
                [
                    "python3",
                    str(INIT_ENV),
                    "--master-token",
                    shared_secret,
                    "--supaoauth-bff-signing-secret",
                    shared_secret,
                    "--output",
                    str(env_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("must be independent", completed.stderr)
            self.assertFalse(env_path.exists())

    def test_legacy_encryption_key_is_explicit_and_migration_only(self) -> None:
        current_key = "current-encryption-key-0123456789abcdef0123456789"
        legacy_key = "legacy-encryption-key-0123456789abcdef0123456789"
        with tempfile.TemporaryDirectory() as temporary_directory:
            env_path = Path(temporary_directory) / ".env"
            subprocess.run(
                [
                    "python3",
                    str(INIT_ENV),
                    "--secrets-encryption-key",
                    current_key,
                    "--legacy-secrets-encryption-key",
                    legacy_key,
                    "--output",
                    str(env_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            generated_env = parsed_env(env_path)
            self.assertNotIn("LEGACY_SECRETS_ENCRYPTION_KEY", generated_env)
            migration_path = Path(generated_env["LEGACY_SECRETS_MIGRATION_FILE"])
            self.assertEqual(migration_path.read_text(encoding="utf-8"), f"{legacy_key}\n")
            self.assertEqual(stat.S_IMODE(migration_path.stat().st_mode), 0o600)

            subprocess.run(
                ["python3", str(INIT_ENV), "--secrets-encryption-key", current_key, "--output", str(env_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(migration_path.read_text(encoding="utf-8"), f"{legacy_key}\n")

            rejected = subprocess.run(
                [
                    "python3",
                    str(INIT_ENV),
                    "--secrets-encryption-key",
                    current_key,
                    "--legacy-secrets-encryption-key",
                    current_key,
                    "--output",
                    str(env_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("must be a distinct value", rejected.stderr)

    def test_compose_scopes_bff_secret_without_global_provider_linking_flags(self) -> None:
        self_host_compose = (SELF_HOST_DIR / "docker-compose.yml").read_text(encoding="utf-8")
        dev_compose = (REPO_ROOT / "docker/dev/docker-compose.yml").read_text(encoding="utf-8")
        env_example = (SELF_HOST_DIR / ".env.example").read_text(encoding="utf-8")

        self.assertEqual(self_host_compose.count("SUPAOAUTH_BFF_SIGNING_SECRET:"), 1)
        self.assertIn("SUPAOAUTH_BFF_SIGNING_SECRET: ${SUPAOAUTH_BFF_SIGNING_SECRET}", self_host_compose)
        self.assertIn(
            "SUPAOAUTH_BFF_SIGNING_SECRET=${SUPAOAUTH_BFF_SIGNING_SECRET:-dev-supaoauth-bff-signing-secret-change-me}",
            dev_compose,
        )
        self.assertIn("\nSUPAOAUTH_BFF_SIGNING_SECRET=\n", env_example)
        self.assertNotIn("LEGACY_SECRETS_ENCRYPTION_KEY:", self_host_compose)
        self.assertIn("LEGACY_SECRETS_MIGRATION_FILE", self_host_compose)
        self.assertNotIn("GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS", self_host_compose)
        self.assertNotIn("GOTRUE_EXPERIMENTAL_PROVIDERS_WITH_OWN_LINKING_DOMAIN", self_host_compose)

    def test_compose_exposes_gotrue_at_the_supabase_auth_path(self) -> None:
        self_host_compose = (SELF_HOST_DIR / "docker-compose.yml").read_text(encoding="utf-8")
        dev_compose = (REPO_ROOT / "docker/dev/docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("API_EXTERNAL_URL: ${PUBLIC_URL}/auth/v1", self_host_compose)
        self.assertIn("API_EXTERNAL_URL: http://localhost:${CADDY_HTTP_PORT:-8000}/auth/v1", dev_compose)
        for compose in (self_host_compose, dev_compose):
            self.assertIn("GOTRUE_CUSTOM_OAUTH_ENABLED:", compose)
            self.assertIn("GOTRUE_SECURITY_DATABASE_ENCRYPTION_ENCRYPT:", compose)
            self.assertIn("GOTRUE_PASSKEY_ENABLED:", compose)
            self.assertIn("GOTRUE_WEBAUTHN_RP_ID:", compose)

    @unittest.skipUnless(shutil.which("docker"), "docker compose is not installed")
    def test_compose_scopes_bff_secret_to_management_api(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            env_path = Path(temporary_directory) / ".env"
            subprocess.run(
                ["python3", str(INIT_ENV), "--output", str(env_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            default_services = compose_config(env_path)["services"]
            self.assertIsInstance(default_services, dict)
            default_service_map = cast(dict[str, dict[str, Any]], default_services)
            default_gotrue = default_service_map["gotrue"]["environment"]
            management_environment = default_service_map["management-api"]["environment"]

            self.assertNotIn("GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS", default_gotrue)
            self.assertNotIn("GOTRUE_EXPERIMENTAL_PROVIDERS_WITH_OWN_LINKING_DOMAIN", default_gotrue)
            self.assertGreaterEqual(len(management_environment["SUPAOAUTH_BFF_SIGNING_SECRET"]), 32)
            self.assertNotIn("LEGACY_SECRETS_ENCRYPTION_KEY", management_environment)
            for service_name, service_config in default_service_map.items():
                if service_name == "management-api":
                    continue
                self.assertNotIn("SUPAOAUTH_BFF_SIGNING_SECRET", service_config.get("environment", {}))
                self.assertNotIn("LEGACY_SECRETS_ENCRYPTION_KEY", service_config.get("environment", {}))

    def test_management_entrypoint_consumes_legacy_key_only_after_success(self) -> None:
        legacy_key = "legacy-encryption-key-0123456789abcdef0123456789"
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            migration_file = root / "migration.env"
            invocation_log = root / "invocations.log"
            fake_bun = fake_bin / "bun"
            fake_bun.write_text(
                """#!/bin/sh
if [ "$1" = "-e" ]; then
  cat "$MIGRATION_FILE"
  exit 0
fi
if [ "$*" = "run src/index.ts --init-db" ]; then
  printf 'init:%s\\n' "${LEGACY_SECRETS_ENCRYPTION_KEY:+present}" >> "$INVOCATION_LOG"
  exit "${INIT_STATUS:-0}"
fi
printf 'runtime:%s\\n' "${LEGACY_SECRETS_ENCRYPTION_KEY:+present}" >> "$INVOCATION_LOG"
""",
                encoding="utf-8",
            )
            fake_bun.chmod(0o755)

            def run_entrypoint(init_status: int) -> subprocess.CompletedProcess[str]:
                completed = subprocess.run(
                    ["sh", str(MANAGEMENT_ENTRYPOINT)],
                    check=False,
                    capture_output=True,
                    text=True,
                    env={
                        **os.environ,
                        "PATH": f"{fake_bin}:{os.environ['PATH']}",
                        "INIT_STATUS": str(init_status),
                        "INVOCATION_LOG": str(invocation_log),
                        "LEGACY_SECRETS_MIGRATION_FILE": str(migration_file),
                    },
                )
                return completed

            migration_file.write_text(f"{legacy_key}\n", encoding="utf-8")
            migration_file.chmod(0o600)
            failed = run_entrypoint(1)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(migration_file.read_text(encoding="utf-8"), f"{legacy_key}\n")

            succeeded = run_entrypoint(0)
            self.assertEqual(succeeded.returncode, 0, succeeded.stderr)
            self.assertEqual(migration_file.read_text(encoding="utf-8"), "")
            self.assertEqual(
                invocation_log.read_text(encoding="utf-8").splitlines(),
                ["init:present", "init:present", "runtime:"],
            )

    def test_management_entrypoint_rejects_an_insecure_migration_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            migration_file = Path(temporary_directory) / "migration.env"
            migration_file.write_text("legacy-encryption-key-0123456789abcdef0123456789\n", encoding="utf-8")
            migration_file.chmod(0o644)

            completed = subprocess.run(
                ["sh", str(MANAGEMENT_ENTRYPOINT)],
                check=False,
                capture_output=True,
                text=True,
                env={
                    **os.environ,
                    "LEGACY_SECRETS_MIGRATION_FILE": str(migration_file),
                },
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("must not be group/world accessible", completed.stderr)


if __name__ == "__main__":
    unittest.main()
