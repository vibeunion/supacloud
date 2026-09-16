import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  ApprovalBusinessSnapshotSchema, approvalWorkbenchClient, durableApprovalClient,
  DurableApprovalReceiptSchema,decodeDurableApprovalDefinition, simulateApprovalDefinition,
  type ApprovalSqlConnection, type DurableApprovalReceipt,
} from './durable.js';
import { planApprovalGraph } from './graph.js';

const Uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const Command = Type.Object({
  action: Type.Union((['approve','reject','return','cancel','resubmit','claim','release','transfer','delegate','resolve','add'] as const)
    .map(value => Type.Literal(value))),
  requestId: Uuid,
  expectedVersion: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
  reason: Type.String({ maxLength: 4000 }),
  target: Type.Optional(Type.String({ minLength: 1,maxLength: 128,pattern: '^[A-Za-z0-9_.:@-]+$' })),
  businessSnapshot: Type.Optional(ApprovalBusinessSnapshotSchema),
},{ additionalProperties: false });
const Page = Type.Object({
  view: Type.Union([Type.Literal('inbox'),Type.Literal('done'),Type.Literal('started'),Type.Literal('delegated')]),
  createdAt: Type.Optional(Type.String()),
  runId: Type.Optional(Uuid),
},{ additionalProperties: false });
export const ApprovalNoticeItemSchema = Type.Object({
  noticeId: Uuid,runId: Uuid,kind: Type.Union([Type.Literal('reminder'),Type.Literal('escalation')]),
  status: Type.Union(['scheduled','ready','cancelled','acknowledged','dead'].map(value => Type.Literal(value))),
  dueAt: Type.String(),attempts: Type.Integer({ minimum: 0,maximum: 10 }),
  recoveryAttempts: Type.Integer({ minimum: 0,maximum: 5 }),lastError: Type.Union([Type.String(),Type.Null()]),
},{ additionalProperties: false });

export interface ApprovalWorkbenchSession {
  tenant: string;
  actor: string;
  csrfToken: string;
  connection: ApprovalSqlConnection;
  /** Platform-level monitoring, not ordinary approver authorization. */
  operatorConnection?: ApprovalSqlConnection;
}
export interface ApprovalWorkbenchHttpOptions {
  origin: string;
  basePath: string;
  authenticate(request: Request): Promise<ApprovalWorkbenchSession | null>;
  /** Hosts must recheck mutable authorization in the command's DB transaction too. */
  authorizeEntity(session: ApprovalWorkbenchSession,entityId: string): Promise<boolean>;
  assets: { html: string; script: string; stylesheet: string };
  onError?(error: unknown): void;
}

class HttpError extends Error {
  constructor(readonly status: number,code: string) { super(code); }
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new HttpError(415,'JSON_REQUIRED');
  const reader = request.body?.getReader();
  if (reader === undefined) throw new HttpError(400,'INVALID_BODY');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 65536) { await reader.cancel(); throw new HttpError(413,'BODY_TOO_LARGE'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new HttpError(400,'INVALID_JSON'); }
}

/** Framework-neutral Web Request/Response boundary. No default authentication or DB identity. */
export function createApprovalWorkbenchHandler(options: ApprovalWorkbenchHttpOptions) {
  const origin = new URL(options.origin).origin;
  if (!/^\/[A-Za-z0-9/_-]+$/.test(options.basePath) || options.basePath.endsWith('/')) throw new Error('INVALID_WORKBENCH_BASE_PATH');
  const base = options.basePath;
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const json = (value: unknown,status = 200) => new Response(JSON.stringify(value),{
    status,headers: { ...headers,'content-type': 'application/json; charset=utf-8' },
  });
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin) throw new HttpError(403,'ORIGIN_FORBIDDEN');
      if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) throw new HttpError(404,'NOT_FOUND');
      const session = await options.authenticate(request);
      if (session === null) throw new HttpError(401,'AUTHENTICATION_REQUIRED');
      if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(session.tenant) || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(session.actor)
        || session.csrfToken.length < 32) throw new HttpError(500,'SESSION_CONFIGURATION_INVALID');
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== origin || request.headers.get('x-csrf-token') !== session.csrfToken) {
          throw new HttpError(403,'CSRF_REJECTED');
        }
      } else if (request.method !== 'GET') throw new HttpError(405,'METHOD_NOT_ALLOWED');
      if (request.method === 'GET' && url.pathname === base) {
        return new Response(null,{ status: 303,headers: { ...headers,location: `${base}/` } });
      }
      const path = url.pathname.slice(base.length);
      const asset = path === '/' ? ['text/html; charset=utf-8',options.assets.html]
        : path === '/workbench.js' ? ['text/javascript; charset=utf-8',options.assets.script]
        : path === '/workbench.css' ? ['text/css; charset=utf-8',options.assets.stylesheet] : null;
      if (asset !== null && request.method === 'GET') {
        return new Response(asset[1],{ headers: { ...headers,'content-type': asset[0] ?? 'text/plain' } });
      }
      const client = durableApprovalClient(session.connection);
      const workbench = approvalWorkbenchClient(session.connection);
      if (path === '/api/session' && request.method === 'GET') return json({
        actor: session.actor,csrfToken: session.csrfToken,operations: session.operatorConnection !== undefined,
      });
      if (path === '/api/runs' && request.method === 'GET') {
        const input = Object.fromEntries(url.searchParams);
        if (!Value.Check(Page,input) || (input.createdAt === undefined) !== (input.runId === undefined)) throw new HttpError(400,'INVALID_PAGE');
        const rows = await workbench.list({
          tenant: session.tenant,actor: session.actor,view: input.view,
          ...(input.createdAt !== undefined && input.runId !== undefined ? { before: { createdAt: input.createdAt,runId: input.runId } } : {}),
          limit: 50,
        });
        const visible = [];
        for (const row of rows) if (await options.authorizeEntity(session,row.entityId)) visible.push(row);
        const last = rows[rows.length-1];
        return json({ items: visible,next: rows.length === 50 && last !== undefined ? { createdAt: last.createdAt,runId: last.runId } : null });
      }
      if (path === '/api/health' && request.method === 'GET') {
        if (session.operatorConnection === undefined) throw new HttpError(403,'OPERATIONS_FORBIDDEN');
        const rows = await session.operatorConnection.query('SELECT approval.operational_health() AS result',[]);
        if (rows.length !== 1) throw new HttpError(502,'INVALID_OPERATIONAL_RESPONSE');
        return json(rows[0]?.result);
      }
      if (path === '/api/preview' && request.method === 'POST') {
        const body = await readJson(request);
        if (!Value.Check(Type.Object({
          definition: Type.Unknown(),samples: Type.Optional(Type.Record(Type.String(),Type.Unknown())),
          facts: Type.Optional(Type.Unknown()),
        },{ additionalProperties: false }),body)) throw new HttpError(400,'INVALID_PREVIEW');
        const definition = decodeDurableApprovalDefinition(body.definition);
        return json(definition.schemaVersion === 5 ? planApprovalGraph(definition,body.facts)
          : simulateApprovalDefinition(definition,session.actor,body.samples));
      }
      const match = /^\/api\/runs\/([0-9a-f-]{36})(\/command|\/events|\/rounds|\/recover|\/migrate|\/notices|\/recover-notice)?$/.exec(path);
      if (match?.[1] === undefined || !Value.Check(Uuid,match[1])) throw new HttpError(404,'NOT_FOUND');
      const runId = match[1];
      const run = await client.get(session.tenant,runId);
      if (!await options.authorizeEntity(session,run.entityId)) throw new HttpError(404,'NOT_FOUND');
      if (match[2] === '/notices' && request.method === 'GET') {
        if (session.operatorConnection === undefined) throw new HttpError(403,'OPERATIONS_FORBIDDEN');
        const after = url.searchParams.get('after');
        if (after !== null && !Value.Check(Uuid,after)) throw new HttpError(400,'INVALID_PAGE');
        const rows = await session.operatorConnection.query('SELECT approval.list_notices($1,$2::uuid,$3::uuid,50) AS result',
          [session.tenant,runId,after]);
        const result = rows[0]?.result;
        if (rows.length !== 1 || !Value.Check(Type.Array(ApprovalNoticeItemSchema),result)
          || result.some(item => item.runId !== runId)) throw new HttpError(502,'INVALID_NOTICE_RESPONSE');
        return json(result);
      }
      if (match[2] === '/recover-notice' && request.method === 'POST') {
        if (session.operatorConnection === undefined) throw new HttpError(403,'OPERATIONS_FORBIDDEN');
        const body = await readJson(request);
        if (!Value.Check(Type.Object({
          requestId: Uuid,noticeId: Uuid,expectedAttempts: Type.Integer({ minimum: 0,maximum: 10 }),
          reason: Type.String({ minLength: 1,maxLength: 4000 }),
        },{ additionalProperties: false }),body) || body.reason.trim() === '') throw new HttpError(400,'INVALID_RECOVERY');
        const rows = await session.operatorConnection.query(
          'SELECT approval.recover_notice($1,$2,$3::uuid,$4::uuid,$5::uuid,$6::integer,$7) AS result',
          [session.tenant,session.actor,body.requestId,runId,body.noticeId,body.expectedAttempts,body.reason]);
        const result = rows[0]?.result;
        if (rows.length !== 1 || !Value.Check(Type.Object({
          noticeId: Type.Literal(body.noticeId),runId: Type.Literal(runId),status: Type.Literal('ready'),
        },{ additionalProperties: false }),result)) throw new HttpError(502,'INVALID_NOTICE_RESPONSE');
        return json(result);
      }
      if (request.method === 'GET' && match[2] === undefined) return json(run);
      if (request.method === 'GET' && match[2] === '/rounds') {
        const after = url.searchParams.get('after') ?? '0';
        if (!/^(0|[1-9][0-9]{0,9})$/.test(after) || Number(after) > 2147483647) throw new HttpError(400,'INVALID_PAGE');
        const rounds = await workbench.rounds(session.tenant,runId,Number(after));
        return json(rounds);
      }
      if (request.method === 'GET' && match[2] === '/events') {
        const after = url.searchParams.get('after') ?? '0';
        if (!/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after)>9223372036854775807n) throw new HttpError(400,'INVALID_PAGE');
        const rows = await session.connection.query('SELECT approval.list_events($1,$2::uuid,$3::bigint,50) AS result',
          [session.tenant,runId,after]);
        if (rows.length !== 1) throw new HttpError(502,'INVALID_EVENTS_RESPONSE');
        return json(rows[0]?.result);
      }
      if (request.method === 'POST' && match[2] === '/recover') {
        if (session.operatorConnection === undefined) throw new HttpError(403,'OPERATIONS_FORBIDDEN');
        const body = await readJson(request);
        if (!Value.Check(Type.Object({
          kind: Type.Union([Type.Literal('execution'),Type.Literal('outcome')]),
          expectedEngine: Type.String({ pattern: '^[0-9a-f]{8}$' }),
          reason: Type.String({ minLength: 1,maxLength: 4000 }),
        },{ additionalProperties: false }),body) || body.reason.trim() === '') throw new HttpError(400,'INVALID_RECOVERY');
        if (body.expectedEngine !== run.engineId) throw new HttpError(409,'APPROVAL_RECOVERY_CONFLICT');
        const rows = body.kind === 'execution'
          ? await session.operatorConnection.query('SELECT approval.retry_execution($1,$2::uuid,$3,$4) AS result',
            [session.tenant,runId,body.expectedEngine,body.reason])
          : await session.operatorConnection.query('SELECT approval.requeue_outcome($1,$2::uuid,$3) AS result',
            [session.tenant,runId,body.reason]);
        return json(rows[0]?.result);
      }
      if (request.method === 'POST' && match[2] === '/migrate') {
        if (session.operatorConnection === undefined) throw new HttpError(403,'OPERATIONS_FORBIDDEN');
        const body = await readJson(request);
        if (!Value.Check(Type.Object({
          requestId: Uuid,expectedVersion: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
          targetVersion: Type.Integer({ minimum: 1,maximum: 2147483647 }),
          businessSnapshot: Type.Optional(ApprovalBusinessSnapshotSchema),
          reason: Type.String({ minLength: 1,maxLength: 4000 }),
        },{ additionalProperties: false }),body) || body.reason.trim() === ''
          || BigInt(body.expectedVersion)>9223372036854775807n) throw new HttpError(400,'INVALID_MIGRATION');
        const rows = await session.operatorConnection.query('SELECT approval.migrate_run($1,$2,$3::uuid,$4::uuid,$5::bigint,$6::integer,$7::jsonb,$8) AS result',
          [session.tenant,session.actor,body.requestId,runId,body.expectedVersion,body.targetVersion,
            body.businessSnapshot === undefined ? null : JSON.stringify(body.businessSnapshot),body.reason]);
        const result = rows[0]?.result;
        if (rows.length !== 1 || !Value.Check(DurableApprovalReceiptSchema,result) || result.tenant !== session.tenant
          || result.entityId !== run.entityId || result.migrationSourceRunId !== runId) throw new HttpError(502,'INVALID_MIGRATION_RESPONSE');
        return json(result);
      }
      if (request.method !== 'POST' || match[2] !== '/command') throw new HttpError(405,'METHOD_NOT_ALLOWED');
      const body = await readJson(request);
      if (!Value.Check(Command,body)) throw new HttpError(400,'INVALID_COMMAND');
      const common = { tenant: session.tenant,actor: session.actor,requestId: body.requestId,runId,
        expectedVersion: body.expectedVersion,reason: body.reason };
      const snapshot = body.businessSnapshot === undefined ? {} : { businessSnapshot: body.businessSnapshot };
      let receipt: DurableApprovalReceipt;
      switch (body.action) {
        case 'approve': case 'reject':
          receipt = await client.decide({ ...common,...snapshot,decision: body.action === 'approve' ? 'approved' : 'rejected' }); break;
        case 'return': receipt = await client.returnForChanges(common); break;
        case 'cancel': receipt = await client.cancel(common); break;
        case 'resubmit': receipt = await client.resubmit({ ...common,...snapshot }); break;
        default: receipt = await client.taskAction({ ...common,action: body.action,...(body.target === undefined ? {} : { target: body.target }) });
      }
      return json(receipt);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message },error.status);
      const text = error instanceof Error ? error.message : '';
      const code = text.match(/\bAPPROVAL_[A-Z_]+\b/)?.[0];
      if (code !== undefined) return json({ error: code },code === 'APPROVAL_NOT_FOUND' ? 404 : 409);
      options.onError?.(error);
      return json({ error: 'APPROVAL_SERVICE_UNAVAILABLE' },503);
    }
  };
}
