import ast
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch


class ImageIdentityTest(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).with_name("build_realtime_slot_isolation_beam.sh").read_text()
        verifier = source.split("def verify(image, role,", 1)[1].split("\nverify(", 1)[0]
        tree = ast.parse("def verify(image, role," + verifier)
        namespace = {"json": json, "subprocess": subprocess, "runtime": "docker", "arch": "arm64"}
        exec(compile(tree, "<builder-image-verifier>", "exec"), namespace)
        self.verify = namespace["verify"]
        self.index = "sha256:" + "1" * 64
        self.platform = "sha256:" + "2" * 64
        self.config = "sha256:" + "3" * 64
        self.image = {
            "Architecture": "arm64",
            "Id": self.config,
            "RepoDigests": ["example.test/realtime@" + self.index],
        }

    def check(self):
        with patch.object(subprocess, "check_output", return_value=json.dumps([self.image])):
            self.verify("image", "runtime", self.index, self.platform, self.config)

    def test_classic_config_identity(self):
        self.check()

    def test_containerd_index_requires_matching_typed_descriptor(self):
        self.image["Id"] = self.index
        with self.assertRaises(SystemExit):
            self.check()
        self.image["Descriptor"] = {
            "digest": self.index,
            "mediaType": "application/vnd.oci.image.index.v1+json",
        }
        self.check()
        self.image["Descriptor"]["digest"] = self.platform
        with self.assertRaises(SystemExit):
            self.check()

    def test_untrusted_identity_cannot_borrow_official_repo_digest(self):
        self.image["Id"] = "sha256:" + "4" * 64
        with self.assertRaises(SystemExit):
            self.check()

    def test_wrong_architecture_or_repo_digest_is_rejected(self):
        self.image["Architecture"] = "amd64"
        with self.assertRaises(SystemExit):
            self.check()
        self.image["Architecture"] = "arm64"
        self.image["RepoDigests"] = ["example.test/realtime@sha256:" + "4" * 64]
        with self.assertRaises(SystemExit):
            self.check()


if __name__ == "__main__":
    unittest.main()
