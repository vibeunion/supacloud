import { Elysia, status, t } from "elysia";
import type { requireAdminAuth } from "../middleware/auth";
import type { createProjectStorageRegistry } from "../services/project-storage-registry";
import { ProjectStorageError } from "../services/project-storage-contract";

const params = t.Object({ ref: t.String({ pattern: '^[A-Za-z0-9_-]{1,20}$' }) });

async function configurationBody(request: Request): Promise<{ settings: unknown; expectedRevision: string | null }> {
  const invalid = () => new ProjectStorageError('STORAGE_CONFIG_INVALID', 400);
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 32768) { await reader.cancel(); throw invalid(); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !('settings' in body)
      || !('expected_revision' in body) || (body.expected_revision !== null && typeof body.expected_revision !== 'string')) throw invalid();
    return { settings: body.settings, expectedRevision: body.expected_revision };
  } catch { throw invalid(); }
  finally { reader.releaseLock(); }
}

function safeError(error: unknown) {
  const failure = error instanceof ProjectStorageError ? error : new ProjectStorageError('STORAGE_CONFIG_UNAVAILABLE');
  return status(failure.statusCode, { code: failure.code, message: failure.message });
}

export interface ProjectStorageRouteDependencies {
  authorize: typeof requireAdminAuth;
  storage: Pick<ReturnType<typeof createProjectStorageRegistry>, "get" | "put" | "probe">;
}

export function createProjectStorageConfigRoutes(dependencies: ProjectStorageRouteDependencies) {
  return new Elysia({ prefix: '/v1/projects/:ref/storage' })
    .beforeHandle(async ({ request }) => {
      const denied = await dependencies.authorize(request);
      if (denied) return status(denied.status, denied.body);
    })
    .get('/config', {
      params, detail: { tags: ['storage'], summary: 'Get project storage configuration without credentials' },
    }, async ({ params }) => {
      try { return await dependencies.storage.get(params.ref); } catch (error) { return safeError(error); }
    })
    .put('/config', {
      params, parse: 'none',
      detail: { tags: ['storage'], summary: 'Bind unused project storage or rotate credentials at an expected revision' },
    }, async ({ params, request }) => {
      try {
        // Parse only after admin authorization. Framework validation must not echo secrets.
        const input = await configurationBody(request);
        return await dependencies.storage.put(params.ref, input.settings, input.expectedRevision);
      } catch (error) { return safeError(error); }
    })
    .post('/config/probe', {
      params, parse: 'none', detail: { tags: ['storage'], summary: 'Probe the configured S3 prefix without creating objects' },
    }, async ({ params }) => {
      try { return await dependencies.storage.probe(params.ref); } catch (error) { return safeError(error); }
    });
}
