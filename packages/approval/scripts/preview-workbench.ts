import { assertLocalApprovalContainer } from './local-container.js';
import { createApprovalWorkbenchHandler } from '../src/workbench-http.js';
import type { ApprovalSqlConnection } from '../src/durable.js';

// Local acceptance only: never use this PostgreSQL administrator bridge in a host app.
const container = 'supacloud-approval-postgres-1';
await assertLocalApprovalContainer(container);
function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error('UNSUPPORTED_PREVIEW_PARAMETER');
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}
async function sql(statement: string): Promise<string> {
  const child = Bun.spawn(['docker','exec','-i',container,'psql','-X','-Atq','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{
    stdin: new TextEncoder().encode(statement),stdout: 'pipe',stderr: 'pipe',
  });
  const [output,error,exit] = await Promise.all([
    new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
  ]);
  if (exit !== 0) throw new Error(error);
  return output.trim();
}
function makeConnection(role: 'supacloud_approval_service' | 'supacloud_approval_operator'): ApprovalSqlConnection {
  return {
  async query(statement,parameters) {
    const output = await sql(`SET ROLE ${role};
      PREPARE preview AS SELECT row_to_json(record) FROM (${statement}) AS record;
      EXECUTE preview${parameters.length ? `(${parameters.map(literal).join(',')})` : ''};`);
    const value: unknown = JSON.parse(output);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PREVIEW_ROW');
    return [value as Record<string,unknown>];
  },
  };
}
const connection = makeConnection('supacloud_approval_service');
const operations = process.argv.includes('--operator');
const tenant = `preview-${crypto.randomUUID()}`;
const definition = {
  schemaVersion: 1,
  steps: [{ key: 'review',mode: 'all',approvers: ['reviewer'],timeoutSeconds: 86400 }],
};
await sql(`SET ROLE supacloud_approval_publisher;
  SELECT approval.publish(${literal(tenant)},'publisher',${literal(crypto.randomUUID())},'report-review',1,${literal(JSON.stringify(definition))}::jsonb);`);
if (operations) await sql(`SET ROLE supacloud_approval_publisher;
  SELECT approval.publish_notification_policy(${literal(tenant)},'publisher','report-review',1,86400,86399,'supervisor');`);
for (const entity of ['FA-2026-0916-001','FA-2026-0916-002']) {
  await connection.query('SELECT approval.start($1,$2,$3::uuid,$4,1,$5) AS receipt',
    [tenant,'maker',crypto.randomUUID(),'report-review',entity]);
}
if (operations) {
  await sql(`SET ROLE supacloud_approval_owner;
    SELECT approval.ready_notice(id) FROM approval.notices WHERE tenant=${literal(tenant)} AND kind='reminder';
    UPDATE approval.notices SET status='dead',attempts=10,last_error='LOCAL_ACCEPTANCE_FAILURE'
      WHERE tenant=${literal(tenant)} AND kind='reminder';`);
}
const build = await Bun.build({ entrypoints: [new URL('../web/workbench.ts',import.meta.url).pathname],target: 'browser' });
if (!build.success || !build.outputs[0]) throw new Error('WORKBENCH_BUILD_FAILED');
const assets = {
  html: await Bun.file(new URL('../web/workbench.html',import.meta.url)).text(),
  stylesheet: await Bun.file(new URL('../web/workbench.css',import.meta.url)).text(),
  script: await build.outputs[0].text(),
};
const csrfToken = crypto.randomUUID();
const cookie = crypto.randomUUID();
const bootstrap = crypto.randomUUID();
const browserBootstrap = crypto.randomUUID();
const tokens = new Set<string>([bootstrap,browserBootstrap]);
let handler: (request: Request) => Promise<Response> = async () => new Response(null,{ status: 503 });
const server = Bun.serve({
  hostname: '127.0.0.1',port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== server.url.origin) return new Response(null,{ status: 403 });
    const token = url.searchParams.get('token');
    if (url.pathname === '/login' && request.method === 'GET' && token !== null && tokens.delete(token)) {
      return new Response(null,{ status: 303,headers: {
        location: '/approvals/','set-cookie': `approval_preview=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`,
        'cache-control': 'no-store','referrer-policy': 'no-referrer',
      } });
    }
    return handler(request);
  },
});
handler = createApprovalWorkbenchHandler({
  origin: server.url.origin,basePath: '/approvals',assets,
  authenticate: async request => request.headers.get('cookie')?.split(';').some(value => value.trim() === `approval_preview=${cookie}`)
    ? { tenant,actor: 'reviewer',csrfToken,connection,
      ...(operations ? { operatorConnection: makeConnection('supacloud_approval_operator') } : {}) } : null,
  authorizeEntity: async (_session,entity) => ['FA-2026-0916-001','FA-2026-0916-002'].includes(entity),
  onError: error => console.error(error instanceof Error ? error.message : 'Preview request failed'),
});
console.log(`Local approval acceptance: ${server.url.origin}/login?token=${bootstrap}`);
console.log(`Browser verification only: ${server.url.origin}/login?token=${browserBootstrap}`);
