import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

const MAX_INPUT_BYTES = 500 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const LEGACY_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const OOXML_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

const FORMATS = {
  doc: {
    target: "docx",
    inputMime: "application/msword",
    outputMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xls: {
    target: "xlsx",
    inputMime: "application/vnd.ms-excel",
    outputMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  ppt: {
    target: "pptx",
    inputMime: "application/vnd.ms-powerpoint",
    outputMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
} as const;

export type LegacyOfficeFormat = keyof typeof FORMATS;
export type OfficeConversionErrorCode =
  | "OFFICE_CONVERSION_DISABLED"
  | "OFFICE_CONVERSION_CONFIG_INVALID"
  | "OFFICE_CONVERSION_FORBIDDEN"
  | "OFFICE_CONVERSION_INPUT_INVALID"
  | "OFFICE_CONVERSION_UNSUPPORTED_FORMAT"
  | "OFFICE_CONVERSION_CHECKSUM_MISMATCH"
  | "OFFICE_CONVERSION_INPUT_TOO_LARGE"
  | "OFFICE_CONVERSION_OUTPUT_TOO_LARGE"
  | "OFFICE_CONVERSION_BUSY"
  | "OFFICE_CONVERSION_TIMEOUT"
  | "OFFICE_CONVERSION_CANCELLED"
  | "OFFICE_CONVERSION_ENGINE_UNAVAILABLE"
  | "OFFICE_CONVERSION_FAILED"
  | "OFFICE_CONVERSION_OUTPUT_INVALID";

export class OfficeConversionError extends Error {
  constructor(readonly code: OfficeConversionErrorCode, readonly retryable = false) {
    super(code);
    this.name = "OfficeConversionError";
  }
}

export interface OfficeConversionInput {
  readonly projectRef: string;
  readonly renderProfile: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface OfficeConversionResult {
  readonly projectRef: string;
  readonly renderProfile: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly sourceSha256: string;
  readonly sha256: string;
  readonly engine: "office-oxide";
  readonly sourceFormat: LegacyOfficeFormat;
  readonly targetFormat: "docx" | "xlsx" | "pptx";
}

export type OfficeConversionRunner = (
  inputPath: string,
  outputPath: string,
  signal: AbortSignal,
) => Promise<void>;

export interface OfficeConverter {
  readonly enabled: boolean;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  convert(input: OfficeConversionInput, signal?: AbortSignal): Promise<OfficeConversionResult>;
}

export interface OfficeConverterOptions {
  readonly enabled?: boolean;
  readonly projectRef?: string;
  readonly renderProfile?: string;
  readonly executable?: string;
  readonly tempRoot?: string;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly runner?: OfficeConversionRunner;
}

function configError(): never {
  throw new OfficeConversionError("OFFICE_CONVERSION_CONFIG_INVALID");
}

function integer(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) configError();
  return result;
}

function validIdentity(value: string | undefined, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function formatOf(input: OfficeConversionInput): LegacyOfficeFormat {
  if (typeof input.filename !== "string" || input.filename.trim() !== input.filename
    || input.filename.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(input.filename)) {
    throw new OfficeConversionError("OFFICE_CONVERSION_INPUT_INVALID");
  }
  const extension = extname(input.filename).slice(1).toLowerCase() as LegacyOfficeFormat;
  const format = FORMATS[extension];
  if (!format || input.mimeType !== format.inputMime) {
    throw new OfficeConversionError("OFFICE_CONVERSION_UNSUPPORTED_FORMAT");
  }
  return extension;
}

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  return magic.every((value, index) => bytes[index] === value);
}

function abortError(signal: AbortSignal): OfficeConversionError {
  return signal.reason instanceof OfficeConversionError
    ? signal.reason
    : new OfficeConversionError("OFFICE_CONVERSION_CANCELLED");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

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

async function defaultRunner(
  executable: string,
  inputPath: string,
  outputPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (typeof Bun === "undefined") {
    throw new OfficeConversionError("OFFICE_CONVERSION_ENGINE_UNAVAILABLE", true);
  }
  const child = Bun.spawn({
    cmd: [executable, "--input", inputPath, "--output", outputPath],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await child.exited;
    checkAbort(signal);
    if (exitCode !== 0) throw new OfficeConversionError("OFFICE_CONVERSION_FAILED", true);
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    if (error instanceof OfficeConversionError) throw error;
    throw new OfficeConversionError("OFFICE_CONVERSION_ENGINE_UNAVAILABLE", true);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function runWithDeadline(
  runner: OfficeConversionRunner,
  inputPath: string,
  outputPath: string,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new OfficeConversionError("OFFICE_CONVERSION_CANCELLED"));
  callerSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new OfficeConversionError("OFFICE_CONVERSION_TIMEOUT", true)),
    timeoutMs,
  );
  const pending = Promise.resolve().then(() => runner(inputPath, outputPath, controller.signal));
  try {
    await abortable(pending, controller.signal);
    checkAbort(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (error instanceof OfficeConversionError) throw error;
    throw new OfficeConversionError("OFFICE_CONVERSION_FAILED", true);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

function disabledConverter(): OfficeConverter {
  return Object.freeze({
    enabled: false,
    async convert(): Promise<OfficeConversionResult> {
      throw new OfficeConversionError("OFFICE_CONVERSION_DISABLED");
    },
  });
}

/** Default-off, project-bound adapter for legacy Office -> OOXML conversion. */
export function createOfficeOxideConverter(options: OfficeConverterOptions = {}): OfficeConverter {
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") configError();
  if (options.enabled !== true) return disabledConverter();
  if (!validIdentity(options.projectRef, /^[a-z0-9][a-z0-9-]{0,99}$/)
    || !validIdentity(options.renderProfile, /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/)) {
    configError();
  }
  if (options.runner === undefined
    && (typeof options.executable !== "string" || options.executable.trim() !== options.executable
      || options.executable.length === 0 || options.executable.length > 4096)) configError();
  if (options.tempRoot !== undefined
    && (typeof options.tempRoot !== "string" || options.tempRoot.length === 0 || !options.tempRoot.startsWith("/"))) {
    configError();
  }
  const maxInputBytes = integer(options.maxInputBytes, MAX_INPUT_BYTES, MAX_INPUT_BYTES);
  const maxOutputBytes = integer(options.maxOutputBytes, MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  const timeoutMs = integer(options.timeoutMs, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxConcurrent = integer(options.maxConcurrent, 1, 4);
  const runner = options.runner ?? ((inputPath, outputPath, signal) =>
    defaultRunner(options.executable as string, inputPath, outputPath, signal));
  if (typeof runner !== "function") configError();
  let active = 0;

  return Object.freeze({
    enabled: true,
    maxInputBytes,
    maxOutputBytes,
    async convert(input: OfficeConversionInput, callerSignal?: AbortSignal): Promise<OfficeConversionResult> {
      if (!input || input.projectRef !== options.projectRef || input.renderProfile !== options.renderProfile) {
        throw new OfficeConversionError("OFFICE_CONVERSION_FORBIDDEN");
      }
      checkAbort(callerSignal ?? new AbortController().signal);
      const sourceFormat = formatOf(input);
      const target = FORMATS[sourceFormat];
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < LEGACY_MAGIC.byteLength
        || typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) {
        throw new OfficeConversionError("OFFICE_CONVERSION_INPUT_INVALID");
      }
      if (input.bytes.byteLength > maxInputBytes) {
        throw new OfficeConversionError("OFFICE_CONVERSION_INPUT_TOO_LARGE");
      }
      if (active >= maxConcurrent) throw new OfficeConversionError("OFFICE_CONVERSION_BUSY", true);
      active++;
      let directory: string | undefined;
      try {
        const bytes = new Uint8Array(input.bytes);
        if (!startsWith(bytes, LEGACY_MAGIC)
          || createHash("sha256").update(bytes).digest("hex") !== input.sha256) {
          throw new OfficeConversionError(
            startsWith(bytes, LEGACY_MAGIC)
              ? "OFFICE_CONVERSION_CHECKSUM_MISMATCH"
              : "OFFICE_CONVERSION_INPUT_INVALID",
          );
        }
        checkAbort(callerSignal ?? new AbortController().signal);
        directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "supacloud-office-"));
        const inputPath = join(directory, `source.${sourceFormat}`);
        const outputPath = join(directory, `result.${target.target}`);
        await writeFile(inputPath, bytes, { mode: 0o600 });
        await runWithDeadline(runner, inputPath, outputPath, timeoutMs, callerSignal);
        const outputInfo = await stat(outputPath).catch(() => null);
        if (!outputInfo?.isFile()) throw new OfficeConversionError("OFFICE_CONVERSION_OUTPUT_INVALID");
        if (outputInfo.size > maxOutputBytes) {
          throw new OfficeConversionError("OFFICE_CONVERSION_OUTPUT_TOO_LARGE");
        }
        const output = new Uint8Array(await readFile(outputPath));
        if (output.byteLength === 0 || output.byteLength > maxOutputBytes || !startsWith(output, OOXML_MAGIC)) {
          throw new OfficeConversionError("OFFICE_CONVERSION_OUTPUT_INVALID");
        }
        const sourceName = basename(input.filename, extname(input.filename));
        return {
          projectRef: options.projectRef,
          renderProfile: options.renderProfile,
          filename: `${sourceName}.${target.target}`,
          mimeType: target.outputMime,
          bytes: output,
          sourceSha256: input.sha256,
          sha256: createHash("sha256").update(output).digest("hex"),
          engine: "office-oxide",
          sourceFormat,
          targetFormat: target.target,
        };
      } catch (error) {
        if (error instanceof OfficeConversionError) throw error;
        throw new OfficeConversionError("OFFICE_CONVERSION_FAILED", true);
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
        active--;
      }
    },
  });
}

export function createOfficeConverterFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): OfficeConverter {
  const enabled = environment["SUPACLOUD_OFFICE_CONVERSION_ENABLED"];
  if (enabled !== undefined && enabled !== "false" && enabled !== "true") configError();
  if (enabled !== "true") return disabledConverter();
  if (environment["SUPACLOUD_OFFICE_CONVERSION_ENGINE"] !== "office-oxide") configError();
  function byteLimit(name: string, fallback: number): number {
    const value = environment[name];
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(value)) configError();
    return integer(Number(value), fallback, fallback);
  }
  function timeout(name: string, fallback: number): number {
    const value = environment[name];
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(value)) configError();
    return integer(Number(value), fallback, DEFAULT_TIMEOUT_MS);
  }
  return createOfficeOxideConverter({
    enabled: true,
    projectRef: environment["SUPACLOUD_PROJECT_REF"] ?? "",
    renderProfile: environment["SUPACLOUD_OFFICE_CONVERSION_RENDER_PROFILE"] ?? "",
    executable: environment["SUPACLOUD_OFFICE_CONVERSION_BIN"] ?? "",
    maxInputBytes: byteLimit("SUPACLOUD_OFFICE_CONVERSION_MAX_INPUT_BYTES", MAX_INPUT_BYTES),
    maxOutputBytes: byteLimit("SUPACLOUD_OFFICE_CONVERSION_MAX_OUTPUT_BYTES", MAX_OUTPUT_BYTES),
    timeoutMs: timeout("SUPACLOUD_OFFICE_CONVERSION_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    ...(environment["SUPACLOUD_OFFICE_CONVERSION_TEMP_ROOT"] === undefined ? {}
      : { tempRoot: environment["SUPACLOUD_OFFICE_CONVERSION_TEMP_ROOT"] }),
    ...(environment["SUPACLOUD_OFFICE_CONVERSION_MAX_CONCURRENT"] === undefined ? {}
      : {
        maxConcurrent: integer(
          Number(environment["SUPACLOUD_OFFICE_CONVERSION_MAX_CONCURRENT"]),
          1,
          4,
        ),
      }),
  });
}
