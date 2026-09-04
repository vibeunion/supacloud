import { InjectionToken } from "./token";
import type { EnvironmentProviders, Provider, Type } from "./provider";
import { makeEnvironmentProviders } from "./provider";
import type { RouteDefinition } from "./decorators";
import { TITLE_STRATEGY, type TitleStrategy } from "./title_strategy";

export const ROUTE_CONFIG = new InjectionToken<RouteDefinition[]>("supacloud:route-config");

/**
 * Built-in injection token for the application base href.
 * Modeled directly after Angular's APP_BASE_HREF in @angular/common.
 */
export const APP_BASE_HREF = new InjectionToken<string>("supacloud.app-base-href", {
  scope: "application",
  factory: () => "/",
});

export interface RouterFeature {
  kind: string;
  providers: Provider[];
}

export interface RouterConfigOptions {
  onSameUrlNavigation?: "reload" | "ignore";
  paramsInheritanceStrategy?: "emptyOnly" | "always";
}

export const ROUTER_CONFIGURATION = new InjectionToken<RouterConfigOptions>("supacloud.router-configuration", {
  scope: "application",
  factory: () => ({ onSameUrlNavigation: "ignore", paramsInheritanceStrategy: "emptyOnly" }),
});

/**
 * Feature flag enabling automatic binding of route and query parameters to component/handler inputs.
 * Modeled after Angular 16+ withComponentInputBinding().
 */
export function withComponentInputBinding(): RouterFeature {
  return {
    kind: "componentInputBinding",
    providers: [
      {
        provide: new InjectionToken<boolean>("supacloud.with-component-input-binding"),
        useValue: true,
      },
    ],
  };
}

/**
 * Configures global router behavior options.
 * Modeled after Angular 15+ withRouterConfig().
 */
export function withRouterConfig(options: RouterConfigOptions): RouterFeature {
  return {
    kind: "routerConfig",
    providers: [
      {
        provide: ROUTER_CONFIGURATION,
        useValue: options,
      },
    ],
  };
}

/**
 * Registers a custom TitleStrategy for page title updates upon navigation.
 * Modeled after Angular 14+ withTitleStrategy().
 */
export function withTitleStrategy(strategy: TitleStrategy | Type<TitleStrategy>): RouterFeature {
  return {
    kind: "titleStrategy",
    providers: [
      typeof strategy === "function"
        ? { provide: TITLE_STRATEGY, useClass: strategy }
        : { provide: TITLE_STRATEGY, useValue: strategy },
    ],
  };
}

/**
 * Provides application-wide route configuration and router features.
 * Modeled after Angular 15+ standalone provideRouter.
 */
export function provideRouter(routes: RouteDefinition[], ...features: RouterFeature[]): EnvironmentProviders {
  const featureProviders: Provider[] = [];
  for (const feature of features) {
    if (feature && Array.isArray(feature.providers)) {
      featureProviders.push(...feature.providers);
    }
  }
  return makeEnvironmentProviders([
    {
      provide: ROUTE_CONFIG,
      useValue: routes,
    },
    ...featureProviders,
  ]);
}
