import { InjectionToken } from "./token";
import type { EnvironmentProviders } from "./provider";
import { makeEnvironmentProviders } from "./provider";
import type { RouteDefinition } from "./decorators";

export const ROUTE_CONFIG = new InjectionToken<RouteDefinition[]>("supacloud:route-config");

/**
 * Provides application-wide route configuration and router features.
 * Modeled after Angular 15+ provideRouter.
 */
export function provideRouter(routes: RouteDefinition[], ..._features: any[]): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: ROUTE_CONFIG,
      useValue: routes,
    },
  ]);
}
