import { expect, test } from "bun:test";
import { createDefaultApplicationRouteComposition } from "../../src/services/application-deployment-composition";
import { applicationRoutes } from "../../src/routes/applications";
import { applicationRoutes as mountedApplicationRoutes } from "../../src/routes";

test("default composition provides an executable compatibility verifier", () => {
  const composition = createDefaultApplicationRouteComposition();
  expect(composition.deployment).toBeDefined();
  expect(composition.routes.routes.some(route =>
    route.path === "/v1/projects/:ref/applications/:id/environments/:environmentId/activations",
  )).toBe(true);
});

test("explicit composition registers activation, observation recovery and retirement without effects", () => {
  let verified = false;
  const { routes } = createDefaultApplicationRouteComposition(async () => { verified = true; });
  const writes = routes.routes.filter(route => route.method === "POST").map(route => route.path);
  const prefix = "/v1/projects/:ref/applications/:id/environments/:environmentId/activations";
  expect(writes).toContain(prefix);
  expect(writes).toContain(`${prefix}/:activationId/reconcile`);
  expect(writes).toContain(`${prefix}/:activationId/retire`);
  expect(verified).toBe(false);
  expect(applicationRoutes.routes.some(route => route.path.includes("/activations"))).toBe(false);
});

test("routes index mounts the default composed activation routes", () => {
  expect(mountedApplicationRoutes.routes.some(route =>
    route.path === "/v1/projects/:ref/applications/:id/environments/:environmentId/activations",
  )).toBe(true);
  expect(mountedApplicationRoutes.routes.some(route =>
    route.path === "/v1/projects/:ref/applications/:id/environments/:environmentId/activations/:activationId/reconcile",
  )).toBe(true);
});
