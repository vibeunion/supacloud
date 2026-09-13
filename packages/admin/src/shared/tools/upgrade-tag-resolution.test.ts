import { describe, expect, test } from "bun:test";
import { buildRootUpgradeScript } from "./ssh-tools";

function resolveTag(tag: string) {
    const statement = buildRootUpgradeScript({ helperPath: "/tmp/release-assets.sh" })
        .split("\n").find(line => line.startsWith("TARGET_MANAGEMENT_VERSION="));
    if (!statement) throw new Error("Upgrade script is missing release tag resolution");
    return Bun.spawnSync(["bash", "-c", [
        "set -euo pipefail",
        statement,
        "printf '%s' \"$TARGET_MANAGEMENT_VERSION\"",
    ].join("\n")], {
        env: { ...process.env, MANAGEMENT_RELEASE: JSON.stringify({ tag_name: tag }) },
    });
}

describe("generated Management upgrade tag resolution", () => {
    test.each(["0.77.1", "1.2.3", "10.20.30"])("resolves %s using real bash and jq", version => {
        const result = resolveTag(`management-api-v${version}`);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe(version);
        expect(result.stderr.toString()).toBe("");
    });

    test.each([
        "management-api-v0x77x1",
        "management-api-v00.77.1",
        "management-api-v0.77.1-rc.1",
        "management-api-v0.77.1+build",
        "edge-runtime-v0.77.1",
        "management-api-v0.77",
    ])("rejects invalid release tag %s", tag => {
        const result = resolveTag(tag);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout.toString()).toBe("");
    });
});
