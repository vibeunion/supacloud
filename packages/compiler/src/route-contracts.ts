import type { ApplicationGraph, Diagnostic } from "./types";

/** Declaration coverage only; runtime decoding and database behavior require separate tests. */
export function inspectRouteContracts(graph: ApplicationGraph) {
  return graph.modules.flatMap((module) => module.controllers.flatMap((controller) =>
    controller.routes.map((route) => {
      const missing: Array<"body" | "params" | "query" | "response"> = [];
      if ((route.hasBodyBinding || route.handlerParams?.some((param) => param.kind === "body")) && !route.body) missing.push("body");
      if ((route.pathParams?.length || route.paramBindings?.length
        || route.handlerParams?.some((param) => param.kind === "param")
        || /:[^/]+/.test(`${controller.path}/${route.path}`)) && !route.params) missing.push("params");
      if ((route.queryBindings?.length || route.handlerParams?.some((param) => param.kind === "query")) && !route.query) missing.push("query");
      if (!route.response) missing.push("response");
      return {
        module: module.name, controller: controller.className, handler: route.handler,
        method: route.method, path: `${controller.path}${route.path}`, file: controller.file,
        missing,
      };
    }),
  ));
}

export function validateRouteContracts(graph: ApplicationGraph): Diagnostic[] {
  return inspectRouteContracts(graph).filter((route) => route.missing.length).map((route) => ({
    severity: "error",
    code: "route-contract-required",
    file: route.file,
    message: `${route.controller}.${route.handler} (${route.method} ${route.path}) is missing contract declarations: ${route.missing.join(", ")}.`,
    suggestion: "Declare the missing schemas and test actual request/response decoding. An opaque schema is not proof of validation.",
  }));
}
