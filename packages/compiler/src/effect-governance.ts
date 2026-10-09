import type { ApplicationGraph, Diagnostic, EffectCompilerOptions, RouteNode } from "./types";
import { COMPILER_DIAGNOSTIC_CODES } from "./validate";

function diagnostic(
  code: string,
  message: string,
  file: string | undefined,
  suggestion?: string,
): Diagnostic {
  const metadata = COMPILER_DIAGNOSTIC_CODES[code];
  return {
    severity: "error",
    code,
    message,
    ...(file === undefined ? {} : { file }),
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(metadata ? { errorCode: metadata.code, docsUrl: metadata.docsUrl } : {}),
  };
}

function routeLabel(route: RouteNode, controllerPath: string): string {
  return `${route.method} ${controllerPath}${route.path}`;
}

/** Validates the static Effect contract without inspecting Effect runtime internals. */
export function validateEffectPolicies(
  graph: ApplicationGraph,
  options: EffectCompilerOptions = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const module of graph.modules) {
    const commands = new Map(module.commands.map((command) => [command.className, command]));
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const label = routeLabel(route, controller.path);
        if (options.requireRouteEffects && route.effect === undefined) {
          diagnostics.push(diagnostic(
            "effect-contract-required",
            `Route ${label} must declare an Effect contract.`,
            controller.file,
            "Add effect: { dependencies: [...], errors: [...], retry: \"none\" } to the route options.",
          ));
          continue;
        }
        const effect = route.effect;
        if (effect === undefined) continue;
        if (options.requireErrorMappings && effect.errors === undefined) {
          diagnostics.push(diagnostic(
            "effect-error-mapping-required",
            `Route ${label} declares an Effect contract without public error mappings.`,
            controller.file,
            "Map every expected domain failure to a stable HTTP status and public code.",
          ));
        }
        if (options.requireDependencies && effect.dependencies === undefined) {
          diagnostics.push(diagnostic(
            "effect-dependencies-required",
            `Route ${label} declares an Effect contract without dependencies.`,
            controller.file,
            "Declare the logical services required by the Effect environment.",
          ));
        }
        if (effect.retry === "explicit" && effect.maxAttempts === undefined) {
          diagnostics.push(diagnostic(
            "invalid-effect-retry",
            `Route ${label} enables explicit Effect retry without maxAttempts.`,
            controller.file,
            "Declare a positive maxAttempts value including the initial attempt.",
          ));
        }
        if (route.command && effect.retry === "explicit") {
          const command = commands.get(route.command);
          if (command && command.idempotency !== "required") {
            diagnostics.push(diagnostic(
              "effect-command-retry-forbidden",
              `Route ${label} enables explicit Effect retry for non-idempotent command "${command.name}".`,
              controller.file,
              "Set command idempotency to \"required\" or use effect.retry: \"none\".",
            ));
          }
        }
      }
    }
  }
  return diagnostics;
}
