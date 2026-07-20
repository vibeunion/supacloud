import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
]);
export const MAX_OUTBOUND_RESPONSE_BYTES = 64 * 1_024;

const BLOCKED_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as Array<[string, number]>) BLOCKED_ADDRESSES.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["2001:db8::", 32],
] as Array<[string, number]>) BLOCKED_ADDRESSES.addSubnet(address, prefix, "ipv6");

type ResolvedTarget = {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
};

function normalizedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const suffix = lower.slice(7);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const bytes = parts.flatMap((part) => {
    const segmentNumber = Number.parseInt(part, 16);
    return [segmentNumber >> 8, segmentNumber & 255];
  });
  return bytes.join(".");
}

export function isBlockedOutboundAddress(address: string): boolean {
  const mapped = mappedIpv4(address);
  if (mapped) return BLOCKED_ADDRESSES.check(mapped, "ipv4");
  const family = isIP(address);
  if (family === 4) return BLOCKED_ADDRESSES.check(address, "ipv4");
  if (family === 6) return BLOCKED_ADDRESSES.check(address, "ipv6");
  return true;
}

export function validateOutboundHttpUrl(urlValue: string): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(urlValue.trim());
  } catch {
    return { ok: false, error: "url must be a valid HTTP(S) URL" };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, error: "url must be a valid HTTP(S) URL" };
  const hostname = normalizedHostname(url.hostname).toLowerCase();
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return { ok: false, error: "url host is not allowed" };
  }
  if (isIP(hostname) && isBlockedOutboundAddress(hostname)) {
    return { ok: false, error: "url host must not resolve to a private or local address" };
  }
  return { ok: true, url: url.toString() };
}

async function resolveTarget(urlValue: string): Promise<ResolvedTarget> {
  const validated = validateOutboundHttpUrl(urlValue);
  if (!validated.ok) throw new Error(validated.error);
  const url = new URL(validated.url);
  const hostname = normalizedHostname(url.hostname);
  const literalFamily = isIP(hostname);
  const candidates = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (candidates.length === 0 || candidates.some(({ address }) => isBlockedOutboundAddress(address))) {
    throw new Error("url host must not resolve to a private or local address");
  }
  const selected = candidates[0];
  return { url, hostname, address: selected.address, family: selected.family as 4 | 6 };
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const output = new Headers();
  for (const [name, headerValue] of Object.entries(headers)) {
    if (Array.isArray(headerValue)) headerValue.forEach((entry) => output.append(name, entry));
    else if (headerValue !== undefined) output.set(name, headerValue);
  }
  return output;
}

function outboundOptions(target: ResolvedTarget, init: RequestInit): RequestOptions {
  return {
    protocol: target.url.protocol,
    hostname: target.address,
    family: target.family,
    port: target.url.port || undefined,
    path: `${target.url.pathname}${target.url.search}`,
    method: init.method || "GET",
    headers: { ...Object.fromEntries(new Headers(init.headers).entries()), host: target.url.host },
    servername: isIP(target.hostname) ? undefined : target.hostname,
  };
}

type ResponseReadState = {
  chunks: Buffer[];
  receivedBytes: number;
  settled: boolean;
};

function appendResponseChunk(
  incoming: IncomingMessage,
  state: ResponseReadState,
  chunk: unknown,
  reject: (reason: Error) => void,
): void {
  if (state.settled) return;
  const bytes = Buffer.from(chunk as Uint8Array);
  state.receivedBytes += bytes.length;
  if (state.receivedBytes <= MAX_OUTBOUND_RESPONSE_BYTES) {
    state.chunks.push(bytes);
    return;
  }
  state.settled = true;
  const error = new Error(`outbound response exceeds ${MAX_OUTBOUND_RESPONSE_BYTES} bytes`);
  incoming.destroy(error);
  reject(error);
}

function rejectResponseRead(
  state: ResponseReadState,
  error: Error,
  reject: (reason: Error) => void,
): void {
  if (state.settled) return;
  state.settled = true;
  reject(error);
}

function completeResponseRead(
  incoming: IncomingMessage,
  state: ResponseReadState,
  resolve: (response: Response) => void,
): void {
  if (state.settled) return;
  state.settled = true;
  resolve(new Response(Buffer.concat(state.chunks), {
    status: incoming.statusCode || 500,
    headers: responseHeaders(incoming.headers),
  }));
}

export function responseFromIncoming(incoming: IncomingMessage): Promise<Response> {
  return new Promise((resolve, reject) => {
    const state: ResponseReadState = { chunks: [], receivedBytes: 0, settled: false };
    incoming.on("data", (chunk) => appendResponseChunk(incoming, state, chunk, reject));
    incoming.on("error", (error) => rejectResponseRead(state, error, reject));
    incoming.on("end", () => completeResponseRead(incoming, state, resolve));
  });
}

function outboundBody(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  throw new TypeError("safeOutboundFetch supports string or Uint8Array request bodies");
}

export async function safeOutboundFetch(urlValue: string, init: RequestInit = {}): Promise<Response> {
  const target = await resolveTarget(urlValue);
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  const body = outboundBody(init.body);
  return new Promise<Response>((resolve, reject) => {
    const outbound = request(outboundOptions(target, init), (incoming) => {
      responseFromIncoming(incoming).then(resolve, reject);
    });
    outbound.on("error", reject);
    init.signal?.addEventListener("abort", () => outbound.destroy(init.signal?.reason), { once: true });
    if (body !== undefined) outbound.write(body);
    outbound.end();
  });
}

export async function isOutboundUrlSafe(urlValue: string): Promise<boolean> {
  try {
    await resolveTarget(urlValue);
    return true;
  } catch {
    return false;
  }
}
