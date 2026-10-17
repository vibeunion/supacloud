import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createCollaboraDocumentConverter, createDocumentConverterFromEnvironment } from "../src/document-conversion.js";
import { createDocumentConversionTask } from "../examples/document-conversion-worker.js";

const limit = 500 * 1024 * 1024;
const settings = {
  enabled: true,
  projectRef: "size-test",
  renderProfile: "size-v1",
  baseUrl: "https://conversion.test.invalid",
};
function input(bytes: Uint8Array) {
  return {
    projectRef: settings.projectRef, renderProfile: settings.renderProfile,
    filename: "source.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const pdf = () => new Response("%PDF-1.7\n%%EOF\n", { headers: { "content-type": "application/pdf" } });

test("document defaults accept an input above the old 25 MiB ceiling", async () => {
  const bytes = new Uint8Array(26 * 1024 * 1024);
  bytes.set([0x50, 0x4b, 3, 4]);
  let calls = 0;
  const converter = createCollaboraDocumentConverter({
    ...settings,
    fetch: async (_url, init) => {
      calls++;
      expect(init.body).toBeInstanceOf(FormData);
      if (!(init.body instanceof FormData)) throw new Error("Expected form");
      const file = init.body.get("data");
      expect(file).toBeInstanceOf(Blob);
      if (!(file instanceof Blob)) throw new Error("Expected file");
      expect(file.size).toBe(bytes.byteLength);
      return pdf();
    },
  });
  expect((await converter.convert(input(bytes))).mimeType).toBe("application/pdf");
  expect(calls).toBe(1);
});

test("document input configuration accepts 500 MiB, rejects more, and retains lower limits", async () => {
  expect(createCollaboraDocumentConverter({ ...settings, maxInputBytes: limit }).enabled).toBe(true);
  expect(() => createCollaboraDocumentConverter({ ...settings, maxInputBytes: limit + 1 }))
    .toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
  const converter = createCollaboraDocumentConverter({ ...settings, maxInputBytes: 4,
    fetch: async () => { throw new Error("Must not send"); } });
  await expect(converter.convert(input(new Uint8Array([0x50, 0x4b, 3, 4, 0]))))
    .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_INPUT_TOO_LARGE" });
});

const environment = {
    SUPACLOUD_DOCUMENT_CONVERSION_ENABLED: "true",
    SUPACLOUD_DOCUMENT_CONVERSION_ENGINE: "collabora-online",
    SUPACLOUD_PROJECT_REF: settings.projectRef,
    SUPACLOUD_DOCUMENT_CONVERSION_RENDER_PROFILE: settings.renderProfile,
    SUPACLOUD_DOCUMENT_CONVERSION_URL: settings.baseUrl,
};

test("document environment configuration captures and enforces both processing limits", async () => {
  const env = { ...environment,
    SUPACLOUD_DOCUMENT_CONVERSION_MAX_INPUT_BYTES: "4",
    SUPACLOUD_DOCUMENT_CONVERSION_MAX_OUTPUT_BYTES: "8",
  };
  let calls = 0;
  const converter = createDocumentConverterFromEnvironment(env, async () => { calls++; return pdf(); });
  env.SUPACLOUD_DOCUMENT_CONVERSION_MAX_INPUT_BYTES = String(limit);
  expect(converter.maxInputBytes).toBe(4);
  expect(converter.maxOutputBytes).toBe(8);
  await expect(converter.convert(input(new Uint8Array([0x50, 0x4b, 3, 4, 0]))))
    .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_INPUT_TOO_LARGE" });
  expect(calls).toBe(0);
  await expect(converter.convert(input(new Uint8Array([0x50, 0x4b, 3, 4]))))
    .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE" });
  expect(calls).toBe(1);
  const defaults = createDocumentConverterFromEnvironment(environment);
  expect(defaults.maxInputBytes).toBe(limit);
  expect(defaults.maxOutputBytes).toBe(limit);
});

test("document environment limits fail closed for malformed values", () => {
  for (const key of ["SUPACLOUD_DOCUMENT_CONVERSION_MAX_INPUT_BYTES", "SUPACLOUD_DOCUMENT_CONVERSION_MAX_OUTPUT_BYTES"]) {
    for (const value of ["0", "-1", "1.5", "NaN", "", "1e6", "500MiB", String(limit + 1), "9007199254740992"]) {
      expect(() => createDocumentConverterFromEnvironment({ ...environment, [key]: value }))
        .toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
    }
  }
});

test("document task download uses its converter input limit", async () => {
  const source = input(new Uint8Array([0x50, 0x4b, 3, 4]));
  const converter = createDocumentConverterFromEnvironment({
    ...environment, SUPACLOUD_DOCUMENT_CONVERSION_MAX_INPUT_BYTES: "4",
  }, async () => pdf());
  let published = 0;
  const task = createDocumentConversionTask({ ...settings, converter }, {
    authorize: async () => true,
    read: async (_source, maxBytes) => { expect(maxBytes).toBe(4); return source.bytes; },
    publish: async () => { published++; },
  });
  await task.execute({
    operationId: "op", projectRef: source.projectRef, renderProfile: source.renderProfile,
    artifactId: "artifact", revision: "1", filename: source.filename, mimeType: source.mimeType, sha256: source.sha256,
  }, {
    projectRef: source.projectRef, queueName: "queue", taskKey: "convert",
    idempotencyKey: "op", messageId: "1", attempt: 1, signal: new AbortController().signal,
  });
  expect(published).toBe(1);
});

test("document default rejects a declared oversize buffer before copying or transport", async () => {
  // Exercise the byte-length fence without allocating half a GiB in a unit test.
  class OversizedBytes extends Uint8Array {
    override get byteLength() { return limit + 1; }
  }
  let calls = 0;
  const converter = createCollaboraDocumentConverter({ ...settings, fetch: async () => { calls++; return pdf(); } });
  const valid = input(new Uint8Array([0x50, 0x4b, 3, 4]));
  await expect(converter.convert({ ...valid, bytes: new OversizedBytes(4) }))
    .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_INPUT_TOO_LARGE" });
  expect(calls).toBe(0);
});

test("document output ceiling is 500 MiB", async () => {
  expect(createCollaboraDocumentConverter({ ...settings, maxOutputBytes: limit }).enabled).toBe(true);
  expect(() => createCollaboraDocumentConverter({ ...settings, maxOutputBytes: limit + 1 }))
    .toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
  const converter = createCollaboraDocumentConverter({
    ...settings,
    fetch: async () => new Response("%PDF-1.7\n", { headers: {
      "content-type": "application/pdf", "content-length": String(500 * 1024 * 1024 + 1),
    } }),
  });
  await expect(converter.convert(input(new Uint8Array([0x50, 0x4b, 3, 4]))))
    .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE" });
});

test("document default accepts PDF output larger than the old 64 MiB ceiling", async () => {
  const bytes = new Uint8Array(65 * 1024 * 1024);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  bytes.set(new TextEncoder().encode("%%EOF\n"), bytes.length - 6);
  const converter = createCollaboraDocumentConverter({
    ...settings,
    fetch: async () => new Response(bytes, { headers: { "content-type": "application/pdf" } }),
  });
  const result = await converter.convert(input(new Uint8Array([0x50, 0x4b, 3, 4])));
  expect(result.bytes.byteLength).toBe(bytes.byteLength);
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
});
