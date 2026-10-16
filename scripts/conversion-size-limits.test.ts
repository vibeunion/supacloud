import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createCollaboraDocumentConverter } from "../packages/worker/src/document-conversion";
import { transformImage } from "../packages/supacloud-lite/src/runtime/storage/image-transform";

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

test("document output ceiling remains 64 MiB", async () => {
  const converter = createCollaboraDocumentConverter({
    ...settings,
    fetch: async () => new Response("%PDF-1.7\n", { headers: {
      "content-type": "application/pdf", "content-length": String(64 * 1024 * 1024 + 1),
    } }),
  });
  await expect(converter.convert(input(new Uint8Array([0x50, 0x4b, 3, 4]))))
    .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE" });
});

test("image declared-size boundary accepts 500 MiB and rejects the next byte", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=",
    "base64",
  );
  const options = { resize: "contain", format: "png" } as const;
  expect((await transformImage(png, options, limit)).ok).toBe(true);
  expect(await transformImage(png, options, limit + 1)).toMatchObject({
    ok: false, status: 413, message: "The source image exceeds the 500MB transformation limit",
  });
  class OversizedBlob extends Blob {
    override get size() { return limit + 1; }
  }
  expect(await transformImage(new OversizedBlob(), options, 1)).toMatchObject({ ok: false, status: 413 });
});
