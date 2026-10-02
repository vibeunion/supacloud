import { Injectable } from "./decorators";
import { InjectionToken } from "./token";
import { inject, injectAll } from "./inject";
import { makeEnvironmentProviders, type EnvironmentProviders, type Provider } from "./provider";
import type { HttpInterceptorFn } from "./interceptor";
import {
  HttpClientCore,
  delegateHttpRequestsToParent,
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
  const parentFeatures = features.filter(feature => feature.kind === "ParentRequests");
  const fetchFeatures = features.filter(feature => feature.kind === "Fetch");
  if (parentFeatures.length > 0 && fetchFeatures.length > 0) {
    throw new TypeError("withRequestsMadeViaParent() cannot be combined with withFetch()");
  }
  if (parentFeatures.length > 1 || fetchFeatures.length > 1) {
    throw new TypeError("HTTP transport features must be configured only once per provideHttpClient()");
  }
  const viaParent = parentFeatures.length === 1;
  const providers: Provider[] = [{
    provide: HttpClient,
    useFactory: () => {
      // Resolve configuration explicitly, outside the legacy standalone
      // constructor's compatibility fallback. Provider failures must surface.
      // self prevents inherited interceptors running once here and again in
      // the parent's pipeline, and keeps non-delegating children independent.
      const config = inject(HTTP_CLIENT_CONFIG, { optional: true, self: true }) ?? {};
      const interceptors = inject(HTTP_INTERCEPTORS, { optional: true, self: true }) ?? [];
      const parent = viaParent ? inject(HttpClient, { optional: true, skipSelf: true }) : undefined;
      if (viaParent && !parent) {
        throw new Error("withRequestsMadeViaParent() requires a configured parent HttpClient");
      }
      const client = new HttpClient(config, interceptors.flat());
      if (parent) delegateHttpRequestsToParent(client, parent);
      return client;
    },
  }];
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
