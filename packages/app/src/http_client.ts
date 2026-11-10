import { Injectable } from "./decorators";
import { inject, injectAll } from "./inject";
import { makeEnvironmentProviders, type EnvironmentProviders, type Provider } from "./provider";
import type { HttpInterceptorFn } from "./interceptor";
import {
  HTTP_CLIENT_CONFIG,
  HTTP_INTERCEPTORS,
  type HttpClientFeature,
} from "./http_features";
import {
  HttpClientCore,
  delegateHttpRequestsToParent,
  type HttpClientConfig,
} from "./http_client_core";

export {
  HTTP_CLIENT_CONFIG,
  HTTP_INTERCEPTORS,
  withFetch,
  withInterceptors,
  withRequestsMadeViaParent,
} from "./http_features";
export type { HttpClientFeature, HttpClientFeatureKind } from "./http_features";
export {
  HttpErrorResponse,
  type HttpClientConfig,
  type HttpRequestOptions,
} from "./http_client_core";

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
