import type { ApplicationGraph, Diagnostic } from "./types";

/** Declaration coverage only; runtime decoding and database behavior require separate tests. */
export function inspectRouteContracts(graph: ApplicationGraph) {
  return graph.modules.flatMap((module) => module.controllers.flatMap((controller) =>
    controller.routes.map((route) => {
      const missing: Array<"body" | "params" | "query" | "headers" | "cookie" | "response"> = [];
      if ((route.hasBodyBinding || route.handlerParams?.some((param) => param.kind === "body")) && !route.body) missing.push("body");
      if ((route.pathParams?.length || route.paramBindings?.length
        || route.handlerParams?.some((param) => param.kind === "param")
        || /:[^/]+/.test(`${controller.path}/${route.path}`)) && !route.params) missing.push("params");
      if ((route.queryBindings?.length || route.handlerParams?.some((param) => param.kind === "query")) && !route.query) missing.push("query");
      if (route.handlerParams?.some((param) => param.kind === "headers") && !route.headers) missing.push("headers");
      if (route.handlerParams?.some((param) => param.kind === "cookie") && !route.cookie) missing.push("cookie");
      if (!route.response && !route.responses && !["binary", "stream"].includes(route.contract?.response ?? "")) missing.push("response");
      const body = !route.body ? "missing" : route.contract?.body === "domain" ? "domain"
        : route.schemaKinds?.body === "opaque" ? "opaque" : "framework-declared";
      const response = route.contract?.response ?? (route.nativeResponse ? "native-response-unclassified"
        : route.schemaKinds?.response === "opaque" ? "opaque" : !route.response && !route.responses ? "missing" : "framework-declared");
      return {
        module: module.name, controller: controller.className, handler: route.handler,
        method: route.method, path: `${controller.path}${route.path}`, file: controller.file,
        missing,
        validation: {
          body,
          response,
          schemas: route.schemaKinds ?? {},
          evidence: route.contract?.evidence ?? null,
          verified: false as const,
          obligations: [
            "Exercise actual HTTP request and response boundaries.",
            ...(response === "opaque" ? ["Decode the response's business fields; an opaque schema accepts unvalidated output."] : []),
            ...(body === "domain" || body === "opaque" ? ["Prove invalid input is rejected by the domain before writes."] : []),
            ...(response === "native-json" || response === "native-response-unclassified"
              ? ["Validate serialized JSON explicitly; native Response bypasses framework response schemas."] : []),
            ...(["binary", "stream"].includes(response) ? ["Test transport headers, access and bytes without JSON decoding."] : []),
          ],
        },
      };
    }),
  ));
}

export function validateRouteContracts(graph: ApplicationGraph): Diagnostic[] {
  return inspectRouteContracts(graph).flatMap((route): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];
    const subject = `${route.controller}.${route.handler} (${route.method} ${route.path})`;
    if (route.missing.length) diagnostics.push({
      severity: "error",
      code: "route-contract-required",
      file: route.file,
      message: `${subject} is missing contract declarations: ${route.missing.join(", ")}.`,
      suggestion: "Declare the missing schemas and test actual request/response decoding. An opaque schema is not proof of validation.",
    });
    const { body, response, schemas, evidence } = route.validation;
    const opaque = Object.entries(schemas).filter(([field, kind]) =>
      kind === "opaque" && !(field === "body" && body === "domain"),
    ).map(([field]) => field);
    if (opaque.length || response === "native-response-unclassified") diagnostics.push({
      severity: "error",
      code: "route-contract-unverified",
      file: route.file,
      message: `${subject} has unchecked boundaries: ${[...opaque, ...(response === "native-response-unclassified" ? ["native Response"] : [])].join(", ")}.`,
      suggestion: "Use concrete schemas. Explicitly classify native JSON, binary or stream output and test the actual boundary.",
    });
    if ((body === "domain" || ["native-json", "binary", "stream"].includes(response))
      && !evidence?.trim()) diagnostics.push({
      severity: "error",
      code: "route-contract-evidence-required",
      file: route.file,
      message: `${subject} delegates validation or uses native transport without a test evidence reference.`,
      suggestion: "Set contract.evidence to the boundary test path. This records an obligation, not proof that the test passed.",
    });
    return diagnostics;
  });
}
