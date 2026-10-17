import {
  constantTimeSecretMatches,
  type WorkerHttpErrorCodes,
} from "./worker-http";

export type ScheduledWorkerHttpOptions<TResult> = {
  expectedBearer?: string;
  authorize?: (request: Request) => boolean | Promise<boolean>;
  runBatch: (request: Request) => TResult | Promise<TResult>;
  successStatus?: (result: TResult) => 200 | 202;
  minimumSecretLength?: number;
  errorCodes?: Partial<WorkerHttpErrorCodes>;
  logError?: (error: unknown) => void;
};

const DEFAULT_ERROR_CODES: WorkerHttpErrorCodes = {
  notConfigured: "SUPACLOUD_SCHEDULED_WORKER_NOT_CONFIGURED",
  unauthorized: "SUPACLOUD_SCHEDULED_WORKER_UNAUTHORIZED",
  invalidRequest: "SUPACLOUD_SCHEDULED_WORKER_REQUEST_INVALID",
  unavailable: "SUPACLOUD_SCHEDULED_WORKER_UNAVAILABLE",
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

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

async function isAuthorized(
  request: Request,
  options: Pick<ScheduledWorkerHttpOptions<never>, "expectedBearer" | "authorize">,
): Promise<boolean> {
  if (options.authorize) return options.authorize(request);
  if (options.expectedBearer === undefined) return false;
  return constantTimeSecretMatches(
    bearerToken(request),
    options.expectedBearer,
  );
}

/** Creates a POST-only scheduled invocation endpoint with injected trust. */
export function createScheduledWorkerHttpHandler<TResult>(
  options: ScheduledWorkerHttpOptions<TResult>,
): (request: Request) => Promise<Response> {
  const errorCodes = { ...DEFAULT_ERROR_CODES, ...options.errorCodes };
  const minimumSecretLength = options.minimumSecretLength ?? 32;
  if (!Number.isSafeInteger(minimumSecretLength) || minimumSecretLength < 32) {
    throw new RangeError("Minimum secret length must be at least 32");
  }

  return async (request) => {
    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: { code: "METHOD_NOT_ALLOWED" } },
        405,
      );
    }
    if (
      (options.expectedBearer === undefined && !options.authorize) ||
      (options.expectedBearer !== undefined && options.authorize !== undefined) ||
      (options.expectedBearer !== undefined &&
        options.expectedBearer.length < minimumSecretLength)
    ) {
      return jsonResponse(
        { ok: false, error: { code: errorCodes.notConfigured } },
        503,
      );
    }
    try {
      if (!(await isAuthorized(request, options))) {
        return jsonResponse(
          { ok: false, error: { code: errorCodes.unauthorized } },
          401,
        );
      }
      const result = await options.runBatch(request);
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
        { ok: false, error: { code: errorCodes.unavailable } },
        503,
      );
    }
  };
}
