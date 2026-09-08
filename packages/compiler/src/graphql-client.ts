/** Appended to the generated SDK; browser consumers need only the platform fetch API. */
export const GRAPHQL_CLIENT_SOURCE = `
export interface GraphqlClientOptions {
  /** Project base URL, not the management API URL. HTTPS is required outside loopback. */
  url: string;
  /** Public project key only. Never put a service-role or management key in a browser. */
  publishableKey?: string;
  /** Resolved on every request so session refresh and logout are observed. */
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface GraphqlRequestOptions {
  signal?: AbortSignal;
}

export class GraphqlRequestError extends Error {
  constructor(
    public readonly code: "http" | "graphql" | "invalid-response",
    message: string,
    public readonly status?: number,
    public readonly errors?: readonly unknown[],
  ) {
    super(message);
    this.name = "GraphqlRequestError";
  }
}

export function createGraphqlClient(options: GraphqlClientOptions) {
  const endpoint = new URL(options.url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("GraphQL requires HTTPS outside loopback development.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("GraphQL project URLs must not contain credentials, query parameters or fragments.");
  }
  endpoint.pathname = endpoint.pathname.replace(/\\/$/, "") + "/graphql/v1";
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  return getSdk<GraphqlRequestOptions>(async <R, V>(
    query: string,
    variables?: V,
    request?: GraphqlRequestOptions,
  ): Promise<R> => {
    const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
    if (options.publishableKey) headers.set("apikey", options.publishableKey);
    const token = await options.getAccessToken?.();
    if (token) headers.set("Authorization", "Bearer " + token);
    const response = await fetcher(endpoint.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: request?.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new GraphqlRequestError("http", "GraphQL HTTP request failed (" + response.status + ").", response.status);
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new GraphqlRequestError("invalid-response", "GraphQL returned invalid JSON.", response.status);
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new GraphqlRequestError("invalid-response", "GraphQL returned an invalid envelope.", response.status);
    }
    if ("errors" in envelope) {
      if (!Array.isArray(envelope.errors)) {
        throw new GraphqlRequestError("invalid-response", "GraphQL returned invalid errors.", response.status);
      }
      if (envelope.errors.length > 0) {
        throw new GraphqlRequestError("graphql", "GraphQL query failed.", response.status, envelope.errors);
      }
    }
    if (!("data" in envelope) || !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
      throw new GraphqlRequestError("invalid-response", "GraphQL returned no result object.", response.status);
    }
    // Operation types describe the schema snapshot, not runtime response validation.
    return envelope.data as R;
  });
}
`;
