import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAppTool } from "./app-tools";

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("app infer exposes a bounded, read-only structural plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-inference-"));
    roots.push(root);
    const result = await runAppTool({ action: "infer", root, format: "json" });
    const payload = JSON.parse(result.content[0]!.text) as {
        version: number;
        source: string;
        ready: boolean;
        explicitInputs: string[];
        commands: Record<string, string>;
        items: Array<{ field: string; readiness: string }>;
        next: string[];
    };
    expect(result.isError).toBe(false);
    expect(payload).toMatchObject({
        version: 1,
        source: "application-graph",
        ready: true,
    });
    expect(payload.explicitInputs).toContain("business permissions");
    expect(payload.explicitInputs).toContain("table operation ownership in db/modules.ts");
    expect(payload.commands).toMatchObject({
        infer: "supacloud app infer --format json",
        ownershipSuggest: "supacloud db operation-ownership suggest",
        ownershipAdopt: "supacloud db operation-ownership adopt",
    });
    expect(payload.next).toContain("supacloud app check --format json");
    expect(payload.next).toContain("supacloud db operation-ownership suggest");

    const textResult = await runAppTool({ action: "infer", root });
    expect(textResult.content[0]!.text).toContain("ownership: supacloud db operation-ownership suggest");

    const contextResult = await runAppTool({ action: "context", root, format: "json" });
    const context = JSON.parse(contextResult.content[0]!.text) as {
        inference: { source: string; explicitInputs: string[] };
    };
    expect(contextResult.isError).toBe(false);
    expect(context.inference.source).toBe("application-graph");
    expect(context.inference.explicitInputs).toContain("tenant and RLS policy");
});
