#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import tempfile
import unittest


SELF_HOST_DIR = pathlib.Path(__file__).resolve().parent
COMPOSE_FILE = SELF_HOST_DIR / "docker-compose.yml"
ENTRYPOINT = SELF_HOST_DIR / "caddy" / "entrypoint.sh"
BOOTSTRAP_CONFIG = SELF_HOST_DIR / "caddy" / "Caddyfile"


def compose_model() -> dict:
    environment = os.environ | {
        "LEGACY_SECRETS_MIGRATION_FILE": str(SELF_HOST_DIR / ".legacy-secrets-migration.env"),
    }
    command = ["docker", "compose", "-f", str(COMPOSE_FILE), "config", "--format", "json"]
    return json.loads(subprocess.run(command, check=True, capture_output=True, text=True, env=environment).stdout)


def volume(service: dict, target: str) -> dict:
    return next(mount for mount in service["volumes"] if mount["target"] == target)


def run_entrypoint(config_contents: str | None, initialized: bool = False) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    with tempfile.TemporaryDirectory() as temporary_dir:
        root = pathlib.Path(temporary_dir)
        managed_config = root / "config.json"
        marker = root / "INITIALIZED"
        bootstrap_config = root / "Caddyfile"
        caddy_calls = root / "caddy.calls"
        fake_caddy = root / "caddy"
        bootstrap_config.write_text("bootstrap")
        if config_contents is not None:
            managed_config.write_text(config_contents)
        if initialized:
            marker.write_text("initialized")
        fake_caddy.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$CADDY_CALLS"\n'
            'if [ "$1" = validate ] && grep -q INVALID "$3"; then exit 1; fi\n'
            'exit 0\n'
        )
        fake_caddy.chmod(0o755)
        environment = os.environ | {
            "PATH": f"{root}:{os.environ['PATH']}",
            "CADDY_CALLS": str(caddy_calls),
            "SUPACLOUD_CADDY_CONFIG_PATH": str(managed_config),
            "SUPACLOUD_CADDY_INITIALIZED_MARKER": str(marker),
            "SUPACLOUD_CADDY_BOOTSTRAP_CONFIG": str(bootstrap_config),
        }
        completed = subprocess.run([str(ENTRYPOINT)], capture_output=True, text=True, env=environment)
        calls = caddy_calls.read_text().splitlines() if caddy_calls.exists() else []
        return completed, calls


class CaddyComposeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.model = compose_model()

    def test_gateway_ports_and_startup_order(self) -> None:
        caddy = self.model["services"]["caddy"]
        management = self.model["services"]["management-api"]
        port_pairs = {(port["published"], port["target"]) for port in caddy["ports"]}

        self.assertIn(("8000", 80), port_pairs)
        self.assertIn(("8443", 443), port_pairs)
        self.assertNotIn("depends_on", caddy)
        self.assertEqual(management["depends_on"]["caddy"]["condition"], "service_healthy")

    def test_shared_volume_permissions(self) -> None:
        caddy = self.model["services"]["caddy"]
        management = self.model["services"]["management-api"]

        for target in ("/var/supacloud/frontends", "/etc/supacloud/caddy"):
            self.assertFalse(volume(management, target).get("read_only", False))
            self.assertTrue(volume(caddy, target)["read_only"])
        self.assertFalse(volume(management, "/var/lib/supacloud/caddy").get("read_only", False))
        self.assertFalse(volume(caddy, "/var/lib/supacloud/caddy").get("read_only", False))

    def test_bootstrap_tls_uses_only_a_fixed_internal_subject(self) -> None:
        bootstrap = BOOTSTRAP_CONFIG.read_text()

        self.assertIn("auto_https disable_redirects", bootstrap)
        self.assertIn("default_sni supacloud-bootstrap.invalid", bootstrap)
        self.assertIn("fallback_sni supacloud-bootstrap.invalid", bootstrap)
        self.assertIn("supacloud-bootstrap.invalid:443", bootstrap)
        self.assertNotIn("on_demand", bootstrap)

    def test_entrypoint_uses_durable_json_and_fails_closed_after_initialization(self) -> None:
        durable, durable_calls = run_entrypoint('{"admin":{"listen":"0.0.0.0:2019"}}')
        durable_initialized, initialized_calls = run_entrypoint(
            '{"admin":{"listen":"0.0.0.0:2019"}}',
            initialized=True,
        )
        fresh, fresh_calls = run_entrypoint(None)
        missing, missing_calls = run_entrypoint(None, initialized=True)
        invalid, invalid_calls = run_entrypoint("INVALID", initialized=True)

        self.assertEqual(durable.returncode, 0)
        self.assertEqual([call.split()[0] for call in durable_calls], ["validate", "run"])
        self.assertNotIn("--adapter", durable_calls[-1])
        self.assertEqual(durable_initialized.returncode, 0)
        self.assertEqual([call.split()[0] for call in initialized_calls], ["validate", "run"])
        self.assertEqual(fresh.returncode, 0)
        self.assertIn("--adapter caddyfile", fresh_calls[-1])
        self.assertNotEqual(missing.returncode, 0)
        self.assertEqual(missing_calls, [])
        self.assertIn("initialized Caddy config was lost", missing.stderr)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertEqual([call.split()[0] for call in invalid_calls], ["validate"])


if __name__ == "__main__":
    unittest.main()
