import { expect, test } from "bun:test";
import { appStarterFiles } from "./app-starter";
import { appTemplateFiles } from "./app-starter-templates";
import appMetadata from "../../../../app/package.json" with { type: "json" };

test("all official starters install the same RxJS version and emit the reactive guidance/tests", () => {
  for (const files of [appStarterFiles("reactive-demo"), appTemplateFiles("reactive-demo", "http"), appTemplateFiles("reactive-demo", "edge")]) {
    const manifest = JSON.parse(files["package.json"]!) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.rxjs).toBe(appMetadata.dependencies.rxjs);
    expect(files["REACTIVE.md"]).toContain("client.supabase");
    expect(files["REACTIVE.md"]).toContain("onCursor");
    expect(files["AGENTS.md"]).toContain("REACTIVE.md");
    expect(files["tests/reactive.test.ts"]).toContain("takeUntilAborted");
  }
});
