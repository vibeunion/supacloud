#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planSqlImpact, type SqlDependencyEdge, type SqlMigrationSource } from "./sql-analysis";

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Expected configuration object");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Expected nonempty text");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("Expected string list");
  return value.map(text);
}

export async function runSqlImpactFile(path: string) {
  const absolute = resolve(path), directory = dirname(absolute);
  const raw: unknown = JSON.parse(await readFile(absolute, "utf8"));
  const config = object(raw);
  if (!Array.isArray(config.migrations)) throw new TypeError("Expected ordered migrations");
  const sources: SqlMigrationSource[] = [];
  for (const value of config.migrations) {
    const entry = object(value);
    sources.push({
      id: text(entry.id), owner: text(entry.owner),
      sql: await readFile(resolve(directory, text(entry.path)), "utf8"),
      ...(entry.dependencies === undefined ? {} : { dependencies: strings(entry.dependencies) }),
    });
  }
  const baseline = config.baseline === undefined ? [] : (() => {
    if (!Array.isArray(config.baseline)) throw new TypeError("Invalid baseline");
    return config.baseline.map((value) => {
      const entry = object(value), sha256 = text(entry.sha256);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError("Invalid baseline hash");
      return { id: text(entry.id), sha256 };
    });
  })();
  const edges: SqlDependencyEdge[] = config.catalogEdges === undefined ? [] : (() => {
    if (!Array.isArray(config.catalogEdges)) throw new TypeError("Invalid catalogEdges");
    return config.catalogEdges.map((value) => {
      const entry = object(value);
      return { dependent: text(entry.dependent), dependency: text(entry.dependency) };
    });
  })();
  const plan = await planSqlImpact(sources, baseline, edges);
  const catalogReview = config.catalogReview === undefined ? [] : strings(config.catalogReview);
  plan.review.push(...catalogReview);
  if (config.catalogEdges === undefined) plan.review.push("No live catalog snapshot supplied; verify deployed dependencies before applying");
  const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const approved = config.approvedDigest === digest;
  return { ...plan, digest, approved, ok: plan.errors.length === 0 && (plan.review.length === 0 || approved) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const path = args[0];
    if (!path || path.startsWith("-") || args.slice(1).some((arg) => arg !== "--check")) {
      throw new Error("Usage: supacloud-sql-impact <config.json> [--check]");
    }
    const result = await runSqlImpactFile(path);
    console.log(JSON.stringify(result, null, 2));
    if (args.includes("--check") && !result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SQL impact analysis failed");
    process.exitCode = 1;
  }
}
