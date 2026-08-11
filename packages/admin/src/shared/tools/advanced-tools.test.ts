import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";
import { registerAdvancedTools } from "./advanced-tools";

type ToolResponse = { content: Array<{ text: string }>; isError?: boolean };

function platformTool(http: Record<string, unknown>) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<ToolResponse>) | undefined;
    registerAdvancedTools({
        tool(name, _description, toolSchema, toolCallback) {
            if (name !== "platform") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as never);
    if (!schema || !callback) throw new Error("platform tool was not registered");
    return { schema, callback };
}

describe("admin platform backup CLI", () => {
    test("requires an explicit full physical backup type", async () => {
        const { schema, callback } = platformTool({});

        expect(parseToolArguments(schema, {
            action: "create_backup",
            ref: "fa_staging",
            backup_type: "full",
        }).backup_type).toBe("full");
        expect(() => parseToolArguments(schema, {
            action: "create_backup",
            ref: "fa_staging",
            backup_type: "incr",
        })).toThrow("Invalid arguments");
        await expect(callback({ action: "create_backup", ref: "fa_staging" }))
            .rejects.toThrow("'backup_type' required for 'create_backup'");
    });
});
