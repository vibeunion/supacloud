import { expect, test } from "bun:test";

test("guarded constructors preserve framework branding and reject dynamic imports", async () => {
  // The guard permanently replaces intrinsics: isolate it from the test runner.
  const child = Bun.spawn([process.execPath, "--eval", `
    const { guardDynamicCodeApis } = await import("./deno-compat.ts");
    const { init, parse } = await import("es-module-lexer");
    await init;
    const samples = [
      function () {}, async function () {},
      function* () {}, async function* () {},
    ];
    const originals = samples.map(fn => Object.getPrototypeOf(fn).constructor);
    guardDynamicCodeApis(source => {
      if (parse(source)[0].length) throw new Error("blocked-import");
    });
    const results = samples.map((fn, index) => {
      const guarded = Object.getPrototypeOf(fn).constructor;
      let blocked = false;
      try { guarded("return import('node:fs')"); }
      catch (error) { blocked = error instanceof Error && error.message === "blocked-import"; }
      return {
        name: guarded.name, length: guarded.length,
        replaced: guarded !== originals[index],
        locked: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fn), "constructor").writable === false,
        blocked,
        generatedName: Object.getPrototypeOf(guarded("return 42")).constructor.name,
      };
    });
    let evalBlocked = false;
    try { globalThis.eval("1"); } catch { evalBlocked = true; }
    console.log("RESULT=" + JSON.stringify({ results, evalBlocked }));
  `], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const line = stdout.split("\n").find(line => line.startsWith("RESULT="));
  expect(line).toBeDefined();
  const result: unknown = JSON.parse(line!.slice("RESULT=".length));
  expect(result).toEqual({
    results: ["Function", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"]
      .map(name => ({ name, length: 1, replaced: true, locked: true, blocked: true, generatedName: name })),
    evalBlocked: true,
  });
});
