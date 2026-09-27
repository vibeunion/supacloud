#!/usr/bin/env python3
"""Verify the immutable trust chain for the Realtime slot-isolation BEAM."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path


ARTIFACT_VERSION = 2
REALTIME_VERSION = "2.138.1"
REALTIME_IMAGE_TAG = "public.ecr.aws/supabase/realtime:v2.138.1"
REALTIME_IMAGE_REPOSITORY = "public.ecr.aws/supabase/realtime"
REALTIME_IMAGE_INDEX_DIGEST = "sha256:7a6d995635f747b566079e51b1a1388dded8b2d0dfef1eda5afe98f6c9e5567e"
REALTIME_IMAGE_PLATFORM_MANIFEST_DIGESTS = {
    "amd64": "sha256:023cd658da8212c67d12eb1a43914bab67e1a3ea51f731a385ad7596d8226ec0",
    "arm64": "sha256:839743c3294d69d9eef0d2909338b40be1da1fe58114129e510dfd2fe2020c79",
}
REALTIME_IMAGE_CONFIG_DIGESTS = {
    "amd64": "sha256:b069a8f97f0d05eadd5a18aebce08f051b3b8e07d6c120eef457f5d24f2523dd",
    "arm64": "sha256:ecc1bc4f347e7565b290ddd68c0079e3e9b0f8cad7ba06d1ee686135bfaa1b97",
}
REALTIME_RESOLVED_IMAGE = f"{REALTIME_IMAGE_REPOSITORY}@{REALTIME_IMAGE_INDEX_DIGEST}"

BUILDER_IMAGE_TAG = "docker.io/hexpm/elixir:1.19.5-erlang-28.5.0.4-debian-trixie-20260713"
BUILDER_IMAGE_REPOSITORY = "docker.io/hexpm/elixir"
BUILDER_IMAGE_INDEX_DIGEST = "sha256:5db16aff7fdc118d4b268c7104f3c0409049b3255d503e08ca00a7e29050a408"
BUILDER_IMAGE_PLATFORM_MANIFEST_DIGESTS = {
    "amd64": "sha256:77d1ed571b8fd66d60940c030d24a0f3a0ca48735155534e3132e8209ae56b86",
    "arm64": "sha256:51030f0252b08486eeb38e27fe6cf2e9769538594244734a7184ad8d6236be10",
}
BUILDER_RESOLVED_IMAGE = f"{BUILDER_IMAGE_REPOSITORY}@{BUILDER_IMAGE_INDEX_DIGEST}"

SOURCE_REPOSITORY = "https://github.com/supabase/realtime.git"
SOURCE_COMMIT = "ba9b550891b7b591954fc6c67a180634bc128624"
SOURCE_FILE = "lib/realtime/tenants/replication_connection.ex"
SOURCE_FILE_SHA256 = "91467fc0bcb380a66cdeb548a060212652f6e39d0d6024854a45ef7496d2f17a"
PATCHED_SOURCE_FILE_SHA256 = "359a26b3c195a29e10d8a82c1f81e8b972c6e9ffbf61636a83d7e587c3672ac6"
MODULE = "Elixir.Realtime.Tenants.ReplicationConnection.beam"
CONTAINER_PATH = f"/app/lib/realtime-{REALTIME_VERSION}/ebin/{MODULE}"


class VerificationError(ValueError):
    """Raised when an artifact is outside the pinned trust root."""


def _secure_path(path: Path, expected_uid: int, *, directory: bool) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise VerificationError(f"cannot inspect {path}: {error}") from error
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if path.is_symlink() or not expected_type(info.st_mode):
        kind = "directory" if directory else "regular file"
        raise VerificationError(f"Realtime slot-isolation path is not a secure {kind}: {path}")
    if info.st_uid != expected_uid:
        raise VerificationError(
            f"Realtime slot-isolation path owner is {info.st_uid}, expected {expected_uid}: {path}"
        )
    if info.st_mode & 0o022:
        raise VerificationError(f"Realtime slot-isolation path is writable by group/other: {path}")


def _secure_ancestors(path: Path, expected_uid: int) -> None:
    """Reject symlinked or attacker-writable ancestors of the artifact path."""
    for parent in path.parents:
        try:
            info = parent.lstat()
        except OSError as error:
            raise VerificationError(f"cannot inspect Realtime slot-isolation parent {parent}: {error}") from error
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise VerificationError(f"Realtime slot-isolation parent is not a real directory: {parent}")
        if parent == Path("/"):
            break
        # A root-owned sticky directory such as /tmp protects entries from
        # replacement while still allowing an isolated test workspace.
        sticky_public = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
        if info.st_uid not in {0, expected_uid}:
            raise VerificationError(
                f"Realtime slot-isolation parent owner is {info.st_uid}, expected {expected_uid}: {parent}"
            )
        if info.st_mode & 0o022 and not sticky_public:
            raise VerificationError(f"Realtime slot-isolation parent is writable by group/other: {parent}")


def expected_manifest(architecture: str, beam_sha256: str) -> dict[str, object]:
    if architecture not in REALTIME_IMAGE_PLATFORM_MANIFEST_DIGESTS:
        raise VerificationError(f"unsupported Realtime architecture: {architecture}")
    return {
        "artifactVersion": ARTIFACT_VERSION,
        "runtimeVersion": REALTIME_VERSION,
        "baseImage": REALTIME_IMAGE_TAG,
        "resolvedImageReference": REALTIME_RESOLVED_IMAGE,
        "runtimeImageIndexDigest": REALTIME_IMAGE_INDEX_DIGEST,
        "runtimeImagePlatform": f"linux/{architecture}",
        "runtimeImagePlatformManifestDigest": REALTIME_IMAGE_PLATFORM_MANIFEST_DIGESTS[architecture],
        "runtimeImageConfigDigest": REALTIME_IMAGE_CONFIG_DIGESTS[architecture],
        "sourceRepository": SOURCE_REPOSITORY,
        "sourceCommit": SOURCE_COMMIT,
        "sourceFile": SOURCE_FILE,
        "sourceFileSha256": SOURCE_FILE_SHA256,
        "patchedSourceFileSha256": PATCHED_SOURCE_FILE_SHA256,
        "builderImageTag": BUILDER_IMAGE_TAG,
        "builderImage": BUILDER_RESOLVED_IMAGE,
        "builderImageIndexDigest": BUILDER_IMAGE_INDEX_DIGEST,
        "builderImagePlatform": f"linux/{architecture}",
        "builderImagePlatformManifestDigest": BUILDER_IMAGE_PLATFORM_MANIFEST_DIGESTS[architecture],
        "module": MODULE,
        "containerPath": CONTAINER_PATH,
        "beamSha256": beam_sha256,
    }


def verify_artifact(
    artifact_dir: Path,
    manifest_path: Path,
    beam_path: Path,
    architecture: str,
    expected_uid: int = 0,
) -> dict[str, object]:
    artifact_dir = Path(os.path.abspath(artifact_dir))
    manifest_path = Path(os.path.abspath(manifest_path))
    beam_path = Path(os.path.abspath(beam_path))
    if manifest_path != artifact_dir / "manifest.json":
        raise VerificationError("Realtime slot-isolation manifest is outside the artifact directory")
    if beam_path != artifact_dir / MODULE:
        raise VerificationError("Realtime slot-isolation BEAM is outside the artifact directory")
    _secure_ancestors(artifact_dir, expected_uid)
    _secure_path(artifact_dir, expected_uid, directory=True)
    _secure_path(manifest_path, expected_uid, directory=False)
    _secure_path(beam_path, expected_uid, directory=False)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise VerificationError(f"Realtime slot-isolation manifest is invalid: {error}") from error
    if not isinstance(manifest, dict):
        raise VerificationError("Realtime slot-isolation manifest must be a JSON object")
    beam_sha256 = hashlib.sha256(beam_path.read_bytes()).hexdigest()
    for key, expected in expected_manifest(architecture, beam_sha256).items():
        if manifest.get(key) != expected:
            raise VerificationError(f"Realtime slot-isolation manifest field {key} is not verified")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--beam", required=True, type=Path)
    parser.add_argument("--architecture", required=True, choices=sorted(REALTIME_IMAGE_PLATFORM_MANIFEST_DIGESTS))
    parser.add_argument("--expected-uid", type=int, default=0)
    args = parser.parse_args()
    try:
        verify_artifact(args.artifact_dir, args.manifest, args.beam, args.architecture, args.expected_uid)
    except VerificationError as error:
        print(str(error), file=os.sys.stderr)
        return 1
    print("Realtime slot-isolation artifact verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
