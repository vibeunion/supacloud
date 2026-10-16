import { createHash } from "node:crypto";

const MAX_INPUT_BYTES = 500 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MIME_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export type DocumentFormat = keyof typeof MIME_TYPES;
export type DocumentConversionErrorCode =
  | "DOCUMENT_CONVERSION_DISABLED"
  | "DOCUMENT_CONVERSION_CONFIG_INVALID"
  | "DOCUMENT_CONVERSION_FORBIDDEN"
  | "DOCUMENT_CONVERSION_INPUT_INVALID"
  | "DOCUMENT_CONVERSION_UNSUPPORTED_FORMAT"
  | "DOCUMENT_CONVERSION_CHECKSUM_MISMATCH"
  | "DOCUMENT_CONVERSION_INPUT_TOO_LARGE"
  | "DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE"
  | "DOCUMENT_CONVERSION_BUSY"
  | "DOCUMENT_CONVERSION_TIMEOUT"
  | "DOCUMENT_CONVERSION_CANCELLED"
  | "DOCUMENT_CONVERSION_HTTP_ERROR"
  | "DOCUMENT_CONVERSION_RESPONSE_INVALID";

export class DocumentConversionError extends Error {
  constructor(readonly code: DocumentConversionErrorCode, readonly retryable = false) {
    // No transport causes, URLs, engine bodies or caller cancellation reasons in logs.
    super(code);
    this.name = "DocumentConversionError";
  }
}

export interface DocumentConversionInput {
  readonly projectRef: string;
  readonly renderProfile: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface DocumentConversionResult {
  readonly projectRef: string;
  readonly renderProfile: string;
  readonly filename: string;
  readonly mimeType: "application/pdf";
  readonly bytes: Uint8Array;
  readonly sourceSha256: string;
  readonly sha256: string;
  readonly engine: "collabora-online";
}

export interface DocumentConverter {
  readonly enabled: boolean;
  convert(input: DocumentConversionInput, signal?: AbortSignal): Promise<DocumentConversionResult>;
}

export type DocumentConversionFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DocumentConverterOptions {
  readonly enabled?: boolean;
  readonly projectRef?: string;
  readonly renderProfile?: string;
  readonly baseUrl?: string;
  /** Optional credential for an internal gateway; not a Collabora native credential. */
  readonly bearerToken?: string;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly fetch?: DocumentConversionFetch;
}

function configError(): never {
  throw new DocumentConversionError("DOCUMENT_CONVERSION_CONFIG_INVALID");
}

function integer(value: number | undefined, fallback: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) configError();
  return result;
}

function endpoint(value: string | undefined): string {
  if (typeof value !== "string" || value.trim() !== value || /[\s\\]/.test(value)) configError();
  let url: URL;
  try { url = new URL(value); } catch { return configError(); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.search || url.hash || url.pathname !== "/") configError();
  return new URL("/cool/convert-to/pdf", url).href;
}

function formatOf(input: DocumentConversionInput): DocumentFormat {
  if (typeof input.filename !== "string" || input.filename.trim() !== input.filename
    || input.filename.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(input.filename)) {
    throw new DocumentConversionError("DOCUMENT_CONVERSION_INPUT_INVALID");
  }
  const match = /^.+\.(docx|xlsx)$/i.exec(input.filename);
  const format = match?.[1]?.toLowerCase();
  if ((format !== "docx" && format !== "xlsx") || input.mimeType !== MIME_TYPES[format]) {
    throw new DocumentConversionError("DOCUMENT_CONVERSION_UNSUPPORTED_FORMAT");
  }
  return format;
}

function abortError(signal: AbortSignal): DocumentConversionError {
  return signal.reason instanceof DocumentConversionError
    ? signal.reason
    : new DocumentConversionError("DOCUMENT_CONVERSION_CANCELLED");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

/** Also bounds custom transports/streams that do not implement native fetch cancellation. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

async function readPdf(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (response.status !== 200) {
    throw new DocumentConversionError(
      response.status === 413 ? "DOCUMENT_CONVERSION_INPUT_TOO_LARGE" : "DOCUMENT_CONVERSION_HTTP_ERROR",
      response.status === 429 || response.status >= 500,
    );
  }
  if (response.redirected
    || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") {
    throw new DocumentConversionError("DOCUMENT_CONVERSION_RESPONSE_INVALID");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new DocumentConversionError("DOCUMENT_CONVERSION_RESPONSE_INVALID");
  }
  if (length !== null && Number(length) > maxBytes) {
    throw new DocumentConversionError("DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE");
  }
  if (!response.body) throw new DocumentConversionError("DOCUMENT_CONVERSION_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    while (true) {
      checkAbort(signal);
      const part = await abortable(reader.read(), signal);
      if (part.done) { done = true; break; }
      total += part.value.byteLength;
      if (total > maxBytes || chunks.length >= 65_536) {
        throw new DocumentConversionError("DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE");
      }
      chunks.push(part.value.slice());
    }
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  checkAbort(signal);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const start = new TextDecoder().decode(bytes.subarray(0, 8));
  const end = new TextDecoder().decode(bytes.subarray(Math.max(0, total - 1024)));
  // Envelope check only; layout and PDF semantic validation require real engine acceptance.
  if (!/^%PDF-[12]\.[0-9]/.test(start) || !/%%EOF\s*$/.test(end)) {
    throw new DocumentConversionError("DOCUMENT_CONVERSION_RESPONSE_INVALID");
  }
  return bytes;
}

/** Explicit opt-in, project-bound transport. No service installation, queue or implicit fallback. */
export function createCollaboraDocumentConverter(options: DocumentConverterOptions = {}): DocumentConverter {
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") configError();
  if (options.enabled !== true) return Object.freeze({
    enabled: false,
    async convert(): Promise<DocumentConversionResult> {
      throw new DocumentConversionError("DOCUMENT_CONVERSION_DISABLED");
    },
  });
  const { projectRef, renderProfile, bearerToken } = options;
  if (typeof projectRef !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(projectRef)
    || typeof renderProfile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(renderProfile)) configError();
  if (bearerToken !== undefined && (typeof bearerToken !== "string"
    || !/^[A-Za-z0-9._~+/-]+=*$/.test(bearerToken) || bearerToken.length > 4096)) configError();
  const url = endpoint(options.baseUrl);
  const maxInputBytes = integer(options.maxInputBytes, MAX_INPUT_BYTES, MAX_INPUT_BYTES);
  const maxOutputBytes = integer(options.maxOutputBytes, MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  const timeoutMs = integer(options.timeoutMs, 120_000, 120_000);
  const maxConcurrent = integer(options.maxConcurrent, 1, 4);
  const send = options.fetch ?? ((target, init) => fetch(target, init));
  if (typeof send !== "function") configError();
  let active = 0;

  return Object.freeze({
    enabled: true,
    async convert(input: DocumentConversionInput, callerSignal?: AbortSignal): Promise<DocumentConversionResult> {
      if (!input || input.projectRef !== projectRef || input.renderProfile !== renderProfile) {
        throw new DocumentConversionError("DOCUMENT_CONVERSION_FORBIDDEN");
      }
      if (callerSignal?.aborted) throw new DocumentConversionError("DOCUMENT_CONVERSION_CANCELLED");
      const format = formatOf(input);
      const name = input.filename;
      const sourceSha256 = input.sha256;
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 4
        || typeof sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceSha256)) {
        throw new DocumentConversionError("DOCUMENT_CONVERSION_INPUT_INVALID");
      }
      if (input.bytes.byteLength > maxInputBytes) throw new DocumentConversionError("DOCUMENT_CONVERSION_INPUT_TOO_LARGE");
      if (active >= maxConcurrent) throw new DocumentConversionError("DOCUMENT_CONVERSION_BUSY", true);
      active++;
      const controller = new AbortController();
      const cancel = () => controller.abort(new DocumentConversionError("DOCUMENT_CONVERSION_CANCELLED"));
      callerSignal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => controller.abort(new DocumentConversionError("DOCUMENT_CONVERSION_TIMEOUT", true)), timeoutMs);
      let response: Response | undefined;
      try {
        const bytes = new Uint8Array(input.bytes);
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) {
          throw new DocumentConversionError("DOCUMENT_CONVERSION_INPUT_INVALID");
        }
        if (createHash("sha256").update(bytes).digest("hex") !== sourceSha256) {
          throw new DocumentConversionError("DOCUMENT_CONVERSION_CHECKSUM_MISMATCH");
        }
        checkAbort(controller.signal);
        const form = new FormData();
        form.append("data", new Blob([bytes], { type: MIME_TYPES[format] }), `source.${format}`);
        const headers = new Headers({ accept: "application/pdf" });
        if (bearerToken) headers.set("authorization", `Bearer ${bearerToken}`);
        const pending = send(url, {
          method: "POST", headers, body: form, redirect: "error", signal: controller.signal,
        });
        // A late response from a non-cooperative custom transport must not leak its body.
        void pending.then(late => {
          if (controller.signal.aborted) void late.body?.cancel().catch(() => {});
        }, () => {});
        response = await abortable(pending, controller.signal);
        const result = await readPdf(response, maxOutputBytes, controller.signal);
        checkAbort(controller.signal);
        return {
          projectRef, renderProfile, filename: `${name.replace(/\.[^.]+$/, "")}.pdf`,
          mimeType: "application/pdf", bytes: result, sourceSha256,
          sha256: createHash("sha256").update(result).digest("hex"), engine: "collabora-online",
        };
      } catch (error) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        if (error instanceof DocumentConversionError) throw error;
        throw new DocumentConversionError("DOCUMENT_CONVERSION_HTTP_ERROR", true);
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", cancel);
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        active--;
      }
    },
  });
}

export function createDocumentConverterFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  fetcher?: DocumentConversionFetch,
): DocumentConverter {
  const enabled = environment["SUPACLOUD_DOCUMENT_CONVERSION_ENABLED"];
  if (enabled !== undefined && enabled !== "false" && enabled !== "true") configError();
  if (enabled !== "true") return createCollaboraDocumentConverter();
  if (environment["SUPACLOUD_DOCUMENT_CONVERSION_ENGINE"] !== "collabora-online") configError();
  return createCollaboraDocumentConverter({
    enabled: true,
    projectRef: environment["SUPACLOUD_PROJECT_REF"] ?? "",
    renderProfile: environment["SUPACLOUD_DOCUMENT_CONVERSION_RENDER_PROFILE"] ?? "",
    baseUrl: environment["SUPACLOUD_DOCUMENT_CONVERSION_URL"] ?? "",
    ...(environment["SUPACLOUD_DOCUMENT_CONVERSION_TOKEN"] === undefined ? {}
      : { bearerToken: environment["SUPACLOUD_DOCUMENT_CONVERSION_TOKEN"] }),
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  });
}
