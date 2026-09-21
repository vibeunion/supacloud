import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createClient, FunctionsHttpError } from "@supabase/supabase-js";

const packageRoot = resolve(import.meta.dir, "..");

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a consumer compiler configuration object");
  }
  return Object.fromEntries(Object.entries(value));
}

async function configuration(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return record(value);
}

function checkedCommand(command: string, args: string[], cwd: string, label: string) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
  expect(result.status, `${label}\n${output}`).toBe(0);
}

test("fresh SDK artifacts satisfy an external strict NodeNext consumer with real peer declarations", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "supacloud-sdk-consumer-"));
  try {
    const dependencies = join(temporary, "node_modules");
    const installedPackage = join(dependencies, "@supacloud", "js");
    const dist = join(installedPackage, "dist");
    await mkdir(dist, { recursive: true });
    await mkdir(join(temporary, "test"));
    await mkdir(join(dependencies, "@supabase"), { recursive: true });
    await mkdir(join(dependencies, "@types"), { recursive: true });
    await copyFile(join(packageRoot, "package.json"), join(installedPackage, "package.json"));
    await copyFile(join(packageRoot, "test", "consumer-node-next.ts"), join(temporary, "test", "consumer-node-next.ts"));
    await symlink(join(packageRoot, "node_modules", "@supabase", "supabase-js"), join(dependencies, "@supabase", "supabase-js"));
    await symlink(join(packageRoot, "node_modules", "@types", "node"), join(dependencies, "@types", "node"));

    const consumerConfig = await configuration(join(packageRoot, "tsconfig.consumer.json"));
    const strictConfig = await configuration(join(packageRoot, "../../tsconfig.strict.json"));
    const options = record(consumerConfig.compilerOptions);
    const strict = record(strictConfig.compilerOptions);
    expect(options.strict).toBe(true);
    expect(options.skipLibCheck).toBe(false);
    expect(options.module).toBe("NodeNext");
    expect(options.moduleResolution).toBe("NodeNext");
    expect(options.types).toEqual(["node"]);
    expect(options.paths).toBeUndefined();
    expect(strict.paths).toBeUndefined();
    expect(consumerConfig.include).toEqual(["test/consumer-node-next.ts"]);
    expect(strict.exactOptionalPropertyTypes).toBe(true);
    expect(strict.noUncheckedIndexedAccess).toBe(true);
    await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await writeFile(join(temporary, "strict.json"), JSON.stringify(strictConfig));
    await writeFile(join(temporary, "tsconfig.json"), JSON.stringify({
      ...consumerConfig, extends: "./strict.json",
    }));

    const compiler = join(packageRoot, "node_modules", ".bin", "tsc");
    checkedCommand(compiler, [
      "-p", join(packageRoot, "tsconfig.json"), "--noEmit", "false",
      "--declaration", "--emitDeclarationOnly", "--outDir", dist,
    ], packageRoot, "Fresh SDK declaration generation failed");
    expect((await readFile(join(dist, "index.d.ts"), "utf8")).length).toBeGreaterThan(0);

    await symlink(join(packageRoot, "src"), join(installedPackage, "src"));
    checkedCommand("bun", ["run", "build:js"], installedPackage, "Fresh SDK JavaScript generation failed");
    const runtime: unknown = await import(pathToFileURL(join(dist, "index.js")).href);
    const exports = record(runtime);
    expect(typeof exports.createSupaCloudClient).toBe("function");
    expect(typeof exports.createSupaCloudOAuthFetch).toBe("function");
    expect(typeof exports.createSupaCloudWorkflowFetch).toBe("function");
    expect(typeof exports.createSupaCloudCommandFetch).toBe("function");
    expect(typeof exports.createSupaCloudArtifactFetch).toBe("function");
    expect(typeof exports.createSupaCloudTaskFetch).toBe("function");
    expect(typeof exports.SupaCloudTaskSubmitError).toBe("function");
    expect(typeof exports.SupaCloudTaskResponseError).toBe("function");
    expect(typeof exports.SupaCloudTaskAuthenticationError).toBe("function");

    const response = Response.json({ code: "synthetic-conflict" }, { status: 409 });
    const peer = createClient("https://consumer.example.test", "synthetic-consumer-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async () => response },
    });
    if (typeof exports.createSupaCloudClient !== "function") throw new Error("Expected SDK factory");
    const client: unknown = exports.createSupaCloudClient({
      supabase: peer, projectRef: "consumer", managementApiUrl: "https://management.example.test",
    });
    const tasks = record(client).tasks;
    if (typeof tasks !== "object" || tasks === null) throw new Error("Expected task client");
    const submit: unknown = Reflect.get(tasks, "submit");
    if (typeof submit !== "function") throw new Error("Expected task submission method");
    let failure: unknown;
    try { await Reflect.apply(submit, tasks, ["worker"]); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(FunctionsHttpError);
    if (!(failure instanceof FunctionsHttpError)) throw new Error("Expected shared official peer error");
    expect(failure.context).toBe(response);

    checkedCommand(compiler, [
      "-p", join(temporary, "tsconfig.json"), "--noEmit",
    ], temporary, "Fresh SDK consumer contract failed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);
