import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const entry of ["angular.ts", "rxjs.ts"]) {
  test(`${entry} is browser-buildable without bundling another Angular runtime`, async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL(`./${entry}`, import.meta.url))],
      target: "browser",
      external: ["@angular/*", "rxjs"],
    });
    expect(result.success).toBe(true);
    const output = (await Promise.all(result.outputs.map((item) => item.text()))).join("\n");
    expect(output).toContain("@angular/core");
    expect(output).not.toContain("node:async_hooks");
    expect(output).not.toContain("class R3Injector");
    expect(output).not.toContain("class Observable");
  });
}
