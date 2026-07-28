import { isIP } from "node:net";
import { logger } from "../utils/logger";

const MAX_ALLOWED_CIDRS = 64;
const MAX_PENDING_BYTES = 1024 * 1024;

export type NormalizedAllowedNetworks = {
  ipv4: string[];
  ipv6: string[];
};

type CompiledCidr = {
  family: 4 | 6;
  network: bigint;
  mask: bigint;
};

export type CompiledAllowedNetworks = CompiledCidr[];

export type JitDatabaseGatewayBinding = {
  credentialId: string;
  port: number;
  expiresAt: Date;
  allowedNetworks: NormalizedAllowedNetworks;
};

export type GatewayPortRange = { start: number; end: number };

export function normalizeGatewayPortRange(value: string): GatewayPortRange {
  const match = value.trim().match(/^(\d+)-(\d+)$/);
  if (!match) throw new Error("JIT gateway port range must use start-end syntax");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end < start) {
    throw new Error("JIT gateway ports must be ordered and start at 1024 or above");
  }
  if (end - start + 1 > 256) throw new Error("JIT gateway port range cannot exceed 256 ports");
  return { start, end };
}

type ProxySocketData = {
  peer?: Bun.Socket<ProxySocketData>;
  pending: Buffer[];
  pendingBytes: number;
  resumeOnDrain?: Bun.Socket<ProxySocketData>;
  closed: boolean;
};

function parseEntryArray(value: unknown, family: 4 | 6): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`allowed_cidrs${family === 6 ? "_v6" : ""} must be an array`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { cidr?: unknown }).cidr !== "string") {
      throw new Error("Each allowed network must contain a CIDR string");
    }
    const cidr = (entry as { cidr: string }).cidr.trim();
    const [address, prefixText, extra] = cidr.split("/");
    if (!address || !prefixText || extra !== undefined || !/^\d+$/.test(prefixText)) {
      throw new Error(`Invalid CIDR: ${cidr}`);
    }
    if (isIP(address) !== family) throw new Error(`Expected an IPv${family} CIDR: ${cidr}`);
    const prefix = Number(prefixText);
    const maxPrefix = family === 4 ? 32 : 128;
    if (prefix < 0 || prefix > maxPrefix) throw new Error(`Invalid CIDR prefix: ${cidr}`);
    return `${address}/${prefix}`;
  });
}

export function normalizeAllowedNetworks(value: unknown): NormalizedAllowedNetworks {
  if (value === undefined || value === null) return { ipv4: [], ipv6: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("allowed_networks must be an object");
  const source = value as { allowed_cidrs?: unknown; allowed_cidrs_v6?: unknown };
  const ipv4 = parseEntryArray(source.allowed_cidrs, 4);
  const ipv6 = parseEntryArray(source.allowed_cidrs_v6, 6);
  if (ipv4.length + ipv6.length > MAX_ALLOWED_CIDRS) {
    throw new Error(`allowed_networks supports at most ${MAX_ALLOWED_CIDRS} CIDRs`);
  }
  const all = [...ipv4, ...ipv6];
  if (new Set(all).size !== all.length) throw new Error("allowed_networks contains a duplicate CIDR");
  return { ipv4, ipv6 };
}

export function serializeAllowedNetworks(value: NormalizedAllowedNetworks) {
  return {
    allowed_cidrs: value.ipv4.map((cidr) => ({ cidr })),
    allowed_cidrs_v6: value.ipv6.map((cidr) => ({ cidr })),
  };
}

function parseIpv4(address: string): bigint | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((result, octet) => (result << 8n) | BigInt(Number(octet)), 0n);
}

function parseIpv6(address: string): bigint | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const ipv4 = parseIpv4(mapped[1]!);
    return ipv4 === null ? null : (0xffffn << 32n) | ipv4;
  }
  const embeddedIpv4 = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedIpv4) {
    const ipv4 = parseIpv4(embeddedIpv4[2]!);
    if (ipv4 === null) return null;
    normalized = `${embeddedIpv4[1]}${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function compileCidr(cidr: string, family: 4 | 6): CompiledCidr {
  const [address, prefixText] = cidr.split("/");
  const bits = family === 4 ? 32 : 128;
  const value = family === 4 ? parseIpv4(address!) : parseIpv6(address!);
  if (value === null) throw new Error(`Invalid IPv${family} CIDR: ${cidr}`);
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { family, mask, network: value & mask };
}

export function compileAllowedNetworks(value: NormalizedAllowedNetworks): CompiledAllowedNetworks {
  return [
    ...value.ipv4.map((cidr) => compileCidr(cidr, 4)),
    ...value.ipv6.map((cidr) => compileCidr(cidr, 6)),
  ];
}

export function isAddressAllowed(address: string, policy: CompiledAllowedNetworks): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const normalizedAddress = mapped?.[1] ?? address;
  const family = isIP(normalizedAddress);
  if (family !== 4 && family !== 6) return false;
  const value = family === 4 ? parseIpv4(normalizedAddress) : parseIpv6(normalizedAddress);
  if (value === null) return false;
  return policy.some((cidr) => cidr.family === family && (value & cidr.mask) === cidr.network);
}

function socketData(): ProxySocketData {
  return { pending: [], pendingBytes: 0, closed: false };
}

function closePair(socket: Bun.Socket<ProxySocketData>): void {
  if (socket.data.closed) return;
  socket.data.closed = true;
  const peer = socket.data.peer;
  socket.data.peer = undefined;
  try { socket.terminate(); } catch { /* already closed */ }
  if (peer && !peer.data.closed) {
    peer.data.peer = undefined;
    peer.data.closed = true;
    try { peer.terminate(); } catch { /* already closed */ }
  }
}

function queueForPeer(source: Bun.Socket<ProxySocketData>, chunk: Buffer): void {
  source.data.pending.push(Buffer.from(chunk));
  source.data.pendingBytes += chunk.byteLength;
  if (source.data.pendingBytes > MAX_PENDING_BYTES) closePair(source);
}

function forward(source: Bun.Socket<ProxySocketData>, target: Bun.Socket<ProxySocketData>, chunk: Buffer): void {
  if (source.data.closed || target.data.closed) return;
  const written = target.write(chunk);
  if (written < chunk.byteLength) {
    const offset = Math.max(0, written);
    target.data.pending.push(Buffer.from(chunk.subarray(offset)));
    target.data.pendingBytes += chunk.byteLength - offset;
    target.data.resumeOnDrain = source;
    source.pause();
    if (target.data.pendingBytes > MAX_PENDING_BYTES) closePair(target);
  }
}

function flushPending(target: Bun.Socket<ProxySocketData>): void {
  while (!target.data.closed && target.data.pending.length > 0) {
    const chunk = target.data.pending.shift()!;
    target.data.pendingBytes -= chunk.byteLength;
    const written = target.write(chunk);
    if (written < chunk.byteLength) {
      const offset = Math.max(0, written);
      const remainder = Buffer.from(chunk.subarray(offset));
      target.data.pending.unshift(remainder);
      target.data.pendingBytes += remainder.byteLength;
      return;
    }
  }
  const source = target.data.resumeOnDrain;
  target.data.resumeOnDrain = undefined;
  source?.resume();
}

export class JitDatabaseGateway {
  private readonly listeners = new Map<string, Bun.TCPSocketListener>();
  private readonly expiryTimers = new Map<string, Timer>();

  constructor(
    private readonly bindHost: string,
    private readonly upstreamHost: string,
    private readonly upstreamPort: number,
  ) {}

  hasBinding(credentialId: string): boolean {
    return this.listeners.has(credentialId);
  }

  boundPort(credentialId: string): number | null {
    return this.listeners.get(credentialId)?.port ?? null;
  }

  private scheduleExpiry(credentialId: string, expiresAt: Date): void {
    const remaining = expiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      this.release(credentialId);
      return;
    }
    const timer = setTimeout(() => this.scheduleExpiry(credentialId, expiresAt), Math.min(remaining, 2_147_000_000));
    this.expiryTimers.set(credentialId, timer);
  }

  bind(binding: JitDatabaseGatewayBinding): void {
    this.release(binding.credentialId);
    if (binding.expiresAt.getTime() <= Date.now()) return;
    const policy = compileAllowedNetworks(binding.allowedNetworks);
    if (policy.length === 0) throw new Error("JIT gateway binding requires at least one allowed CIDR");

    const listener = Bun.listen<ProxySocketData>({
      hostname: this.bindHost,
      port: binding.port,
      exclusive: true,
      data: socketData(),
      socket: {
        open: (client) => {
          client.data = socketData();
          if (binding.expiresAt.getTime() <= Date.now() || !isAddressAllowed(client.remoteAddress, policy)) {
            logger.warn("[JitDatabaseGateway] Rejected source address", {
              credentialId: binding.credentialId,
              sourceAddress: client.remoteAddress,
            });
            closePair(client);
            return;
          }
          void Bun.connect<ProxySocketData>({
            hostname: this.upstreamHost,
            port: this.upstreamPort,
            data: socketData(),
            socket: {
              open: (upstream) => {
                upstream.data.peer = client;
                client.data.peer = upstream;
                const pending = client.data.pending.splice(0);
                client.data.pendingBytes = 0;
                for (const chunk of pending) forward(client, upstream, chunk);
              },
              data: (upstream, data) => {
                if (upstream.data.peer) forward(upstream, upstream.data.peer, Buffer.from(data));
              },
              drain: flushPending,
              close: closePair,
              error: closePair,
              connectError: closePair,
              end: closePair,
              binaryType: "buffer",
            },
          }).catch(() => closePair(client));
        },
        data: (client, data) => {
          const chunk = Buffer.from(data);
          if (client.data.peer) forward(client, client.data.peer, chunk);
          else queueForPeer(client, chunk);
        },
        drain: flushPending,
        close: closePair,
        error: closePair,
        end: closePair,
        binaryType: "buffer",
      },
    });
    this.listeners.set(binding.credentialId, listener);
    this.scheduleExpiry(binding.credentialId, binding.expiresAt);
  }

  release(credentialId: string): void {
    const timer = this.expiryTimers.get(credentialId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(credentialId);
    const listener = this.listeners.get(credentialId);
    if (listener) listener.stop(true);
    this.listeners.delete(credentialId);
  }

  close(): void {
    for (const credentialId of [...this.listeners.keys()]) this.release(credentialId);
  }
}
