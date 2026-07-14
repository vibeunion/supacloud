import type { ResolvedProjectApiKey } from "./project-auth";

export function translateRealtimeProxyCredentials(input: {
  url: URL;
  requestHeaders: Headers;
  candidateKey: string;
  resolved: ResolvedProjectApiKey;
}): {
  search: string;
  forwardHeaders: Record<string, string>;
} {
  const { url, requestHeaders, candidateKey, resolved } = input;
  const searchParams = new URLSearchParams(url.searchParams);
  const forwardHeaders: Record<string, string> = {};
  const isOpaque = resolved.kind === "publishable" || resolved.kind === "secret";

  const queryApiKey = searchParams.get("apikey") || "";
  if (isOpaque && queryApiKey === candidateKey) {
    searchParams.set("apikey", resolved.upstreamKey);
  }

  const headerApiKey = requestHeaders.get("apikey") || "";
  if (headerApiKey) {
    forwardHeaders.apikey = isOpaque && headerApiKey === candidateKey
      ? resolved.upstreamKey
      : headerApiKey;
  }

  const authorization = requestHeaders.get("authorization") || "";
  const bearerToken = authorization.replace(/^Bearer\s+/i, "");
  if (authorization) {
    forwardHeaders.authorization = isOpaque && bearerToken === candidateKey
      ? `Bearer ${resolved.upstreamKey}`
      : authorization;
  }

  const protocol = requestHeaders.get("sec-websocket-protocol");
  if (protocol) forwardHeaders["sec-websocket-protocol"] = protocol;

  const serialized = searchParams.toString();
  return {
    search: serialized ? `?${serialized}` : "",
    forwardHeaders,
  };
}
