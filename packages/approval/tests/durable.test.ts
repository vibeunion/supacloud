import { beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareApprovalOutcome } from '../src/index.js';
import { assertLocalApprovalContainer } from '../scripts/local-container.js';
import { loadApprovalMigrations, migrationScript } from '../scripts/migrations.js';
import { createApprovalWorkbenchHandler, type ApprovalWorkbenchSession } from '../src/workbench-http.js';
import {
  decodeDurableApprovalDefinition, durableApprovalClient, ApprovalOutcomeClaimSchema, approvalOutcomeClient,
  ApprovalBusinessSnapshotSchema, type ApprovalBusinessSnapshot,
  ApprovalNoticeClaimSchema, ApprovalWorkItemSchema, simulateApprovalDefinition,
  decodeApprovalGraph,planApprovalGraph,
} from '../src/durable.js';

const container = process.env.APPROVAL_TEST_CONTAINER ?? 'supacloud-approval-postgres-1';
const tenant = `test-${crypto.randomUUID()}`;
const definition = {
  schemaVersion: 1 as const,
  steps: [
    { key: 'technical', mode: 'all' as const, approvers: ['tech-1', 'tech-2'], timeoutSeconds: 300 },
    { key: 'quality', mode: 'any' as const, approvers: ['quality-1', 'quality-2'], timeoutSeconds: 300 },
  ],
};
function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function json(value: unknown): string { return `${quote(JSON.stringify(value))}::jsonb`; }
async function sql(text: string): Promise<string> {
  const proc = Bun.spawn(['docker', 'exec', '-i', container, 'psql', '-X', '-Atq',
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'],
  { stdin: new TextEncoder().encode(text), stdout: 'pipe', stderr: 'pipe' });
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(error);
  return output.trim();
}
async function call(expression: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await sql(`SET ROLE supacloud_approval_service; SELECT ${expression};`));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid receipt');
  return raw as Record<string, unknown>;
}
function id(receipt: Record<string, unknown>): string {
  if (typeof receipt.id !== 'string') throw new Error('Missing id');
  return receipt.id;
}
function version(receipt: Record<string, unknown>): string {
  if (typeof receipt.rowVersion !== 'string' || !/^\d+$/.test(receipt.rowVersion)) throw new Error('Missing version');
  return receipt.rowVersion;
}
function start(request: string = crypto.randomUUID(), key = 'review', entity: string = crypto.randomUUID(), actor = 'maker') {
  return call(`approval.start(${quote(tenant)},${quote(actor)},${quote(request)},${quote(key)},1,${quote(entity)})`);
}
function decide(receipt: Record<string, unknown>, actor: string, decision = 'approved', request = crypto.randomUUID()) {
  return call(`approval.decide(${quote(tenant)},${quote(actor)},${quote(request)},${quote(id(receipt))},
    ${version(receipt)},${quote(decision)},'reviewed')`);
}
async function until(query: string, expected: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await sql(query) === expected) return;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out: ${query}`);
}
async function waiting(receipt: Record<string, unknown>) {
  await until(`SET ROLE supacloud_approval_owner; SELECT EXISTS(
    SELECT 1 FROM df.instance_nodes(${quote(String(receipt.engineId))})
    WHERE node_type='SIGNAL' AND inferred_status='running');`, 't');
}
function decodeClaim(raw: string) {
  const value: unknown=JSON.parse(raw);
  if (!Value.Check(ApprovalOutcomeClaimSchema,value)) throw new Error('Invalid outcome claim');
  return value;
}
async function outcomeFixture() {
  const name=`outcome-${crypto.randomUUID()}`;
  await sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish(
    ${quote(name)},'publisher',${quote(crypto.randomUUID())},'review',1,${json(definition)});`);
  const run=await call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},'review',1,'entity')`);
  const result=await call(`approval.decide(${quote(name)},'tech-1',${quote(crypto.randomUUID())},
    ${quote(id(run))},1,'rejected','reviewed')`);
  return {tenant:name,run:result};
}

beforeAll(async () => {
  await assertLocalApprovalContainer(container);
  const bundle = migrationScript(await loadApprovalMigrations(), true);
  await sql(bundle);
  // Verify migrations can be rerun without deleting domain history.
  await sql(bundle);
  await sql(`SET ROLE supacloud_approval_owner;
    INSERT INTO approval.definitions(tenant,key,version,definition) VALUES
    (${quote(tenant)},'review',1,${json(definition)}),
    (${quote(tenant)},'timeout',1,${json({ schemaVersion: 1, steps: [
      { key: 'review', mode: 'all', approvers: ['tech-1'], timeoutSeconds: 2 },
    ] })});`);
}, 30000);

describe('pg_durable approval boundary', () => {
  test('approval package exports and workbench bundle build as consumable artifacts', async () => {
    const snapshot = { definitionKey: 'review',definitionVersion: '1',tenantId: 'tenant',
      entityId: 'entity',state: 'pending',rowVersion: 1 };
    expect(compareApprovalOutcome({
      kind: 'blocked',code: 'guard_denied',reasons: ['not qualified'],before: snapshot,
      requestId: 'request',actorId: 'actor',event: 'approve',
    },{
      kind: 'rejected',snapshot,idempotent: false,requestId: 'request',actorId: 'actor',event: 'approve',
    })).toEqual({ kind: 'match',reason: 'both_rejected' });
    const directory = await mkdtemp(join(tmpdir(),'approval-artifacts-'));
    try {
      const result = Bun.spawnSync(['bun',new URL('../node_modules/typescript/bin/tsc',import.meta.url).pathname,
        '-p',new URL('../tsconfig.json',import.meta.url).pathname,'--outDir',directory]);
      expect(new TextDecoder().decode(result.stdout)+new TextDecoder().decode(result.stderr)).toBe('');
      expect(result.exitCode).toBe(0);
      for (const entry of ['index','fa','durable','workbench-http']) {
        expect(await Bun.file(join(directory,`${entry}.js`)).exists()).toBe(true);
        expect(await Bun.file(join(directory,`${entry}.d.ts`)).exists()).toBe(true);
      }
      const browser = await Bun.build({
        entrypoints: [new URL('../web/workbench.ts',import.meta.url).pathname],target: 'browser',
      });
      expect(browser.success).toBe(true);
      expect(browser.outputs.length).toBe(1);
      expect(await browser.outputs[0]?.text()).toContain('recover-notice');
    } finally { await rm(directory,{ recursive: true,force: true }); }
  },20000);

  test('controlled migration requires authorization, rolls back failures and preserves evidence on replay', async () => {
    const key = `migration-${crypto.randomUUID()}`;
    const original = await sql("SELECT pg_get_functiondef('approval.authorize_migration(text,uuid,text,integer)'::regprocedure);");
    await sql(`SET ROLE supacloud_approval_publisher;
      SELECT approval.publish(${quote(tenant)},'publisher',${quote(crypto.randomUUID())},${quote(key)},1,${json(definition)});
      SELECT approval.publish(${quote(tenant)},'publisher',${quote(crypto.randomUUID())},${quote(key)},2,${json(definition)});
      SELECT approval.publish(${quote(tenant)},'publisher',${quote(crypto.randomUUID())},${quote(key)},3,
        ${json({ schemaVersion: 3,subjectResolver: 'missing.adapter',steps: [{
          key: 'review',mode: 'all',assignment: { resolver: 'missing.adapter',scope: 'lab' },timeoutSeconds: 300,
        }] })});`);
    const run = await start(crypto.randomUUID(),key);
    const request = crypto.randomUUID();
    const expression = (target: number, expected = version(run)) =>
      `approval.migrate_run(${quote(tenant)},'operator',${quote(request)},${quote(id(run))},${expected},${target},NULL,'policy revision')`;
    const migrate = (target: number, expected?: string) =>
      sql(`SET ROLE supacloud_approval_operator; SELECT ${expression(target,expected)};`);
    try {
      await expect(migrate(2)).rejects.toThrow('APPROVAL_MIGRATION_FORBIDDEN');
      await expect(sql(`SET ROLE supacloud_approval_service; SELECT ${expression(2)};`)).rejects.toThrow('permission denied');
      await sql(`CREATE OR REPLACE FUNCTION approval.authorize_migration(p_tenant text,p_run uuid,p_actor text,p_target_version integer)
        RETURNS boolean LANGUAGE sql SET search_path='' AS 'SELECT true';`);
      await expect(migrate(2,'999')).rejects.toThrow('APPROVAL_STALE_VERSION');
      await expect(migrate(99)).rejects.toThrow('APPROVAL_MIGRATION_TARGET_INVALID');
      await expect(migrate(3)).rejects.toThrow();
      expect(await sql(`SELECT status||':'||row_version FROM approval.runs WHERE id=${quote(id(run))};`)).toBe(`pending:${version(run)}`);
      expect(await sql(`SELECT count(*) FROM approval.outcomes WHERE run_id=${quote(id(run))};`)).toBe('0');
      const raw = await migrate(2);
      const migrated: unknown = JSON.parse(raw);
      expect(migrated).toMatchObject({ status: 'pending',migrationSourceRunId: id(run) });
      expect(await migrate(2)).toBe(raw);
      expect(await sql(`SELECT status FROM approval.runs WHERE id=${quote(id(run))};`)).toBe('cancelled');
      expect(await sql(`SELECT count(*) FROM approval.instance_migrations WHERE source_run_id=${quote(id(run))};`)).toBe('1');
      expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(id(run))} AND kind='migrated_out' AND actor='operator';`)).toBe('1');
      await expect(decide(run,'tech-1')).rejects.toThrow();
      await expect(sql(`UPDATE approval.instance_migrations SET reason='changed' WHERE source_run_id=${quote(id(run))};`)).rejects.toThrow();
    } finally { await sql(`${original};`); }
  },60000);

  test('workbench HTTP boundary rejects forged identity, CSRF and hidden entities and sanitizes failures', async () => {
    const run = await start();
    const origin = 'http://localhost:54329';
    const csrfToken = 'x'.repeat(32);
    let queries = 0;
    let fail = false;
    let visible = true;
    let authenticated = true;
    const session: ApprovalWorkbenchSession = {
      tenant,actor: 'tech-1',csrfToken,
      connection: { async query(statement,parameters) {
        queries++;
        if (fail) throw new Error('private connection password');
        if (statement.includes('approval.get_run')) return [{ receipt: run }];
        if (statement.includes('approval.decide')) {
          expect(parameters[0]).toBe(tenant);
          expect(parameters[1]).toBe('tech-1');
          throw new Error('ERROR: APPROVAL_STALE_VERSION');
        }
        throw new Error(`Unexpected fixture query: ${statement}`);
      } },
    };
    const errors: unknown[] = [];
    const handler = createApprovalWorkbenchHandler({
      origin,basePath: '/approvals',authenticate: async () => authenticated ? session : null,
      authorizeEntity: async () => visible,assets: { html: '<main>Approvals</main>',script: '',stylesheet: '' },
      onError: error => errors.push(error),
    });
    const get = (path: string) => handler(new Request(`${origin}/approvals${path}`));
    const post = (path: string,body: unknown,token = csrfToken) => handler(new Request(`${origin}/approvals${path}`,{
      method: 'POST',headers: { origin,'x-csrf-token': token,'content-type': 'application/json' },body: JSON.stringify(body),
    }));
    const path = `/api/runs/${id(run)}`;
    const body = { action: 'approve',requestId: crypto.randomUUID(),expectedVersion: version(run),reason: 'reviewed' };
    authenticated = false;
    expect((await get('/')).status).toBe(401);
    expect(queries).toBe(0);
    authenticated = true;
    expect((await post(`${path}/command`,body,'bad')).status).toBe(403);
    expect(queries).toBe(0);
    expect((await get('/api/health')).status).toBe(403);
    visible = false;
    expect((await get(path)).status).toBe(404);
    visible = true;
    expect((await post(`${path}/command`,{ ...body,tenant: 'other' })).status).toBe(400);
    expect((await post(`${path}/command`,{ ...body,actor: 'maker' })).status).toBe(400);
    expect((await post(`${path}/command`,{ ...body,reason: 'x'.repeat(65536) })).status).toBe(413);
    expect((await get(`${path}/rounds?after=NaN`)).status).toBe(400);
    expect((await post(`${path}/migrate`,{})).status).toBe(403);
    expect((await get(`${path}/notices`)).status).toBe(403);
    expect((await post(`${path}/recover-notice`,{})).status).toBe(403);
    const noticeId = crypto.randomUUID();
    let operatorQueries = 0;
    session.operatorConnection = { async query(statement,parameters) {
      operatorQueries++;
      expect(parameters[0]).toBe(tenant);
      if (statement.includes('list_notices')) return [{ result: [] }];
      expect(parameters[1]).toBe('tech-1');
      expect(parameters[3]).toBe(id(run));
      expect(parameters[4]).toBe(noticeId);
      return [{ result: { noticeId,runId: id(run),status: 'ready' } }];
    } };
    expect((await get(`${path}/notices?after=invalid`)).status).toBe(400);
    expect(operatorQueries).toBe(0);
    expect(await (await get(`${path}/notices`)).json()).toEqual([]);
    const recovery = { requestId: crypto.randomUUID(),noticeId,expectedAttempts: 10,reason: 'retry' };
    expect((await post(`${path}/recover-notice`,{ ...recovery,actor: 'forged' })).status).toBe(400);
    expect((await post(`${path}/recover-notice`,recovery)).status).toBe(200);
    visible = false;
    const previousQueries = operatorQueries;
    expect((await post(`${path}/recover-notice`,recovery)).status).toBe(404);
    expect(operatorQueries).toBe(previousQueries);
    visible = true;
    delete session.operatorConnection;
    const stale = await post(`${path}/command`,body);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'APPROVAL_STALE_VERSION' });
    fail = true;
    const unavailable = await get(path);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('password');
    expect(errors.length).toBe(1);
    const asset = await get('/');
    expect(asset.headers.get('cache-control')).toBe('no-store');
    expect(asset.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  },60000);

  test('changed runtime, tooling and targeted tests satisfy strict TypeScript without emitting files', () => {
    const result=Bun.spawnSync(['bun',new URL('../node_modules/typescript/bin/tsc',import.meta.url).pathname,
      '-p',new URL('../tsconfig.durable.json',import.meta.url).pathname],{
      cwd:new URL('../',import.meta.url).pathname,
    });
    expect(new TextDecoder().decode(result.stdout)+new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
  },20000);

  test('self-host extension initialization scripts have valid shell syntax', () => {
    for (const name of ['00-configure-postgres.sh', '02-durable.sh']) {
      const path = new URL(`../../../docker/self-host/postgres/initdb/${name}`, import.meta.url);
      const result = Bun.spawnSync(['bash', '-n', path.pathname]);
      expect(new TextDecoder().decode(result.stderr)).toBe('');
      expect(result.exitCode).toBe(0);
    }
  });

  test('single schema rejects invalid structures in application and PostgreSQL', async () => {
    for (const invalid of [
      {}, { ...definition, extra: true },
      { schemaVersion: 1, steps: [{ ...definition.steps[0], timeoutSeconds: '20' }] },
      { schemaVersion: 1, steps: [{ ...definition.steps[0], approvers: ['tech-1', 'tech-1'] }] },
      { schemaVersion: 1, steps: [{ ...definition.steps[0], sql: 'SELECT 1' }] },
    ]) {
      expect(() => decodeDurableApprovalDefinition(invalid)).toThrow();
      expect(await sql(`SELECT approval.valid_definition(${json(invalid)});`)).toBe('f');
    }
    expect(decodeDurableApprovalDefinition(definition)).toEqual(definition);
    expect(await sql(`SELECT approval.valid_definition(${json(definition)});`)).toBe('t');
  });

  test('rule assignment definitions have matching application and database validation', async () => {
    const step = { key: 'review', mode: 'all' as const, assignment: { resolver: 'fa.qualified', scope: 'lab-1' }, timeoutSeconds: 300 };
    const valid = { schemaVersion: 2 as const, steps: [step] };
    expect(decodeDurableApprovalDefinition(valid)).toEqual(valid);
    expect(await sql(`SELECT approval.valid_definition(${json(valid)});`)).toBe('t');
    for (const invalid of [
      { schemaVersion: 2, steps: [{ ...step, approvers: ['tech-1'] }] },
      { schemaVersion: 2, steps: [{ ...step, assignment: { resolver: 'SELECT 1', scope: 'lab-1' } }] },
      { schemaVersion: 2, steps: [{ ...step, assignment: { resolver: 'fa.qualified', scope: '' } }] },
      { schemaVersion: 2, steps: [{ ...step, assignment: { ...step.assignment, sql: 'SELECT 1' } }] },
      { schemaVersion: 1, steps: [step] },
    ]) {
      expect(() => decodeDurableApprovalDefinition(invalid)).toThrow('APPROVAL_DEFINITION_INVALID');
      expect(await sql(`SELECT approval.valid_definition(${json(invalid)});`)).toBe('f');
    }
  });

  test('dynamic assignments snapshot each stage, recheck eligibility and fail atomically', async () => {
    const dynamic = { schemaVersion: 2, steps: [
      { key: 'technical', mode: 'all', assignment: { resolver: 'test.qualified', scope: 'lab' }, timeoutSeconds: 300 },
      { key: 'quality', mode: 'any', assignment: { resolver: 'test.qualified', scope: 'quality' }, timeoutSeconds: 300 },
    ] };
    await sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish(
      ${quote(tenant)},'publisher',${quote(crypto.randomUUID())},'dynamic',1,${json(dynamic)});`);
    const entity = crypto.randomUUID();
    const request = crypto.randomUUID();
    await expect(start(request, 'dynamic', entity)).rejects.toThrow('APPROVAL_ASSIGNMENT_ADAPTER_REQUIRED');
    expect(await sql(`SELECT count(*) FROM approval.runs WHERE tenant=${quote(tenant)} AND entity_id=${quote(entity)};`)).toBe('0');
    const originalAdapter = await sql("SELECT pg_get_functiondef('approval.resolve_assignment(text,text,jsonb)'::regprocedure);");
    try {
      await sql(`SET ROLE supacloud_approval_owner;
        CREATE TABLE approval.test_assignment_source(
          tenant text, entity text, scope text, resolution jsonb, PRIMARY KEY(tenant,entity,scope));
        INSERT INTO approval.test_assignment_source VALUES
          (${quote(tenant)},${quote(entity)},'lab','{"actors":["tech-1","tech-2"],"revision":"1"}'),
          (${quote(tenant)},${quote(entity)},'quality','{"actors":["quality-1"],"revision":"1"}');
        CREATE OR REPLACE FUNCTION approval.resolve_assignment(p_tenant text,p_entity text,p_rule jsonb) RETURNS jsonb
        LANGUAGE plpgsql SET search_path='' AS $$
        DECLARE result jsonb;
        BEGIN
          IF p_rule->>'resolver'<>'test.qualified' THEN RAISE EXCEPTION 'UNKNOWN_RESOLVER'; END IF;
          SELECT resolution INTO result FROM approval.test_assignment_source
            WHERE tenant=p_tenant AND entity=p_entity AND scope=p_rule->>'scope' FOR SHARE;
          RETURN result;
        END $$;`);
      const setResolution = (scope: string, resolution: unknown) => sql(`UPDATE approval.test_assignment_source
        SET resolution=${json(resolution)} WHERE tenant=${quote(tenant)} AND entity=${quote(entity)} AND scope=${quote(scope)};`);
      for (const resolution of [
        null, { actors: [], revision: '1' }, { actors: ['tech-1', 'tech-1'], revision: '1' },
        { actors: ['bad actor'], revision: '1' }, { actors: ['tech-1'], revision: '' },
        { actors: ['tech-1'], revision: '1', extra: true },
      ]) {
        await setResolution('lab', resolution);
        await expect(start(request, 'dynamic', entity)).rejects.toThrow('APPROVAL_ASSIGNMENT_RESOLUTION_INVALID');
      }
      await setResolution('lab', { actors: ['maker'], revision: '1' });
      await expect(start(request, 'dynamic', entity)).rejects.toThrow('APPROVAL_MAKER_CHECKER');
      expect(await sql(`SELECT count(*) FROM approval.receipts WHERE tenant=${quote(tenant)} AND request_id=${quote(request)};`)).toBe('0');
      await setResolution('lab', { actors: ['tech-1', 'tech-2'], revision: '2' });
      let run = await start(request, 'dynamic', entity);
      const initial = run;
      const snapshot = await sql(`SELECT resolution FROM approval.assignments WHERE tenant=${quote(tenant)} AND run_id=${quote(id(run))};`);
      expect(JSON.parse(snapshot)).toEqual({ actors: ['tech-1', 'tech-2'], revision: '2' });
      await setResolution('lab', { actors: ['tech-2', 'tech-3'], revision: '3' });
      await expect(decide(run, 'tech-1')).rejects.toThrow('APPROVAL_ACTOR_INELIGIBLE');
      await expect(decide(run, 'tech-1', 'rejected')).rejects.toThrow('APPROVAL_ACTOR_INELIGIBLE');
      await expect(decide(run, 'tech-3')).rejects.toThrow('APPROVAL_ACTOR_NOT_ASSIGNED');
      expect(await call(`approval.get_run(${quote(tenant)},${quote(id(run))})`)).toEqual(initial);
      expect(await start(request, 'dynamic', entity)).toEqual(initial);
      expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(id(run))} AND kind='eligibility_verified';`)).toBe('0');
      await setResolution('lab', { actors: ['tech-1', 'tech-2'], revision: '4' });
      const decisionRequest = crypto.randomUUID();
      const transactionName = `assignment-${crypto.randomUUID()}`;
      const pendingDecision = sql(`SET application_name=${quote(transactionName)};
        SET ROLE supacloud_approval_service; BEGIN;
        SELECT approval.decide(${quote(tenant)},'tech-1',${quote(decisionRequest)},${quote(id(run))},
          ${version(run)},'approved','reviewed');
        SELECT pg_sleep(4); COMMIT;`);
      await until(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE application_name=${quote(transactionName)} AND wait_event='PgSleep');`, 't');
      const revocation = setResolution('lab', { actors: ['tech-2'], revision: '5' });
      await until(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE 'UPDATE approval.test_assignment_source%'
        AND query LIKE ${quote(`%${entity}%`)});`, 't');
      const [decisionResult] = await Promise.all([pendingDecision, revocation]);
      const decoded: unknown = JSON.parse(decisionResult);
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid decision');
      run = decoded as Record<string, unknown>;
      expect(await decide(initial, 'tech-1', 'approved', decisionRequest)).toEqual(run);
      expect(await sql(`SELECT resolution FROM approval.assignments WHERE tenant=${quote(tenant)} AND run_id=${quote(id(run))};`)).toBe(snapshot);
      await setResolution('quality', { actors: ['maker'], revision: '2' });
      await expect(decide(run, 'tech-2')).rejects.toThrow('APPROVAL_MAKER_CHECKER');
      expect(await call(`approval.get_run(${quote(tenant)},${quote(id(run))})`)).toEqual(run);
      expect(await sql(`SELECT count(*) FROM approval.assignments WHERE run_id=${quote(id(run))};`)).toBe('1');
      await setResolution('quality', { actors: ['quality-2'], revision: '3' });
      run = await decide(run, 'tech-2');
      expect(run.stepIndex).toBe(1);
      expect(await sql(`SELECT resolution->'actors' FROM approval.assignments WHERE run_id=${quote(id(run))} AND step_index=1;`)).toBe('["quality-2"]');
      await expect(decide(run, 'quality-1')).rejects.toThrow('APPROVAL_ACTOR_NOT_ASSIGNED');
      run = await decide(run, 'quality-2');
      expect(run.status).toBe('approved');
      expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(id(run))} AND kind='eligibility_verified';`)).toBe('3');
      expect(await sql(`SELECT detail->>'eligibilityRevision' FROM approval.events WHERE run_id=${quote(id(run))}
        AND kind='eligibility_verified' AND actor='tech-1';`)).toBe('4');
      for (const statement of [
        `UPDATE approval.assignments SET rule=rule WHERE run_id=${quote(id(run))}`,
        `DELETE FROM approval.assignments WHERE run_id=${quote(id(run))}`,
        'TRUNCATE approval.assignments',
      ]) await expect(sql(statement)).rejects.toThrow('APPROVAL_IMMUTABLE_RECORD');
      await expect(sql('SET ROLE supacloud_approval_service; SELECT * FROM approval.assignments;')).rejects.toThrow('permission denied');
      await expect(sql(`SET ROLE supacloud_approval_service;
        SELECT approval.resolve_assignment(${quote(tenant)},${quote(entity)},'{}');`)).rejects.toThrow('permission denied');
      await expect(start(crypto.randomUUID(), 'dynamic', 'different-entity')).rejects.toThrow('APPROVAL_ASSIGNMENT_RESOLUTION_INVALID');
      await expect(call(`approval.start('different-tenant','maker',${quote(crypto.randomUUID())},'dynamic',1,${quote(entity)})`))
        .rejects.toThrow('APPROVAL_DEFINITION_NOT_FOUND');
    } finally {
      await sql(`${originalAdapter};\nDROP TABLE IF EXISTS approval.test_assignment_source;`);
    }
  }, 60000);

  test('business snapshot definitions and values share strict application/database schemas', async () => {
    const valid = { schemaVersion: 3 as const, subjectResolver: 'fa.report', steps: [
      { key: 'review', mode: 'all' as const, assignment: { resolver: 'fa.reviewers', scope: 'lab' }, timeoutSeconds: 300 },
    ] };
    expect(decodeDurableApprovalDefinition(valid)).toEqual(valid);
    expect(await sql(`SELECT approval.valid_definition(${json(valid)});`)).toBe('t');
    for (const invalid of [
      { ...valid, subjectResolver: '' }, { ...valid, subjectResolver: 'SELECT 1' },
      { ...valid, schemaVersion: 2 }, { schemaVersion: 3, steps: valid.steps },
    ]) {
      expect(() => decodeDurableApprovalDefinition(invalid)).toThrow();
      expect(await sql(`SELECT approval.valid_definition(${json(invalid)});`)).toBe('f');
    }
    for (const invalid of [
      null, {}, { revision: '', sha256: 'a'.repeat(64) },
      { revision: '1', sha256: 'A'.repeat(64) }, { revision: '1', sha256: 'a'.repeat(63) },
      { revision: '1', sha256: 'a'.repeat(64), extra: true },
    ]) {
      expect(Value.Check(ApprovalBusinessSnapshotSchema, invalid)).toBe(false);
      expect(await sql(`SELECT approval.valid_business_snapshot(${json(invalid)});`)).toBe('f');
    }
  });

  test('business snapshots bind commands, audit and outcomes with atomic current-version checks', async () => {
    const name = `subject-${crypto.randomUUID()}`;
    const entity = crypto.randomUUID();
    const snapshot: ApprovalBusinessSnapshot = { revision: '1', sha256: 'a'.repeat(64) };
    const changed = { revision: '2', sha256: 'b'.repeat(64) };
    const boundDefinition = { schemaVersion: 3, subjectResolver: 'test.report', steps: [
      { key: 'review', mode: 'all', assignment: { resolver: 'test.reviewers', scope: 'lab' }, timeoutSeconds: 300 },
    ] };
    await sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish(
      ${quote(name)},'publisher',${quote(crypto.randomUUID())},'bound',1,${json(boundDefinition)});`);
    const request = crypto.randomUUID();
    const begin = (expected: unknown = snapshot, req = request) => call(`approval.start(
      ${quote(name)},'maker',${quote(req)},'bound',1,${quote(entity)},${json(expected)})`);
    const decisionExpression = (run: Record<string, unknown>, expected: unknown = snapshot,
      req = crypto.randomUUID(), decision = 'approved') => `approval.decide(
      ${quote(name)},'reviewer',${quote(req)},${quote(id(run))},${version(run)},${quote(decision)},'reviewed',${json(expected)})`;
    await expect(begin()).rejects.toThrow('APPROVAL_SUBJECT_ADAPTER_REQUIRED');
    await expect(call(`approval.start(${quote(name)},'maker',${quote(request)},'bound',1,${quote(entity)})`))
      .rejects.toThrow('APPROVAL_INVALID_SNAPSHOT');
    const originalSubject = await sql("SELECT pg_get_functiondef('approval.resolve_subject(text,text,text)'::regprocedure);");
    const originalAssignment = await sql("SELECT pg_get_functiondef('approval.resolve_assignment(text,text,jsonb)'::regprocedure);");
    try {
      await sql(`SET ROLE supacloud_approval_owner;
        CREATE TABLE approval.test_subject_source(tenant text,entity text,snapshot jsonb,PRIMARY KEY(tenant,entity));
        INSERT INTO approval.test_subject_source VALUES(${quote(name)},${quote(entity)},${json(snapshot)});
        CREATE OR REPLACE FUNCTION approval.resolve_subject(p_tenant text,p_entity text,p_resolver text) RETURNS jsonb
        LANGUAGE plpgsql SET search_path='' AS $$
        DECLARE result jsonb;
        BEGIN
          IF p_resolver<>'test.report' THEN RAISE EXCEPTION 'UNKNOWN_RESOLVER'; END IF;
          SELECT snapshot INTO result FROM approval.test_subject_source
            WHERE tenant=p_tenant AND entity=p_entity FOR SHARE;
          RETURN result;
        END $$;
        CREATE OR REPLACE FUNCTION approval.resolve_assignment(p_tenant text,p_entity text,p_rule jsonb) RETURNS jsonb
        LANGUAGE plpgsql SET search_path='' AS $$
        BEGIN
          IF p_rule='{"resolver":"test.reviewers","scope":"lab"}'::jsonb AND EXISTS(
            SELECT 1 FROM approval.test_subject_source WHERE tenant=p_tenant AND entity=p_entity
          ) THEN RETURN '{"actors":["reviewer"],"revision":"1"}'::jsonb; END IF;
          RAISE EXCEPTION 'UNKNOWN_ASSIGNMENT';
        END $$;`);
      const update = (value: unknown) => sql(`UPDATE approval.test_subject_source SET snapshot=${json(value)}
        WHERE tenant=${quote(name)} AND entity=${quote(entity)};`);
      await expect(begin(changed)).rejects.toThrow('APPROVAL_SUBJECT_CHANGED');
      expect(await sql(`SELECT count(*) FROM approval.runs WHERE tenant=${quote(name)};`)).toBe('0');
      const run = await begin();
      expect(run.businessSnapshot).toEqual(snapshot);
      await expect(begin(changed)).rejects.toThrow('APPROVAL_IDEMPOTENCY_CONFLICT');
      await expect(call(`approval.decide(${quote(name)},'reviewer',${quote(crypto.randomUUID())},
        ${quote(id(run))},1,'approved','reviewed')`)).rejects.toThrow('APPROVAL_SNAPSHOT_MISMATCH');
      await expect(call(decisionExpression(run, changed))).rejects.toThrow('APPROVAL_SNAPSHOT_MISMATCH');
      for (const current of [changed, { ...snapshot, sha256: changed.sha256 }, { ...snapshot, revision: '2' }]) {
        await update(current);
        await expect(call(decisionExpression(run))).rejects.toThrow('APPROVAL_SUBJECT_CHANGED');
        await expect(call(decisionExpression(run, snapshot, crypto.randomUUID(), 'rejected')))
          .rejects.toThrow('APPROVAL_SUBJECT_CHANGED');
      }
      await update({});
      await expect(call(decisionExpression(run))).rejects.toThrow('APPROVAL_SUBJECT_RESOLUTION_INVALID');
      expect(await call(`approval.get_run(${quote(name)},${quote(id(run))})`)).toEqual(run);
      expect(await sql(`SELECT count(*) FROM approval.events WHERE tenant=${quote(name)} AND kind='decision';`)).toBe('0');
      expect(await sql(`SELECT count(*) FROM approval.outcomes WHERE tenant=${quote(name)};`)).toBe('0');
      expect(await sql(`SELECT count(*) FROM approval.wakeups WHERE tenant=${quote(name)};`)).toBe('0');
      expect(await sql(`SELECT count(*) FROM approval.receipts WHERE tenant=${quote(name)};`)).toBe('1');
      expect(await begin()).toEqual(run);
      await update(snapshot);
      const decisionRequest = crypto.randomUUID();
      const transactionName = `subject-${crypto.randomUUID()}`;
      const pending = sql(`SET application_name=${quote(transactionName)}; SET ROLE supacloud_approval_service;
        BEGIN; SELECT ${decisionExpression(run, snapshot, decisionRequest)}; SELECT pg_sleep(4); COMMIT;`);
      await until(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE application_name=${quote(transactionName)} AND wait_event='PgSleep');`, 't');
      const edit = update(changed);
      await until(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE 'UPDATE approval.test_subject_source%' AND query LIKE ${quote(`%${entity}%`)});`, 't');
      const [result] = await Promise.all([pending, edit]);
      const approved: unknown = JSON.parse(result);
      if (approved === null || typeof approved !== 'object' || Array.isArray(approved)) throw new Error('Invalid decision');
      expect(await call(decisionExpression(run, snapshot, decisionRequest))).toEqual(approved as Record<string, unknown>);
      expect(await sql(`SELECT status FROM approval.runs WHERE id=${quote(id(run))};`)).toBe('approved');
      expect(JSON.parse(await sql(`SELECT detail->'businessSnapshot' FROM approval.events
        WHERE tenant=${quote(name)} AND kind='decision';`))).toEqual(snapshot);
      const claim = decodeClaim(await sql(`SET ROLE supacloud_approval_consumer;
        SELECT approval.claim_outcome(${quote(name)},60);`));
      expect(claim.payload.businessSnapshot).toEqual(snapshot);
      for (const statement of [
        `UPDATE approval.runs SET business_snapshot=${json(changed)} WHERE id=${quote(id(run))}`,
        `UPDATE approval.runs SET entity_id='different' WHERE id=${quote(id(run))}`,
        `UPDATE approval.runs SET subject_resolver='other' WHERE id=${quote(id(run))}`,
      ]) await expect(sql(statement)).rejects.toThrow('APPROVAL_SNAPSHOT_IMMUTABLE');
      await expect(sql(`SET ROLE supacloud_approval_service;
        SELECT approval.resolve_subject(${quote(name)},${quote(entity)},'test.report');`)).rejects.toThrow('permission denied');
      await expect(call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},
        'bound',1,'wrong-entity',${json(changed)})`)).rejects.toThrow('APPROVAL_SUBJECT_RESOLUTION_INVALID');
      const second = await begin(changed, crypto.randomUUID());
      await update({ ...changed, revision: '3' });
      const cancelled = await call(`approval.cancel(${quote(name)},'maker',${quote(crypto.randomUUID())},
        ${quote(id(second))},${version(second)})`);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.businessSnapshot).toEqual(changed);
      await sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish(${quote(name)},'publisher',
        ${quote(crypto.randomUUID())},'bound-timeout',1,${json({
          ...boundDefinition, steps: boundDefinition.steps.map(step => ({ ...step, timeoutSeconds: 2 })),
        })});`);
      const timedSnapshot = { ...changed, revision: '3' };
      const expiring = await call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},
        'bound-timeout',1,${quote(entity)},${json(timedSnapshot)})`);
      await update({});
      await until(`SELECT status FROM approval.runs WHERE id=${quote(id(expiring))};`, 'timed_out');
      expect(JSON.parse(await sql(`SELECT payload->'businessSnapshot' FROM approval.outcomes
        WHERE run_id=${quote(id(expiring))};`))).toEqual(timedSnapshot);
    } finally {
      await sql(`${originalSubject};\n${originalAssignment};\nDROP TABLE IF EXISTS approval.test_subject_source;`);
    }
  }, 40000);

  test('bound clients reject invalid input, missing snapshots and mismatched receipts', async () => {
    const snapshot: ApprovalBusinessSnapshot = { revision: '1', sha256: 'a'.repeat(64) };
    const original = await start();
    await expect(call(`approval.start(${quote(tenant)},'maker',${quote(crypto.randomUUID())},
      'review',1,${quote(crypto.randomUUID())},${json(snapshot)})`)).rejects.toThrow('APPROVAL_SNAPSHOT_UNSUPPORTED');
    await expect(call(`approval.decide(${quote(tenant)},'tech-1',${quote(crypto.randomUUID())},
      ${quote(id(original))},${version(original)},'approved','reviewed',${json(snapshot)})`))
      .rejects.toThrow('APPROVAL_SNAPSHOT_UNSUPPORTED');
    const receipt = { ...original, businessSnapshot: snapshot };
    const calls: { statement: string; parameters: readonly unknown[] }[] = [];
    const client = durableApprovalClient({ async query(statement, parameters) {
      calls.push({ statement, parameters });
      return [{ receipt }];
    } });
    const input = {
      tenant, actor: 'maker', requestId: crypto.randomUUID(), definitionKey: 'bound', definitionVersion: 1,
      entityId: String(original.entityId), businessSnapshot: snapshot,
    };
    expect((await client.start(input)).businessSnapshot).toEqual(snapshot);
    expect(calls[0]?.statement).toContain('$7::jsonb');
    expect(calls[0]?.parameters[6]).toBe(JSON.stringify(snapshot));
    expect(() => client.start({ ...input, businessSnapshot: { ...snapshot, sha256: 'bad' } }))
      .toThrow('APPROVAL_INVALID_SNAPSHOT');
    const decision = {
      tenant, actor: 'tech-1', requestId: crypto.randomUUID(), runId: id(original),
      expectedVersion: version(original), decision: 'approved' as const, reason: '', businessSnapshot: snapshot,
    };
    expect((await client.decide(decision)).businessSnapshot).toEqual(snapshot);
    expect(calls[1]?.statement).toContain('$8::jsonb');
    expect(calls[1]?.parameters[7]).toBe(JSON.stringify(snapshot));
    expect(() => client.decide({ ...decision, businessSnapshot: { ...snapshot, revision: '' } }))
      .toThrow('APPROVAL_INVALID_SNAPSHOT');
    for (const wrong of [original, { ...receipt, businessSnapshot: { ...snapshot, revision: '2' } },
      { ...receipt, businessSnapshot: { ...snapshot, sha256: 'b'.repeat(64) } }]) {
      const wrongClient = durableApprovalClient({ async query() { return [{ receipt: wrong }]; } });
      await expect(wrongClient.start(input)).rejects.toThrow('APPROVAL_RECEIPT_SNAPSHOT_MISMATCH');
      await expect(wrongClient.decide(decision)).rejects.toThrow('APPROVAL_RECEIPT_SNAPSHOT_MISMATCH');
    }
    const invalidOutcome = approvalOutcomeClient({ async query() {
      return [{ result: { payload: { tenant, runId: id(original), entityId: String(original.entityId),
        definitionKey: 'bound', definitionVersion: 1, status: 'approved', rowVersion: '2',
        businessSnapshot: { revision: '1', sha256: 'bad' } },
      leaseToken: crypto.randomUUID(), leaseUntil: new Date().toISOString(), attempt: 1 } }];
    } });
    await expect(invalidOutcome.claim(tenant)).rejects.toThrow('APPROVAL_OUTCOME_RESULT_INVALID');
    await decide(original, 'tech-1', 'rejected');
  });

  test('publication rejects duplicate steps and published versions are immutable', async () => {
    const duplicate = { schemaVersion: 1, steps: [definition.steps[0], definition.steps[0]] };
    expect(() => decodeDurableApprovalDefinition(duplicate)).toThrow('APPROVAL_DUPLICATE_STEP');
    await expect(sql(`INSERT INTO approval.definitions VALUES
      (${quote(tenant)},'bad',1,${json(duplicate)},now());`)).rejects.toThrow('APPROVAL_DUPLICATE_STEP');
    await expect(sql(`UPDATE approval.definitions SET definition=definition
      WHERE tenant=${quote(tenant)};`)).rejects.toThrow('APPROVAL_DEFINITION_IMMUTABLE');
    await expect(sql(`INSERT INTO approval.definitions(tenant,key,version,definition)
      VALUES(${quote(tenant)},'invalid',1,'{}');`)).rejects.toThrow('check constraint');
  });

  test('return and resubmit preserve rounds, fence old tasks and serialize duplicate submissions', async () => {
    let run = await start();
    run = await decide(run, 'tech-1');
    run = await decide(run, 'tech-2');
    const parent = run;
    const request = crypto.randomUUID();
    const returnCommand = `approval.return_for_changes(${quote(tenant)},'quality-1',${quote(request)},
      ${quote(id(run))},${version(run)},'Correct the report')`;
    await expect(call(`approval.return_for_changes(${quote(tenant)},'unassigned',${quote(crypto.randomUUID())},
      ${quote(id(run))},${version(run)},'Correct')`)).rejects.toThrow('APPROVAL_ACTOR_NOT_ASSIGNED');
    await expect(call(`approval.return_for_changes(${quote(tenant)},'quality-1',${quote(crypto.randomUUID())},
      ${quote(id(run))},${version(run)},' ')`)).rejects.toThrow('APPROVAL_RETURN_REASON_REQUIRED');
    run = await call(returnCommand);
    expect(run.status).toBe('returned');
    expect(run.round).toBe(1);
    expect(await call(returnCommand)).toEqual(run);
    await expect(decide(parent, 'quality-1')).rejects.toThrow('APPROVAL_NOT_PENDING');
    const newRequest = crypto.randomUUID();
    const resubmit = `approval.resubmit(${quote(tenant)},'maker',${quote(newRequest)},
      ${quote(id(run))},${version(run)},NULL,'Report corrected')`;
    await expect(call(`approval.resubmit(${quote(tenant)},'tech-1',${quote(crypto.randomUUID())},
      ${quote(id(run))},${version(run)},NULL,'Corrected')`)).rejects.toThrow('APPROVAL_NOT_REQUESTER');
    const [next, replay] = await Promise.all([call(resubmit), call(resubmit)]);
    expect(next).toEqual(replay);
    expect(next.id).not.toBe(run.id);
    expect(next.rootRunId).toBe(run.rootRunId);
    expect(next.previousRunId).toBe(run.id);
    expect(next.round).toBe(2);
    expect(next.stepIndex).toBe(0);
    expect(next.executionVersion).toBe(1);
    await expect(call(`approval.resubmit(${quote(tenant)},'maker',${quote(crypto.randomUUID())},
      ${quote(id(run))},${version(run)},NULL,'Again')`)).rejects.toThrow('APPROVAL_RESUBMISSION_CONFLICT');
    const oldToken = await sql(`SELECT wait_token FROM approval.runs WHERE id=${quote(id(run))};`);
    expect(await sql(`SET ROLE supacloud_approval_owner; SELECT approval.resume_wait(
      ${quote(tenant)},${quote(id(run))},${quote(oldToken)});`)).toBe('f');
    expect(await call(`approval.get_run(${quote(tenant)},${quote(id(next))})`)).toEqual(next);
    expect(await sql(`SELECT count(*) FROM approval.tasks WHERE run_id=${quote(id(run))} AND status='approved';`)).toBe('2');
    expect(await sql(`SELECT payload->>'status' FROM approval.outcomes WHERE run_id=${quote(id(run))};`)).toBe('returned');
    await expect(sql(`UPDATE approval.runs SET review_round=3 WHERE id=${quote(id(next))};`))
      .rejects.toThrow('APPROVAL_LINEAGE_IMMUTABLE');
    await decide(next, 'tech-1', 'rejected');
    await expect(call(`approval.resubmit(${quote(tenant)},'maker',${quote(crypto.randomUUID())},
      ${quote(id(next))},${Number(version(next)) + 2},NULL,'Again')`)).rejects.toThrow('APPROVAL_NOT_RETURNED');
  }, 30000);

  test('pinned execution ignores dispatcher changes and rejects frozen implementation drift', async () => {
    const run = await start();
    expect(run.executionVersion).toBe(1);
    expect(await sql(`SELECT has_function_privilege('supacloud_approval_service',
      'approval.decide_v1(text,text,uuid,uuid,bigint,text,text,jsonb)','EXECUTE');`)).toBe('f');
    const command = `SELECT approval.decide(${quote(tenant)},'tech-1',${quote(crypto.randomUUID())},
      ${quote(id(run))},${version(run)},'rejected','reviewed');`;
    await sql(`BEGIN; SET ROLE supacloud_approval_owner;
      CREATE OR REPLACE FUNCTION approval.advance(p_tenant text,p_run uuid) RETURNS boolean
      LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'UNPINNED_IMPLEMENTATION'; END $$;
      ${command} ROLLBACK;`);
    expect((await call(`approval.get_run(${quote(tenant)},${quote(id(run))})`)).status).toBe('pending');
    await expect(sql(`BEGIN; SET ROLE supacloud_approval_owner;
      CREATE OR REPLACE FUNCTION approval.advance_v1(p_tenant text,p_run uuid) RETURNS boolean
      LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RETURN true; END $$;
      ${command} ROLLBACK;`)).rejects.toThrow('APPROVAL_EXECUTION_VERSION_DRIFT');
    expect(await sql('SET ROLE supacloud_approval_owner; SELECT approval.check_execution_version(1) IS NULL;')).toBe('f');
    await decide(run, 'tech-1', 'rejected');
  }, 15000);

  test('v2 core supports claim, release, transfer, delegation, additions and quorum without changing v1', async () => {
    const name = `tasks-${crypto.randomUUID()}`;
    const snapshot = { revision: '1', sha256: 'c'.repeat(64) };
    const originalSubject = await sql("SELECT pg_get_functiondef('approval.resolve_subject(text,text,text)'::regprocedure);");
    const originalAssignment = await sql("SELECT pg_get_functiondef('approval.resolve_assignment(text,text,jsonb)'::regprocedure);");
    const originalPolicy = await sql("SELECT pg_get_functiondef('approval.authorize_task_change(text,uuid,text,text,text)'::regprocedure);");
    const action = (run: Record<string, unknown>, actor: string, verb: string, target: string | null = null,
      request = crypto.randomUUID()) => call(`approval.task_action(${quote(name)},${quote(actor)},${quote(request)},
      ${quote(id(run))},${version(run)},${quote(verb)},${target === null ? 'NULL' : quote(target)},'reviewed')`);
    const vote = (run: Record<string, unknown>, actor: string, decision = 'approved') => call(`approval.decide(
      ${quote(name)},${quote(actor)},${quote(crypto.randomUUID())},${quote(id(run))},${version(run)},${quote(decision)},'reviewed',${json(snapshot)})`);
    try {
      await sql(`SET ROLE supacloud_approval_owner;
        CREATE TABLE approval.test_task_candidates(tenant text PRIMARY KEY,actors jsonb);
        INSERT INTO approval.test_task_candidates VALUES(${quote(name)},'["a","b","c"]');
        CREATE OR REPLACE FUNCTION approval.resolve_subject(p_tenant text,p_entity text,p_resolver text) RETURNS jsonb
        LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
          IF p_tenant=${quote(name)} AND p_resolver='test.subject' THEN RETURN ${json(snapshot)}; END IF;
          RAISE EXCEPTION 'UNKNOWN_SUBJECT';
        END $$;
        CREATE OR REPLACE FUNCTION approval.resolve_assignment(p_tenant text,p_entity text,p_rule jsonb) RETURNS jsonb
        LANGUAGE plpgsql SET search_path='' AS $$ DECLARE actors jsonb; BEGIN
          SELECT s.actors INTO actors FROM approval.test_task_candidates s WHERE tenant=p_tenant FOR SHARE;
          RETURN jsonb_build_object('actors',actors,'revision','1');
        END $$;`);
      for (const mode of ['claim','all','quorum']) {
        const d = { schemaVersion: 4, subjectResolver: 'test.subject', steps: [{
          key: 'review', mode, assignment: { resolver: 'test.candidates', scope: 'lab' }, timeoutSeconds: 300,
          ...(mode === 'quorum' ? { quorum: 2 } : {}),
        }] };
        expect(decodeDurableApprovalDefinition(d)).toEqual(d as ReturnType<typeof decodeDurableApprovalDefinition>);
        await sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish(
          ${quote(name)},'publisher',${quote(crypto.randomUUID())},${quote(mode)},1,${json(d)});`);
      }
      const begin = (mode: string) => call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},
        ${quote(mode)},1,${quote(crypto.randomUUID())},${json(snapshot)})`);
      let run = await begin('claim');
      expect(run.executionVersion).toBe(2);
      await expect(vote(run, 'a')).rejects.toThrow('APPROVAL_TASK_NOT_CLAIMED');
      const before = run;
      const request = crypto.randomUUID();
      run = await action(run, 'a', 'claim', null, request);
      expect(await action(before, 'a', 'claim', null, request)).toEqual(run);
      await expect(action(run, 'b', 'claim')).rejects.toThrow('APPROVAL_ALREADY_CLAIMED');
      run = await action(run, 'a', 'release');
      const competing = await Promise.allSettled([action(run, 'a', 'claim'), action(run, 'b', 'claim')]);
      expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const winner = competing.find(result => result.status === 'fulfilled');
      if (winner?.status !== 'fulfilled') throw new Error('No claim winner');
      run = winner.value;
      const context = run.taskContext;
      if (context === null || typeof context !== 'object' || !('claimant' in context) || typeof context.claimant !== 'string') {
        throw new Error('Missing claimant');
      }
      run = await action(run, context.claimant, 'transfer', 'c');
      await expect(vote(run, 'a')).rejects.toThrow('APPROVAL_TASK_NOT_CLAIMED');
      run = await action(run, 'c', 'delegate', 'b');
      await expect(vote(run, 'c')).rejects.toThrow('APPROVAL_DELEGATION_PENDING');
      run = await action(run, 'b', 'resolve', 'c');
      run = await vote(run, 'c');
      expect(run.status).toBe('approved');
      run = await begin('quorum');
      run = await vote(run, 'a');
      expect(run.status).toBe('pending');
      run = await vote(run, 'b');
      expect(run.status).toBe('approved');
      run = await begin('all');
      await sql(`UPDATE approval.test_task_candidates SET actors='["a","b","c","d","e"]' WHERE tenant=${quote(name)};`);
      await expect(action(run, 'operator', 'add', 'd')).rejects.toThrow('APPROVAL_TASK_CHANGE_FORBIDDEN');
      await sql(`SET ROLE supacloud_approval_owner;
        CREATE OR REPLACE FUNCTION approval.authorize_task_change(
          p_tenant text,p_run uuid,p_actor text,p_action text,p_target text) RETURNS boolean
        LANGUAGE sql SET search_path='' AS $$ SELECT p_tenant=${quote(name)} AND p_actor='operator' AND p_action='add' $$;`);
      run = await action(run, 'operator', 'add', 'd');
      run = await action(run, 'a', 'transfer', 'e');
      await expect(vote(run, 'a')).rejects.toThrow('APPROVAL_ACTOR_NOT_ASSIGNED');
      for (const actor of ['b','c','d','e']) run = await vote(run, actor);
      expect(run.status).toBe('approved');
      await sql(`UPDATE approval.test_task_candidates SET actors='["a"]' WHERE tenant=${quote(name)};`);
      await expect(begin('quorum')).rejects.toThrow('APPROVAL_QUORUM_UNREACHABLE');
    } finally {
      await sql(`${originalSubject};\n${originalAssignment};\n${originalPolicy};
        DROP TABLE IF EXISTS approval.test_task_candidates;`);
    }
  }, 40000);

  test('preview is pure, catches assignment/quorum errors and does not authorize commands', () => {
    expect(simulateApprovalDefinition(definition,'maker').map(step => step.requiredApprovals)).toEqual([2,1]);
    const d = { schemaVersion: 4,subjectResolver: 'test.subject',steps: [{
      key: 'review',mode: 'quorum',quorum: 2,assignment: { resolver: 'test.candidates',scope: 'lab' },timeoutSeconds: 30,
    }] };
    expect(() => simulateApprovalDefinition(d,'maker')).toThrow('APPROVAL_SIMULATION_RESOLUTION_REQUIRED');
    expect(() => simulateApprovalDefinition(d,'maker',{ review: { actors: ['a'],revision: '1' } }))
      .toThrow('APPROVAL_QUORUM_UNREACHABLE');
    expect(() => simulateApprovalDefinition(d,'maker',{ review: { actors: ['a','maker'],revision: '1' } }))
      .toThrow('APPROVAL_MAKER_CHECKER');
    expect(simulateApprovalDefinition(d,'maker',{ review: { actors: ['a','b'],revision: '1' } })[0]?.requiredApprovals).toBe(2);
  });

  test('stage notifications use durable timers, fenced delivery and cancellation without approving', async () => {
    const name = `notices-${crypto.randomUUID()}`;
    const d = { schemaVersion: 1,steps: [{ key: 'review',mode: 'all',approvers: ['reviewer'],timeoutSeconds: 300 }] };
    await sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish(
      ${quote(name)},'publisher',${quote(crypto.randomUUID())},'review',1,${json(d)});
      SELECT approval.publish_notification_policy(${quote(name)},'publisher','review',1,300,299,'supervisor');`);
    const run = await call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},'review',1,'entity')`);
    await until(`SELECT count(*) FROM approval.notices WHERE tenant=${quote(name)} AND status='ready';`, '2');
    expect((await call(`approval.get_run(${quote(name)},${quote(id(run))})`)).status).toBe('pending');
    const claim = () => sql(`SET ROLE supacloud_approval_consumer; SELECT approval.claim_notice(${quote(name)},60);`);
    const first: unknown = JSON.parse(await claim());
    if (!Value.Check(ApprovalNoticeClaimSchema,first)) throw new Error('Invalid notice');
    expect(first.payload.tenant).toBe(name);
    const second: unknown = JSON.parse(await claim());
    if (!Value.Check(ApprovalNoticeClaimSchema,second)) throw new Error('Invalid notice');
    expect(first.payload.noticeId).not.toBe(second.payload.noticeId);
    expect(await claim()).toBe('');
    await expect(sql(`SET ROLE supacloud_approval_consumer; SELECT approval.finish_notice(
      ${quote(name)},${quote(first.payload.noticeId)},${quote(crypto.randomUUID())},NULL);`)).rejects.toThrow('APPROVAL_NOTICE_LEASE_CONFLICT');
    const ack = `SET ROLE supacloud_approval_consumer; SELECT approval.finish_notice(
      ${quote(name)},${quote(first.payload.noticeId)},${quote(first.leaseToken)},NULL);`;
    expect(await sql(ack)).toBe('t');
    expect(await sql(ack)).toBe('t');
    await sql(`SET ROLE supacloud_approval_consumer; SELECT approval.finish_notice(
      ${quote(name)},${quote(second.payload.noticeId)},${quote(second.leaseToken)},'UNAVAILABLE');`);
    expect(await claim()).toBe('');
    await expect(sql(`UPDATE approval.notices SET payload='{}' WHERE id=${quote(first.payload.noticeId)};`))
      .rejects.toThrow('APPROVAL_IMMUTABLE_NOTICE');
    await call(`approval.cancel(${quote(name)},'maker',${quote(crypto.randomUUID())},${quote(id(run))},${version(run)})`);
    expect(await sql(`SELECT status FROM approval.notices WHERE id=${quote(second.payload.noticeId)};`)).toBe('cancelled');
    expect(await sql(`SELECT payload->>'status' FROM approval.outcomes WHERE run_id=${quote(id(run))};`)).toBe('cancelled');
    await expect(sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish_notification_policy(
      ${quote(name)},'publisher','review',1,100,50,'supervisor');`)).rejects.toThrow('APPROVAL_NOTIFICATION_POLICY_IMMUTABLE');
  }, 25000);

  test('graph child stages inherit the root notification policy and operator recovery is fenced', async () => {
    const name = `graph-notice-${crypto.randomUUID()}`;
    const snapshot = { revision: '1',sha256: 'e'.repeat(64) };
    const graph = { schemaVersion: 5,subjectResolver: 'test.subject',nodes: [{
      key: 'review',after: [],mode: 'all',
      assignment: { resolver: 'test.candidates',scope: 'lab' },timeoutSeconds: 300,
    }] };
    const originals = await Promise.all([
      sql("SELECT pg_get_functiondef('approval.resolve_subject(text,text,text)'::regprocedure);"),
      sql("SELECT pg_get_functiondef('approval.resolve_assignment(text,text,jsonb)'::regprocedure);"),
      sql("SELECT pg_get_functiondef('approval.resolve_graph_facts(text,text,text)'::regprocedure);"),
    ]);
    try {
      await sql(`SET ROLE supacloud_approval_owner;
        CREATE OR REPLACE FUNCTION approval.resolve_subject(p_tenant text,p_entity text,p_resolver text) RETURNS jsonb
        LANGUAGE sql SET search_path='' AS ${quote(`SELECT ${json(snapshot)};`)};
        CREATE OR REPLACE FUNCTION approval.resolve_assignment(p_tenant text,p_entity text,p_rule jsonb) RETURNS jsonb
        LANGUAGE sql SET search_path='' AS 'SELECT ''{"actors":["reviewer"],"revision":"1"}''::jsonb';
        CREATE OR REPLACE FUNCTION approval.resolve_graph_facts(p_tenant text,p_entity text,p_resolver text) RETURNS jsonb
        LANGUAGE sql SET search_path='' AS 'SELECT ''{}''::jsonb';
        RESET ROLE; SET ROLE supacloud_approval_publisher;
        SELECT approval.publish(${quote(name)},'publisher',${quote(crypto.randomUUID())},'graph',1,${json(graph)});
        SELECT approval.publish_notification_policy(${quote(name)},'publisher','graph',1,300,299,'supervisor');`);
      const root = await call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},'graph',1,'entity',${json(snapshot)})`);
      const childId = await sql(`SELECT child_run_id FROM approval.graph_nodes WHERE tenant=${quote(name)}
        AND run_id=${quote(id(root))} AND key='review';`);
      expect(childId).not.toBe('');
      await until(`SELECT count(*) FROM approval.notices WHERE tenant=${quote(name)} AND run_id=${quote(childId)};`,'2');
      await until(`SELECT count(*) FROM approval.notices WHERE tenant=${quote(name)} AND status='ready';`,'2');
      expect(await sql(`SELECT payload->'recipients' FROM approval.notices
        WHERE tenant=${quote(name)} AND kind='escalation';`)).toBe('["supervisor"]');
      expect(await sql(`SELECT count(*) FROM approval.notification_policies WHERE tenant=${quote(name)}
        AND definition_key LIKE 'graph.%';`)).toBe('1');
      const dead = await sql(`UPDATE approval.notices SET status='dead',attempts=10
        WHERE tenant=${quote(name)} AND run_id=${quote(childId)} AND kind='reminder' RETURNING id;`);
      const noticeId = dead;
      const current = await sql(`SELECT attempts FROM approval.notices WHERE id=${quote(noticeId)};`);
      await expect(sql(`SET ROLE supacloud_approval_operator; SELECT approval.recover_notice(
        ${quote(name)},'operator',${quote(crypto.randomUUID())},${quote(childId)},${quote(noticeId)},${Number(current)+1},'stale');`))
        .rejects.toThrow('APPROVAL_RECOVERY_CONFLICT');
      const request = crypto.randomUUID();
      const command = `SELECT approval.recover_notice(${quote(name)},'operator',${quote(request)},
        ${quote(childId)},${quote(noticeId)},${current},'operator retry');`;
      await expect(sql(`SET ROLE supacloud_approval_service; ${command}`)).rejects.toThrow('permission denied');
      const recovered = await sql(`SET ROLE supacloud_approval_operator; ${command}`);
      expect(JSON.parse(recovered)).toMatchObject({ status: 'ready',noticeId,runId: childId });
      expect(await sql(`SET ROLE supacloud_approval_operator; ${command}`)).toBe(recovered);
      await expect(sql(`SET ROLE supacloud_approval_operator; SELECT approval.recover_notice(
        ${quote(name)},'operator',${quote(crypto.randomUUID())},${quote(id(root))},${quote(noticeId)},0,'wrong run');`))
        .rejects.toThrow('APPROVAL_NOT_FOUND');
      expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(childId)}
        AND kind='notice_requeued' AND actor='operator';`)).toBe('1');
      await call(`approval.cancel(${quote(name)},'maker',${quote(crypto.randomUUID())},${quote(id(root))},${version(root)})`);
      expect(await sql(`SELECT count(*) FROM approval.notices WHERE tenant=${quote(name)} AND status='cancelled';`)).toBe('2');
      await expect(sql(`SET ROLE supacloud_approval_operator; SELECT approval.recover_notice(
        ${quote(name)},'operator',${quote(crypto.randomUUID())},${quote(childId)},${quote(noticeId)},0,'obsolete');`))
        .rejects.toThrow('APPROVAL_NOTICE_OBSOLETE');
    } finally { await sql(originals.map(body => `${body};`).join('\n')); }
  }, 30000);

  test('workbench views and review history have tenant/actor scope and bounded keyset pagination', async () => {
    const name = `workbench-${crypto.randomUUID()}`;
    await sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish(
      ${quote(name)},'publisher',${quote(crypto.randomUUID())},'review',1,${json(definition)});`);
    const first = await call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},'review',1,'one')`);
    const second = await call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},'review',1,'two')`);
    const list: unknown = JSON.parse(await sql(`SET ROLE supacloud_approval_service; SELECT approval.list_runs(
      ${quote(name)},'tech-1','inbox',NULL,NULL,1);`));
    if (!Value.Check(Type.Array(ApprovalWorkItemSchema),list)) throw new Error('Invalid work items');
    expect(list).toHaveLength(1);
    const item = list[0];
    if (item === undefined) throw new Error('Missing work item');
    expect(item.runId).toBe(id(second));
    const nextPage: unknown = JSON.parse(await sql(`SET ROLE supacloud_approval_service; SELECT approval.list_runs(
      ${quote(name)},'tech-1','inbox',${quote(item.createdAt)},${quote(item.runId)},1);`));
    if (!Value.Check(Type.Array(ApprovalWorkItemSchema),nextPage)) throw new Error('Invalid work items');
    expect(nextPage[0]?.runId).toBe(id(first));
    expect(await sql(`SET ROLE supacloud_approval_service; SELECT approval.list_runs(${quote(name)},'stranger','inbox');`)).toBe('[]');
    expect(await sql(`SET ROLE supacloud_approval_service; SELECT approval.list_runs('other-tenant','tech-1','inbox');`)).toBe('[]');
    await expect(sql(`SET ROLE supacloud_approval_service; SELECT approval.list_runs(${quote(name)},'tech-1','inbox',NULL,NULL,101);`))
      .rejects.toThrow('APPROVAL_INVALID_PAGE');
    const returned = await call(`approval.return_for_changes(${quote(name)},'tech-1',${quote(crypto.randomUUID())},
      ${quote(id(first))},${version(first)},'Correct')`);
    const next = await call(`approval.resubmit(${quote(name)},'maker',${quote(crypto.randomUUID())},
      ${quote(id(first))},${version(returned)},NULL,'Corrected')`);
    const rounds: unknown = JSON.parse(await sql(`SET ROLE supacloud_approval_service;
      SELECT approval.list_rounds(${quote(name)},${quote(id(next))});`));
    expect(Array.isArray(rounds) ? rounds.length : 0).toBe(2);
    for (const run of [second,next]) {
      await call(`approval.cancel(${quote(name)},'maker',${quote(crypto.randomUUID())},${quote(id(run))},${version(run)})`);
    }
  }, 20000);

  test('graph planner rejects cycles and ambiguous routes and propagates skipped branches', () => {
    const node = { mode: 'all',assignment: { resolver: 'test.candidates',scope: 'lab' },timeoutSeconds: 300 };
    const graph = { schemaVersion: 5,subjectResolver: 'test.subject',nodes: [
      { ...node,key: 'first',after: [] },
      { ...node,key: 'high',after: ['first'],choice: 'risk',when: { field: 'risk',equals: 'high' } },
      { ...node,key: 'low',after: ['first'],choice: 'risk',default: true },
      { ...node,key: 'join',after: ['high','low'] },
    ] };
    expect(planApprovalGraph(graph,{ risk: 'high' }).map(n => [n.key,n.selected])).toEqual([
      ['first',true],['high',true],['low',false],['join',true],
    ]);
    expect(() => planApprovalGraph(graph,{})).toThrow('APPROVAL_GRAPH_FACT_MISSING');
    expect(() => decodeApprovalGraph({ ...graph,nodes: [{ ...node,key: 'a',after: ['b'] },{ ...node,key: 'b',after: ['a'] }] }))
      .toThrow('APPROVAL_GRAPH_CYCLE');
    expect(() => decodeApprovalGraph({ ...graph,nodes: graph.nodes.filter(n => n.key !== 'low') })).toThrow();
    expect(() => planApprovalGraph({ ...graph,nodes: [
      ...graph.nodes,{ ...node,key: 'also-high',after: ['first'],choice: 'risk',when: { field: 'risk',equals: 'high' } },
    ] },{ risk: 'high' })).toThrow('APPROVAL_AMBIGUOUS_ROUTE');
  });

  test('graph execution runs independent branches, joins them, routes once and emits only a root outcome', async () => {
    const name = `graph-${crypto.randomUUID()}`;
    const snapshot = { revision: '1',sha256: 'd'.repeat(64) };
    const node = { mode: 'all',assignment: { resolver: 'test.candidates',scope: 'lab' },timeoutSeconds: 300 };
    const graph = { schemaVersion: 5,subjectResolver: 'test.subject',nodes: [
      { ...node,key: 'technical',after: [] },
      { ...node,key: 'quality',after: [] },
      { ...node,key: 'high',after: ['technical','quality'],choice: 'risk',when: { field: 'risk',equals: 'high' },
        mode: 'quorum',quorumPercent: 50 },
      { ...node,key: 'normal',after: ['technical','quality'],choice: 'risk',default: true },
      { ...node,key: 'final',after: ['high','normal'] },
    ] };
    const originals = await Promise.all([
      sql("SELECT pg_get_functiondef('approval.resolve_subject(text,text,text)'::regprocedure);"),
      sql("SELECT pg_get_functiondef('approval.resolve_assignment(text,text,jsonb)'::regprocedure);"),
      sql("SELECT pg_get_functiondef('approval.resolve_graph_facts(text,text,text)'::regprocedure);"),
    ]);
    try {
      await sql(`SET ROLE supacloud_approval_owner;
        CREATE OR REPLACE FUNCTION approval.resolve_subject(p_tenant text,p_entity text,p_resolver text) RETURNS jsonb
        LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
          IF p_tenant=${quote(name)} THEN RETURN ${json(snapshot)}; END IF; RAISE EXCEPTION 'UNKNOWN_SUBJECT';
        END $$;
        CREATE OR REPLACE FUNCTION approval.resolve_assignment(p_tenant text,p_entity text,p_rule jsonb) RETURNS jsonb
        LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
          IF p_tenant=${quote(name)} THEN RETURN '{"actors":["reviewer"],"revision":"1"}'::jsonb; END IF;
          RAISE EXCEPTION 'UNKNOWN_ASSIGNMENT';
        END $$;
        CREATE OR REPLACE FUNCTION approval.resolve_graph_facts(p_tenant text,p_entity text,p_resolver text) RETURNS jsonb
        LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
          IF p_tenant=${quote(name)} THEN RETURN '{"risk":"high"}'::jsonb; END IF; RAISE EXCEPTION 'UNKNOWN_FACTS';
        END $$;
        RESET ROLE; SET ROLE supacloud_approval_publisher; SELECT approval.publish(
          ${quote(name)},'publisher',${quote(crypto.randomUUID())},'graph',1,${json(graph)});
        SELECT approval.publish_notification_policy(${quote(name)},'publisher','graph',1,300,299,'supervisor');`);
      const begin = (entity: string) => call(`approval.start(${quote(name)},'maker',${quote(crypto.randomUUID())},
        'graph',1,${quote(entity)},${json(snapshot)})`);
      const root = await begin('one');
      expect(root.executionVersion).toBe(3);
      const child = async (run: Record<string,unknown>,key: string) => {
        const childId = await sql(`SELECT child_run_id FROM approval.graph_nodes WHERE tenant=${quote(name)}
          AND run_id=${quote(id(run))} AND key=${quote(key)};`);
        if (!childId) throw new Error(`Missing child ${key}`);
        return call(`approval.get_run(${quote(name)},${quote(childId)})`);
      };
      const vote = (run: Record<string,unknown>,decision = 'approved') => call(`approval.decide(
        ${quote(name)},'reviewer',${quote(crypto.randomUUID())},${quote(id(run))},${version(run)},
        ${quote(decision)},'reviewed',${json(snapshot)})`);
      expect(await sql(`SELECT count(*) FROM approval.graph_nodes WHERE run_id=${quote(id(root))} AND status='running';`)).toBe('2');
      await vote(await child(root,'technical'));
      await until(`SELECT status FROM approval.graph_nodes WHERE run_id=${quote(id(root))} AND key='technical';`,'approved');
      expect(await sql(`SELECT status FROM approval.graph_nodes WHERE run_id=${quote(id(root))} AND key='high';`)).toBe('waiting');
      await vote(await child(root,'quality'));
      await until(`SELECT status FROM approval.graph_nodes WHERE run_id=${quote(id(root))} AND key='high';`,'running');
      expect(await sql(`SELECT status FROM approval.graph_nodes WHERE run_id=${quote(id(root))} AND key='normal';`)).toBe('skipped');
      await vote(await child(root,'high'));
      await until(`SELECT status FROM approval.graph_nodes WHERE run_id=${quote(id(root))} AND key='final';`,'running');
      await vote(await child(root,'final'));
      await until(`SELECT status FROM approval.runs WHERE id=${quote(id(root))};`,'approved');
      expect(await sql(`SELECT count(*) FROM approval.outcomes WHERE tenant=${quote(name)};`)).toBe('1');
      expect(await sql(`SELECT payload->>'runId' FROM approval.outcomes WHERE tenant=${quote(name)};`)).toBe(id(root));
      expect(await sql(`SELECT count(*) FROM approval.notices n JOIN approval.runs r ON r.id=n.run_id
        WHERE r.graph_parent_id=${quote(id(root))};`)).toBe('8');
      expect(await sql(`SELECT count(*) FROM approval.notices n JOIN approval.runs r ON r.id=n.run_id
        WHERE r.graph_parent_id=${quote(id(root))} AND n.status IN ('scheduled','ready');`)).toBe('0');
      await expect(sql(`UPDATE approval.graph_notification_snapshots SET policy=NULL
        WHERE tenant=${quote(name)} AND run_id=${quote(id(root))};`)).rejects.toThrow();
      const rejected = await begin('two');
      await vote(await child(rejected,'technical'),'rejected');
      await until(`SELECT status FROM approval.runs WHERE id=${quote(id(rejected))};`,'rejected');
      expect((await child(rejected,'quality')).status).toBe('cancelled');
      expect(await sql(`SELECT count(*) FROM approval.outcomes WHERE tenant=${quote(name)};`)).toBe('2');
      await expect(sql(`SET ROLE supacloud_approval_publisher; SELECT approval.publish(${quote(name)},'publisher',
        ${quote(crypto.randomUUID())},'cycle',1,${json({ ...graph,nodes: [
          { ...node,key: 'a',after: ['b'] },{ ...node,key: 'b',after: ['a'] },
        ] })});`)).rejects.toThrow('APPROVAL_GRAPH_CYCLE');
    } finally {
      await sql(originals.map(body => `${body};`).join('\n'));
    }
  }, 60000);

  test('no browser/public table access, no service engine or internal-function access', async () => {
    expect(await sql(`SELECT has_table_privilege('supacloud_approval_service','approval.runs','SELECT');`)).toBe('f');
    expect(await sql(`SELECT has_function_privilege('supacloud_approval_service',
      'approval.advance(text,uuid)','EXECUTE');`)).toBe('f');
    expect(await sql(`SELECT has_schema_privilege('supacloud_approval_service','df','USAGE');`)).toBe('f');
    await expect(sql('SET ROLE supacloud_approval_service; SELECT * FROM approval.tasks;')).rejects.toThrow('permission denied');
  });

  test('sequential all-of and any-of decisions, receipts, and engine completion', async () => {
    let run = await start();
    const original = run;
    const request = crypto.randomUUID();
    run = await decide(run, 'tech-1', 'approved', request);
    expect(run.stepIndex).toBe(0);
    expect(await decide(original, 'tech-1', 'approved', request)).toEqual(run);
    await expect(decide(original, 'tech-1', 'rejected', request)).rejects.toThrow('APPROVAL_IDEMPOTENCY_CONFLICT');
    await expect(decide(original, 'tech-2')).rejects.toThrow('APPROVAL_STALE_VERSION');
    run = await decide(run, 'tech-2');
    expect(run.stepIndex).toBe(1);
    await waiting(run);
    run = await decide(run, 'quality-1');
    expect(run.status).toBe('approved');
    expect(await sql(`SELECT count(*) FROM approval.tasks WHERE run_id=${quote(id(run))}
      AND actor='quality-2' AND status='cancelled';`)).toBe('1');
    await until(`SET ROLE supacloud_approval_owner; SELECT df.status(${quote(String(run.engineId))});`, 'completed');
  }, 40000);

  test('start replay, active-instance uniqueness and maker/checker separation', async () => {
    const request = crypto.randomUUID();
    const entity = crypto.randomUUID();
    const run = await start(request, 'review', entity);
    expect(await start(request, 'review', entity)).toEqual(run);
    await expect(start(request, 'review', 'different')).rejects.toThrow('APPROVAL_IDEMPOTENCY_CONFLICT');
    await expect(start(crypto.randomUUID(), 'review', entity)).rejects.toThrow('one_active_approval');
    await expect(start(crypto.randomUUID(), 'review', crypto.randomUUID(), 'tech-1')).rejects.toThrow('APPROVAL_MAKER_CHECKER');
    await decide(run, 'tech-1', 'rejected');
  });

  test('reject, authorization, wrong tenant and terminal state protection', async () => {
    let run = await start();
    await expect(decide(run, 'unassigned')).rejects.toThrow('APPROVAL_ACTOR_NOT_ASSIGNED');
    await expect(call(`approval.get_run('another-tenant',${quote(id(run))})`)).rejects.toThrow('APPROVAL_NOT_FOUND');
    run = await decide(run, 'tech-1', 'rejected');
    expect(run.status).toBe('rejected');
    await expect(decide(run, 'tech-2')).rejects.toThrow('APPROVAL_NOT_PENDING');
  });

  test('only requester can cancel; cancellation is replayable', async () => {
    const run = await start();
    const request = crypto.randomUUID();
    await expect(call(`approval.cancel(${quote(tenant)},'other',${quote(request)},${quote(id(run))},1)`))
      .rejects.toThrow('APPROVAL_NOT_REQUESTER');
    const expression = `approval.cancel(${quote(tenant)},'maker',${quote(request)},${quote(id(run))},1)`;
    const cancelled = await call(expression);
    expect(cancelled.status).toBe('cancelled');
    expect(await call(expression)).toEqual(cancelled);
  });

  test('concurrent decision retries create one ballot and one audit record', async () => {
    const run = await start();
    const request = crypto.randomUUID();
    const replies = await Promise.all(Array.from({ length: 5 }, () => decide(run, 'tech-1', 'rejected', request)));
    expect(replies.every(reply => JSON.stringify(reply) === JSON.stringify(replies[0]))).toBe(true);
    expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(id(run))} AND kind='decision';`)).toBe('1');
  });

  test('rolled-back start does not leave a domain run or execute a workflow', async () => {
    const entity = crypto.randomUUID();
    const rolledBack: unknown=JSON.parse(await sql(`BEGIN; SET LOCAL ROLE supacloud_approval_service;
      SELECT approval.start(${quote(tenant)},'maker',${quote(crypto.randomUUID())},'review',1,${quote(entity)}); ROLLBACK;`));
    expect(await sql(`SELECT count(*) FROM approval.runs WHERE entity_id=${quote(entity)};`)).toBe('0');
    if (rolledBack===null || typeof rolledBack!=='object' || !('engineId' in rolledBack)
      || typeof rolledBack.engineId!=='string') throw new Error('Missing rolled-back engine identity');
    expect(await sql(`SELECT count(*) FROM df.instances WHERE id=${quote(rolledBack.engineId)};`)).toBe('0');
  });

  test('rolled-back decision produces no wakeup and no ballot', async () => {
    const run = await start();
    const request = crypto.randomUUID();
    await sql(`BEGIN; SET LOCAL ROLE supacloud_approval_service;
      SELECT approval.decide(${quote(tenant)},'tech-1',${quote(request)},${quote(id(run))},1,'rejected','test');
      ROLLBACK;`);
    expect(await sql(`SELECT count(*) FROM approval.wakeups WHERE request_id=${quote(request)};`)).toBe('0');
    expect(await sql(`SELECT count(*) FROM approval.tasks WHERE run_id=${quote(id(run))} AND status<>'pending';`)).toBe('0');
    expect(await sql(`SELECT count(*) FROM approval.outcomes WHERE run_id=${quote(id(run))};`)).toBe('0');
    await decide(run, 'tech-1', 'rejected');
  });

  test('a late decision is refused even before the timer worker records timeout', async () => {
    const run = await start();
    await sql(`UPDATE approval.runs SET deadline=clock_timestamp()-interval '1 second'
      WHERE id=${quote(id(run))};`);
    await expect(decide(run, 'tech-1')).rejects.toThrow('APPROVAL_NOT_PENDING');
    expect(await sql(`SELECT count(*) FROM approval.tasks WHERE run_id=${quote(id(run))} AND status='approved';`)).toBe('0');
    await sql(`SET ROLE supacloud_approval_owner; SELECT approval.advance(${quote(tenant)},${quote(id(run))});`);
  });

  test('timeout is driven by a real pg_durable worker', async () => {
    const run = await start(crypto.randomUUID(), 'timeout');
    await until(`SELECT status FROM approval.runs WHERE id=${quote(id(run))};`, 'timed_out');
    await expect(decide(run, 'tech-1')).rejects.toThrow('APPROVAL_NOT_PENDING');
  }, 40000);

  test('a forged signal cannot approve, extend the deadline or let an old wait affect the new one', async () => {
    const run = await start();
    const oldToken = await sql(`SELECT wait_token FROM approval.runs WHERE id=${quote(id(run))};`);
    await waiting(run);
    await sql(`SET ROLE supacloud_approval_owner;
      SELECT df.signal(${quote(String(run.engineId))},'changed','{"approved":true}');`);
    await until(`SELECT engine_id<>${quote(String(run.engineId))} FROM approval.runs WHERE id=${quote(id(run))};`, 't');
    const resumed = await call(`approval.get_run(${quote(tenant)},${quote(id(run))})`);
    expect(resumed.status).toBe('pending');
    expect(resumed.deadline).toBe(run.deadline);
    expect(resumed.rowVersion).toBe(run.rowVersion);
    expect(await sql(`SET ROLE supacloud_approval_owner;
      SELECT approval.resume_wait(${quote(tenant)},${quote(id(run))},${quote(oldToken)});`)).toBe('f');
    expect((await call(`approval.get_run(${quote(tenant)},${quote(id(run))})`)).engineId).toBe(resumed.engineId);
    await decide(resumed, 'tech-1', 'rejected');
  }, 40000);

  test('parameterized server adapter never interpolates tenant or actor into SQL', async () => {
    const calls: { sql: string; parameters: readonly unknown[] }[] = [];
    const receipt = await start();
    const client = durableApprovalClient({ async query(statement, parameters) {
      calls.push({ sql: statement, parameters });
      return [{ receipt: { ...receipt, tenant: parameters[0],entityId: parameters[5] ?? receipt.entityId } }];
    } });
    await client.start({ tenant, actor: 'actor',
      requestId: crypto.randomUUID(), definitionKey: 'review', definitionVersion: 1, entityId: "';DROP TABLE approval.runs;--" });
    expect(calls[0]?.sql).not.toContain('DROP');
    expect(calls[0]?.parameters[5]).toContain('DROP');
    expect(() => client.get('invalid tenant',id(receipt))).toThrow('APPROVAL_INVALID_IDENTITY');
    const malformed = durableApprovalClient({ async query() { return [{ receipt: { status: 'approved' } }]; } });
    await expect(malformed.get(tenant,id(receipt))).rejects.toThrow('APPROVAL_RECEIPT_INVALID');
    const wrongScope = durableApprovalClient({ async query() { return [{ receipt: { ...receipt, tenant: 'other' } }]; } });
    await expect(wrongScope.get(tenant,id(receipt))).rejects.toThrow('APPROVAL_RECEIPT_SCOPE_MISMATCH');
    const wrongRun = durableApprovalClient({ async query() { return [{ receipt: { ...receipt,id: crypto.randomUUID() } }]; } });
    await expect(wrongRun.get(tenant,id(receipt))).rejects.toThrow('APPROVAL_RECEIPT_SCOPE_MISMATCH');
    await decide(receipt, 'tech-1', 'rejected');
  });

  test('migration ledger prevents checksum drift and skips already-applied migrations', async () => {
    const migrations = await loadApprovalMigrations();
    expect(await sql("SELECT count(*) FROM approval_migrations.applied;")).toBe(String(migrations.length));
    await expect(sql(migrationScript(migrations.map(m => m.version==='001'
      ? { ...m,sql: m.sql.replace('COMMIT;','-- modified\nCOMMIT;') } : m))))
      .rejects.toThrow('APPROVAL_MIGRATION_CHECKSUM_MISMATCH');
    expect(() => migrationScript([{ version:'001',sql:'SELECT 1;' }])).toThrow('APPROVAL_MIGRATION_BOUNDARY');
    await sql(migrationScript(migrations));
    expect(await sql("SELECT count(*) FROM approval_migrations.applied;")).toBe(String(migrations.length));
  });

  test('a failed forward migration rolls back DDL and never writes a success ledger', async () => {
    const migrations=await loadApprovalMigrations();
    await expect(sql(migrationScript([...migrations,{version:'999',sql:
      'BEGIN;\nCREATE TABLE approval.test_failed_migration(id integer);\nSELECT 1/0;\nCOMMIT;'}])))
      .rejects.toThrow('division by zero');
    expect(await sql("SELECT to_regclass('approval.test_failed_migration') IS NULL;")).toBe('t');
    expect(await sql("SELECT count(*) FROM approval_migrations.applied WHERE version='999';")).toBe('0');
  });

  test('publisher has audited idempotent publication, without command or operations access', async () => {
    const request = crypto.randomUUID();
    const expression=`approval.publish(${quote(tenant)},'publisher',${quote(request)},'published',1,${json(definition)})`;
    const first=await sql(`SET ROLE supacloud_approval_publisher; SELECT ${expression};`);
    expect(await sql(`SET ROLE supacloud_approval_publisher; SELECT ${expression};`)).toBe(first);
    await expect(sql(`SET ROLE supacloud_approval_publisher;
      SELECT approval.publish(${quote(tenant)},'publisher',${quote(request)},'different',1,${json(definition)});`))
      .rejects.toThrow('APPROVAL_IDEMPOTENCY_CONFLICT');
    await expect(sql(`SET ROLE supacloud_approval_publisher;
      SELECT approval.publish(${quote(tenant)},'publisher',${quote(crypto.randomUUID())},'published',1,
        ${json({ schemaVersion:1,steps:[definition.steps[0]] })});`)).rejects.toThrow('APPROVAL_DEFINITION_VERSION_CONFLICT');
    await expect(sql('SET ROLE supacloud_approval_service; SELECT approval.maintenance(50);')).rejects.toThrow('permission denied');
    await expect(sql('SET ROLE supacloud_approval_publisher; SELECT approval.ensure_maintenance();')).rejects.toThrow('permission denied');
    await expect(sql('SET ROLE supacloud_approval_consumer; SELECT approval.health();')).rejects.toThrow('permission denied');
  },20000);

  test('audit and idempotency receipts cannot be mutated by the runtime owner', async () => {
    await expect(sql(`SET ROLE supacloud_approval_owner;
      UPDATE approval.events SET detail='{}' WHERE id=(SELECT min(id) FROM approval.events WHERE tenant=${quote(tenant)});`))
      .rejects.toThrow('APPROVAL_IMMUTABLE_RECORD');
    await expect(sql(`SET ROLE supacloud_approval_owner;
      DELETE FROM approval.receipts WHERE tenant=${quote(tenant)};`)).rejects.toThrow('APPROVAL_IMMUTABLE_RECORD');
    await expect(sql(`SET ROLE supacloud_approval_owner; TRUNCATE approval.events;`)).rejects.toThrow('APPROVAL_IMMUTABLE_RECORD');
  });

  test('maintenance recovers a failed real engine without duplicating tasks or extending deadlines', async () => {
    const run=await start();
    const oldToken=await sql(`SELECT wait_token FROM approval.runs WHERE id=${quote(id(run))};`);
    await sql(`SET ROLE supacloud_approval_owner; SELECT df.cancel(${quote(String(run.engineId))},'injected failure');`);
    await sql('SET ROLE supacloud_approval_operator; SELECT approval.maintenance(100);');
    const repaired=await call(`approval.get_run(${quote(tenant)},${quote(id(run))})`);
    expect(repaired.engineId).not.toBe(run.engineId);
    expect(repaired.deadline).toBe(run.deadline);
    expect(repaired.rowVersion).toBe(run.rowVersion);
    expect(await sql(`SELECT count(*) FROM approval.tasks WHERE run_id=${quote(id(run))};`)).toBe('2');
    expect(await sql(`SET ROLE supacloud_approval_owner;
      SELECT approval.resume_wait(${quote(tenant)},${quote(id(run))},${quote(oldToken)});`)).toBe('f');
    await decide(repaired,'tech-1','rejected');
  },20000);

  test('recovery caps retries and operator retry is fenced and audited', async () => {
    const run=await start();
    await sql(`SET ROLE supacloud_approval_owner; SELECT df.cancel(${quote(String(run.engineId))},'injected failure');`);
    await sql(`UPDATE approval.runs SET recovery_attempts=5 WHERE id=${quote(id(run))};`);
    await sql('SET ROLE supacloud_approval_operator; SELECT approval.maintenance(100);');
    expect((await call(`approval.get_run(${quote(tenant)},${quote(id(run))})`)).engineId).toBe(run.engineId);
    const statement=`approval.retry_execution(${quote(tenant)},${quote(id(run))},${quote(String(run.engineId))},'fixed dependency')`;
    await sql(`SET ROLE supacloud_approval_operator; SELECT ${statement};`);
    await expect(sql(`SET ROLE supacloud_approval_operator; SELECT ${statement};`)).rejects.toThrow('APPROVAL_RECOVERY_CONFLICT');
    expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(id(run))} AND kind='execution_retry_requested';`)).toBe('1');
    await decide(await call(`approval.get_run(${quote(tenant)},${quote(id(run))})`),'tech-1','rejected');
  },20000);

  test('operators can locate and retry an exhausted notification without table access', async () => {
    const fixture=await outcomeFixture();
    const request=crypto.randomUUID();
    await sql(`INSERT INTO approval.wakeups(tenant,request_id,run_id,recovery_attempts)
      VALUES(${quote(fixture.tenant)},${quote(request)},${quote(id(fixture.run))},5);`);
    const queue=await sql('SET ROLE supacloud_approval_operator; SELECT approval.recovery_queue(100);');
    expect(queue).toContain(request);
    await expect(sql('SET ROLE supacloud_approval_operator; SELECT * FROM approval.wakeups;')).rejects.toThrow('permission denied');
    await sql(`SET ROLE supacloud_approval_operator; SELECT approval.retry_wakeup(
      ${quote(fixture.tenant)},${quote(request)},NULL,'retry missing notification engine');`);
    await until(`SELECT delivered_at IS NOT NULL FROM approval.wakeups WHERE request_id=${quote(request)};`,'t');
    expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(id(fixture.run))}
      AND kind='wakeup_retry_requested';`)).toBe('1');
  },15000);

  test('the fifth successful replacement is not reported as an exhausted failed execution', async () => {
    const run=await start();
    await sql(`UPDATE approval.runs SET recovery_attempts=5 WHERE id=${quote(id(run))};`);
    const queue=await sql('SET ROLE supacloud_approval_operator; SELECT approval.recovery_queue(100);');
    expect(queue).not.toContain(id(run));
    await decide(run,'tech-1','rejected');
  });

  test('maintenance observes absolute deadlines even when the start transaction was delayed', async () => {
    const entity=crypto.randomUUID();
    await sql(`BEGIN; SET LOCAL ROLE supacloud_approval_service;
      SELECT approval.start(${quote(tenant)},'maker',${quote(crypto.randomUUID())},'timeout',1,${quote(entity)});
      SELECT pg_sleep(3); COMMIT;`);
    await sql('SET ROLE supacloud_approval_operator; SELECT approval.maintenance(100);');
    expect(await sql(`SELECT status FROM approval.runs WHERE entity_id=${quote(entity)};`)).toBe('timed_out');
  },10000);

  test('terminal outbox has atomic rollback, exclusive leases, stale-token fencing and replayable acknowledgements', async () => {
    const fixture=await outcomeFixture();
    const raw=await sql(`SET ROLE supacloud_approval_consumer; SELECT approval.claim_outcome(${quote(fixture.tenant)},60);`);
    const claim=decodeClaim(raw);
    expect(claim.payload.runId).toBe(id(fixture.run));
    expect(await sql(`SET ROLE supacloud_approval_consumer; SELECT approval.claim_outcome(${quote(fixture.tenant)},60);`)).toBe('');
    await sql(`BEGIN; SET LOCAL ROLE supacloud_approval_consumer;
      SELECT approval.ack_outcome(${quote(fixture.tenant)},${quote(id(fixture.run))},${quote(claim.leaseToken)}); ROLLBACK;`);
    expect(await sql(`SELECT acknowledged_at IS NULL FROM approval.outcomes WHERE run_id=${quote(id(fixture.run))};`)).toBe('t');
    await sql(`UPDATE approval.outcomes SET lease_until=clock_timestamp()-interval '1 second'
      WHERE run_id=${quote(id(fixture.run))};`);
    const replies=await Promise.all(Array.from({length:3},()=>sql(`SET ROLE supacloud_approval_consumer;
      SELECT approval.claim_outcome(${quote(fixture.tenant)},60);`)));
    const leases=replies.filter(reply=>reply!=='');
    expect(leases.length).toBe(1);
    const next=decodeClaim(leases[0] ?? '');
    expect(next.leaseToken).not.toBe(claim.leaseToken);
    await expect(sql(`SET ROLE supacloud_approval_consumer; SELECT approval.ack_outcome(
      ${quote(fixture.tenant)},${quote(id(fixture.run))},${quote(claim.leaseToken)});`)).rejects.toThrow('APPROVAL_STALE_LEASE');
    const ack=`SET ROLE supacloud_approval_consumer; SELECT approval.ack_outcome(
      ${quote(fixture.tenant)},${quote(id(fixture.run))},${quote(next.leaseToken)});`;
    expect(await sql(ack)).toBe('t');
    expect(await sql(ack)).toBe('t');
  },20000);

  test('a local business effect and acknowledgement share a transaction and consumer idempotency key', async () => {
    const fixture=await outcomeFixture();
    const claim=decodeClaim(await sql(`SET ROLE supacloud_approval_consumer;
      SELECT approval.claim_outcome(${quote(fixture.tenant)},60);`));
    const table=`test_effect_${id(fixture.run).replaceAll('-','')}`;
    await sql(`CREATE TABLE approval.${table}(run_id uuid PRIMARY KEY);
      GRANT INSERT,SELECT ON approval.${table} TO supacloud_approval_consumer;`);
    try {
      await expect(sql(`BEGIN; SET LOCAL ROLE supacloud_approval_consumer;
        INSERT INTO approval.${table} VALUES(${quote(id(fixture.run))});
        SELECT approval.ack_outcome(${quote(fixture.tenant)},${quote(id(fixture.run))},${quote(crypto.randomUUID())});
        COMMIT;`)).rejects.toThrow('APPROVAL_STALE_LEASE');
      expect(await sql(`SELECT count(*) FROM approval.${table};`)).toBe('0');
      const commit=`BEGIN; SET LOCAL ROLE supacloud_approval_consumer;
        INSERT INTO approval.${table} VALUES(${quote(id(fixture.run))}) ON CONFLICT DO NOTHING;
        SELECT approval.ack_outcome(${quote(fixture.tenant)},${quote(id(fixture.run))},${quote(claim.leaseToken)}); COMMIT;`;
      await sql(commit);
      await sql(commit);
      expect(await sql(`SELECT count(*) FROM approval.${table};`)).toBe('1');
      expect(await sql(`SELECT acknowledged_at IS NOT NULL FROM approval.outcomes WHERE run_id=${quote(id(fixture.run))};`)).toBe('t');
    } finally {
      await sql(`DROP TABLE approval.${table};`);
    }
  },10000);

  test('outcome errors back off, dead-letter and require audited operator requeue', async () => {
    const fixture=await outcomeFixture();
    let claim=decodeClaim(await sql(`SET ROLE supacloud_approval_consumer;
      SELECT approval.claim_outcome(${quote(fixture.tenant)},60);`));
    await sql(`SET ROLE supacloud_approval_consumer; SELECT approval.nack_outcome(
      ${quote(fixture.tenant)},${quote(id(fixture.run))},${quote(claim.leaseToken)},'DEPENDENCY_UNAVAILABLE');`);
    expect(await sql(`SELECT available_at>now() FROM approval.outcomes WHERE run_id=${quote(id(fixture.run))};`)).toBe('t');
    await sql(`UPDATE approval.outcomes SET attempts=9,available_at=clock_timestamp() WHERE run_id=${quote(id(fixture.run))};`);
    claim=decodeClaim(await sql(`SET ROLE supacloud_approval_consumer;
      SELECT approval.claim_outcome(${quote(fixture.tenant)},60);`));
    await sql(`SET ROLE supacloud_approval_consumer; SELECT approval.nack_outcome(
      ${quote(fixture.tenant)},${quote(id(fixture.run))},${quote(claim.leaseToken)},'DEPENDENCY_UNAVAILABLE');`);
    expect(await sql(`SELECT dead_lettered_at IS NOT NULL FROM approval.outcomes WHERE run_id=${quote(id(fixture.run))};`)).toBe('t');
    await sql(`SET ROLE supacloud_approval_operator; SELECT approval.requeue_outcome(
      ${quote(fixture.tenant)},${quote(id(fixture.run))},'dependency repaired');`);
    expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(id(fixture.run))} AND kind='outcome_requeued';`)).toBe('1');
    expect(await sql(`SELECT attempts FROM approval.outcomes WHERE run_id=${quote(id(fixture.run))};`)).toBe('0');
  },20000);

  test('outcome client validates lease payloads and acknowledgement results', async () => {
    const fixture=await outcomeFixture();
    const claim=decodeClaim(await sql(`SET ROLE supacloud_approval_consumer;
      SELECT approval.claim_outcome(${quote(fixture.tenant)},60);`));
    const statements: string[]=[];
    const client=approvalOutcomeClient({async query(statement) {
      statements.push(statement);
      return [{result:statement.includes('claim_outcome') ? claim : true}];
    }});
    expect(await client.claim(fixture.tenant)).toEqual(claim);
    await client.ack(fixture.tenant,id(fixture.run),claim.leaseToken);
    expect(statements[1]).toContain('$3::uuid');
    const incorrect=approvalOutcomeClient({async query() {return [{result:{...claim,payload:{...claim.payload,tenant:'wrong'}}}];}});
    await expect(incorrect.claim(fixture.tenant)).rejects.toThrow('APPROVAL_OUTCOME_RESULT_INVALID');
    const badAck=approvalOutcomeClient({async query() {return [{result:false}];}});
    await expect(badAck.ack(fixture.tenant,id(fixture.run),claim.leaseToken)).rejects.toThrow('APPROVAL_OUTCOME_RESULT_INVALID');
    await expect(client.nack(fixture.tenant,id(fixture.run),claim.leaseToken,'secret body\n')).rejects.toThrow('APPROVAL_INVALID_ERROR_CODE');
  },10000);

  test('malformed outcomes cannot rewrite business payloads and audit pagination is tenant scoped', async () => {
    const fixture=await outcomeFixture();
    await expect(sql(`UPDATE approval.outcomes SET payload='{}' WHERE run_id=${quote(id(fixture.run))};`))
      .rejects.toThrow('APPROVAL_IMMUTABLE_OUTCOME');
    const first: unknown=JSON.parse(await sql(`SET ROLE supacloud_approval_service;
      SELECT approval.list_events(${quote(fixture.tenant)},${quote(id(fixture.run))},0,1);`));
    expect(Array.isArray(first)).toBe(true);
    if (!Array.isArray(first) || first.length!==1) throw new Error('Expected first event');
    const entry: unknown=first[0];
    if (entry===null || typeof entry!=='object' || !('id' in entry) || typeof entry.id!=='string') {
      throw new Error('Expected event cursor');
    }
    const rest: unknown=JSON.parse(await sql(`SET ROLE supacloud_approval_service;
      SELECT approval.list_events(${quote(fixture.tenant)},${quote(id(fixture.run))},${quote(entry.id)}::bigint,100);`));
    expect(Array.isArray(rest) && rest.length>=2).toBe(true);
    await expect(sql(`SET ROLE supacloud_approval_service;
      SELECT approval.list_events('wrong-tenant',${quote(id(fixture.run))},0,1);`)).rejects.toThrow('APPROVAL_NOT_FOUND');
  },10000);

  test('bounded concurrent instances keep commands and terminal notifications one-to-one', async () => {
    const requestIds=Array.from({length:12},()=>crypto.randomUUID());
    const runs=await Promise.all(requestIds.map(request=>start(request)));
    const results=await Promise.all(runs.map(run=>decide(run,'tech-1','rejected')));
    expect(results.every(run=>run.status==='rejected')).toBe(true);
    const ids=runs.map(run=>quote(id(run))).join(',');
    expect(await sql(`SELECT count(*) FROM approval.outcomes WHERE run_id IN (${ids});`)).toBe('12');
    expect(await sql(`SELECT count(*) FROM approval.events WHERE kind='decision' AND run_id IN (${ids});`)).toBe('12');
  },30000);

  test('maintenance isolates poison timeout records instead of retrying them without bounds', async () => {
    const run=await start();
    // Test-only trigger injects failure for exactly this instance, never other tenants.
    await sql(`CREATE FUNCTION approval.test_fail_${id(run).replaceAll('-','')}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF NEW.id=${quote(id(run))}::uuid AND NEW.status='timed_out' THEN
        RAISE EXCEPTION 'injected timeout failure'; END IF; RETURN NEW; END $body$;
      CREATE TRIGGER test_timeout_failure BEFORE UPDATE ON approval.runs FOR EACH ROW
        EXECUTE FUNCTION approval.test_fail_${id(run).replaceAll('-','')}();
      UPDATE approval.runs SET deadline=clock_timestamp()-interval '1 second' WHERE id=${quote(id(run))};`);
    try {
      await sql('SET ROLE supacloud_approval_operator; SELECT approval.maintenance(100);');
      expect(await sql(`SELECT timeout_failures FROM approval.runs WHERE id=${quote(id(run))};`)).toBe('1');
      await sql('SET ROLE supacloud_approval_operator; SELECT approval.maintenance(100);');
      expect(await sql(`SELECT timeout_failures FROM approval.runs WHERE id=${quote(id(run))};`)).toBe('1');
      await sql(`UPDATE approval.runs SET timeout_failures=5,timeout_retry_after='-infinity'
        WHERE id=${quote(id(run))};`);
      await sql('SET ROLE supacloud_approval_operator; SELECT approval.maintenance(100);');
      expect(await sql(`SELECT status FROM approval.runs WHERE id=${quote(id(run))};`)).toBe('pending');
    } finally {
      await sql(`DROP TRIGGER test_timeout_failure ON approval.runs;
        DROP FUNCTION approval.test_fail_${id(run).replaceAll('-','')}();
        UPDATE approval.runs SET timeout_failures=0,timeout_retry_after='-infinity' WHERE id=${quote(id(run))};
        SET ROLE supacloud_approval_operator; SELECT approval.maintenance(100);`);
    }
    expect(await sql(`SELECT status FROM approval.runs WHERE id=${quote(id(run))};`)).toBe('timed_out');
  },20000);

  test('maintenance schedule is singleton and has a real heartbeat', async () => {
    const one=await sql('SET ROLE supacloud_approval_operator; SELECT approval.ensure_maintenance();');
    expect(await sql('SET ROLE supacloud_approval_operator; SELECT approval.ensure_maintenance();')).toBe(one);
    await until('SELECT last_success IS NOT NULL FROM approval.maintenance_state;','t');
    expect(await sql(`SET ROLE supacloud_approval_operator; SELECT approval.health()->>'maintenanceStale';`)).toBe('false');
  },40000);

  test('external health probe reports overdue synthetic deliveries instead of a false green', async () => {
    const child=Bun.spawn(['bun',new URL('../scripts/check-durable.ts',import.meta.url).pathname],{
      env:{...process.env,APPROVAL_TEST_CONTAINER:container,APPROVAL_OUTCOME_MAX_AGE_SECONDS:'1'},
      stdout:'pipe',stderr:'pipe',
    });
    const [output,error,code]=await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    expect(error).toBe('');
    expect(code).toBe(1);
    const report: unknown=JSON.parse(output);
    if (report===null || typeof report!=='object' || !('healthy' in report) || !('overdueDelivery' in report)) {
      throw new Error('Invalid health report');
    }
    expect(report.healthy).toBe(false);
    expect(report.overdueDelivery).toBe(true);
  },10000);

  test('pending approval survives a database restart without duplicate events', async () => {
    const run = await start();
    const maintenance=await sql('SELECT engine_id FROM approval.maintenance_state;');
    await assertLocalApprovalContainer(container);
    const restart = Bun.spawn(['docker', 'restart', container], { stdout: 'pipe', stderr: 'pipe' });
    await new Response(restart.stdout).text();
    if (await restart.exited !== 0) throw new Error('Restart failed');
    const deadline = Date.now() + 20000;
    while (true) {
      try {
        if (await sql(`SELECT to_regclass('df.instances') IS NOT NULL;`) === 't') break;
      } catch {
        if (Date.now() >= deadline) throw new Error('Database did not recover');
      }
      if (Date.now() >= deadline) throw new Error('Database did not recover');
      await Bun.sleep(250);
    }
    await until(`SELECT status FROM approval.runs WHERE id=${quote(id(run))};`, 'pending');
    await waiting(run);
    expect(await sql(`SELECT count(*) FROM approval.events WHERE run_id=${quote(id(run))} AND kind='started';`)).toBe('1');
    expect(await sql('SELECT engine_id FROM approval.maintenance_state;')).toBe(maintenance);
    await until(`SET ROLE supacloud_approval_owner; SELECT df.status(${quote(maintenance)});`,'running');
    const rejected = await decide(run, 'tech-1', 'rejected');
    expect(rejected.status).toBe('rejected');
    await until(`SET ROLE supacloud_approval_owner; SELECT df.status(${quote(String(run.engineId))});`, 'completed');
  }, 60000);
});
