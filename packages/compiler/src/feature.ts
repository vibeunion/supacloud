import type { Diagnostic, FeatureSpecNode, ModuleNode } from "./types";
import { joinRoutePaths } from "./util";

/** Validate the declaration itself and its bindings within the owning module. */
export function validateFeatureSpec(spec: FeatureSpecNode, module?: ModuleNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string): void => {
    diagnostics.push({
      severity: "error", code, message,
      ...(spec.file === undefined ? {} : { file: spec.file }),
      ...(spec.line === undefined ? {} : { line: spec.line }),
    });
  };
  if (!spec.name.trim() || spec.states.length === 0 ||
    spec.states.some((state) => !state.trim()) || new Set(spec.states).size !== spec.states.length) {
    error("invalid-feature-states", "Feature name and states must be non-empty; states must be unique.");
  }
  const names = new Set<string>();
  for (const transition of spec.transitions) {
    if (!transition.name.trim() || names.has(transition.name)) {
      error("duplicate-feature-transition", `Feature ${spec.name} has duplicate/empty transition '${transition.name}'.`);
    }
    names.add(transition.name);
    if (!spec.states.includes(transition.from) || !spec.states.includes(transition.to)) {
      error("invalid-feature-transition", `Transition ${transition.name} references an undeclared state.`);
    }
    if (transition.permission !== undefined && !transition.permission.trim()) {
      error("feature-governance-drift", `Transition ${transition.name} declares an empty permission.`);
    }
    if (!module) continue;
    const commands = module.commands.filter((command) =>
      command.className === transition.command || command.name === transition.command);
    const command = commands[0];
    if (transition.command && commands.length !== 1) {
      error("feature-command-unresolved", `Transition ${transition.name} must reference exactly one command in module ${module.name}.`);
    }
    if (!transition.command && [transition.permission, transition.transaction, transition.idempotency, transition.audit].some((value) => value !== undefined)) {
      error("feature-command-unresolved", `Transition ${transition.name} declares governance without a command binding.`);
    }
    if (command) {
      for (const key of ["permission", "transaction", "idempotency", "audit"] as const) {
        if (transition[key] !== undefined && transition[key] !== command[key]) {
          error("feature-governance-drift", `Transition ${transition.name} ${key} differs from command ${command.className}.`);
        }
      }
    }
    if (transition.route) {
      const routes = module.controllers.flatMap((controller) => controller.routes.filter((route) =>
        `${route.method} ${joinRoutePaths(controller.path, route.path)}` === transition.route));
      if (routes.length !== 1) {
        error("feature-route-unresolved", `Transition ${transition.name} must reference exactly one route '${transition.route}' in module ${module.name}.`);
      } else if (command && routes[0]?.command !== command.className) {
        error("feature-route-drift", `Route ${transition.route} is not bound to ${command.className}.`);
      }
    }
  }
  return diagnostics;
}

/**
 * Generate an editable feature slice scaffold, never a fake business implementation.
 * execute() fails closed until the application's persistence logic is supplied.
 */
export function generateFeatureSource(spec: FeatureSpecNode): string {
  const errors = validateFeatureSpec(spec);
  if (errors.length) throw new Error(errors.map((error) => error.message).join("\n"));
  if (spec.transitions.some((transition) => !transition.permission)) {
    throw new Error("Spec-to-Code requires an explicit permission for every transition.");
  }
  const transitions = spec.transitions.map((transition, index) => ({
    ...transition,
    command: `Transition${index + 1}Command`,
  }));
  if (transitions.some((transition) => transition.route)) {
    throw new Error("Generate the command slice first; existing HTTP routes require explicit schema and handler implementations.");
  }
  const sourceSpec = { name: spec.name, states: spec.states, transitions: Object.fromEntries(transitions.map((transition) => {
    const { name, ...options } = transition;
    return [name, options];
  })) };
  return [
    'import { Command, defineFeatureSlice, defineFeatureSpec } from "@supacloud/app";',
    "",
    `export const featureSpec = defineFeatureSpec(${JSON.stringify(sourceSpec, null, 2)});`,
    `export type FeatureState = typeof featureSpec.states[number];`,
    "",
    ...transitions.flatMap((transition) => [
      `@Command(${JSON.stringify({
        name: `${spec.name}.${transition.name}`, permission: transition.permission,
        transaction: transition.transaction ?? "none", idempotency: transition.idempotency ?? "none", audit: transition.audit,
      })})`,
      `export class ${transition.command} {`,
      `  execute(state: FeatureState): never {`,
      `    if (state !== ${JSON.stringify(transition.from)}) throw new Error("Invalid transition state");`,
      `    throw new Error(${JSON.stringify(`Implement ${spec.name}.${transition.name}: persist state ${transition.to}`)});`,
      "  }",
      "",
    ]),
    "export const FeatureSlice = defineFeatureSlice({",
    `  name: ${JSON.stringify(spec.name)},`,
    '  tags: ["type:feature"],',
    "  spec: featureSpec,",
    `  providers: [${transitions.map((transition) => transition.command).join(", ")}],`,
    "});",
    "",
  ].join("\n");
}
