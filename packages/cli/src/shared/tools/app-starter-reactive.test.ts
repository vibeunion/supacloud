import { expect, test } from "bun:test";
import { appStarterFiles } from "./app-starter";
import appMetadata from "../../../../app/package.json" with { type: "json" };

test("all official starters install the same RxJS version and emit the reactive guidance/tests", () => {
  for (const files of [appStarterFiles("reactive-demo")]) {
    const manifest = JSON.parse(files["package.json"]!) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.rxjs).toBe(appMetadata.dependencies.rxjs);
    expect(files["REACTIVE.md"]).toContain("client.supabase");
    expect(files["REACTIVE.md"]).toContain("@supacloud/app/angular");
    expect(files["REACTIVE.md"]).toContain("legacy root signal graph");
    expect(files["AGENTS.md"]).toContain("@supacloud/app/angular");
    expect(files["REACTIVE.md"]).toContain("onCursor");
    expect(files["AGENTS.md"]).toContain("REACTIVE.md");
    expect(files["AGENTS.md"]).toContain("supacloud app context --format json");
    expect(files["AGENTS.md"]).toContain("supacloud app doctor --format json");
    expect(files["AGENTS.md"]).toContain("supacloud app fix --fix <file>");
    expect(files["tests/reactive.test.ts"]).toContain("takeUntilAborted");
  }
});
