#!/usr/bin/env bun
import { modelMain, type ModelToolchain } from "@supacloud/db-zenstack/cli";
import { delimiter, dirname, join } from "node:path";
import { createRequire } from "node:module";

function packageFile(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}

const zenPackage = packageFile("@zenstackhq/cli/package.json");
const prismaEntry = packageFile("prisma/build/index.js");
const pgPackage = packageFile("pg/package.json");

// ZenStack resolves optional database drivers from the project root. Keep the
// driver private to this tooling package while preserving that upstream API.
process.env["NODE_PATH"] = [dirname(dirname(pgPackage)), process.env["NODE_PATH"]].filter(Boolean).join(delimiter);

const toolchain: ModelToolchain = {
  resolve(binary) {
    if (binary === "zen") {
      return { executable: process.execPath, args: [join(dirname(zenPackage), "bin", "cli")] };
    }
    return { executable: process.execPath, args: [prismaEntry] };
  },
};

try {
  await modelMain(process.argv.slice(2), toolchain);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Model command failed");
  process.exitCode = 1;
}
