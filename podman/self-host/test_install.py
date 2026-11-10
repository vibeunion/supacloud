from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


SELF_HOST = Path(__file__).resolve().parent
QUADLET = SELF_HOST / "quadlet"


class PodmanInstallContractTests(unittest.TestCase):
    def test_dry_run_renders_without_podman_or_root(self) -> None:
        result = subprocess.run(
            [str(SELF_HOST / "install.sh"), "--dry-run", "--no-start"],
            check=True,
            capture_output=True,
            text=True,
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
