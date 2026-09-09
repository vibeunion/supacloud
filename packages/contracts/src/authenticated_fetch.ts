export type SingleAttemptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CommandAuthenticationError extends Error {
  readonly code = "COMMAND_AUTHENTICATION_REQUIRED";
  constructor() {
    super("A current authenticated session is required before sending");
    this.name = "CommandAuthenticationError";
  }
}

/** The provider may refresh before sending; this transport never handles a 401 by resending. */
export function createAuthenticatedFetch(options: {
  getAccessToken(): Promise<string | null>;
  fetch?: SingleAttemptFetch;
}): SingleAttemptFetch {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new TypeError("Authenticated command transport requires HTTPS without URL credentials");
    }
    request.signal.throwIfAborted();
    const token = await options.getAccessToken();
    if (typeof token !== "string" || !token.trim() || /[\x00-\x20\x7f]/.test(token)) {
      throw new CommandAuthenticationError();
    }
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    return send(new Request(request, { headers, redirect: "error" }));
  };
}
