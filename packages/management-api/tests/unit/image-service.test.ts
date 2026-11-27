import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type Subprocess } from "bun";

const repoRoot = join(import.meta.dir, "../../../..");
const apiRoot = join(repoRoot, "packages/management-api");
const serviceEntry = join(apiRoot, "src/image-service/main.ts");
const readRepoFile = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");
const nativeModuleAvailable = existsSync(join(apiRoot, "node_modules/@napi-rs/image"));
const serviceAvailable = existsSync(serviceEntry) && nativeModuleAvailable;

test("config.env does not deploy imagor", () => {
  const template = readRepoFile("config.env");
  expect(template).not.toContain("IMAGOR_IMAGE");
  expect(template).not.toContain("IMAGINARY_IMAGE");
  expect(template).not.toContain("shumc/imagor");
});

test("config.env exposes imgproxy signature settings", () => {
  const template = readRepoFile("config.env");
  expect(template).toContain("IMGPROXY_KEY");
  expect(template).toContain("IMGPROXY_SALT");
  expect(template).toContain("IMGPROXY_ALLOWED_SOURCES");
  expect(template).toContain("IMGPROXY_LOCAL_FILESYSTEM_ROOT");
  expect(template).toContain("IMGPROXY_SOURCE_URL_ENCRYPTION_KEY");
  expect(template).toContain("IMGPROXY_SECRET");
});

test("install.sh deploys the native image service without an imagor fallback", () => {
  const installer = readRepoFile("install.sh");
  expect(installer).toContain("install_image_service_binary()");
  expect(installer).toContain("deploy_image_service()");
  expect(installer).toContain("supacloud-image.service");
  expect(installer).toContain("scripts/build_supacloud_image.sh");
  expect(installer).toContain("IMGPROXY_KEY");
  expect(installer).toContain("IMGPROXY_SALT");
  expect(installer).toContain("IMGPROXY_ALLOWED_SOURCES");
  expect(installer).not.toContain("crates/image-service");
  expect(installer).not.toContain("install_rust_image_binary");
  expect(installer).not.toContain("deploy_rust_image_service");
  expect(installer).not.toContain("--name supacloud-imagor");
  expect(installer).not.toContain("IMAGOR_IMAGE");
});

test("supacloud-image systemd unit has sandboxing and memory limits", () => {
  const unit = readRepoFile("infrastructure/systemd/supacloud-image.service");
  expect(unit).toContain("Description=SupaCloud Image Service");
  expect(unit).toContain("Environment=IMAGE_SERVICE_PORT=9010");
  expect(unit).toContain("Environment=IMAGE_SERVICE_HOST=127.0.0.1");
  expect(unit).toContain("ExecStart=/usr/local/bin/supacloud-image");
  expect(unit).toContain("NoNewPrivileges=true");
  expect(unit).toContain("MemoryHigh=512M");
  expect(unit).toContain("MemoryMax=1G");
});

test("scripts/build_supacloud_image.sh compiles the Bun service", () => {
  const buildScript = readRepoFile("scripts/build_supacloud_image.sh");
  expect(buildScript).toContain("packages/management-api");
  expect(buildScript).toContain("bun build src/image-service/main.ts");
  expect(buildScript).toContain("--compile");
  expect(buildScript).not.toContain("cargo build");
});

// A valid 2x2 red PNG image with correct IDAT chunk CRC
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";
const tinyPngBytes = Buffer.from(TINY_PNG_BASE64, "base64");

const TEST_PORT = 9876;
let proc: Subprocess | null = null;

beforeAll(async () => {
  if (!serviceAvailable) return;
  proc = spawn({
    cmd: [process.execPath, serviceEntry],
    cwd: apiRoot,
    env: {
      ...process.env,
      IMAGE_SERVICE_HOST: "127.0.0.1",
      IMAGE_SERVICE_PORT: String(TEST_PORT),
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const start = Date.now();
  let healthy = false;
  while (Date.now() - start < 10000) {
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
    throw new Error("supacloud-image failed to start in test harness");
  }
});

afterAll(() => {
  if (proc) {
    proc.kill();
  }
});

test.skipIf(!serviceAvailable)("native image service responds to /healthcheck", async () => {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/healthcheck`);
  expect(res.status).toBe(200);
  expect(res.headers.get("x-image-engine")).toBe("supacloud-image/napi-rs");
  const data = (await res.json()) as { status: string; engine: string };
  expect(data.status).toBe("healthy");
  expect(data.engine).toBe("supacloud-image/napi-rs");
});

test.skipIf(!serviceAvailable)("transforms PNG to lossy WebP", async () => {
  const res = await fetch(
    `http://127.0.0.1:${TEST_PORT}/fit-in/100x100/filters:format(webp):quality(80):brightness(10)/`,
    {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: tinyPngBytes,
    },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("x-image-engine")).toBe("supacloud-image/napi-rs");
  expect(res.headers.get("content-type")).toBe("image/webp");
  const buffer = await res.arrayBuffer();
  expect(buffer.byteLength).toBeGreaterThan(0);
  expect(String.fromCharCode(...new Uint8Array(buffer.slice(0, 4)))).toBe("RIFF");
  expect(String.fromCharCode(...new Uint8Array(buffer.slice(8, 12)))).toBe("WEBP");
});

test.skipIf(!serviceAvailable)("extracts image metadata JSON using /meta/", async () => {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/meta/`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: tinyPngBytes,
  });

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  const meta = (await res.json()) as {
    width: number;
    height: number;
    format: string;
    has_alpha: boolean;
    size_bytes: number;
  };
  expect(meta.width).toBe(2);
  expect(meta.height).toBe(2);
  expect(meta.format).toBe("png");
  expect(meta.has_alpha).toBe(false);
  expect(meta.size_bytes).toBe(tinyPngBytes.byteLength);
});

test.skipIf(!serviceAvailable)("negotiates AVIF via Accept and sets Vary", async () => {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/50x50/`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      Accept: "image/avif,image/webp,*/*",
    },
    body: tinyPngBytes,
  });

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/avif");
  expect(res.headers.get("vary")).toBe("Accept");
});

test.skipIf(!serviceAvailable)("supports smartcrop", async () => {
  const res = await fetch(
    `http://127.0.0.1:${TEST_PORT}/fit-in/32x32/smart/filters:format(webp):quality(80)/`,
    {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: tinyPngBytes,
    },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
});

test.skipIf(!serviceAvailable)("applies a text watermark", async () => {
  const encoded = Buffer.from("ACME", "utf8").toString("base64url");
  const res = await fetch(
    `http://127.0.0.1:${TEST_PORT}/fit-in/64x0/filters:format(webp):quality(80):text(b64%3A${encoded},center,bottom,sans%20bold%2024,white,80,,0,low,false,word)/`,
    {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: tinyPngBytes,
    },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
});

test.skipIf(!serviceAvailable)("applies an image watermark from the request header", async () => {
  const res = await fetch(
    `http://127.0.0.1:${TEST_PORT}/fit-in/64x0/filters:format(webp):quality(80):watermark(b64%3AaHR0cDovL2V4YW1wbGUuY29tL3dtLnBuZw,center,center,50,16,16)/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-SupaCloud-Watermark-Image": tinyPngBytes.toString("base64"),
      },
      body: tinyPngBytes,
    },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
});

test.skipIf(!serviceAvailable)("accepts AVIF input", async () => {
  const { Transformer } = await import("@napi-rs/image");
  const avif = new Transformer(tinyPngBytes).avifSync({ quality: 60, speed: 6 });
  const res = await fetch(
    `http://127.0.0.1:${TEST_PORT}/fit-in/64x0/filters:format(webp):quality(80)/`,
    {
      method: "POST",
      headers: { "Content-Type": "image/avif" },
      body: avif,
    },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
});

test.skipIf(!serviceAvailable)("rejects an empty payload", async () => {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/fit-in/100x100/`, {
    method: "POST",
    body: new Uint8Array(),
  });

  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Empty image payload");
});
