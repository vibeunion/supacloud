import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    assertLocalGithubVerifier,
    assertLocalUpgradeBundleSize,
    assertSignedArtifact,
    parseGithubReleaseMetadata,
    runGithubCli,
    serializeAttestationBundles,
    settleLocalBundleDownloads,
    type LocalUpgradeFile,
} from "./local-upgrade-bundle";
import { RELEASE_BUNDLE_SIZE_LIMITS } from "../../../../management-api/src/release-manifest";

const RELEASE_TAG = "management-api-v0.50.31";

function releaseMetadata(downloadUrl: string): unknown {
    return {
        tag_name: RELEASE_TAG,
        draft: false,
        prerelease: false,
        assets: [{
            name: "SUPACLOUD-RELEASE.json",
            browser_download_url: downloadUrl,
        }],
    };
}

function withFakeGithubCli(script: string, run: () => Promise<void>, mode = 0o700): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-admin-gh-"));
    const executable = join(directory, "gh");
    const previousPath = process.env.PATH;
    writeFileSync(executable, script, { mode });
    chmodSync(executable, mode);
    process.env.PATH = `${directory}:${previousPath || ""}`;
    return run().finally(() => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(directory, { recursive: true, force: true });
    });
}

describe("local upgrade download trust boundary", () => {
    test("accepts only the exact official GitHub release asset path", () => {
        const official = `https://github.com/zuohuadong/supacloud/releases/download/${RELEASE_TAG}/SUPACLOUD-RELEASE.json`;

        expect(parseGithubReleaseMetadata(releaseMetadata(official), RELEASE_TAG).assets[0]?.name)
            .toBe("SUPACLOUD-RELEASE.json");
        expect(() => parseGithubReleaseMetadata(
            releaseMetadata(`https://proxy.example.com/${RELEASE_TAG}/SUPACLOUD-RELEASE.json`), RELEASE_TAG,
        )).toThrow("approved official GitHub endpoint");
        expect(() => parseGithubReleaseMetadata(
            releaseMetadata(`https://github.com/zuohuadong/other/releases/download/${RELEASE_TAG}/SUPACLOUD-RELEASE.json`),
            RELEASE_TAG,
        )).toThrow("official GitHub release path");
    });

    test("serializes every GitHub attestation bundle as bounded JSONL input", () => {
        const serialized = serializeAttestationBundles({
            attestations: [{ bundle: { mediaType: "one" } }, { bundle: { mediaType: "two" } }],
        });

        expect(serialized).toBe('{"mediaType":"one"}\n{"mediaType":"two"}\n');
        expect(() => serializeAttestationBundles({ attestations: [] })).toThrow("did not contain attestations");
    });

    test("counts the optional verifier archive against the shared bundle limit", () => {
        const componentFiles: LocalUpgradeFile[] = [{
            localPath: "/tmp/component",
            relativePath: "bundle/management-api/component",
            sha256: "0".repeat(64),
            size: RELEASE_BUNDLE_SIZE_LIMITS.total - 1,
        }];
        const verifierArchive: LocalUpgradeFile = {
            localPath: "/tmp/verifier",
            relativePath: "verifier/gh.tar.gz",
            sha256: "1".repeat(64),
            size: 2,
        };

        expect(() => assertLocalUpgradeBundleSize(componentFiles)).not.toThrow();
        expect(() => assertLocalUpgradeBundleSize([...componentFiles, verifierArchive])).toThrow("total size limit");
    });

    test("waits for every parallel bundle download before preserving the first failure", async () => {
        const firstFailure = new Error("management download failed");
        let resolveEdgeDownload!: (files: LocalUpgradeFile[]) => void;
        const edgeDownload = new Promise<LocalUpgradeFile[]>((resolve) => { resolveEdgeDownload = resolve; });
        let completed = false;
        const settlement = settleLocalBundleDownloads([
            Promise.reject(firstFailure),
            edgeDownload,
            Promise.resolve(null),
        ]).catch((error: unknown) => {
            completed = true;
            return error;
        });

        await Bun.sleep(10);
        expect(completed).toBe(false);
        resolveEdgeDownload([]);
        expect(await settlement).toBe(firstFailure);
        expect(completed).toBe(true);
    });

    test("rejects a downloaded artifact whose signed digest no longer matches", () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-admin-artifact-"));
        const artifactPath = join(directory, "artifact.bin");
        const contents = "verified release artifact";
        writeFileSync(artifactPath, contents);
        const manifest = {
            artifacts: [{
                name: "artifact.bin",
                size: Buffer.byteLength(contents),
                sha256: createHash("sha256").update(contents).digest("hex"),
            }],
        } as never;
        try {
            chmodSync(artifactPath, 0o600);
            expect(assertSignedArtifact(artifactPath, manifest)).toHaveLength(64);
            writeFileSync(artifactPath, "tampered release artifact");
            expect(() => assertSignedArtifact(artifactPath, manifest)).toThrow("signed release hashes");

            if (process.platform === "linux") {
                writeFileSync(artifactPath, contents);
                chmodSync(artifactPath, 0o4600);
                expect(() => assertSignedArtifact(artifactPath, manifest)).toThrow("exact mode 0600");
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("requires every strict offline verification flag from the local gh", async () => {
        await withFakeGithubCli([
            "#!/usr/bin/env bash",
            "printf '%s\\n' --bundle --signer-workflow --source-ref --source-digest --deny-self-hosted-runners",
        ].join("\n"), async () => {
            await expect(assertLocalGithubVerifier()).resolves.toBeUndefined();
        });
    });

    test("rejects a local gh verifier carrying special permission bits", async () => {
        if (process.platform !== "linux") return;
        await withFakeGithubCli("#!/bin/sh\nexit 0\n", async () => {
            await expect(assertLocalGithubVerifier()).rejects.toThrow("special permission bits");
        }, 0o4700);
    });

    test("waits for a timed-out gh process to exit after the kill grace", async () => {
        await withFakeGithubCli([
            "#!/usr/bin/env node",
            "process.on('SIGTERM', () => {});",
            "console.log(process.pid);",
            "setInterval(() => {}, 1000);",
        ].join("\n"), async () => {
            const execution = await runGithubCli(["hang"], 1_500);
            const pid = Number(execution.stdout.trim());

            expect(execution.exitCode).toBe(124);
            expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
            expect(Bun.spawnSync(["kill", "-0", String(pid)]).exitCode).not.toBe(0);
        });
    });
});
