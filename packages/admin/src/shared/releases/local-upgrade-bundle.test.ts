import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    assertLocalGithubVerifier,
    assertLocalTrustedRootDirectory,
    assertLocalUpgradeBundleSize,
    assertSignedArtifact,
    githubAttestationVerificationArguments,
    parseGithubReleaseMetadata,
    prepareLocalUpgradeBundle,
    runGithubCli,
    serializeAttestationBundles,
    settleLocalBundleDownloads,
    type LocalUpgradeFile,
} from "./local-upgrade-bundle";
import { RELEASE_BUNDLE_SIZE_LIMITS } from "../../../../management-api/src/release-manifest";
import {
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME,
    SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL,
} from "../../../../management-api/src/sigstore-trusted-root";
import * as sigstoreTrustedRoot from "../../../../management-api/src/sigstore-trusted-root";

const RELEASE_TAG = "management-api-v0.50.31";

function setFixtureMode(filePath: string, mode: number): void {
    if ((mode & 0o7000) === 0) {
        chmodSync(filePath, mode);
        return;
    }
    const chmod = Bun.spawnSync(["chmod", mode.toString(8), filePath]);
    if (chmod.exitCode !== 0) {
        throw new Error(`Unable to set fixture mode ${mode.toString(8)}: ${chmod.stderr.toString().trim()}`);
    }
    const actualMode = statSync(filePath).mode & 0o7777;
    if (actualMode !== mode) {
        throw new Error(`Fixture mode is ${actualMode.toString(8)}, expected ${mode.toString(8)}`);
    }
}

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
    setFixtureMode(executable, mode);
    process.env.PATH = `${directory}:${previousPath || ""}`;
    return run().finally(() => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(directory, { recursive: true, force: true });
    });
}

describe("local upgrade download trust boundary", () => {
    test("accepts only the exact official GitHub release asset path", () => {
        const official = `https://github.com/vibeunion/supacloud/releases/download/${RELEASE_TAG}/SUPACLOUD-RELEASE.json`;

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

    test("rejects a tampered target Management runner at the signed bundle boundary", () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-admin-artifact-"));
        const artifactPath = join(directory, "supacloud-linux-amd64");
        const contents = "verified release artifact";
        writeFileSync(artifactPath, contents);
        const manifest = {
            artifacts: [{
                name: "supacloud-linux-amd64",
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
                setFixtureMode(artifactPath, 0o4600);
                expect(() => assertSignedArtifact(artifactPath, manifest)).toThrow("exact mode 0600");
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("requires every strict offline verification flag from the local gh", async () => {
        await withFakeGithubCli([
            "#!/usr/bin/env bash",
            "printf '%s\\n' --bundle --signer-workflow --source-ref --source-digest --deny-self-hosted-runners --custom-trusted-root",
        ].join("\n"), async () => {
            await expect(assertLocalGithubVerifier()).resolves.toBeUndefined();
        });
    });

    test("rejects a local verifier without custom trusted-root support", async () => {
        await withFakeGithubCli([
            "#!/usr/bin/env bash",
            "printf '%s\\n' --bundle --signer-workflow --source-ref --source-digest --deny-self-hosted-runners",
        ].join("\n"), async () => {
            await expect(assertLocalGithubVerifier()).rejects.toThrow("current gh attestation verifier");
        });
    });

    test("uses the same fixed trusted root for every local attestation verification", () => {
        const trustedRootPath = "/private/trusted_root.jsonl";
        const arguments_ = githubAttestationVerificationArguments({
            artifactPath: "/bundle/SUPACLOUD-RELEASE.json",
            bundlePath: "/bundle/SUPACLOUD-RELEASE.attestation.jsonl",
            trustedRootPath,
            manifest: { source: { commit: "a".repeat(40) } } as never,
        });

        expect(arguments_).toContain("--custom-trusted-root");
        expect(arguments_[arguments_.indexOf("--custom-trusted-root") + 1]).toBe(trustedRootPath);
        expect(arguments_.filter(argument => argument === "--custom-trusted-root")).toHaveLength(1);
    });

    test("fails closed when the pinned local trusted root is missing, altered, linked, or too permissive", () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), "supacloud-admin-trusted-root-"));
        const trustedRootDirectory = join(fixtureRoot, "verification");
        const trustedRootPath = join(trustedRootDirectory, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_FILENAME);
        mkdirSync(trustedRootDirectory, { mode: 0o700 });
        chmodSync(trustedRootDirectory, 0o700);
        try {
            expect(() => assertLocalTrustedRootDirectory(trustedRootDirectory)).toThrow("strict file allowlist");

            writeFileSync(trustedRootPath, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL, { mode: 0o600 });
            chmodSync(trustedRootPath, 0o600);
            expect(assertLocalTrustedRootDirectory(trustedRootDirectory)).toBe(trustedRootPath);

            writeFileSync(trustedRootPath, `${SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL} `);
            expect(() => assertLocalTrustedRootDirectory(trustedRootDirectory)).toThrow("pinned size and digest");

            writeFileSync(trustedRootPath, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL);
            chmodSync(trustedRootPath, 0o644);
            expect(() => assertLocalTrustedRootDirectory(trustedRootDirectory)).toThrow("exact mode 0600");

            rmSync(trustedRootPath);
            const linkedRoot = join(fixtureRoot, "linked-root.jsonl");
            writeFileSync(linkedRoot, SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL, { mode: 0o600 });
            symlinkSync(linkedRoot, trustedRootPath);
            expect(() => assertLocalTrustedRootDirectory(trustedRootDirectory)).toThrow("without links");
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    test("removes the prepared bundle layout when trusted-root setup fails", async () => {
        const existingLayouts = new Set(
            readdirSync(tmpdir()).filter(name => name.startsWith("supacloud-admin-upgrade-")),
        );
        const setupFailure = new Error("trusted-root setup failed");
        const trustedRootSetup = spyOn(sigstoreTrustedRoot, "withSigstoreVerificationDirectory")
            .mockRejectedValue(setupFailure);
        try {
            await withFakeGithubCli([
                "#!/usr/bin/env bash",
                "printf '%s\\n' --bundle --signer-workflow --source-ref --source-digest --deny-self-hosted-runners --custom-trusted-root",
            ].join("\n"), async () => {
                await expect(prepareLocalUpgradeBundle({
                    architecture: "amd64",
                    managementVersion: "0.50.33",
                    edgeRuntimeVersion: "0.16.9",
                    verifierProvisioning: "installed",
                })).rejects.toBe(setupFailure);
            });
        } finally {
            trustedRootSetup.mockRestore();
        }
        const leakedLayouts = readdirSync(tmpdir()).filter(name => (
            name.startsWith("supacloud-admin-upgrade-") && !existingLayouts.has(name)
        ));
        expect(leakedLayouts).toEqual([]);
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
