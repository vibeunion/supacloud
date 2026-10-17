import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createDocumentConverterFromEnvironment,
  createCollaboraDocumentConverter,
  type DocumentConverterOptions,
} from "../src/document-conversion.js";
import {
  createDocumentConversionTask,
  type DocumentConversionDomain,
} from "../examples/document-conversion-worker.js";
import type { TaskContext } from "../src/queue-handler.js";

const mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const source = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
const sha256 = createHash("sha256").update(source).digest("hex");
const input = {
  projectRef: "project-a",
  renderProfile: "collabora-fonts-v1",
  filename: "source.docx",
  mimeType,
  sha256,
  bytes: source,
};
const pdf = "%PDF-1.7\n%%EOF\n";
const pdfResponse = () => new Response(pdf, { headers: { "content-type": "application/pdf" } });
function converter(options: DocumentConverterOptions = {}) {
  return createCollaboraDocumentConverter({
    enabled: true, projectRef: input.projectRef, renderProfile: input.renderProfile,
    baseUrl: "http://collabora.internal", fetch: async () => pdfResponse(), ...options,
  });
}

describe("optional document conversion", () => {
  test("is disabled by default without making a request", async () => {
    let calls = 0;
    const converter = createDocumentConverterFromEnvironment({}, async () => {
      calls++;
      return new Response();
    });

    expect(converter.enabled).toBe(false);
    await expect(converter.convert(input)).rejects.toMatchObject({
      code: "DOCUMENT_CONVERSION_DISABLED",
    });
    expect(calls).toBe(0);
  });

  test("uploads bytes to the fixed Collabora route and returns checked PDF metadata", async () => {
    let request: Request | undefined;
    const converter = createCollaboraDocumentConverter({
      enabled: true,
      projectRef: "project-a",
      renderProfile: "collabora-fonts-v1",
      baseUrl: "http://collabora.internal/",
      bearerToken: "gateway-token",
      fetch: async (url, init) => {
        request = new Request(url, init);
        return new Response("%PDF-1.7\n%%EOF\n", {
          headers: { "content-type": "application/pdf" },
        });
      },
    });

    const result = await converter.convert(input);
    expect(result.filename).toBe("source.pdf");
    expect(result.engine).toBe("collabora-online");
    expect(result.sourceSha256).toBe(sha256);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(request?.url).toBe("http://collabora.internal/cool/convert-to/pdf");
    expect(request?.redirect).toBe("error");
    expect(request?.headers.get("authorization")).toBe("Bearer gateway-token");
    const form = await request?.formData();
    const file = form?.get("data");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("source.docx");
    expect((file as File).type).toBe(mimeType);
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(source);
  });

  test("rejects a changed source before calling the engine", async () => {
    let calls = 0;
    const converter = createCollaboraDocumentConverter({
      enabled: true,
      projectRef: "project-a",
      renderProfile: "collabora-fonts-v1",
      baseUrl: "http://collabora.internal",
      fetch: async () => {
        calls++;
        return new Response("%PDF-1.7\n%%EOF\n", {
          headers: { "content-type": "application/pdf" },
        });
      },
    });

    await expect(converter.convert({ ...input, sha256: "0".repeat(64) })).rejects.toMatchObject({
      code: "DOCUMENT_CONVERSION_CHECKSUM_MISMATCH",
    });
    expect(calls).toBe(0);
  });

  test("rejects oversized input, invalid PDF and unsafe feature configuration", async () => {
    const fetcher = async () => new Response("<html>", {
      headers: { "content-type": "text/html" },
    });
    const converter = createCollaboraDocumentConverter({
      enabled: true,
      projectRef: "project-a",
      renderProfile: "collabora-fonts-v1",
      baseUrl: "http://collabora.internal",
      maxInputBytes: source.byteLength,
      fetch: fetcher,
    });

    const oversized = new Uint8Array(source.byteLength + 1);
    oversized.set(source);
    await expect(converter.convert({
      ...input,
      bytes: oversized,
      sha256: createHash("sha256").update(oversized).digest("hex"),
    })).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_INPUT_TOO_LARGE" });
    await expect(converter.convert(input)).rejects.toMatchObject({
      code: "DOCUMENT_CONVERSION_RESPONSE_INVALID",
    });
    expect(() => createCollaboraDocumentConverter({
      enabled: true,
      projectRef: "project-a",
      renderProfile: "collabora-fonts-v1",
      baseUrl: "https://collabora.internal/?url=unsafe",
    })).toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
    expect(() => createDocumentConverterFromEnvironment({
      SUPACLOUD_DOCUMENT_CONVERSION_ENABLED: "maybe",
    })).toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
  });

  test("strict configuration remains default off and captures enabled configuration", async () => {
    expect(createCollaboraDocumentConverter().enabled).toBe(false);
    expect(createDocumentConverterFromEnvironment({
      SUPACLOUD_DOCUMENT_CONVERSION_ENABLED: "false",
      SUPACLOUD_DOCUMENT_CONVERSION_URL: "invalid but unused",
    }).enabled).toBe(false);
    for (const value of ["TRUE", "1", " true ", ""]) {
      expect(() => createDocumentConverterFromEnvironment({
        SUPACLOUD_DOCUMENT_CONVERSION_ENABLED: value,
      })).toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
    }
    for (const options of [
      { projectRef: "" }, { renderProfile: "" }, { maxInputBytes: NaN },
      { maxOutputBytes: 501 * 1024 * 1024 }, { timeoutMs: 120001 },
      { maxConcurrent: 0 }, { maxConcurrent: 5 }, { bearerToken: "secret\nheader" },
      { baseUrl: "https://user:secret@engine/" }, { baseUrl: "file:///tmp/" },
      { baseUrl: "https://engine/path" }, { baseUrl: "https://engine/#token" },
    ]) expect(() => converter(options)).toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
    expect(() => createDocumentConverterFromEnvironment({
      SUPACLOUD_DOCUMENT_CONVERSION_ENABLED: "true",
    })).toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");

    const environment = {
      SUPACLOUD_DOCUMENT_CONVERSION_ENABLED: "true",
      SUPACLOUD_DOCUMENT_CONVERSION_ENGINE: "collabora-online",
      SUPACLOUD_PROJECT_REF: input.projectRef,
      SUPACLOUD_DOCUMENT_CONVERSION_RENDER_PROFILE: input.renderProfile,
      SUPACLOUD_DOCUMENT_CONVERSION_URL: "http://collabora.internal",
    };
    const instance = createDocumentConverterFromEnvironment(environment, async () => pdfResponse());
    environment.SUPACLOUD_PROJECT_REF = "other";
    expect((await instance.convert(input)).projectRef).toBe("project-a");
  });

  test("cross-project/profile, unsupported format and path inputs never reach transport", async () => {
    let calls = 0;
    const instance = converter({ fetch: async () => { calls++; return pdfResponse(); } });
    for (const changed of [{ projectRef: "project-b" }, { renderProfile: "other" }]) {
      await expect(instance.convert({ ...input, ...changed })).rejects.toMatchObject({
        code: "DOCUMENT_CONVERSION_FORBIDDEN",
      });
    }
    for (const filename of ["source.docm", "source.pptx", "source.xlsx", "source.pdf"]) {
      await expect(instance.convert({ ...input, filename })).rejects.toMatchObject({
        code: "DOCUMENT_CONVERSION_UNSUPPORTED_FORMAT",
      });
    }
    for (const filename of ["../source.docx", "C:\\source.docx", "source\n.docx"]) {
      await expect(instance.convert({ ...input, filename })).rejects.toMatchObject({
        code: "DOCUMENT_CONVERSION_INPUT_INVALID",
      });
    }
    await expect(instance.convert({ ...input, bytes: new Uint8Array([1, 2, 3, 4]) }))
      .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_INPUT_INVALID" });
    expect(calls).toBe(0);
  });

  test("accepts XLSX without adding print overrides or transmitting original filename", async () => {
    const instance = converter({ fetch: async (_url, init) => {
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect([...form.keys()].sort()).toEqual([
        "data",
      ]);
      expect(form.has("FullSheetPreview")).toBe(false);
      expect(form.has("PDFVer")).toBe(false);
      const file = form.get("data");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("source.xlsx");
      return pdfResponse();
    } });
    const result = await instance.convert({
      ...input, filename: "\u62a5\u544a.XLSX",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(result.filename).toBe("\u62a5\u544a.pdf");
    expect(result.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
  });

  test("enabled environments require explicit Collabora selection without fallback", () => {
    const environment = {
      SUPACLOUD_DOCUMENT_CONVERSION_ENABLED: "true",
      SUPACLOUD_PROJECT_REF: input.projectRef,
      SUPACLOUD_DOCUMENT_CONVERSION_RENDER_PROFILE: input.renderProfile,
      SUPACLOUD_DOCUMENT_CONVERSION_URL: "http://collabora.internal",
    };
    expect(() => createDocumentConverterFromEnvironment(environment)).toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
    for (const engine of ["auto", "onlyoffice", "gotenberg", "libreoffice", "Collabora", ""]) {
      expect(() => createDocumentConverterFromEnvironment({
        ...environment, SUPACLOUD_DOCUMENT_CONVERSION_ENGINE: engine,
      })).toThrow("DOCUMENT_CONVERSION_CONFIG_INVALID");
    }
  });

  test("real HTTP transport uses Collabora multipart for DOCX and XLSX", async () => {
    let calls = 0;
    const observed: { path: string; method: string; keys: string[]; name: string; type: string; bytes: Uint8Array; auth: string | null }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        calls++;
        const form = await request.formData();
        const file = form.get("data");
        if (!(file instanceof File)) return new Response("missing data", { status: 400 });
        observed.push({
          path: new URL(request.url).pathname, method: request.method, keys: [...form.keys()],
          name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()),
          auth: request.headers.get("authorization"),
        });
        return pdfResponse();
      },
    });
    try {
      const instance = converter({
        baseUrl: server.url.origin, bearerToken: "gateway-token", fetch: (url, init) => fetch(url, init),
      });
      for (const [format, type] of [
        ["docx", mimeType],
        ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ] as const) {
        const result = await instance.convert({ ...input, filename: `confidential.${format}`, mimeType: type });
        expect(result).toMatchObject({
          filename: "confidential.pdf", engine: "collabora-online",
          projectRef: input.projectRef, renderProfile: input.renderProfile, sourceSha256: sha256,
        });
        expect(observed.at(-1)).toEqual({
          path: "/cool/convert-to/pdf", method: "POST", keys: ["data"],
          name: `source.${format}`, type, bytes: source, auth: "Bearer gateway-token",
        });
      }
      expect(calls).toBe(2);
    } finally { await server.stop(true); }
  });

  test("copies source bytes and captures metadata before awaiting transport", async () => {
    const mutable = { ...input, bytes: new Uint8Array(source) };
    const instance = converter({ fetch: async (_url, init) => {
      mutable.bytes.fill(0);
      mutable.filename = "changed.docx";
      mutable.sha256 = "0".repeat(64);
      const form = init.body as FormData;
      const file = form.get("data") as File;
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(source);
      return pdfResponse();
    } });
    expect(await instance.convert(mutable)).toMatchObject({
      filename: "source.pdf", sourceSha256: sha256,
    });
  });

  test("rejects fake PDFs, absent bodies, HTML, partial responses and redirects", async () => {
    for (const response of [
      new Response("fake", { headers: { "content-type": "application/pdf" } }),
      new Response("%PDF-1.7\ntruncated", { headers: { "content-type": "application/pdf" } }),
      new Response(null, { headers: { "content-type": "application/pdf" } }),
      new Response(pdf, { headers: { "content-type": "text/html" } }),
    ]) {
      await expect(converter({ fetch: async () => response }).convert(input))
        .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_RESPONSE_INVALID" });
    }
    for (const status of [202, 206, 301, 302, 307, 400, 401, 413, 429, 503]) {
      const response = new Response("secret upstream details", { status });
      await expect(converter({ fetch: async () => response }).convert(input))
        .rejects.toMatchObject({
          code: status === 413 ? "DOCUMENT_CONVERSION_INPUT_TOO_LARGE" : "DOCUMENT_CONVERSION_HTTP_ERROR",
          retryable: status === 429 || status >= 500,
        });
      expect(response.bodyUsed).toBe(true);
    }
  });

  test("native fetch refuses redirect without forwarding source or token", async () => {
    let destinationCalls = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { destinationCalls++; return pdfResponse(); },
    });
    const redirector = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { return Response.redirect(destination.url, 307); },
    });
    try {
      const instance = converter({
        baseUrl: redirector.url.origin, bearerToken: "secret", fetch: (url, init) => fetch(url, init),
      });
      await expect(instance.convert(input)).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_HTTP_ERROR" });
      expect(destinationCalls).toBe(0);
    } finally {
      await redirector.stop(true);
      await destination.stop(true);
    }
  });

  test("rejects declared and streamed oversized output and cancels streams", async () => {
    for (const advertised of [true, false]) {
      let cancelled = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(pdf)); },
        cancel() { cancelled = true; },
      }), {
        headers: {
          "content-type": "application/pdf",
          ...(advertised ? { "content-length": "9999" } : {}),
        },
      });
      await expect(converter({ maxOutputBytes: 8, fetch: async () => response }).convert(input))
        .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE" });
      expect(cancelled).toBe(true);
    }
    await expect(converter({ fetch: async () => new Response(pdf, {
      headers: { "content-type": "application/pdf", "content-length": "not-a-number" },
    }) }).convert(input)).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_RESPONSE_INVALID" });
  });

  test("deadline covers stalled transport and stalled response bodies", async () => {
    await expect(converter({
      timeoutMs: 10, fetch: () => new Promise<Response>(() => {}),
    }).convert(input)).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_TIMEOUT", retryable: true });
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("%PDF-1.7\n")); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/pdf" } });
    await expect(converter({ timeoutMs: 10, fetch: async () => response }).convert(input))
      .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_TIMEOUT" });
    expect(cancelled).toBe(true);
  });

  test("cancellation is redacted and releases local capacity", async () => {
    let calls = 0;
    const instance = converter({ fetch: async (_url, init) => {
      calls++;
      if (calls > 1) return pdfResponse();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("secret engine URL")), { once: true });
      });
    } });
    const controller = new AbortController();
    const pending = instance.convert(input, controller.signal);
    await expect(instance.convert(input)).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_BUSY", retryable: true });
    controller.abort(new Error("secret caller reason"));
    await expect(pending).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_CANCELLED" });
    expect((await instance.convert(input)).sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(instance.convert(input, controller.signal))
      .rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_CANCELLED" });
    expect(calls).toBe(2);
  });

  test("errors do not retain credentials or raw upstream failures", async () => {
    try {
      await converter({ fetch: async () => { throw new Error("https://user:secret@engine"); } }).convert(input);
      throw new Error("expected conversion failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "DOCUMENT_CONVERSION_HTTP_ERROR" });
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("engine");
    }
  });
});

describe("document conversion worker integration boundary", () => {
  const sourceRequest = {
    operationId: "op-1", artifactId: "artifact-1", revision: "revision-1",
    projectRef: input.projectRef, renderProfile: input.renderProfile,
    filename: input.filename, mimeType, sha256,
  };
  function context(): TaskContext {
    return {
      projectRef: input.projectRef, queueName: "scw_conversion", taskKey: "document.convert",
      idempotencyKey: "op-1", messageId: "1", attempt: 1, signal: new AbortController().signal,
    };
  }
  function fixture(options: DocumentConverterOptions = {}) {
    const events: string[] = [];
    const domain: DocumentConversionDomain = {
      async authorize() { events.push("authorize"); return true; },
      async read(_request, maxBytes) {
        expect(maxBytes).toBe(500 * 1024 * 1024);
        events.push("read");
        return source;
      },
      async publish(request, result, ctx) {
        events.push("publish");
        expect(request.operationId).toBe(ctx.idempotencyKey);
        expect(result.sourceSha256).toBe(request.sha256);
        expect(result.renderProfile).toBe(request.renderProfile);
      },
    };
    const instance = converter({
      fetch: async () => { events.push("convert"); return pdfResponse(); }, ...options,
    });
    const task = createDocumentConversionTask({
      projectRef: input.projectRef, renderProfile: input.renderProfile, converter: instance,
    }, domain);
    return { task, domain, events };
  }

  test("reauthorizes before private publication and carries durable operation identity", async () => {
    const { task, events } = fixture();
    await task.execute(task.decode(sourceRequest), context());
    expect(events).toEqual(["authorize", "read", "convert", "authorize", "publish"]);
  });

  test("disabled or mismatched projects/operations do not read source data", async () => {
    const disabled = fixture({ enabled: false });
    await expect(disabled.task.execute(sourceRequest, context())).rejects.toMatchObject({
      code: "DOCUMENT_CONVERSION_DISABLED",
    });
    expect(disabled.events).toEqual([]);
    const { task, events } = fixture();
    for (const changed of [{ projectRef: "other" }, { idempotencyKey: "op-2" }]) {
      await expect(task.execute(sourceRequest, { ...context(), ...changed })).rejects.toMatchObject({
        code: "DOCUMENT_CONVERSION_FORBIDDEN",
      });
    }
    expect(events).toEqual([]);
  });

  test("failure or revoked access does not publish any result", async () => {
    const failed = fixture({ fetch: async () => new Response("unavailable", { status: 503 }) });
    await expect(failed.task.execute(sourceRequest, context())).rejects.toMatchObject({
      code: "DOCUMENT_CONVERSION_HTTP_ERROR",
    });
    expect(failed.events).toEqual(["authorize", "read"]);
    const revoked = fixture();
    let authorizations = 0;
    revoked.domain.authorize = async () => ++authorizations === 1;
    await expect(revoked.task.execute(sourceRequest, context())).rejects.toMatchObject({
      code: "DOCUMENT_CONVERSION_FORBIDDEN",
    });
    expect(revoked.events).toEqual(["read", "convert"]);
  });

  test("queue decoder rejects URLs/extras and snapshots operation identity", () => {
    const { task } = fixture();
    for (const value of [null, {}, { ...sourceRequest, url: "https://private/" }, { ...sourceRequest, operationId: 42 }]) {
      expect(() => task.decode(value)).toThrow("DOCUMENT_CONVERSION_INPUT_INVALID");
    }
    const mutable = { ...sourceRequest };
    const decoded = task.decode(mutable);
    mutable.operationId = "op-2";
    expect(decoded.operationId).toBe("op-1");
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  test("cancellation after reading prevents conversion and publication", async () => {
    const { task, domain, events } = fixture();
    const controller = new AbortController();
    domain.read = async () => {
      events.push("read");
      controller.abort();
      return source;
    };
    await expect(task.execute(sourceRequest, { ...context(), signal: controller.signal })).rejects.toThrow();
    expect(events).toEqual(["authorize", "read"]);
  });
});
