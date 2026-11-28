import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOfficeConverterFromEnvironment,
  createOfficeOxideConverter,
  OfficeConversionError,
  type OfficeConverterOptions,
} from "../src/office-conversion.js";
import {
  createOfficeConversionTask,
  type OfficeConversionDomain,
} from "../examples/office-conversion-worker.js";
import type { TaskContext } from "../src/queue-handler.js";

const formats = {
  doc: {
    filename: "source.doc",
    mimeType: "application/msword",
    target: "docx",
    outputMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xls: {
    filename: "source.xls",
    mimeType: "application/vnd.ms-excel",
    target: "xlsx",
    outputMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  ppt: {
    filename: "source.ppt",
    mimeType: "application/vnd.ms-powerpoint",
    target: "pptx",
    outputMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
} as const;

const source = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x01, 0x02, 0x03,
]);
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const projectRef = "project-a";
const renderProfile = "office-oxide-v1";

function input(format: keyof typeof formats = "doc") {
  const value = formats[format];
  return {
    projectRef,
    renderProfile,
    filename: value.filename,
    mimeType: value.mimeType,
    sha256: sourceSha256,
    bytes: source,
  };
}

function converter(options: OfficeConverterOptions = {}) {
  return createOfficeOxideConverter({
    enabled: true,
    projectRef,
    renderProfile,
    runner: async (_inputPath, outputPath) => {
      await writeFile(outputPath, zip);
    },
    ...options,
  });
}

describe("optional Office conversion", () => {
  test("is disabled by default without starting a process", async () => {
    const converter = createOfficeConverterFromEnvironment({});
    expect(converter.enabled).toBe(false);
    await expect(converter.convert(input())).rejects.toMatchObject({
      code: "OFFICE_CONVERSION_DISABLED",
    });
  });

  test("maps DOC, XLS and PPT to their OOXML targets", async () => {
    for (const format of Object.keys(formats) as (keyof typeof formats)[]) {
      const result = await converter().convert(input(format));
      const expected = formats[format];
      expect(result).toMatchObject({
        filename: `source.${expected.target}`,
        mimeType: expected.outputMime,
        sourceFormat: format,
        targetFormat: expected.target,
        engine: "office-oxide",
        sourceSha256,
      });
      expect(result.bytes).toEqual(zip);
      expect(result.sha256).toBe(createHash("sha256").update(zip).digest("hex"));
    }
  });

  test("allows an injected runner without an executable and cleans its temp directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-office-test-"));
    const seen: { inputPath: string; outputPath: string }[] = [];
    try {
      const instance = converter({
        tempRoot: root,
        runner: async (inputPath, outputPath) => {
          seen.push({ inputPath, outputPath });
          await writeFile(outputPath, zip);
        },
      });
      await instance.convert(input());
      expect(seen).toHaveLength(1);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe formats, MIME pairs, non-OLE bytes and changed checksums", async () => {
    let calls = 0;
    const instance = converter({
      runner: async (_inputPath, outputPath) => {
        calls++;
        await writeFile(outputPath, zip);
      },
    });
    await expect(instance.convert({ ...input(), filename: "source.docx" }))
      .rejects.toMatchObject({ code: "OFFICE_CONVERSION_UNSUPPORTED_FORMAT" });
    await expect(instance.convert({ ...input(), mimeType: "application/octet-stream" }))
      .rejects.toMatchObject({ code: "OFFICE_CONVERSION_UNSUPPORTED_FORMAT" });
    await expect(instance.convert({ ...input(), filename: "../source.doc" }))
      .rejects.toMatchObject({ code: "OFFICE_CONVERSION_INPUT_INVALID" });
    await expect(instance.convert({
      ...input(),
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      sha256: createHash("sha256").update(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).digest("hex"),
    })).rejects.toMatchObject({ code: "OFFICE_CONVERSION_INPUT_INVALID" });
    await expect(instance.convert({ ...input(), sha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "OFFICE_CONVERSION_CHECKSUM_MISMATCH" });
    expect(calls).toBe(0);
  });

  test("rejects invalid output and enforces size limits", async () => {
    await expect(converter({
      runner: async (_inputPath, outputPath) => {
        await writeFile(outputPath, new Uint8Array([1, 2, 3, 4]));
      },
    }).convert(input())).rejects.toMatchObject({
      code: "OFFICE_CONVERSION_OUTPUT_INVALID",
    });
    await expect(converter({
      maxOutputBytes: zip.byteLength - 1,
      runner: async (_inputPath, outputPath) => {
        await writeFile(outputPath, zip);
      },
    }).convert(input())).rejects.toMatchObject({
      code: "OFFICE_CONVERSION_OUTPUT_TOO_LARGE",
    });
    const oversized = new Uint8Array(source.byteLength + 1);
    oversized.set(source);
    await expect(converter({
      maxInputBytes: source.byteLength,
    }).convert({
      ...input(),
      bytes: oversized,
      sha256: createHash("sha256").update(oversized).digest("hex"),
    })).rejects.toMatchObject({ code: "OFFICE_CONVERSION_INPUT_TOO_LARGE" });
  });

  test("supports timeout, cancellation and bounded concurrency", async () => {
    let release: (() => void) | undefined;
    const stalled = converter({
      timeoutMs: 10,
      runner: async () => new Promise<void>(resolve => { release = resolve; }),
    });
    await expect(stalled.convert(input())).rejects.toMatchObject({
      code: "OFFICE_CONVERSION_TIMEOUT",
      retryable: true,
    });
    release?.();

    const controller = new AbortController();
    let cancelled = false;
    const cancellable = converter({
      runner: async (_inputPath, _outputPath, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            cancelled = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    });
    const pending = cancellable.convert(input(), controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "OFFICE_CONVERSION_CANCELLED" });
    expect(cancelled).toBe(true);

    const busy = converter({
      timeoutMs: 10,
      runner: async (_inputPath, _outputPath, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const first = busy.convert(input());
    await expect(busy.convert(input())).rejects.toMatchObject({
      code: "OFFICE_CONVERSION_BUSY",
      retryable: true,
    });
    await expect(first).rejects.toMatchObject({
      code: "OFFICE_CONVERSION_TIMEOUT",
      retryable: true,
    });
  });

  test("validates environment and does not fallback to another engine", () => {
    expect(() => createOfficeConverterFromEnvironment({
      SUPACLOUD_OFFICE_CONVERSION_ENABLED: "maybe",
    })).toThrow("OFFICE_CONVERSION_CONFIG_INVALID");
    expect(() => createOfficeConverterFromEnvironment({
      SUPACLOUD_OFFICE_CONVERSION_ENABLED: "true",
      SUPACLOUD_OFFICE_CONVERSION_ENGINE: "libreoffice",
      SUPACLOUD_PROJECT_REF: projectRef,
      SUPACLOUD_OFFICE_CONVERSION_RENDER_PROFILE: renderProfile,
      SUPACLOUD_OFFICE_CONVERSION_BIN: "/usr/local/bin/converter",
    })).toThrow("OFFICE_CONVERSION_CONFIG_INVALID");
    expect(() => createOfficeOxideConverter({
      enabled: true,
      projectRef,
      renderProfile,
    })).toThrow("OFFICE_CONVERSION_CONFIG_INVALID");
    expect(createOfficeConverterFromEnvironment({
      SUPACLOUD_OFFICE_CONVERSION_ENABLED: "false",
      SUPACLOUD_OFFICE_CONVERSION_BIN: "unused",
    }).enabled).toBe(false);
  });
});

describe("Office conversion worker integration boundary", () => {
  const request = {
    operationId: "op-1",
    projectRef,
    renderProfile,
    artifactId: "artifact-1",
    revision: "revision-1",
    filename: formats.doc.filename,
    mimeType: formats.doc.mimeType,
    sha256: sourceSha256,
  };

  function context(): TaskContext {
    return {
      projectRef,
      queueName: "scw_office",
      taskKey: "office.convert",
      idempotencyKey: "op-1",
      messageId: "1",
      attempt: 1,
      signal: new AbortController().signal,
    };
  }

  function fixture() {
    const events: string[] = [];
    const domain: OfficeConversionDomain = {
      async authorize() {
        events.push("authorize");
        return true;
      },
      async read(_source, maxBytes) {
        expect(maxBytes).toBe(500 * 1024 * 1024);
        events.push("read");
        return source;
      },
      async publish(sourceValue, result, taskContext) {
        events.push("publish");
        expect(sourceValue.operationId).toBe(taskContext.idempotencyKey);
        expect(result.sourceSha256).toBe(sourceValue.sha256);
      },
    };
    const instance = converter({
      runner: async (_inputPath, outputPath) => {
        events.push("convert");
        await writeFile(outputPath, zip);
      },
    });
    return {
      task: createOfficeConversionTask({
        projectRef,
        renderProfile,
        converter: instance,
      }, domain),
      domain,
      events,
    };
  }

  test("authorizes, reads, converts, reauthorizes and publishes in order", async () => {
    const { task, events } = fixture();
    await task.execute(task.decode(request), context());
    expect(events).toEqual(["authorize", "read", "convert", "authorize", "publish"]);
  });

  test("revoked access prevents publication and decoder snapshots queue input", async () => {
    const { task, domain, events } = fixture();
    let authorizations = 0;
    domain.authorize = async () => {
      events.push("authorize");
      return ++authorizations === 1;
    };
    await expect(task.execute(request, context())).rejects.toMatchObject({
      code: "OFFICE_CONVERSION_FORBIDDEN",
    });
    expect(events).toEqual(["authorize", "read", "convert", "authorize"]);

    for (const value of [null, {}, { ...request, extra: true }, { ...request, operationId: 42 }]) {
      expect(() => task.decode(value)).toThrow("OFFICE_CONVERSION_INPUT_INVALID");
    }
    const mutable = { ...request };
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
    await expect(task.execute(request, { ...context(), signal: controller.signal })).rejects.toThrow();
    expect(events).toEqual(["authorize", "read"]);
  });
});

test("OfficeConversionError exposes only a bounded code", () => {
  const error = new OfficeConversionError("OFFICE_CONVERSION_FAILED", true);
  expect(String(error)).toBe("OfficeConversionError: OFFICE_CONVERSION_FAILED");
  expect(error.cause).toBeUndefined();
});
