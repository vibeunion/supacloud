import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawn, type Subprocess } from "bun";
import { JitDatabaseGateway } from "../../src/services/jit-database-gateway.service";

const repoRoot = join(import.meta.dir, "../../../..");
const TEST_CONTROL_PORT = 9882;
let proc: Subprocess | null = null;
let upstreamListener: ReturnType<typeof Bun.listen> | null = null;
let upstreamPort = 0;

beforeAll(async () => {
  // Start mock upstream echo server on an ephemeral port
  upstreamListener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        socket.write(data);
      },
      binaryType: "buffer",
    },
  });
  upstreamPort = upstreamListener.port;

  const binaryPath = join(repoRoot, "dist/supacloud-jit-gateway");
  proc = spawn({
    cmd: [binaryPath],
    env: {
      ...process.env,
      JIT_GATEWAY_CONTROL_HOST: "127.0.0.1",
      JIT_GATEWAY_CONTROL_PORT: String(TEST_CONTROL_PORT),
      JIT_GATEWAY_BIND_HOST: "127.0.0.1",
      JIT_GATEWAY_UPSTREAM_HOST: "127.0.0.1",
      JIT_GATEWAY_UPSTREAM_PORT: String(upstreamPort),
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const start = Date.now();
  let healthy = false;
  while (Date.now() - start < 5000) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_CONTROL_PORT}/healthcheck`);
      if (res.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      await Bun.sleep(50);
    }
  }
  if (!healthy) {
    proc.kill();
    throw new Error("supacloud-jit-gateway failed to start in test harness");
  }
});

afterAll(() => {
  if (proc) proc.kill();
  if (upstreamListener) upstreamListener.stop(true);
});

describe("Native Rust JIT Database Gateway", () => {
  test("healthcheck returns healthy status and engine metadata", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_CONTROL_PORT}/healthcheck`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("healthy");
    expect(body.engine).toBe("supacloud-jit-gateway/rust");
  });

  test("proxies PostgreSQL wire traffic via Rust daemon with CIDR filtering", async () => {
    const gateway = new JitDatabaseGateway(
      "127.0.0.1",
      "127.0.0.1",
      upstreamPort,
      `http://127.0.0.1:${TEST_CONTROL_PORT}`,
    );

    try {
      gateway.bind({
        credentialId: "rust-allowed",
        port: 0,
        expiresAt: new Date(Date.now() + 60_000),
        allowedNetworks: { ipv4: ["127.0.0.1/32"], ipv6: [] },
      });

      // Poll until remote port is confirmed
      let boundPort: number | null = null;
      for (let i = 0; i < 20; i++) {
        boundPort = gateway.boundPort("rust-allowed");
        if (boundPort && boundPort !== 0) break;
        await Bun.sleep(50);
      }
      expect(boundPort).not.toBeNull();
      expect(boundPort).toBeGreaterThan(0);

      // Verify traffic is proxied through upstream
      const echoed = await new Promise<string>((resolve, reject) => {
        void Bun.connect({
          hostname: "127.0.0.1",
          port: boundPort!,
          socket: {
            open(socket) {
              socket.write("tokio-postgres-stream");
            },
            data(socket, data) {
              resolve(Buffer.from(data).toString());
              socket.end();
            },
            connectError(_s, err) { reject(err); },
            error(_s, err) { reject(err); },
          },
        }).catch(reject);
      });

      expect(echoed).toBe("tokio-postgres-stream");

      // Verify denied network rejects client
      gateway.bind({
        credentialId: "rust-denied",
        port: 0,
        expiresAt: new Date(Date.now() + 60_000),
        allowedNetworks: { ipv4: ["203.0.113.0/24"], ipv6: [] },
      });

      let deniedPort: number | null = null;
      for (let i = 0; i < 20; i++) {
        deniedPort = gateway.boundPort("rust-denied");
        if (deniedPort && deniedPort !== 0) break;
        await Bun.sleep(50);
      }
      expect(deniedPort).not.toBeNull();

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("denied client did not close")), 2000);
        void Bun.connect({
          hostname: "127.0.0.1",
          port: deniedPort!,
          socket: {
            data() {},
            close() { clearTimeout(timer); resolve(); },
            connectError() { clearTimeout(timer); resolve(); },
            error() { clearTimeout(timer); resolve(); },
          },
        }).catch(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      gateway.close();
    }
  });

  test("falls back cleanly to in-process Bun listener when remote daemon is unavailable", async () => {
    const unreachableGateway = new JitDatabaseGateway(
      "127.0.0.1",
      "127.0.0.1",
      upstreamPort,
      "http://127.0.0.1:59999", // non-existent daemon port
    );

    try {
      unreachableGateway.bind({
        credentialId: "fallback-test",
        port: 0,
        expiresAt: new Date(Date.now() + 60_000),
        allowedNetworks: { ipv4: ["127.0.0.1/32"], ipv6: [] },
      });

      // Wait a tick for fallback to activate
      await Bun.sleep(100);

      const port = unreachableGateway.boundPort("fallback-test");
      expect(port).not.toBeNull();
      expect(unreachableGateway.hasBinding("fallback-test")).toBe(true);
    } finally {
      unreachableGateway.close();
    }
  });
});
