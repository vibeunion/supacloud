#!/usr/bin/env bun
import { compileModel } from "@supacloud/db-zenstack/model";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type RemoteCandidateResponse = {
  readonly candidate?: unknown;
  readonly warnings?: unknown;
  readonly error?: unknown;
};

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function schemas(value: string | undefined): string {
  const selected = (value ?? "public").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!selected.length || selected.some((entry) => !/^[a-z_][a-z0-9_$]*$/i.test(entry))) {
    throw new Error("--schema must contain PostgreSQL identifiers separated by commas");
  }
  return selected.join(",");
}

function requireRemoteContext(): { baseUrl: string; token: string; ref: string } {
  const baseUrl = process.env["SUPACLOUD_API_URL"]?.replace(/\/$/, "");
  const token = process.env["SUPACLOUD_API_TOKEN"];
  const ref = process.env["SUPACLOUD_PROJECT_REF"];
  if (!baseUrl || !token || !ref) {
    throw new Error("Remote model pull requires SUPACLOUD_API_URL, SUPACLOUD_API_TOKEN and SUPACLOUD_PROJECT_REF");
  }
  return { baseUrl, token, ref };
}

/** Pull a review-only model candidate through the Management API. */
export async function remotePull(args: readonly string[]): Promise<void> {
  const candidateArg = option(args, "--candidate");
  if (!candidateArg || !candidateArg.endsWith(".zmodel")) {
    throw new Error("Remote model pull requires a fresh --candidate <file.zmodel>");
  }
  const candidate = resolve(candidateArg);
  if (existsSync(candidate)) throw new Error(`Refusing to overwrite model candidate: ${candidateArg}`);
  const context = requireRemoteContext();
  const schema = schemas(option(args, "--schema"));
  const response = await fetch(
    `${context.baseUrl}/v1/projects/${encodeURIComponent(context.ref)}/pg-meta/model-candidate?schema=${encodeURIComponent(schema)}`,
    { headers: { Authorization: `Bearer ${context.token}`, Accept: "application/json" } },
  );
  const body = await response.json().catch(() => null) as RemoteCandidateResponse | null;
  if (!response.ok || !body || typeof body.candidate !== "string") {
    const detail = body && typeof body.error === "string" ? body.error : "invalid response";
    throw new Error(`Remote model pull failed (${response.status}): ${detail}`);
  }
  await mkdir(dirname(candidate), { recursive: true });
  await Bun.write(candidate, body.candidate);
  const warnings = Array.isArray(body.warnings)
    ? body.warnings.filter((value): value is string => typeof value === "string")
    : [];
  console.log(`Wrote a remote model candidate to ${candidateArg}; the database connection remained in the Management API.`);
  for (const warning of warnings) console.warn(`Warning: ${warning}`);
}

async function compileLocal(command: "generate" | "check", args: readonly string[]): Promise<void> {
  if (args.includes("--remote")) throw new Error("--remote is only supported by supacloud-model pull");
  if (args.includes("--candidate")) throw new Error("--candidate is only supported by supacloud-model pull");
  const schema = resolve(option(args, "--schema") ?? "zenstack/schema.zmodel");
  const output = resolve(option(args, "--output") ?? "zenstack/generated");
  if (!existsSync(schema)) throw new Error(`Maintain ${schema} before ${command}; adopt an existing database with supacloud-model pull first`);
  await compileModel(schema, output, command === "check");
}

export async function runModelCommand(args: readonly string[]): Promise<void> {
  const [command, ...flags] = args;
  switch (command) {
    case "generate":
    case "check":
      await compileLocal(command, flags);
      return;
    case "pull":
      await remotePull(flags);
      return;
    case "diff":
      throw new Error("supacloud-model diff no longer opens a database connection; use `supacloud db plan --dir <migrations>` for a remote migration plan");
    default:
      throw new Error("Usage: supacloud-model generate|check|pull [--schema file] [--output dir] [--candidate file]");
  }
}

if (import.meta.main) {
  try {
    await runModelCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Model command failed");
    process.exitCode = 1;
  }
}
