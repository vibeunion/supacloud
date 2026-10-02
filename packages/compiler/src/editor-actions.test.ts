import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditorCodeActions } from "./diagnostics";
import { applyDiagnosticFix } from "./fixes";
import type { Diagnostic } from "./types";

test("editor semantic actions preview real source, reject drift and preserve explicit policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "editor-action-"));
  try {
    const file = join(root, "command.ts");
    const original = `import { Command } from '@supacloud/app';\n@Command({ transaction: false })\nexport class Save {}`;
    await writeFile(file, original);
    const diagnostic: Diagnostic = { severity: "error", code: "invalid-command-mode", file, message: "Invalid policy",
      fix: { type: "set_command_mode", targetFile: file, command: "Save", property: "transaction", expectedExpression: "false" } };
    expect(await createEditorCodeActions([diagnostic], { rootDir: root })).toEqual([]);
    if (diagnostic.fix?.type !== "set_command_mode") throw new Error("Expected policy fix");
    diagnostic.fix.value = "required";
    const actions = await createEditorCodeActions([diagnostic], { rootDir: root });
    expect(actions).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe(original);
    const action = actions[0]!.command.arguments[0];
    expect(actions[0]!.data.preview).toContain('transaction: "required"');
    await writeFile(file, original + "\n// changed since preview\n");
    await expect(applyDiagnosticFix(action.fix, { rootDir: root, dryRun: false, expectedSourceHash: action.expectedSourceHash }))
      .rejects.toThrow("changed since preview");
    await writeFile(file, original);
    await applyDiagnosticFix(action.fix, { rootDir: root, dryRun: false, expectedSourceHash: action.expectedSourceHash });
    expect(await readFile(file, "utf8")).toContain('transaction: "required"');
    expect(await createEditorCodeActions([diagnostic], { rootDir: root })).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
