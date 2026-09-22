import type { ApplicationGraph } from "./types";
import { joinRoutePaths } from "./util";

export interface ContractManifest {
  version: 1;
  commands: Array<{
    name: string;
    className: string;
    module: string;
    permission?: string;
    rpc?: string;
    transaction: "required" | "none";
    idempotency: "required" | "none";
    auditEvent?: string;
  }>;
  queries: Array<{ name: string; className: string; module: string }>;
  routes: Array<{
    method: string;
    path: string;
    module: string;
    controller: string;
    handler: string;
    command?: string;
    permission?: string;
    requestSchemas: Partial<Record<"body" | "params" | "query" | "headers" | "cookie", string>>;
    responseSchema?: string;
    evidence?: string;
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
  const routes: ContractManifest["routes"] = [];
  const permissions = new Set<string>();
  const rpc: ContractManifest["rpc"] = [];
  const events: ContractManifest["events"] = [];
  const fixtures = new Set<string>();

  for (const module of graph.modules) {
    for (const command of module.commands) {
      if (command.permission) permissions.add(command.permission);
      if (command.rpc) rpc.push({ command: command.name, adapter: command.rpc });
      if (command.audit) events.push({ name: command.audit, source: "command.audit", command: command.name });
      commands.push({
        name: command.name,
        className: command.className,
        module: module.name,
        ...(command.permission === undefined ? {} : { permission: command.permission }),
        ...(command.rpc === undefined ? {} : { rpc: command.rpc }),
        transaction: command.transaction,
        idempotency: command.idempotency,
        ...(command.audit === undefined ? {} : { auditEvent: command.audit }),
      });
    }
    for (const query of module.queries) {
      queries.push({ name: query.name, className: query.className, module: module.name });
    }
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const command = route.command
          ? module.commands.find((candidate) => candidate.className === route.command)
          : undefined;
        if (command?.permission) permissions.add(command.permission);
        if (route.contract?.evidence) fixtures.add(route.contract.evidence);
        routes.push({
          method: route.method,
          path: joinRoutePaths(controller.path, route.path),
          module: module.name,
          controller: controller.className,
          handler: route.handler,
          ...(route.command === undefined ? {} : { command: route.command }),
          ...(command?.permission === undefined ? {} : { permission: command.permission }),
          requestSchemas: Object.fromEntries(
            (["body", "params", "query", "headers", "cookie"] as const)
              .flatMap((key) => route[key] === undefined ? [] : [[key, route[key]] as const]),
          ),
          ...(route.response === undefined ? {} : { responseSchema: route.response }),
          ...(route.contract?.evidence === undefined ? {} : { evidence: route.contract.evidence }),
        });
      }
    }
  }

  commands.sort((left, right) => left.name.localeCompare(right.name));
  queries.sort((left, right) => left.name.localeCompare(right.name));
  routes.sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
  rpc.sort((left, right) => left.command.localeCompare(right.command));
  events.sort((left, right) => left.name.localeCompare(right.name));

  return {
    version: 1,
    commands,
    queries,
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
