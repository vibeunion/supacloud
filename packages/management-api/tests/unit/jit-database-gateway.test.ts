import { describe, expect, test } from "bun:test";
import {
  JitDatabaseGateway,
  compileAllowedNetworks,
  isAddressAllowed,
  normalizeAllowedNetworks,
  normalizeGatewayPortRange,
} from "../../src/services/jit-database-gateway.service";

describe("JIT database gateway CIDR policy", () => {
  test("normalizes Supabase IPv4 and IPv6 allowed_networks entries", () => {
    expect(normalizeAllowedNetworks({
      allowed_cidrs: [{ cidr: "203.0.113.7/32" }],
      allowed_cidrs_v6: [{ cidr: "2001:db8::/32" }],
    })).toEqual({
      ipv4: ["203.0.113.7/32"],
      ipv6: ["2001:db8::/32"],
    });
  });

  test("rejects malformed, mixed-family, duplicate, and oversized networks", () => {
    expect(() => normalizeAllowedNetworks({ allowed_cidrs: [{ cidr: "203.0.113.1" }] })).toThrow("CIDR");
    expect(() => normalizeAllowedNetworks({ allowed_cidrs: [{ cidr: "2001:db8::/32" }] })).toThrow("IPv4");
    expect(() => normalizeAllowedNetworks({ allowed_cidrs: [{ cidr: "203.0.113.0/24" }, { cidr: "203.0.113.0/24" }] })).toThrow("duplicate");
    expect(() => normalizeAllowedNetworks({ allowed_cidrs: Array.from({ length: 65 }, (_, i) => ({ cidr: `203.0.${i}.0/24` })) })).toThrow("64");
  });

  test("matches IPv4 and IPv6 addresses without trusting a host header", () => {
    const policy = compileAllowedNetworks({ ipv4: ["203.0.113.0/24"], ipv6: ["2001:db8::/32", "2001:db9::192.0.2.0/120"] });
    expect(isAddressAllowed("203.0.113.42", policy)).toBe(true);
    expect(isAddressAllowed("::ffff:203.0.113.42", policy)).toBe(true);
    expect(isAddressAllowed("203.0.114.42", policy)).toBe(false);
    expect(isAddressAllowed("2001:db8:1::42", policy)).toBe(true);
    expect(isAddressAllowed("2001:db9::42", policy)).toBe(false);
    expect(isAddressAllowed("2001:db9::192.0.2.42", policy)).toBe(true);
    expect(isAddressAllowed("203.0.113.42:5432", policy)).toBe(false);
  });

  test("accepts only a bounded non-privileged gateway port range", () => {
    expect(normalizeGatewayPortRange("6600-6699")).toEqual({ start: 6600, end: 6699 });
    expect(() => normalizeGatewayPortRange("5432")).toThrow("start-end");
    expect(() => normalizeGatewayPortRange("80-90")).toThrow("1024");
    expect(() => normalizeGatewayPortRange("6600-7000")).toThrow("256");
  });

  test("proxies PostgreSQL bytes only for an allowed source address", async () => {
    let upstreamConnections = 0;
    const upstream = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() { upstreamConnections += 1; },
        data(socket, data) { socket.write(data); },
        binaryType: "buffer",
      },
    });
    const gateway = new JitDatabaseGateway("127.0.0.1", "127.0.0.1", upstream.port);

    try {
      gateway.bind({
        credentialId: "allowed",
        port: 0,
        expiresAt: new Date(Date.now() + 10_000),
        allowedNetworks: { ipv4: ["127.0.0.1/32"], ipv6: [] },
      });
      const allowedPort = gateway.boundPort("allowed");
      expect(allowedPort).not.toBeNull();
      const echoed = await new Promise<string>((resolve, reject) => {
        void Bun.connect({
          hostname: "127.0.0.1",
          port: allowedPort!,
          socket: {
            open(socket) { socket.write("postgres-wire-test"); },
            data(socket, data) { resolve(Buffer.from(data).toString()); socket.end(); },
            connectError(_socket, error) { reject(error); },
            error(_socket, error) { reject(error); },
          },
        }).catch(reject);
      });
      expect(echoed).toBe("postgres-wire-test");
      expect(upstreamConnections).toBe(1);

      gateway.bind({
        credentialId: "denied",
        port: 0,
        expiresAt: new Date(Date.now() + 10_000),
        allowedNetworks: { ipv4: ["203.0.113.0/24"], ipv6: [] },
      });
      const deniedPort = gateway.boundPort("denied");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("denied gateway connection did not close")), 2_000);
        void Bun.connect({
          hostname: "127.0.0.1",
          port: deniedPort!,
          socket: {
            data() { /* denied connections never receive upstream bytes */ },
            close() { clearTimeout(timer); resolve(); },
            connectError() { clearTimeout(timer); resolve(); },
            error() { clearTimeout(timer); resolve(); },
          },
        }).catch(() => { clearTimeout(timer); resolve(); });
      });
      expect(upstreamConnections).toBe(1);
    } finally {
      gateway.close();
      upstream.stop(true);
    }
  });
});
