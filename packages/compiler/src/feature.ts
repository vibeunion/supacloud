import type { Diagnostic, FeatureSpecNode, ModuleNode } from "./types";
import { joinRoutePaths } from "./util";

/** Validate the declaration itself and its bindings within the owning module. */
export function validateFeatureSpec(spec: FeatureSpecNode, module?: ModuleNode): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string): void => {
    diagnostics.push({ severity: "error", code, message,
      ...(spec.file === undefined ? {} : { file: spec.file }),
      ...(spec.line === undefined ? {} : { line: spec.line }),
    });
  };
  if (!spec.name.trim() || spec.states.length === 0 ||
    spec.states.some((state) => !state.trim()) || new Set(spec.states).size !== spec.states.length) {
    error("invalid-feature-states", "Feature name and states must be non-empty; states must be unique.");
  }
  if (spec.tenantField !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.tenantField)) {
    error("feature-tenant-boundary-invalid", `Feature ${spec.name} declares an unsafe tenant field.`);
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
    if (transition.persistence) {
      const persistence = transition.persistence;
      if (persistence.boundary === "database" &&
        (persistence.optimisticLock !== "required" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(persistence.versionField ?? "") ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(persistence.tenantField ?? "") ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(persistence.stateField ?? "") ||
          new Set([persistence.tenantField, persistence.versionField, persistence.stateField]).size !== 3 ||
          persistence.receipt !== "required" || persistence.reconciliation !== "none")) {
        error("feature-persistence-invalid", `Database transition ${transition.name} requires distinct safe tenant/version/state fields, optimistic locking, and a receipt, without reconciliation.`);
      }
      if (persistence.boundary === "database" && spec.tenantField !== persistence.tenantField) {
        error("feature-tenant-boundary-drift", `Database transition ${transition.name} tenant field must match Feature ${spec.name} tenantField.`);
      }
      if (persistence.boundary === "external" &&
        (persistence.optimisticLock !== "none" || persistence.versionField !== undefined || persistence.tenantField !== undefined ||
          persistence.stateField !== undefined ||
          persistence.receipt !== "required" || persistence.reconciliation !== "required")) {
        error("feature-persistence-invalid", `External transition ${transition.name} requires a receipt and reconciliation, without database optimistic locking.`);
      }
      if (persistence.boundary === "external" && !transition.job) {
        error("feature-job-unresolved", `External transition ${transition.name} must bind a reconciliation Job.`);
      }
      if (!transition.command) {
        error("feature-command-unresolved", `Persistent transition ${transition.name} must reference a command.`);
      }
      if (!transition.permission?.trim()) {
        error("feature-governance-drift", `Persistent transition ${transition.name} must declare a permission.`);
      }
    }
    if (!module) continue;
    if (transition.persistence?.boundary === "database") {
      for (const query of module.queries) {
        if (query.tenantScope !== "required") {
          error("feature-query-tenant-boundary", `Query ${query.className} in Feature ${spec.name} must declare tenantScope: "required".`);
        }
      }
      for (const job of module.jobs ?? []) {
        if (job.tenantScope !== "required") {
          error("feature-job-tenant-boundary", `Job ${job.className} in Feature ${spec.name} must declare tenantScope: "required".`);
        }
      }
    }
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
      if (transition.persistence) {
        if (transition.persistence.boundary === "database" && command.transaction !== "required") {
          error("feature-persistence-drift", `Database transition ${transition.name} requires command ${command.className} to declare transaction: "required".`);
        }
        if (command.tenantScope !== "required") {
          error("feature-command-tenant-boundary", `Command ${command.className} in Feature ${spec.name} must declare tenantScope: "required".`);
        }
        if (transition.persistence.boundary === "external" && command.transaction !== "none") {
          error("feature-persistence-drift", `External transition ${transition.name} requires command ${command.className} to declare transaction: "none".`);
        }
        if (command.idempotency !== "required" || !command.audit) {
          error("feature-persistence-drift", `Persistent transition ${transition.name} requires command ${command.className} to declare idempotency and audit.`);
        }
      }
    }
    if (transition.job) {
      const jobs = (module.jobs ?? []).filter((job) =>
        job.className === transition.job || job.name === transition.job);
      if (jobs.length !== 1) {
        error("feature-job-unresolved", `Transition ${transition.name} must reference exactly one Job in module ${module.name}.`);
      } else {
        const job = jobs[0]!;
        if (job.tenantScope !== "required") {
          error("feature-job-tenant-boundary", `Job ${job.className} in Feature ${spec.name} must declare tenantScope: "required".`);
        }
        if (job.idempotency !== "required") {
          error("feature-job-idempotency", `Job ${job.className} in Feature ${spec.name} must declare idempotency: "required".`);
        }
        if (job.mode === undefined) {
          error("feature-job-mode", `Job ${job.className} in Feature ${spec.name} must declare mode: "task" or "workflow".`);
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
  if (spec.transitions.some((transition) => !transition.permission)) {
    throw new Error("Spec-to-Code requires an explicit permission for every transition.");
  }
  const transitions = spec.transitions.map((transition, index) => ({
    ...transition,
    command: `Transition${index + 1}Command`,
  }));
  const errors = validateFeatureSpec({ ...spec, transitions });
  if (errors.length) throw new Error(errors.map((error) => error.message).join("\n"));
  if (transitions.some((transition) => transition.route)) {
    throw new Error("Generate the command slice first; existing HTTP routes require explicit schema and handler implementations.");
  }
  const sourceSpec = {
    name: spec.name, states: spec.states, tenantField: spec.tenantField ?? "tenant_id",
    transitions: Object.fromEntries(transitions.map((transition) => {
    const { name, ...options } = transition;
    const persistence = transition.persistence ?? {
      boundary: "database" as const, optimisticLock: "required" as const, versionField: "version",
      tenantField: "tenant_id", stateField: "state", receipt: "required" as const, reconciliation: "none" as const,
    };
    return [name, {
      ...options,
      persistence,
    }];
    })),
  };
  return [
    'import { Command, defineFeatureSlice, defineFeatureSpec } from "@supacloud/app";',
    "",
    `export const featureSpec = defineFeatureSpec(${JSON.stringify(sourceSpec, null, 2)});`,
    `export type FeatureState = typeof featureSpec.states[number];`,
    "",
    ...transitions.flatMap((transition) => [
      `@Command(${JSON.stringify({
        name: `${spec.name}.${transition.name}`, permission: transition.permission,
        transaction: transition.transaction ?? (transition.persistence?.boundary === "external" ? "none" : "required"),
        idempotency: transition.idempotency ?? "required",
        audit: transition.audit ?? `${spec.name}.${transition.name}`,
        tenantScope: "required",
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
