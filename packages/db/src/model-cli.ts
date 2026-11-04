#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compileModel, modelProcess } from "./model";

export async function modelMain(argv: string[]): Promise<void> {
  const [command, ...flags] = argv;
  if (!["generate", "check", "diff", "pull"].includes(command ?? "")) throw new Error("Usage: supacloud-model generate|check|diff|pull [--schema file] [--output dir] [--candidate file]");
  const options = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index], value = flags[index + 1];
    if (!key || !["--schema", "--output", "--candidate"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid model command option");
    options.set(key, value);
  }
  const schema = resolve(options.get("--schema") ?? "zenstack/schema.zmodel");
  const output = resolve(options.get("--output") ?? "zenstack/generated");
  if (command === "generate" || command === "check") {
    if (options.has("--candidate")) throw new Error("--candidate is only supported by diff and pull");
    await compileModel(schema, output, command === "check");
    return;
  }
  if (command !== "diff" && command !== "pull") throw new Error("Invalid model command");
  const databaseUrl = process.env["SUPACLOUD_MODEL_DATABASE_URL"];
  if (!databaseUrl) throw new Error("Select a read-only database explicitly with SUPACLOUD_MODEL_DATABASE_URL");
  const rawCandidate = options.get("--candidate");
  if (!rawCandidate) throw new Error("Supply a fresh --candidate file; review it before promotion into migration history");
  const candidate = resolve(rawCandidate);
  if (existsSync(candidate) || candidate === schema) throw new Error("Candidate already exists; refusing to overwrite maintained files");
  if (candidate === output || candidate.startsWith(output + sep)
    || !candidate.endsWith(command === "diff" ? ".sql" : ".zmodel")) throw new Error("Select a candidate file outside generated contracts with the correct extension");
  // Validate the datasource even for pull so an embedded URL cannot override explicit selection.
  if (command === "diff") await compileModel(schema, output, true);
  else {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const validation = await mkdtemp(resolve(tmpdir(), "supacloud-model-pull-"));
    try { await compileModel(schema, validation); } finally { await rm(validation, { recursive: true, force: true }); }
  }
  const operation = modelProcess(command, schema, output, candidate);
  const binary = resolve("node_modules/.bin", operation.binary);
  if (!existsSync(binary)) throw new Error(`Install the pinned ${operation.binary} tooling in the application`);
  await mkdir(dirname(candidate), { recursive: true });
  const child = Bun.spawn([binary, ...operation.args], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ["ignore", "inherit", "inherit"],
  });
  if (await child.exited !== 0) throw new Error("Model candidate generation failed; nothing was applied");
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { await modelMain(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Model command failed"); process.exitCode = 1; }
}
