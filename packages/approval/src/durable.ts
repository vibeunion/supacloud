import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ApprovalGraphDefinitionSchema, ApprovalGraphFactsSchema, decodeApprovalGraph } from './graph.js';
export { decodeApprovalGraph, planApprovalGraph } from './graph.js';
export {
  createApprovalIdentity,
  createApprovalIdentityFromSupAuth,
  durableApprovalActor,
} from './identity.js';
export type {
  ApprovalIdentity,
  ApprovalIdentityAccess,
  ApprovalIdentityInput,
  ApprovalPrincipal,
  ApprovalPrincipalKind,
  VerifiedSupAuthContextLike,
} from './identity.js';

const Key = Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9_.-]*$' });
const Actor = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:@-]+$' });
const Uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const RowVersion = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });

/** JSON-only contract shared by application validation and the database migration. */
const DurableApprovalDefinitionV1Schema = Type.Object({
  schemaVersion: Type.Literal(1),
  steps: Type.Array(Type.Object({
    key: Key,
    mode: Type.Union([Type.Literal('all'), Type.Literal('any')]),
    approvers: Type.Array(Actor, { minItems: 1, maxItems: 50, uniqueItems: true }),
    timeoutSeconds: Type.Integer({ minimum: 1, maximum: 2_592_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

export const ApprovalAssignmentRuleSchema = Type.Object({
  resolver: Key,
  scope: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false });

const DurableApprovalDefinitionV2Schema = Type.Object({
  schemaVersion: Type.Literal(2),
  steps: Type.Array(Type.Object({
    key: Key,
    mode: Type.Union([Type.Literal('all'), Type.Literal('any')]),
    assignment: ApprovalAssignmentRuleSchema,
    timeoutSeconds: Type.Integer({ minimum: 1, maximum: 2_592_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

const DurableApprovalDefinitionThroughV2Schema = Type.Union([
  DurableApprovalDefinitionV1Schema, DurableApprovalDefinitionV2Schema,
]);

const DurableApprovalDefinitionV3Schema = Type.Object({
  ...DurableApprovalDefinitionV2Schema.properties,
  schemaVersion: Type.Literal(3),
  subjectResolver: Key,
}, { additionalProperties: false });

const DurableApprovalDefinitionThroughV3Schema = Type.Union([
  DurableApprovalDefinitionV1Schema, DurableApprovalDefinitionV2Schema, DurableApprovalDefinitionV3Schema,
]);

const DurableApprovalDefinitionV4Schema = Type.Object({
  schemaVersion: Type.Literal(4),
  subjectResolver: Key,
  steps: Type.Array(Type.Object({
    key: Key,
    mode: Type.Union([Type.Literal('all'), Type.Literal('any'), Type.Literal('claim'), Type.Literal('quorum')]),
    assignment: ApprovalAssignmentRuleSchema,
    timeoutSeconds: Type.Integer({ minimum: 1, maximum: 2_592_000 }),
    quorum: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });

const DurableApprovalDefinitionThroughV4Schema = Type.Union([
  DurableApprovalDefinitionV1Schema, DurableApprovalDefinitionV2Schema,
  DurableApprovalDefinitionV3Schema, DurableApprovalDefinitionV4Schema,
]);
export const DurableApprovalDefinitionSchema = Type.Union([
  DurableApprovalDefinitionV1Schema, DurableApprovalDefinitionV2Schema,
  DurableApprovalDefinitionV3Schema, DurableApprovalDefinitionV4Schema, ApprovalGraphDefinitionSchema,
]);

export const ApprovalBusinessSnapshotSchema = Type.Object({
  revision: Type.String({ minLength: 1, maxLength: 256 }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
}, { additionalProperties: false });
export type ApprovalBusinessSnapshot = Static<typeof ApprovalBusinessSnapshotSchema>;

export const ApprovalAssignmentResolutionSchema = Type.Object({
  actors: Type.Array(Actor, { minItems: 1, maxItems: 50, uniqueItems: true }),
  revision: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false });

export type DurableApprovalDefinition = Static<typeof DurableApprovalDefinitionSchema>;

export interface ApprovalSimulationStep {
  key: string;
  mode: 'all' | 'any' | 'claim' | 'quorum';
  actors: readonly string[];
  requiredApprovals: number;
  timeoutSeconds: number;
  sourceRevision: string | null;
}

/** Pure preview only. Sample resolutions never authorize a real command. */
export function simulateApprovalDefinition(
  definition: unknown, requester: string, samples: Readonly<Record<string, unknown>> = {},
): readonly ApprovalSimulationStep[] {
  const decoded = decodeDurableApprovalDefinition(definition);
  if (decoded.schemaVersion === 5) throw new Error('APPROVAL_USE_GRAPH_PLANNER');
  if (!Value.Check(Actor,requester)) throw new Error('APPROVAL_INVALID_ACTOR');
  return decoded.steps.map(step => {
    let actors: string[];
    let sourceRevision: string | null = null;
    if ('approvers' in step) actors = [...step.approvers];
    else {
      const sample = Object.hasOwn(samples,step.key) ? samples[step.key] : undefined;
      if (!Value.Check(ApprovalAssignmentResolutionSchema,sample)) throw new Error(`APPROVAL_SIMULATION_RESOLUTION_REQUIRED:${step.key}`);
      actors = [...sample.actors];
      sourceRevision = sample.revision;
    }
    if (actors.includes(requester)) throw new Error(`APPROVAL_MAKER_CHECKER:${step.key}`);
    const requiredApprovals = step.mode === 'all' ? actors.length
      : 'quorum' in step && step.mode === 'quorum' ? step.quorum ?? 0 : 1;
    if (requiredApprovals < 1 || requiredApprovals > actors.length) throw new Error(`APPROVAL_QUORUM_UNREACHABLE:${step.key}`);
    return { key: step.key, mode: step.mode, actors, requiredApprovals, timeoutSeconds: step.timeoutSeconds, sourceRevision };
  });
}

export const DurableApprovalReceiptSchema = Type.Object({
  id: Uuid,
  tenant: Type.String({ minLength: 1, maxLength: 128 }),
  entityId: Type.String({ minLength: 1, maxLength: 256 }),
  businessSnapshot: Type.Optional(ApprovalBusinessSnapshotSchema),
  rootRunId: Type.Optional(Uuid),
  previousRunId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  migrationSourceRunId: Type.Optional(Uuid),
  round: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  executionVersion: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  graphNodes: Type.Optional(Type.Array(Type.Object({
    key: Key,status: Type.Union([Type.Literal('waiting'),Type.Literal('running'),Type.Literal('approved'),
      Type.Literal('rejected'),Type.Literal('returned'),Type.Literal('cancelled'),Type.Literal('timed_out'),Type.Literal('skipped')]),
    childRunId: Type.Union([Uuid,Type.Null()]),
  },{ additionalProperties: false }),{ maxItems: 32 })),
  taskContext: Type.Optional(Type.Object({
    claimant: Type.Union([Actor, Type.Null()]),
    delegations: Type.Array(Type.Object({
      owner: Actor, delegate: Actor, resolved: Type.Boolean(),
    }, { additionalProperties: false }), { maxItems: 50 }),
  }, { additionalProperties: false })),
  status: Type.Union([
    Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected'),
    Type.Literal('cancelled'), Type.Literal('timed_out'), Type.Literal('returned'),
  ]),
  stepIndex: Type.Integer({ minimum: 0, maximum: 31 }),
  rowVersion: RowVersion,
  deadline: Type.String({ minLength: 1 }),
  engineId: Type.String({ pattern: '^[0-9a-f]{8}$' }),
  tasks: Type.Array(Type.Object({
    stepIndex: Type.Integer({ minimum: 0, maximum: 31 }),
    actor: Actor,
    status: Type.Union([
      Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected'), Type.Literal('cancelled'),
    ]),
    reason: Type.String({ maxLength: 4000 }),
  }, { additionalProperties: false }), { minItems: 0, maxItems: 1600 }),
}, { additionalProperties: false });

export type DurableApprovalReceipt = Static<typeof DurableApprovalReceiptSchema>;

export function decodeDurableApprovalDefinition(value: unknown): DurableApprovalDefinition {
  if (!Value.Check(DurableApprovalDefinitionSchema, value)) {
    throw new Error('APPROVAL_DEFINITION_INVALID');
  }
  if (value.schemaVersion === 5) return decodeApprovalGraph(value);
  if (new Set(value.steps.map(step => step.key)).size !== value.steps.length) {
    throw new Error('APPROVAL_DUPLICATE_STEP');
  }
  if (value.schemaVersion === 4 && value.steps.some(step => (step.mode === 'quorum') !== (step.quorum !== undefined))) {
    throw new Error('APPROVAL_QUORUM_INVALID');
  }
  return Value.Clone(value);
}

/** Used only by the migration installer, never during an application request. */
export function renderDurableApprovalMigration(template: string, version: '001' | '005' = '001'): string {
  const marker = '__APPROVAL_DEFINITION_SCHEMA__';
  if (template.split(marker).length !== 2) throw new Error('APPROVAL_MIGRATION_TEMPLATE_INVALID');
  const schema = JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    // Migration 001 must retain its original bytes and checksum.
    ...(version === '001' ? DurableApprovalDefinitionV1Schema : DurableApprovalDefinitionThroughV2Schema),
  }).replaceAll("'", "''");
  const rendered = template.replace(marker, schema);
  if (version === '001') return rendered;
  const resolutionMarker = '__APPROVAL_ASSIGNMENT_RESOLUTION_SCHEMA__';
  if (rendered.split(resolutionMarker).length !== 2) throw new Error('APPROVAL_MIGRATION_TEMPLATE_INVALID');
  return rendered.replace(resolutionMarker, JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...ApprovalAssignmentResolutionSchema,
  }).replaceAll("'", "''"));
}

export function renderApprovalSubjectMigration(template: string): string {
  let result = template;
  for (const [marker, schema] of [
    ['__APPROVAL_DEFINITION_SCHEMA__', DurableApprovalDefinitionThroughV3Schema],
    ['__APPROVAL_BUSINESS_SNAPSHOT_SCHEMA__', ApprovalBusinessSnapshotSchema],
  ] as const) {
    if (result.split(marker).length !== 2) throw new Error('APPROVAL_MIGRATION_TEMPLATE_INVALID');
    result = result.replace(marker, JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#', ...schema,
    }).replaceAll("'", "''"));
  }
  return result;
}

export function renderApprovalTaskMigration(template: string): string {
  const marker = '__APPROVAL_DEFINITION_SCHEMA__';
  if (template.split(marker).length !== 2) throw new Error('APPROVAL_MIGRATION_TEMPLATE_INVALID');
  return template.replace(marker, JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#', ...DurableApprovalDefinitionThroughV4Schema,
  }).replaceAll("'", "''"));
}

export function renderApprovalGraphMigration(template: string): string {
  let result = template;
  for (const [marker,schema] of [
    ['__APPROVAL_DEFINITION_SCHEMA__',DurableApprovalDefinitionSchema],
    ['__APPROVAL_GRAPH_FACTS_SCHEMA__',ApprovalGraphFactsSchema],
  ] as const) {
    if (result.split(marker).length !== 2) throw new Error('APPROVAL_MIGRATION_TEMPLATE_INVALID');
    result = result.replace(marker,JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#',...schema }).replaceAll("'","''"));
  }
  return result;
}
export interface ApprovalSqlConnection {
  query(sql: string, parameters: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

function checkIdentity(tenant: string, actor?: string, requestId?: string): void {
  if (!Value.Check(Actor, tenant) || (actor !== undefined && !Value.Check(Actor, actor))
    || (requestId !== undefined && !Value.Check(Uuid, requestId))) throw new Error('APPROVAL_INVALID_IDENTITY');
}
function checkRun(runId: string, expectedVersion?: string): void {
  if (!Value.Check(Uuid, runId)) throw new Error('APPROVAL_INVALID_RUN_ID');
  if (expectedVersion !== undefined && (!Value.Check(RowVersion, expectedVersion)
    || BigInt(expectedVersion) > 9223372036854775807n)) throw new Error('APPROVAL_INVALID_VERSION');
}

/** Server-only: caller must derive tenant/actor from authenticated membership, not request JSON. */
export function durableApprovalClient(connection: ApprovalSqlConnection) {
  async function invoke(sql: string, parameters: readonly unknown[], scope: {
    runId?: string; entityId?: string; businessSnapshot?: ApprovalBusinessSnapshot; previousRunId?: string;
  }) {
    const rows = await connection.query(sql, parameters);
    if (rows.length !== 1 || rows[0]?.receipt === undefined) throw new Error('APPROVAL_RECEIPT_MISSING');
    const receipt = rows[0].receipt;
    if (!Value.Check(DurableApprovalReceiptSchema, receipt)
      || (receipt.tasks.length === 0 && receipt.executionVersion !== 3)
      || BigInt(receipt.rowVersion)>9223372036854775807n
      || !Number.isFinite(Date.parse(receipt.deadline))) throw new Error('APPROVAL_RECEIPT_INVALID');
    if (receipt.tenant !== parameters[0] || (scope.runId !== undefined && receipt.id !== scope.runId)
      || (scope.entityId !== undefined && receipt.entityId !== scope.entityId)) throw new Error('APPROVAL_RECEIPT_SCOPE_MISMATCH');
    if (scope.businessSnapshot !== undefined && (receipt.businessSnapshot?.revision !== scope.businessSnapshot.revision
      || receipt.businessSnapshot?.sha256 !== scope.businessSnapshot.sha256)) throw new Error('APPROVAL_RECEIPT_SNAPSHOT_MISMATCH');
    if (scope.previousRunId !== undefined && (receipt.previousRunId !== scope.previousRunId
      || receipt.id === scope.previousRunId || receipt.round === undefined || receipt.round < 2)) {
      throw new Error('APPROVAL_RECEIPT_LINEAGE_MISMATCH');
    }
    return Value.Clone(receipt);
  }
  return Object.freeze({
    start(input: {
      tenant: string; actor: string; requestId: string;
      definitionKey: string; definitionVersion: number; entityId: string;
      businessSnapshot?: ApprovalBusinessSnapshot;
    }) {
      checkIdentity(input.tenant,input.actor,input.requestId);
      if (!Value.Check(Key,input.definitionKey) || !Number.isInteger(input.definitionVersion)
        || input.definitionVersion<1 || input.definitionVersion>2147483647
        || typeof input.entityId!=='string' || input.entityId.length<1 || input.entityId.length>256) {
        throw new Error('APPROVAL_INVALID_START');
      }
      if (input.businessSnapshot !== undefined) {
        if (!Value.Check(ApprovalBusinessSnapshotSchema, input.businessSnapshot)) throw new Error('APPROVAL_INVALID_SNAPSHOT');
        return invoke('SELECT approval.start($1,$2,$3::uuid,$4,$5::integer,$6,$7::jsonb) AS receipt',
          [input.tenant, input.actor, input.requestId, input.definitionKey, input.definitionVersion,
            input.entityId, JSON.stringify(input.businessSnapshot)],
          { entityId: input.entityId, businessSnapshot: Value.Clone(input.businessSnapshot) });
      }
      return invoke('SELECT approval.start($1,$2,$3::uuid,$4,$5::integer,$6) AS receipt',
        [input.tenant, input.actor, input.requestId, input.definitionKey, input.definitionVersion, input.entityId],
        { entityId: input.entityId });
    },
    decide(input: {
      tenant: string; actor: string; requestId: string; runId: string;
      expectedVersion: string; decision: 'approved' | 'rejected'; reason: string;
      businessSnapshot?: ApprovalBusinessSnapshot;
    }) {
      checkIdentity(input.tenant,input.actor,input.requestId);
      checkRun(input.runId,input.expectedVersion);
      if (!['approved','rejected'].includes(input.decision) || typeof input.reason!=='string'
        || input.reason.length>4000 || (input.decision==='rejected' && input.reason.trim()==='')) {
        throw new Error('APPROVAL_INVALID_DECISION');
      }
      if (input.businessSnapshot !== undefined) {
        if (!Value.Check(ApprovalBusinessSnapshotSchema, input.businessSnapshot)) throw new Error('APPROVAL_INVALID_SNAPSHOT');
        return invoke('SELECT approval.decide($1,$2,$3::uuid,$4::uuid,$5::bigint,$6,$7,$8::jsonb) AS receipt',
          [input.tenant, input.actor, input.requestId, input.runId, input.expectedVersion,
            input.decision, input.reason, JSON.stringify(input.businessSnapshot)],
          { runId: input.runId, businessSnapshot: Value.Clone(input.businessSnapshot) });
      }
      return invoke('SELECT approval.decide($1,$2,$3::uuid,$4::uuid,$5::bigint,$6,$7) AS receipt',
        [input.tenant, input.actor, input.requestId, input.runId, input.expectedVersion, input.decision, input.reason],
        { runId: input.runId });
    },
    taskAction(input: {
      tenant: string; actor: string; requestId: string; runId: string; expectedVersion: string;
      action: 'claim' | 'release' | 'transfer' | 'delegate' | 'resolve' | 'add'; target?: string; reason: string;
    }) {
      checkIdentity(input.tenant,input.actor,input.requestId);
      checkRun(input.runId,input.expectedVersion);
      if (!['claim','release','transfer','delegate','resolve','add'].includes(input.action)
        || typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 4000
        || (['claim','release'].includes(input.action) ? input.target !== undefined : !Value.Check(Actor,input.target))) {
        throw new Error('APPROVAL_INVALID_TASK_ACTION');
      }
      return invoke('SELECT approval.task_action($1,$2,$3::uuid,$4::uuid,$5::bigint,$6,$7,$8) AS receipt',
        [input.tenant,input.actor,input.requestId,input.runId,input.expectedVersion,input.action,input.target ?? null,input.reason],
        { runId: input.runId });
    },
    returnForChanges(input: {
      tenant: string; actor: string; requestId: string; runId: string; expectedVersion: string; reason: string;
    }) {
      checkIdentity(input.tenant,input.actor,input.requestId);
      checkRun(input.runId,input.expectedVersion);
      if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 4000) {
        throw new Error('APPROVAL_RETURN_REASON_REQUIRED');
      }
      return invoke('SELECT approval.return_for_changes($1,$2,$3::uuid,$4::uuid,$5::bigint,$6) AS receipt',
        [input.tenant,input.actor,input.requestId,input.runId,input.expectedVersion,input.reason], { runId: input.runId });
    },
    resubmit(input: {
      tenant: string; actor: string; requestId: string; runId: string; expectedVersion: string;
      businessSnapshot?: ApprovalBusinessSnapshot; reason: string;
    }) {
      checkIdentity(input.tenant,input.actor,input.requestId);
      checkRun(input.runId,input.expectedVersion);
      if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 4000) {
        throw new Error('APPROVAL_RETURN_REASON_REQUIRED');
      }
      if (input.businessSnapshot !== undefined && !Value.Check(ApprovalBusinessSnapshotSchema,input.businessSnapshot)) {
        throw new Error('APPROVAL_INVALID_SNAPSHOT');
      }
      return invoke('SELECT approval.resubmit($1,$2,$3::uuid,$4::uuid,$5::bigint,$6::jsonb,$7) AS receipt',
        [input.tenant,input.actor,input.requestId,input.runId,input.expectedVersion,
          input.businessSnapshot === undefined ? null : JSON.stringify(input.businessSnapshot),input.reason],
        { previousRunId: input.runId, ...(input.businessSnapshot === undefined
          ? {} : { businessSnapshot: Value.Clone(input.businessSnapshot) }) });
    },
    cancel(input: {
      tenant: string; actor: string; requestId: string; runId: string; expectedVersion: string;
    }) {
      checkIdentity(input.tenant,input.actor,input.requestId);
      checkRun(input.runId,input.expectedVersion);
      return invoke('SELECT approval.cancel($1,$2,$3::uuid,$4::uuid,$5::bigint) AS receipt',
        [input.tenant, input.actor, input.requestId, input.runId, input.expectedVersion], { runId: input.runId });
    },
    get(tenant: string, runId: string) {
      checkIdentity(tenant);
      checkRun(runId);
      return invoke('SELECT approval.get_run($1,$2::uuid) AS receipt', [tenant, runId], { runId });
    },
  });
}

export const ApprovalOutcomeClaimSchema = Type.Object({
  payload: Type.Object({
    tenant: Actor, runId: Uuid, entityId: Type.String({ minLength: 1, maxLength: 256 }),
    definitionKey: Key, definitionVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
    status: Type.Union([Type.Literal('approved'),Type.Literal('rejected'),Type.Literal('cancelled'),Type.Literal('timed_out'),Type.Literal('returned')]),
    rowVersion: RowVersion,
    businessSnapshot: Type.Optional(ApprovalBusinessSnapshotSchema),
    rootRunId: Type.Optional(Uuid),
    round: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    executionVersion: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  }, { additionalProperties: false }),
  leaseToken: Uuid, leaseUntil: Type.String({ minLength: 1 }),
  attempt: Type.Integer({ minimum: 1, maximum: 10 }),
}, { additionalProperties: false });
export type ApprovalOutcomeClaim = Static<typeof ApprovalOutcomeClaimSchema>;

/** Use a transaction-bound connection to commit a local domain write and acknowledgement together. */
export function approvalOutcomeClient(connection: ApprovalSqlConnection) {
  async function execute(statement: string, parameters: readonly unknown[]): Promise<unknown> {
    const rows = await connection.query(statement,parameters);
    if (rows.length!==1 || rows[0]?.result===undefined) throw new Error('APPROVAL_OUTCOME_RESULT_INVALID');
    return rows[0].result;
  }
  return Object.freeze({
    async claim(tenant: string, leaseSeconds = 60): Promise<ApprovalOutcomeClaim | null> {
      checkIdentity(tenant);
      if (!Number.isInteger(leaseSeconds) || leaseSeconds<1 || leaseSeconds>600) throw new Error('APPROVAL_INVALID_LEASE');
      const result = await execute('SELECT approval.claim_outcome($1,$2::integer) AS result',[tenant,leaseSeconds]);
      if (result===null) return null;
      if (!Value.Check(ApprovalOutcomeClaimSchema,result) || result.payload.tenant!==tenant
        || BigInt(result.payload.rowVersion)>9223372036854775807n
        || !Number.isFinite(Date.parse(result.leaseUntil))) throw new Error('APPROVAL_OUTCOME_RESULT_INVALID');
      return Value.Clone(result);
    },
    async ack(tenant: string, runId: string, token: string): Promise<void> {
      checkIdentity(tenant,undefined,token); checkRun(runId);
      if (await execute('SELECT approval.ack_outcome($1,$2::uuid,$3::uuid) AS result',[tenant,runId,token])!==true) {
        throw new Error('APPROVAL_OUTCOME_RESULT_INVALID');
      }
    },
    async nack(tenant: string, runId: string, token: string, errorCode: string): Promise<void> {
      checkIdentity(tenant,undefined,token); checkRun(runId);
      if (!/^[A-Z0-9_]{1,80}$/.test(errorCode)) throw new Error('APPROVAL_INVALID_ERROR_CODE');
      if (await execute('SELECT approval.nack_outcome($1,$2::uuid,$3::uuid,$4) AS result',
        [tenant,runId,token,errorCode])!==true) throw new Error('APPROVAL_OUTCOME_RESULT_INVALID');
    },
  });
}

export const ApprovalNoticeClaimSchema = Type.Object({
  payload: Type.Object({
    noticeId: Uuid, tenant: Actor, runId: Uuid, entityId: Type.String({ minLength: 1, maxLength: 256 }),
    stepIndex: Type.Integer({ minimum: 0, maximum: 31 }), round: Type.Integer({ minimum: 1, maximum: 1000 }),
    kind: Type.Union([Type.Literal('reminder'),Type.Literal('escalation')]),
    recipients: Type.Array(Actor,{ minItems: 1,maxItems: 50,uniqueItems: true }),
    deadline: Type.String({ minLength: 1 }),
    businessSnapshot: Type.Union([ApprovalBusinessSnapshotSchema,Type.Null()]),
  },{ additionalProperties: false }),
  leaseToken: Uuid,leaseUntil: Type.String({ minLength: 1 }),attempt: Type.Integer({ minimum: 1,maximum: 10 }),
},{ additionalProperties: false });
export type ApprovalNoticeClaim = Static<typeof ApprovalNoticeClaimSchema>;

export function approvalNoticeClient(connection: ApprovalSqlConnection) {
  return Object.freeze({
    async claim(tenant: string,leaseSeconds = 60): Promise<ApprovalNoticeClaim | null> {
      checkIdentity(tenant);
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 600) throw new Error('APPROVAL_INVALID_LEASE');
      const rows = await connection.query('SELECT approval.claim_notice($1,$2::integer) AS result',[tenant,leaseSeconds]);
      if (rows.length !== 1) throw new Error('APPROVAL_NOTICE_RESULT_INVALID');
      const result = rows[0]?.result;
      if (result === null) return null;
      if (!Value.Check(ApprovalNoticeClaimSchema,result) || result.payload.tenant !== tenant
        || !Number.isFinite(Date.parse(result.leaseUntil)) || !Number.isFinite(Date.parse(result.payload.deadline))) {
        throw new Error('APPROVAL_NOTICE_RESULT_INVALID');
      }
      return Value.Clone(result);
    },
    async finish(tenant: string,noticeId: string,leaseToken: string,errorCode?: string): Promise<void> {
      checkIdentity(tenant,undefined,leaseToken);
      checkRun(noticeId);
      if (errorCode !== undefined && !/^[A-Z0-9_]{1,80}$/.test(errorCode)) throw new Error('APPROVAL_INVALID_ERROR_CODE');
      const rows = await connection.query('SELECT approval.finish_notice($1,$2::uuid,$3::uuid,$4) AS result',
        [tenant,noticeId,leaseToken,errorCode ?? null]);
      if (rows.length !== 1 || rows[0]?.result !== true) throw new Error('APPROVAL_NOTICE_RESULT_INVALID');
    },
  });
}

export const ApprovalWorkItemSchema = Type.Object({
  tenant: Actor,runId: Uuid, entityId: Type.String({ minLength: 1,maxLength: 256 }),definitionKey: Key,
  definitionVersion: Type.Integer({ minimum: 1,maximum: 2147483647 }),requester: Actor,
  status: DurableApprovalReceiptSchema.properties.status,stepIndex: Type.Integer({ minimum: 0,maximum: 31 }),
  rowVersion: RowVersion,round: Type.Integer({ minimum: 1,maximum: 1000 }),rootRunId: Uuid,
  createdAt: Type.String(),deadline: Type.String(),
  blockingReason: Type.Union([Type.Null(),Type.Literal('deadline_elapsed'),Type.Literal('delegation_pending'),
    Type.Literal('awaiting_claim'),Type.Literal('awaiting_decision')]),
},{ additionalProperties: false });
export type ApprovalWorkItem = Static<typeof ApprovalWorkItemSchema>;
export function approvalWorkbenchClient(connection: ApprovalSqlConnection) {
  return Object.freeze({
    async list(input: {
      tenant: string; actor: string; view: 'inbox' | 'done' | 'started' | 'delegated';
      before?: { createdAt: string; runId: string }; limit?: number;
    }): Promise<ApprovalWorkItem[]> {
      checkIdentity(input.tenant,input.actor);
      const limit = input.limit ?? 50;
      if (!['inbox','done','started','delegated'].includes(input.view) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('APPROVAL_INVALID_PAGE');
      }
      if (input.before !== undefined) {
        checkRun(input.before.runId);
        if (!Number.isFinite(Date.parse(input.before.createdAt))) throw new Error('APPROVAL_INVALID_PAGE');
      }
      const rows = await connection.query('SELECT approval.list_runs($1,$2,$3,$4::timestamptz,$5::uuid,$6::integer) AS result',
        [input.tenant,input.actor,input.view,input.before?.createdAt ?? null,input.before?.runId ?? null,limit]);
      const result = rows[0]?.result;
      if (rows.length !== 1 || !Value.Check(Type.Array(ApprovalWorkItemSchema,{ maxItems: limit }),result)
        || result.some(item => item.tenant !== input.tenant || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.deadline))
          || BigInt(item.rowVersion)>9223372036854775807n)) throw new Error('APPROVAL_WORKBENCH_RESULT_INVALID');
      return Value.Clone(result);
    },
    async rounds(tenant: string,runId: string,after = 0,limit = 50): Promise<DurableApprovalReceipt[]> {
      checkIdentity(tenant); checkRun(runId);
      if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('APPROVAL_INVALID_PAGE');
      const rows = await connection.query('SELECT approval.list_rounds($1,$2::uuid,$3::integer,$4::integer) AS result',
        [tenant,runId,after,limit]);
      const result = rows[0]?.result;
      if (rows.length !== 1 || !Value.Check(Type.Array(DurableApprovalReceiptSchema,{ maxItems: limit }),result)
        || result.some(item => item.tenant !== tenant || item.round === undefined || item.round <= after)) {
        throw new Error('APPROVAL_WORKBENCH_RESULT_INVALID');
      }
      return Value.Clone(result);
    },
  });
}
