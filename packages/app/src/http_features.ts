import { InjectionToken } from "./token";
import type { Provider } from "./provider";
import type { HttpInterceptorFn } from "./interceptor";
import type { HttpClientConfig } from "./http_client_core";

/** Angular-free HTTP configuration. The inject-based client lives in `http_client.ts`. */
export const HTTP_CLIENT_CONFIG = new InjectionToken<HttpClientConfig>(
  "HTTP_CLIENT_CONFIG",
  { scope: "application", factory: () => ({}) },
);

export const HTTP_INTERCEPTORS = new InjectionToken<HttpInterceptorFn[]>(
  "HTTP_INTERCEPTORS",
  { scope: "application", factory: () => [] },
);

export type HttpClientFeatureKind = "Fetch" | "Interceptors" | "ParentRequests";

export interface HttpClientFeature {
  kind: HttpClientFeatureKind;
  providers: Provider[];
}

export function withFetch(customFetch?: typeof fetch): HttpClientFeature {
  return {
    kind: "Fetch",
    providers: [
      {
        provide: HTTP_CLIENT_CONFIG,
        useFactory: () => ({ fetch: customFetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined) }),
      },
    ],
  };
}

export function withInterceptors(...interceptors: (HttpInterceptorFn | HttpInterceptorFn[])[]): HttpClientFeature {
  const flattened = interceptors.flat();
  return {
    kind: "Interceptors",
    providers: [
      {
        provide: HTTP_INTERCEPTORS,
        useValue: flattened,
        multi: true,
      },
    ],
  };
}

export function withRequestsMadeViaParent(): HttpClientFeature {
  return {
    kind: "ParentRequests",
    providers: [],
  };
}
