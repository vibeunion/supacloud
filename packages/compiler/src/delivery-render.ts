import type { ApplicationGraph } from "./types";
import type { DeliveryTarget } from "./delivery-schema";
import { renderApplication, type GenerateOptions } from "./generate";
import { joinRoutePaths } from "./util";

/** Keep conservative service factories while restricting exposed route/job descriptors. */
export function renderDeliveryTarget(
  graph: ApplicationGraph,
  target: DeliveryTarget,
  options: GenerateOptions,
) {
  const included = new Set(target.modules.map((module) => module.name));
  const projected: ApplicationGraph = {
    ...graph,
    modules: graph.modules.filter((module) => included.has(module.name)).map((module) => ({
      ...module,
      controllers: module.controllers.map((controller) => ({
        ...controller,
        routes: controller.routes.filter((route) => target.routes.some((owned) =>
          owned.module === module.name && owned.controller === controller.className
          && owned.handler === route.handler && owned.method === route.method
          && owned.path === joinRoutePaths(controller.path, route.path))),
      })),
      jobs: (module.jobs ?? []).filter((job) => target.jobs.some((owned) =>
        owned.module === module.name && owned.name === job.name && owned.className === job.className)),
    })),
    externalTokens: target.externalTokens,
  };
  // Existing root-provider pruning does not treat Jobs as roots; preserve all providers here.
  return renderApplication(projected, { ...options, treeShakeUnusedProviders: false });
}
