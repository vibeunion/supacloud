import type { ApplicationGraph, Diagnostic, EffectCompilerOptions, RouteNode } from "./types";
import { COMPILER_DIAGNOSTIC_CODES } from "./validate";
import { featureTransitionForRoute } from "./feature";

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
        if (route.effectMode === "simple") {
          const featureTransition = featureTransitionForRoute(module, controller, route);
          const commandRef = route.command ?? featureTransition?.command;
          if (commandRef !== undefined) {
            diagnostics.push(diagnostic(
              "effect-contract-required",
              `Route ${label} cannot use effect: false when it enters command ${commandRef}.`,
              controller.file,
              "Keep Effect enabled for durable commands; effect: false is only for simple non-command routes.",
            ));
          }
          continue;
        }
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
        if (effect.retry === undefined && options.requireRetryPolicy !== false) {
          diagnostics.push(diagnostic(
            "effect-retry-required",
            `Route ${label} declares an Effect contract but does not declare retry.`,
            controller.file,
            'Set effect.retry to "none". That is the required default; use "explicit" only with maxAttempts and a retryable 5xx allow-list.',
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
        if (effect.retry === "explicit") {
          const featureTransition = featureTransitionForRoute(module, controller, route);
          const commandRef = route.command ?? featureTransition?.command;
          const command = commandRef === undefined ? undefined
            : commands.get(commandRef) ?? [...commands.values()].find((candidate) => candidate.name === commandRef);
          if (command && command.idempotency !== "required") {
            diagnostics.push(diagnostic(
              "effect-command-retry-forbidden",
              `Route ${label} enables explicit Effect retry for non-idempotent command "${command.name}".`,
              controller.file,
              "Set command idempotency to \"required\" or use effect.retry: \"none\".",
            ));
          }
          const retryable = (effect.errors ?? []).filter((entry) => entry.retryable === true);
          if (retryable.length === 0) {
            diagnostics.push(diagnostic(
              "effect-retry-target-required",
              `Route ${label} enables explicit Effect retry without a transient failure allow-list.`,
              controller.file,
              "Mark only 5xx failures that did not commit with retryable: true, or use effect.retry: \"none\".",
            ));
          }
        }
        for (const entry of effect.errors ?? []) {
          if (entry.retryable !== true) continue;
          const transient = effect.retry === "explicit"
            && entry.outcomeUnknown !== true
            && entry.statusFromError !== true
            && entry.status >= 500
            && entry.status <= 599;
          if (!transient) {
            diagnostics.push(diagnostic(
              "effect-retryable-invalid",
              `Route ${label} marks "${entry.tag}" retryable, but in-process retry is only for declared 5xx failures that are not outcome-unknown.`,
              controller.file,
              "Remove retryable, or keep it on a 5xx mapping with retry: \"explicit\" and without outcomeUnknown or statusFromError.",
            ));
          }
        }
      }
    }
  }
  return diagnostics;
}

/** A retrying job must replay the same request without duplicating a write. */
export function validateJobPolicies(graph: ApplicationGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const module of graph.modules) {
    for (const job of module.jobs ?? []) {
      if (job.maxAttempts !== undefined && job.maxAttempts > 1 && job.idempotency !== "required") {
        diagnostics.push(diagnostic(
          "job-retry-idempotency-required",
          `Job ${job.name} (${job.className}) enables ${job.maxAttempts} attempts without an idempotency contract.`,
          module.file,
          "Use idempotency: \"required\" with a durable receipt, or set maxAttempts: 1.",
        ));
      }
    }
  }
  return diagnostics;
}
