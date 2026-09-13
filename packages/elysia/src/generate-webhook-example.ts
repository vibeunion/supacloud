import { fileURLToPath } from "node:url";
import { compileProject, type CompileOptions } from "@supacloud/compiler";

export const webhookCompileOptions = {
  rootDir: fileURLToPath(new URL("./fixtures/webhook/", import.meta.url)),
  outDir: fileURLToPath(new URL("./fixtures/webhook-generated/", import.meta.url)),
  strict: true, requireRouteContracts: true, allowRouteCommandBindings: false,
  commandCapabilities: {
    requirePersistentAdapters: true, permission: true,
    rpc: { webhookUpdate: { boundary: "database", audit: true, transaction: true, idempotency: true } },
  },
} satisfies CompileOptions;

if (import.meta.main) {
  const result = await compileProject(webhookCompileOptions);
  for (const diagnostic of result.diagnostics) console.error(diagnostic);
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exitCode = 1;
}
