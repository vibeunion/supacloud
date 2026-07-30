import { describe, expect, test } from "bun:test";
import { PATRONI_CONFIG_PATH, parsePatroniNodes, patronictlListArguments } from "./cluster";

describe("patronictl cluster status command", () => {
    test("uses the installed Patroni configuration when it is available", () => {
        expect(patronictlListArguments(true)).toEqual([
            "-c",
            PATRONI_CONFIG_PATH,
            "list",
            "--format",
            "json",
        ]);
    });

    test("keeps the default Patroni lookup for installations without that configuration path", () => {
        expect(patronictlListArguments(false)).toEqual(["list", "--format", "json"]);
    });

    test("treats a successful command with no cluster output as an unavailable cluster", () => {
        expect(parsePatroniNodes("   \n")).toEqual([]);
    });

    test("normalizes Patroni's formatted member fields", () => {
        expect(parsePatroniNodes('[{"Role":"Leader","State":"running","Member":"pg-meta-1"}]')).toEqual([
            { role: "Leader", state: "running", member: "pg-meta-1" },
        ]);
    });
});
