import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type Subprocess } from "bun";

const repoRoot = join(import.meta.dir, "../../../..");
const readRepoFile = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

test("config.env configures native rust image engine with imagor fallback", () => {
  const template = readRepoFile("config.env");
  expect(template).toContain('SUPACLOUD_IMAGE_ENGINE="rust"');
  expect(template).toContain('IMAGOR_IMAGE="shumc/imagor:1.9.8"');
});

test("install.sh declares rust image engine deployment and fallback", () => {
  const installer = readRepoFile("install.sh");
  expect(installer).toContain("SUPACLOUD_IMAGE_ENGINE");
  expect(installer).toContain("install_rust_image_binary()");
  expect(installer).toContain("deploy_rust_image_service()");
  expect(installer).toContain("supacloud-image.service");
  expect(installer).toContain("scripts/build_supacloud_image.sh");
});

test("supacloud-image systemd unit has sandboxing and memory limits", () => {
  const unit = readRepoFile("infrastructure/systemd/supacloud-image.service");
  expect(unit).toContain("Description=SupaCloud Image Service (Rust)");
  expect(unit).toContain("Environment=IMAGE_SERVICE_PORT=9010");
  expect(unit).toContain("Environment=IMAGE_SERVICE_HOST=127.0.0.1");
  expect(unit).toContain("NoNewPrivileges=true");
  expect(unit).toContain("MemoryHigh=256M");
  expect(unit).toContain("MemoryMax=512M");
});

test("scripts/build_supacloud_image.sh exists and references crates/image-service", () => {
  const buildScript = readRepoFile("scripts/build_supacloud_image.sh");
  expect(buildScript).toContain("crates/image-service");
  expect(buildScript).toContain("cargo build --release");
});

// A valid 2x2 red PNG image with correct IDAT chunk CRC
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";
const tinyPngBytes = Buffer.from(TINY_PNG_BASE64, "base64");

const TEST_PORT = 9876;
const binaryPath = join(repoRoot, "crates/image-service/target/release/supacloud-image-service");
const binaryAvailable = existsSync(binaryPath);
let proc: Subprocess | null = null;

beforeAll(async () => {
  if (!binaryAvailable) return;
  proc = spawn({
    cmd: [binaryPath],
    env: {
      ...process.env,
      IMAGE_SERVICE_HOST: "127.0.0.1",
      IMAGE_SERVICE_PORT: String(TEST_PORT),
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  // Poll for healthcheck readiness
  const start = Date.now();
  let healthy = false;
  while (Date.now() - start < 5000) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/healthcheck`);
      if (res.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      await Bun.sleep(100);
    }
  }
  if (!healthy) {
    proc.kill();
    throw new Error("supacloud-image-service failed to start in test harness");
  }
});

afterAll(() => {
  if (proc) {
    proc.kill();
  }
});

test.skipIf(!binaryAvailable)("native Rust image service responds to /healthcheck", async () => {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/healthcheck`);
  expect(res.status).toBe(200);
  expect(res.headers.get("x-image-engine")).toBe("supacloud-image/rust");
  const data = (await res.json()) as { status: string; engine: string };
  expect(data.status).toBe("healthy");
  expect(data.engine).toBe("supacloud-image/rust");
});

test.skipIf(!binaryAvailable)("transforms PNG to WebP with SIMD resize and custom filters", async () => {
  const res = await fetch(
    `http://127.0.0.1:${TEST_PORT}/fit-in/100x100/filters:format(webp):quality(80):brightness(10)/`,
    {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: tinyPngBytes,
    },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("x-image-engine")).toBe("supacloud-image/rust");
  expect(res.headers.get("content-type")).toBe("image/webp");
  const buffer = await res.arrayBuffer();
  expect(buffer.byteLength).toBeGreaterThan(0);

  // Check WebP header (RIFF....WEBP)
  const header = new Uint8Array(buffer.slice(0, 4));
  const magic = String.fromCharCode(...header);
  expect(magic).toBe("RIFF");
});

test.skipIf(!binaryAvailable)("extracts image metadata JSON using /meta/", async () => {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/meta/`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: tinyPngBytes,
  });

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  const meta = (await res.json()) as { width: number; height: number; format: string };
  expect(meta.width).toBe(2);
  expect(meta.height).toBe(2);
  expect(meta.format).toBe("png");
});

test.skipIf(!binaryAvailable)("supports imgproxy Pro style auto format negotiation via Accept header", async () => {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/50x50/`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      Accept: "image/avif,image/webp,*/*",
    },
    body: tinyPngBytes,
  });

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
});
