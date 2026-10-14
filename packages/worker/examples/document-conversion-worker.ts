import {
  DocumentConversionError,
  type DocumentConversionResult,
  type DocumentConverter,
} from "../src/document-conversion.js";
import type { TaskContext, TaskHandler } from "../src/queue-handler.js";

export interface DocumentConversionSource {
  readonly operationId: string;
  readonly projectRef: string;
  readonly renderProfile: string;
  readonly artifactId: string;
  readonly revision: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sha256: string;
}

export interface DocumentConversionDomain {
  /** Recheck tenant membership, source ownership, revision and feature enablement. */
  authorize(source: DocumentConversionSource, context: TaskContext): Promise<boolean>;
  /** Bound the download while streaming, before allocating a full source buffer. */
  read(source: DocumentConversionSource, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  /** Fence attempts, deduplicate by operation/source/profile and publish a private artifact receipt. */
  publish(
    source: DocumentConversionSource,
    result: DocumentConversionResult,
    context: TaskContext,
  ): Promise<void>;
}

function decode(value: unknown): DocumentConversionSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DOCUMENT_CONVERSION_INPUT_INVALID");
  const fields = value as Record<string, unknown>;
  const keys = ["operationId", "projectRef", "renderProfile", "artifactId", "revision", "filename", "mimeType", "sha256"];
  if (Object.keys(fields).length !== keys.length
    || keys.some(key => typeof fields[key] !== "string" || !fields[key] || fields[key].length > 200)
    || Object.keys(fields).some(key => !keys.includes(key))) throw new Error("DOCUMENT_CONVERSION_INPUT_INVALID");
  // Capture once: mutable queue payloads cannot change identity across authorization awaits.
  return Object.freeze({
    operationId: String(fields.operationId), projectRef: String(fields.projectRef),
    renderProfile: String(fields.renderProfile), artifactId: String(fields.artifactId),
    revision: String(fields.revision), filename: String(fields.filename),
    mimeType: String(fields.mimeType), sha256: String(fields.sha256),
  });
}

/**
 * The queue producer and operation receipt stay application-owned. This
 * handler plugs into createPgflowQueueWorker; it never starts a process itself.
 */
export function createDocumentConversionTask(
  options: { projectRef: string; renderProfile: string; converter: DocumentConverter },
  domain: DocumentConversionDomain,
): TaskHandler<DocumentConversionSource> {
  const { projectRef, renderProfile, converter } = options;
  const authorize = async (source: DocumentConversionSource, context: TaskContext) => {
    context.signal.throwIfAborted();
    if (!converter.enabled) throw new DocumentConversionError("DOCUMENT_CONVERSION_DISABLED");
    if (source.projectRef !== projectRef || context.projectRef !== projectRef
      || source.renderProfile !== renderProfile || source.operationId !== context.idempotencyKey) return false;
    return await domain.authorize(source, context) === true;
  };
  return {
    decode,
    authorize,
    async execute(value, context) {
      const source = decode(value);
      if (!await authorize(source, context)) throw new DocumentConversionError("DOCUMENT_CONVERSION_FORBIDDEN");
      context.signal.throwIfAborted();
      const bytes = await domain.read(source, 25 * 1024 * 1024, context.signal);
      context.signal.throwIfAborted();
      const result = await converter.convert({
        projectRef: source.projectRef, renderProfile: source.renderProfile,
        filename: source.filename, mimeType: source.mimeType, sha256: source.sha256, bytes,
      }, context.signal);
      if (!await authorize(source, context)) throw new DocumentConversionError("DOCUMENT_CONVERSION_FORBIDDEN");
      context.signal.throwIfAborted();
      await domain.publish(source, result, context);
    },
  };
}
