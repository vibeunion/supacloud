import type { CommandExecutionCapabilities, CompiledExecutionManifest, Diagnostic } from "./types";
import { validateGraph } from "./validate";

/** Internal delivery error; the public validator returns structured diagnostics. */
export class ExecutionManifestValidationError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.errorCode}: ${diagnostic.message}`).join("\n"));
    this.name = "ExecutionManifestValidationError";
  }
}

/** Validate a compiler-produced plan against deployment declarations, never runtime attestations. */
export function validateExecutionManifest(
  plan: CompiledExecutionManifest,
  capabilities: CommandExecutionCapabilities = {},
): Diagnostic[] {
  if (plan.version !== 1 || plan.compiler !== "@supacloud/compiler") {
    throw new TypeError("Unsupported execution manifest. Recompile with the deployment compiler version.");
  }
  // Reuse the command validator so RPC branches, external reconciliation and
  // persistent-adapter requirements cannot drift between check and delivery.
  return validateGraph({
    externalTokens: [],
    modules: plan.modules.map((module) => ({
      name: module.name, className: module.className, file: "app.manifest.json", line: 1,
      imports: [], exports: [], providers: [], controllers: [], queries: [],
      commands: module.commands.map((command) => ({
        name: command.name, className: command.className,
        ...(command.permission === null ? {} : { permission: command.permission }),
        ...(command.adapter === null ? {} : { rpc: command.adapter }),
        ...(command.audit === null ? {} : { audit: command.audit }),
        ...(command.branches.length === 0 ? {} : { branches: command.branches }),
        transaction: command.transaction, idempotency: command.idempotency,
      })),
    })),
  }, {
    strict: true,
    commandCapabilities: {
      ...capabilities,
      permission: capabilities.permission ?? false,
      audit: capabilities.audit ?? false,
      idempotency: capabilities.idempotency ?? false,
      transaction: capabilities.transaction ?? false,
    },
  });
}
