interface RequestTimeoutController {
  timeout(request: Request, seconds: number): void;
}

const LOGICAL_BACKUP_MUTATION_PATH =
  /^\/v1\/projects\/([^/]+)\/database\/backups\/logical(?:\/restore)?\/?$/;
const PROJECT_REF = /^[A-Za-z0-9_-]{1,64}$/;
const timeoutControllers = new WeakMap<Request, RequestTimeoutController>();

function hasValidProjectRef(pathname: string): boolean {
  const rawProjectRef = LOGICAL_BACKUP_MUTATION_PATH.exec(pathname)?.[1];
  if (!rawProjectRef) return false;
  try {
    return PROJECT_REF.test(decodeURIComponent(rawProjectRef));
  } catch (error: unknown) {
    if (error instanceof URIError) return false;
    throw error;
  }
}

function isLogicalBackupMutationRequest(request: Request): boolean {
  return request.method === "POST"
    && hasValidProjectRef(new URL(request.url).pathname);
}

export async function withLogicalBackupMutationTimeoutController<T>(
  request: Request,
  server: RequestTimeoutController,
  action: () => T | Promise<T>,
): Promise<T> {
  if (!isLogicalBackupMutationRequest(request)) return action();
  timeoutControllers.set(request, server);
  try {
    return await action();
  } finally {
    timeoutControllers.delete(request);
  }
}

export function disableLogicalBackupMutationIdleTimeout(
  request: Request,
): void {
  timeoutControllers.get(request)?.timeout(request, 0);
}
