export type WorkerBatchRequest = {
  batchSize: number;
};

export type WorkerHttpErrorCodes = {
  notConfigured: string;
  unauthorized: string;
  invalidRequest: string;
  unavailable: string;
};

export type WorkerHttpOptions<TResult> = {
  expectedSecret: string;
  runBatch: (request: WorkerBatchRequest) => TResult | Promise<TResult>;
  defaultBatchSize: number;
  maxBatchSize?: number;
  secretHeader?: string;
  minimumSecretLength?: number;
  successStatus?: (result: TResult) => 200 | 202;
  errorCodes?: Partial<WorkerHttpErrorCodes>;
  logError?: (error: unknown) => void;
};

const DEFAULT_ERROR_CODES: WorkerHttpErrorCodes = {
  notConfigured: "SUPACLOUD_WORKER_SECRET_NOT_CONFIGURED",
  unauthorized: "SUPACLOUD_WORKER_UNAUTHORIZED",
  invalidRequest: "SUPACLOUD_WORKER_REQUEST_INVALID",
  unavailable: "SUPACLOUD_WORKER_UNAVAILABLE",
};

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(status === 405 ? { allow: "POST" } : {}),
    },
  });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** Compare secrets without making the comparison dependent on their contents. */
export async function constantTimeSecretMatches(
  provided: string,
  expected: string,
): Promise<boolean> {
  const [providedDigest, expectedDigest] = await Promise.all([
    digest(provided),
    digest(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= providedDigest[index] ^ expectedDigest[index];
  }
  return difference === 0 && provided.length > 0 && expected.length > 0;
}

async function parseBatchRequest(
  request: Request,
  defaultBatchSize: number,
  maxBatchSize: number,
): Promise<WorkerBatchRequest> {
  const text = await request.text();
  if (!text.trim()) return { batchSize: defaultBatchSize };

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new TypeError("request body must be JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("request body must be an object");
  }

  const batchSize = (payload as Record<string, unknown>).batchSize ?? defaultBatchSize;
  if (
    !Number.isSafeInteger(batchSize) ||
    Number(batchSize) < 1 ||
    Number(batchSize) > maxBatchSize
  ) {
    throw new RangeError(`batchSize must be between 1 and ${maxBatchSize}`);
  }
  return { batchSize: Number(batchSize) };
}

/**
 * Creates a POST-only worker endpoint. Queue claims, leases, and domain work
 * remain injected into `runBatch`; this adapter only handles invocation trust
 * and HTTP response hygiene.
 */
export function createWorkerHttpHandler<TResult>(
  options: WorkerHttpOptions<TResult>,
): (request: Request) => Promise<Response> {
  const errorCodes = { ...DEFAULT_ERROR_CODES, ...options.errorCodes };
  const maxBatchSize = options.maxBatchSize ?? 20;
  const minimumSecretLength = options.minimumSecretLength ?? 32;
  const secretHeader = options.secretHeader ?? "x-supacloud-worker-secret";
  if (
    !Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1 ||
    !Number.isSafeInteger(options.defaultBatchSize) ||
    options.defaultBatchSize < 1 || options.defaultBatchSize > maxBatchSize ||
    !Number.isSafeInteger(minimumSecretLength) || minimumSecretLength < 32
  ) {
    throw new RangeError("Invalid worker batch bounds or minimum secret length");
  }
  // Validate the configured header before accepting invocations.
  new Headers({ [secretHeader]: "" });

  return async (request) => {
    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Method Not Allowed" } },
        405,
      );
    }
    if (options.expectedSecret.length < minimumSecretLength) {
      return jsonResponse(
        { ok: false, error: { code: errorCodes.notConfigured, message: "Worker is unavailable." } },
        503,
      );
    }
    if (
      !(await constantTimeSecretMatches(
        request.headers.get(secretHeader) ?? "",
        options.expectedSecret,
      ))
    ) {
      return jsonResponse(
        { ok: false, error: { code: errorCodes.unauthorized, message: "Worker authentication failed." } },
        401,
      );
    }

    let batchRequest: WorkerBatchRequest;
    try {
      batchRequest = await parseBatchRequest(
        request,
        options.defaultBatchSize,
        maxBatchSize,
      );
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
      return jsonResponse(
        { ok: false, error: { code: errorCodes.invalidRequest, message: "Worker request is invalid." } },
        400,
      );
    }

    try {
      const result = await options.runBatch(batchRequest);
      return jsonResponse(
        { ok: true, result },
        options.successStatus?.(result) ?? 200,
      );
    } catch (error) {
      try {
        options.logError?.(error);
      } catch {
        // Logging failures must not escape the HTTP error boundary.
      }
      return jsonResponse(
        { ok: false, error: { code: errorCodes.unavailable, message: "Worker execution failed." } },
        503,
      );
    }
  };
}
