from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SELF_HOST = Path(__file__).resolve().parent
QUADLET = SELF_HOST / "quadlet"


class PodmanInstallContractTests(unittest.TestCase):
    def test_dry_run_renders_without_podman_or_root(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            result = subprocess.run(
                [str(SELF_HOST / "install.sh"), "--dry-run", "--no-start", "--root-dir", root],
                check=True, capture_output=True, text=True,
            )
        self.assertIn("Podman Quadlet plan ready", result.stdout)
        self.assertIn("single-node", result.stdout)

    def test_quadlet_units_have_single_node_contract(self) -> None:
        expected = {
            "supacloud-postgres.container",
            "supacloud-gotrue.container",
            "supacloud-postgrest.container",
            "supacloud-realtime.container",
            "supacloud-victorialogs.container",
            "supacloud-pgredis-runtime.container",
            "supacloud-management-api.container",
            "supacloud-edge-runtime.container",
            "supacloud-caddy.container",
            "supacloud.network",
        }
        self.assertEqual({path.name for path in QUADLET.iterdir()}, expected)
        for path in QUADLET.glob("*.container"):
            text = path.read_text(encoding="utf-8")
            self.assertIn("[Container]", text)
            self.assertIn("Image=", text)
            self.assertIn("EnvironmentFile=/etc/supacloud/", text)
            self.assertNotIn("docker compose", text.lower())
            self.assertIn("PartOf=supacloud.target", text)
            self.assertIn("Restart=on-failure", text)
            self.assertNotIn("EnvironmentFile=/etc/supacloud/supacloud.env", text)

    def test_generated_service_environments_keep_secrets_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            command = [str(SELF_HOST / "install.sh"), "--dry-run", "--root-dir", root,
                       "--public-url", "https://api.example.test", "--studio-url", "https://studio.example.test"]
            subprocess.run(command, check=True, capture_output=True)
            config = Path(root) / "etc/supacloud"
            def environment(name: str) -> dict[str, str]:
                return dict(line.split("=", 1) for line in (config / f"{name}.env").read_text().splitlines()
                            if line and not line.startswith("#"))
            edge = environment("edge-runtime")
            self.assertEqual(edge["PORT"], "9005")
            self.assertEqual(environment("management-api")["PORT"], "9090")
            self.assertNotIn("POSTGRES_PASSWORD", edge)
            self.assertNotIn("DATABASE_URL", edge)
            self.assertNotIn("SECRETS_ENCRYPTION_KEY", edge)
            self.assertNotIn("DATABASE_URL", environment("pgredis-runtime"))
            self.assertNotIn("MASTER_TOKEN", environment("postgres"))
            self.assertEqual(environment("caddy"), {})
            self.assertEqual(environment("victorialogs"), {})
            self.assertEqual(environment("management-api")["LEGACY_SECRETS_MIGRATION_FILE"],
                             "/run/secrets/supacloud-legacy-secrets-migration")
            original_secrets = (config / "supacloud.env").read_bytes()
            # A retry without URL arguments preserves the original origins.
            subprocess.run(command[:4], check=True, capture_output=True)
            self.assertEqual((config / "supacloud.env").read_bytes(), original_secrets)
            self.assertEqual(environment("gotrue")["GOTRUE_SITE_URL"], "https://studio.example.test")
            for path in config.glob("*.env"):
                self.assertEqual(path.stat().st_mode & 0o077, 0, path.name)

            # Recovery creates a missing file, but preserves an unconsumed key.
            migration = config / ".legacy-secrets-migration.env"
            migration.unlink()
            subprocess.run(command[:4], check=True, capture_output=True)
            self.assertTrue(migration.is_file())
            migration.write_text("synthetic-migration-key-012345678901234567890\n")
            with (config / "supacloud.env").open("a") as output:
                output.write("GOTRUE_SMTP_HOST=smtp.example.test\nENABLE_SSL=false\n")
            subprocess.run(command[:4], check=True, capture_output=True)
            self.assertEqual(migration.read_text(), "synthetic-migration-key-012345678901234567890\n")
            self.assertEqual(environment("management-api")["GOTRUE_SMTP_HOST"], "smtp.example.test")
            self.assertEqual(environment("management-api")["ENABLE_SSL"], "false")

    def test_staging_never_starts_host_services(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            result = subprocess.run([str(SELF_HOST / "install.sh"), "--root-dir", root],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("staging cannot start host services", result.stderr)

    def test_bootstrap_persists_provider_without_replacing_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "install.env"
            config.write_text("SUPACLOUD_DEPLOYMENT_PROFILE=podman\nPOSTGRES_PASSWORD=preserve-this\n")
            script = '''
source ./setup.sh
require_root() { :; }
install_base_deps() { :; }
clone_repo() { INSTALL_DIR="$PWD"; }
consume_setup_install_input() { :; }
run_install() { :; }
# Keep the real main and atomic merge, replacing only host-changing stages.
generate_config() { CONFIG_FILE="$SUPACLOUD_INSTALL_CONFIG_FILE"; }
main
'''
            env = dict(os.environ, SUPACLOUD_INSTALL_CONFIG_FILE=str(config))
            subprocess.run(["bash", "-c", script], cwd=SELF_HOST.parents[1], env=env,
                           check=True, capture_output=True)
            self.assertIn("SUPACLOUD_DEPLOYMENT_PROFILE=podman", config.read_text())
            self.assertIn("POSTGRES_PASSWORD=preserve-this", config.read_text())

    def test_installer_does_not_fallback_to_docker(self) -> None:
        installer = (SELF_HOST / "install.sh").read_text(encoding="utf-8").lower()
        self.assertIn("podman build", installer)
        self.assertNotIn("docker compose", installer)
        self.assertNotIn("podman-compose", installer)

    def test_build_contexts_are_podman_owned(self) -> None:
        installer = (SELF_HOST / "install.sh").read_text(encoding="utf-8")
        self.assertIn('"$SCRIPT_DIR/postgres"', installer)
        self.assertIn('"$REPO_ROOT"', installer)
        for path in (
            SELF_HOST / "postgres/Containerfile",
            SELF_HOST / "management-api.Containerfile",
            SELF_HOST / "edge-runtime.Containerfile",
            SELF_HOST / "pgredis-runtime.Containerfile",
            SELF_HOST / "caddy/Containerfile",
        ):
            self.assertTrue(path.is_file(), path)
            self.assertNotIn("docker/self-host", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
