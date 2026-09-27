import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addStarterTestDependencies,
  installStarterConsumer,
  runStarterCommand,
  starterInstallArgs,
} from "./check_app_starter";

const env = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap(name =>
  process.env[name] === undefined ? [] : [[name, process.env[name]!]]));

describe("starter dependency installation", () => {
  test("uses cached metadata for workspace and consumer installs", () => {
    expect(starterInstallArgs("workspace")).toEqual([
      "install", "--no-progress", "--prefer-offline", "--frozen-lockfile",
    ]);
    expect(starterInstallArgs("consumer")).toEqual([
      "install", "--no-progress", "--prefer-offline", "--ignore-scripts",
    ]);
    expect(starterInstallArgs("locked-consumer")).toEqual([
      "install", "--no-progress", "--offline", "--frozen-lockfile", "--ignore-scripts",
    ]);
  });

  test("keeps the SDK in dependencies instead of duplicating it", () => {
    const manifest: { dependencies: Record<string, string>; devDependencies: Record<string, string> } = {
      dependencies: { "@supabase/supabase-js": "^2.115.0" },
      devDependencies: { "@supabase/supabase-js": "^2.114.0" },
    };
    addStarterTestDependencies(manifest);
    expect(manifest.dependencies["@supabase/supabase-js"]).toBe("^2.115.0");
    expect(manifest.devDependencies["@supabase/supabase-js"]).toBeUndefined();
    expect(manifest.devDependencies.jose).toBe("^6.2.11");
  });

  test("performs the cache-preferred install and offline frozen verification", async () => {
    const calls: string[][] = [];
    await installStarterConsumer("/tmp/starter-consumer", async (args, cwd) => {
      calls.push([cwd, ...args]);
      return "";
    });
    expect(calls).toEqual([
      ["/tmp/starter-consumer", ...starterInstallArgs("consumer")],
      ["/tmp/starter-consumer", ...starterInstallArgs("locked-consumer")],
    ]);
  });

  test("never treats a failed first install as a successful verification", async () => {
    let calls = 0;
    await expect(installStarterConsumer("/unused", async () => {
      calls++;
      throw new Error("Install failed");
    })).rejects.toThrow("Install failed");
    expect(calls).toBe(1);
  });

  test("reports command failures with stage and working directory", async () => {
    await expect(runStarterCommand(["-e", "process.exit(7)"], {
      cwd: import.meta.dir, env, signal: new AbortController().signal,
    })).rejects.toThrow("scripts: bun -e process.exit(7)");
  });

  test("times out and reaps a child even when it ignores SIGTERM", async () => {
    let failure: unknown;
    try {
      await runStarterCommand(["-e", `
process.on("SIGTERM", () => {});
console.log("CHILD_PID=" + process.pid);
setInterval(() => {}, 1000);
`], { cwd: import.meta.dir, env, signal: new AbortController().signal, timeoutMs: 200 });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("timed out after 200ms");
    const pid = Number(message.match(/CHILD_PID=(\d+)/)?.[1]);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("does not spawn an already cancelled command", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before spawn"));
    await expect(runStarterCommand(["-e", "process.exit(0)"], {
      cwd: "/does-not-exist", env, signal: controller.signal,
    })).rejects.toThrow("Cancelled before spawn");
  });

  test("a timeout cannot satisfy an expected command failure", async () => {
    await expect(runStarterCommand(["-e", "setInterval(() => {}, 1000)"], {
      cwd: import.meta.dir, env, signal: new AbortController().signal,
      success: false, timeoutMs: 100,
    })).rejects.toThrow("timed out after 100ms");
  });

  test("installs local transitive tarball overrides and repeats a clean frozen install", async () => {
    const root = await mkdtemp(join(tmpdir(), "starter-install-test-"));
    const signal = new AbortController().signal;
    const run = (args: string[], cwd: string) =>
      runStarterCommand(args, { cwd, env, signal, timeoutMs: 10_000 });
    try {
      const child = join(root, "child"), parent = join(root, "parent"), consumer = join(root, "consumer");
      for (const directory of [child, parent, consumer]) await mkdir(directory);
      await writeFile(join(child, "package.json"), JSON.stringify({
        name: "@starter-install/child", version: "1.0.0", type: "module", exports: "./index.js",
      }));
      await writeFile(join(child, "index.js"), 'export const value = "packed-only";');
      await writeFile(join(parent, "package.json"), JSON.stringify({
        name: "@starter-install/parent", version: "1.0.0", type: "module", exports: "./index.js",
        dependencies: { "@starter-install/child": "file:../child" },
      }));
      await writeFile(join(parent, "index.js"), 'export { value } from "@starter-install/child";');
      const childTar = join(root, "child.tgz"), parentTar = join(root, "parent.tgz");
      await run(["pm", "pack", "--ignore-scripts", "--filename", childTar], child);
      await run(["pm", "pack", "--ignore-scripts", "--filename", parentTar], parent);
      await rm(child, { recursive: true });
      await rm(parent, { recursive: true });
      await writeFile(join(consumer, "package.json"), JSON.stringify({
        private: true, type: "module",
        dependencies: { "@starter-install/parent": `file:${parentTar}` },
        overrides: { "@starter-install/child": `file:${childTar}` },
      }));
      await installStarterConsumer(consumer, run);
      const lock = await readFile(join(consumer, "bun.lock"), "utf8");
      expect(lock).toContain("child.tgz");
      await rm(join(consumer, "node_modules"), { recursive: true });
      await run(starterInstallArgs("locked-consumer"), consumer);
      expect(await readFile(join(consumer, "bun.lock"), "utf8")).toBe(lock);
      expect(await run(["-e", 'import { value } from "@starter-install/parent"; console.log(value)'], consumer))
        .toContain("packed-only");
      const installed = await realpath(join(consumer, "node_modules/@starter-install/child"));
      expect(installed.startsWith(await realpath(join(consumer, "node_modules")))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
