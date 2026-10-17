import { resolve } from "node:path";
import { buildCandidate } from "../../../../scripts/elysia-aot-ab";

const [mode, directory] = Bun.argv.slice(2);
if ((mode !== "plain" && mode !== "aot") || !directory) throw new Error("Expected mode and output directory");
try {
  await buildCandidate("management-api", mode, directory, {
    appEntry: resolve(import.meta.dir, "aot-http-parity-app.ts"),
    entry: resolve(import.meta.dir, "aot-http-parity-entry.ts"),
  });
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
