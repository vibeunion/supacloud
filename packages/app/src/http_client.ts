import { Injectable } from "./decorators";
import { InjectionToken } from "./token";
import { inject, injectAll } from "./inject";
import { makeEnvironmentProviders, type EnvironmentProviders, type Provider } from "./provider";
import type { HttpInterceptorFn } from "./interceptor";
import {
  HttpClientCore,
  type HttpClientConfig,
  type HttpRequestOptions,
  HttpErrorResponse,
} from "./http_client_core";

export {
  HttpErrorResponse,
  type HttpClientConfig,
  type HttpRequestOptions,
} from "./http_client_core";

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

export function provideHttpClient(...features: HttpClientFeature[]): EnvironmentProviders {
  const providers: Provider[] = [
    HttpClient,
  ];
  for (const feature of features) {
    providers.push(...feature.providers);
  }
  return makeEnvironmentProviders(providers);
}

@Injectable({ providedIn: "root" })
export class HttpClient extends HttpClientCore {
  constructor(config?: HttpClientConfig, interceptors?: HttpInterceptorFn[]) {
    super(
      config ?? (() => {
        try {
          return inject(HTTP_CLIENT_CONFIG, { optional: true }) ?? {};
        } catch {
          return {};
        }
      })(),
      interceptors ?? (() => {
        try {
          return injectAll(HTTP_INTERCEPTORS).flat();
        } catch {
          return [];
        }
      })(),
    );
  }
}
