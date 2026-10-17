import { parseArgs } from "node:util";
import { planFrontendArchiveCutover, prepareFrontendArchiveCutover } from "./lib/frontend-archive-cutover";

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  const { values, tokens } = parseArgs({
    args: Bun.argv.slice(2), allowPositionals: false, strict: true, tokens: true,
    options: {
      source: { type: "string" }, "project-ref": { type: "string" },
      "deployment-id": { type: "string" }, output: { type: "string" },
      "plan-digest": { type: "string" }, prepare: { type: "boolean" }, help: { type: "boolean" },
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}`);
    seen.add(token.name);
  }
  if (values.help) {
    console.log("frontend-archive-cutover --source <frozen-copy> --project-ref <ref> --deployment-id <id>\n"
      + "  --prepare --plan-digest <reviewed-sha256> --output <new-private-directory>");
    return;
  }
  const input = {
    sourceDirectory: required(values.source, "source"),
    projectRef: required(values["project-ref"], "project-ref"),
    deploymentId: required(values["deployment-id"], "deployment-id"),
  };
  if (!values.prepare && (values.output !== undefined || values["plan-digest"] !== undefined)) {
    throw new Error("--output and --plan-digest require --prepare");
  }
  const result = values.prepare
    ? await prepareFrontendArchiveCutover({
      ...input,
      outputDirectory: required(values.output, "output"),
      approvedDigest: required(values["plan-digest"], "plan-digest"),
    })
    : await planFrontendArchiveCutover(input);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Archive cutover failed");
  process.exitCode = 1;
});
