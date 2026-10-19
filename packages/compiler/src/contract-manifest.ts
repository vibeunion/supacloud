import type { ApplicationGraph, FeatureDatabaseSourceNode, FeaturePersistenceNode } from "./types";
import { joinRoutePaths } from "./util";
import { featureTransitionForRoute } from "./feature";

export interface ContractManifest {
  version: 1;
  commands: Array<{
    name: string;
    className: string;
    module: string;
    permission?: string;
    rpc?: string;
    branches?: Array<{
      when: string;
      adapter: string;
      transaction: "required" | "none";
      idempotency: "required" | "none";
      auditEvent?: string;
      boundary?: "database" | "external";
    }>;
    transaction: "required" | "none";
    idempotency: "required" | "none";
    tenantScope?: "required" | "none";
    auditEvent?: string;
  }>;
  queries: Array<{
    name: string;
    className: string;
    module: string;
    tenantScope?: "required" | "none";
  }>;
  jobs: Array<{
    name: string;
    className: string;
    module: string;
    input?: string;
    inputKind?: "opaque" | "declared";
    output?: string;
    outputKind?: "opaque" | "declared";
    mode?: "task" | "workflow";
    idempotency?: "required" | "none";
    tenantScope?: "required" | "none";
  }>;
  features: Array<{
    name: string;
    states: string[];
    database?: FeatureDatabaseSourceNode;
    tenantField?: string;
    transitions: Array<{
      name: string;
      from: string;
      to: string;
      permission?: string;
      command?: string;
      route?: string;
      routeBinding?: "command" | "controller";
      transaction?: "required" | "none";
      idempotency?: "required" | "none";
      audit?: string;
      job?: string;
      invalidateTags?: string[];
      jobDetails?: {
        name: string;
        className: string;
        input?: string;
        inputKind?: "opaque" | "declared";
        output?: string;
        outputKind?: "opaque" | "declared";
        mode?: "task" | "workflow";
        idempotency?: "required" | "none";
        tenantScope?: "required" | "none";
      };
      persistence?: FeaturePersistenceNode;
    }>;
  }>;
  routes: Array<{
    method: string;
    path: string;
    module: string;
    controller: string;
    handler: string;
    command?: string;
    permission?: string;
    idempotency?: "required" | "none";
    tags?: string[];
    requestSchemas: Partial<Record<"body" | "params" | "query" | "headers" | "cookie", string>>;
    responseSchema?: string;
    /** Status-aware response schemas; legacy responseSchema remains for compatibility. */
    responseSchemas?: Record<string, string>;
    evidence?: string;
    parse?: "none";
    allowDeleteBody?: true;
  }>;
  permissions: string[];
  rpc: Array<{ command: string; adapter: string }>;
  events: Array<{ name: string; source: string; command: string }>;
  fixtures: string[];
  artifacts: {
    client: boolean;
    openapi: boolean;
    permissions: boolean;
    sdk: "generated-client";
    openapiDocument: "generated";
    permissionManifest: "generated";
  };
}

export function buildContractManifest(
  graph: ApplicationGraph,
  artifacts: Pick<ContractManifest["artifacts"], "client" | "openapi" | "permissions">,
): ContractManifest {
  const commands: ContractManifest["commands"] = [];
  const queries: ContractManifest["queries"] = [];
  const jobs: ContractManifest["jobs"] = [];
  const features: ContractManifest["features"] = [];
  const routes: ContractManifest["routes"] = [];
  const permissions = new Set<string>();
  const rpc: ContractManifest["rpc"] = [];
  const events: ContractManifest["events"] = [];
  const fixtures = new Set<string>();

  for (const module of graph.modules) {
    for (const command of module.commands) {
      if (command.permission) permissions.add(command.permission);
      if (command.rpc) rpc.push({ command: command.name, adapter: command.rpc });
      for (const branch of command.branches ?? []) {
        rpc.push({ command: `${command.name} [${branch.when}]`, adapter: branch.rpc });
      }
      if (command.audit) events.push({ name: command.audit, source: "command.audit", command: command.name });
      for (const branch of command.branches ?? []) {
        if (branch.audit) events.push({ name: branch.audit, source: "command.branch.audit", command: command.name });
      }
      commands.push({
        name: command.name,
        className: command.className,
        module: module.name,
        ...(command.permission === undefined ? {} : { permission: command.permission }),
        ...(command.rpc === undefined ? {} : { rpc: command.rpc }),
        ...(command.branches === undefined ? {} : {
          branches: command.branches.map((branch) => ({
            when: branch.when,
            adapter: branch.rpc,
            transaction: branch.transaction,
            idempotency: branch.idempotency,
            ...(branch.audit === undefined ? {} : { auditEvent: branch.audit }),
            ...(branch.boundary === undefined ? {} : { boundary: branch.boundary }),
          })),
        }),
        transaction: command.transaction,
        idempotency: command.idempotency,
        ...(command.tenantScope === undefined ? {} : { tenantScope: command.tenantScope }),
        ...(command.audit === undefined ? {} : { auditEvent: command.audit }),
      });
    }
    for (const query of module.queries) {
      queries.push({
        name: query.name, className: query.className, module: module.name,
        ...(query.permission === undefined ? {} : { permission: query.permission }),
        ...(query.tenantScope === undefined ? {} : { tenantScope: query.tenantScope }),
      });
    }
    for (const job of module.jobs ?? []) {
      jobs.push({
        name: job.name,
        className: job.className,
        module: module.name,
        ...(job.input === undefined ? {} : { input: job.input }),
        ...(job.schemaKinds?.input === undefined ? {} : { inputKind: job.schemaKinds.input }),
        ...(job.output === undefined ? {} : { output: job.output }),
        ...(job.schemaKinds?.output === undefined ? {} : { outputKind: job.schemaKinds.output }),
        ...(job.mode === undefined ? {} : { mode: job.mode }),
        ...(job.idempotency === undefined ? {} : { idempotency: job.idempotency }),
        ...(job.tenantScope === undefined ? {} : { tenantScope: job.tenantScope }),
      });
    }
    if (module.featureSpec) {
      features.push({
        name: module.featureSpec.name,
        states: [...module.featureSpec.states],
        ...(module.featureSpec.database === undefined ? {} : { database: module.featureSpec.database }),
        ...(module.featureSpec.tenantField === undefined ? {} : { tenantField: module.featureSpec.tenantField }),
        transitions: module.featureSpec.transitions.map((transition) => {
          const job = transition.job === undefined ? undefined
            : (module.jobs ?? []).find((candidate) => candidate.className === transition.job || candidate.name === transition.job);
          return {
            name: transition.name,
            from: transition.from,
            to: transition.to,
            ...(transition.permission === undefined ? {} : { permission: transition.permission }),
            ...(transition.command === undefined ? {} : { command: transition.command }),
            ...(transition.route === undefined ? {} : { route: transition.route }),
            ...(transition.routeBinding === undefined ? {} : { routeBinding: transition.routeBinding }),
            ...(transition.transaction === undefined ? {} : { transaction: transition.transaction }),
            ...(transition.idempotency === undefined ? {} : { idempotency: transition.idempotency }),
            ...(transition.audit === undefined ? {} : { audit: transition.audit }),
            ...(transition.job === undefined ? {} : { job: transition.job }),
            ...(transition.invalidateTags === undefined ? {} : { invalidateTags: [...transition.invalidateTags] }),
            ...(job === undefined ? {} : {
              jobDetails: {
                name: job.name,
                className: job.className,
                ...(job.input === undefined ? {} : { input: job.input }),
                ...(job.schemaKinds?.input === undefined ? {} : { inputKind: job.schemaKinds.input }),
                ...(job.output === undefined ? {} : { output: job.output }),
                ...(job.schemaKinds?.output === undefined ? {} : { outputKind: job.schemaKinds.output }),
                ...(job.mode === undefined ? {} : { mode: job.mode }),
                ...(job.idempotency === undefined ? {} : { idempotency: job.idempotency }),
                ...(job.tenantScope === undefined ? {} : { tenantScope: job.tenantScope }),
              },
            }),
            ...(transition.persistence === undefined ? {} : { persistence: transition.persistence }),
          };
        }),
      });
    }
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const command = route.command
          ? module.commands.find((candidate) =>
            candidate.className === route.command || candidate.name === route.command)
          : undefined;
        const featureTransition = featureTransitionForRoute(module, controller, route);
        const featureCommand = featureTransition?.command === undefined
          ? undefined
          : module.commands.find((candidate) =>
            candidate.className === featureTransition.command || candidate.name === featureTransition.command);
        const governedCommand = command ?? featureCommand;
        const effectiveCommand = route.command ?? featureTransition?.command;
        const idempotency = route.idempotency
          ?? command?.idempotency
          ?? featureTransition?.idempotency;
        if (governedCommand?.permission) permissions.add(governedCommand.permission);
        if (route.contract?.evidence) fixtures.add(route.contract.evidence);
        routes.push({
          method: route.method,
          path: joinRoutePaths(controller.path, route.path),
          module: module.name,
          controller: controller.className,
          handler: route.handler,
          ...(effectiveCommand === undefined ? {} : { command: effectiveCommand }),
          ...(governedCommand?.permission === undefined ? {} : { permission: governedCommand.permission }),
          ...(idempotency === undefined ? {} : { idempotency }),
          ...(route.tags === undefined ? {} : { tags: [...route.tags] }),
          requestSchemas: Object.fromEntries(
            (["body", "params", "query", "headers", "cookie"] as const)
              .flatMap((key) => route[key] === undefined ? [] : [[key, route[key]] as const]),
          ),
          ...(route.response === undefined ? {} : { responseSchema: route.response }),
          ...(route.responses === undefined ? {} : {
            responseSchemas: Object.fromEntries(
              Object.entries(route.responses).sort(([left], [right]) => left.localeCompare(right)),
            ),
          }),
          ...(route.contract?.evidence === undefined ? {} : { evidence: route.contract.evidence }),
          ...(route.parse === undefined ? {} : { parse: route.parse }),
          ...(route.allowDeleteBody === undefined ? {} : { allowDeleteBody: route.allowDeleteBody }),
        });
      }
    }
  }

  commands.sort((left, right) => left.name.localeCompare(right.name));
  queries.sort((left, right) => left.name.localeCompare(right.name));
  jobs.sort((left, right) => left.name.localeCompare(right.name));
  features.sort((left, right) => left.name.localeCompare(right.name));
  routes.sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
  rpc.sort((left, right) => left.command.localeCompare(right.command));
  events.sort((left, right) => left.name.localeCompare(right.name));

  return {
    version: 1,
    commands,
    queries,
    jobs,
    features,
    routes,
    permissions: [...permissions].sort(),
    rpc,
    events,
    fixtures: [...fixtures].sort(),
    artifacts: {
      ...artifacts,
      sdk: "generated-client",
      openapiDocument: "generated",
      permissionManifest: "generated",
    },
  };
}
