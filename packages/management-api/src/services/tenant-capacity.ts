import {
  emptyTenantCapacity,
  evaluateTenantCapacity,
  parseTenantCapacityBudget,
  type TenantCapacityBudget,
  type TenantCapacityDecision,
} from "@supacloud/delivery/tenant-capacity";
import { getProjectDb, resolveDbName, sql as metaSql } from "../db";
import { mockObjects, normalizeStorageObjectSize } from "./storage-rls";

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<readonly Record<string, unknown>[]>;

const overrides = new Map<string, TenantCapacityBudget>();

export class TenantCapacityUnavailable extends Error {
  constructor(message = "TENANT_CAPACITY_UNAVAILABLE") {
    super(message);
    this.name = "TenantCapacityUnavailable";
  }
}

export function setTenantCapacityOverride(projectRef: string, budget: TenantCapacityBudget | null): void {
  if (budget === null) overrides.delete(projectRef);
  else overrides.set(projectRef, budget);
}

export function clearTenantCapacityOverrides(): void {
  overrides.clear();
}

function testBypass(): boolean {
  return process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test";
}

function missingCapacityTable(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "42P01" || /tenant_capacity_policies/i.test(message) && /does not exist/i.test(message);
}

export class TenantCapacityPolicies {
  constructor(private readonly database: SqlTag = metaSql as unknown as SqlTag) {}

  async read(projectRef: string): Promise<{ projectRef: string; budget: TenantCapacityBudget } | null> {
    this.assertRef(projectRef);
    const [row] = await this.database`
      SELECT budget FROM tenant_capacity_policies WHERE project_ref = ${projectRef}
    `;
    if (!row) return null;
    const budget = parseTenantCapacityBudget(row.budget);
    if (!budget) throw new TenantCapacityUnavailable("TENANT_CAPACITY_POLICY_INVALID");
    return { projectRef, budget };
  }

  async set(projectRef: string, budget: TenantCapacityBudget, updatedBy?: string) {
    this.assertRef(projectRef);
    const parsed = parseTenantCapacityBudget(budget);
    if (!parsed) throw new Error("TENANT_CAPACITY_BUDGET_INVALID");
    const [row] = await this.database`
      INSERT INTO tenant_capacity_policies(project_ref, budget, updated_by)
      VALUES (${projectRef}, ${parsed}, ${updatedBy ?? null})
      ON CONFLICT (project_ref) DO UPDATE SET
        budget = EXCLUDED.budget,
        updated_by = EXCLUDED.updated_by,
        updated_at = clock_timestamp()
      RETURNING project_ref, budget, updated_by, updated_at
    `;
    const stored = parseTenantCapacityBudget(row?.budget);
    if (!stored) throw new TenantCapacityUnavailable("TENANT_CAPACITY_POLICY_INVALID");
    return {
      projectRef: String(row?.project_ref ?? projectRef),
      budget: stored,
      updatedBy: row?.updated_by == null ? null : String(row.updated_by),
      updatedAt: new Date(String(row?.updated_at)).toISOString(),
    };
  }

  private assertRef(projectRef: string): void {
    if (!/^[a-z0-9-]{1,20}$/.test(projectRef)) throw new Error("TENANT_CAPACITY_PROJECT_INVALID");
  }
}

export async function loadTenantCapacityBudget(projectRef: string): Promise<TenantCapacityBudget | null> {
  const override = overrides.get(projectRef);
  if (override) return override;
  if (testBypass()) return null;
  try {
    return await new TenantCapacityPolicies().read(projectRef).then(row => row?.budget ?? null);
  } catch (error) {
    if (error instanceof TenantCapacityUnavailable) throw error;
    if (missingCapacityTable(error)) return null;
    throw new TenantCapacityUnavailable();
  }
}

function mockStorageBytes(bucket: string, objectName: string): { total: number; replaced: number } {
  let total = 0;
  let replaced = 0;
  const key = `${bucket}/${objectName}`;
  for (const [name, object] of mockObjects) {
    const size = normalizeStorageObjectSize(object.metadata["size"]);
    total += size;
    if (name === key) replaced += size;
  }
  return { total, replaced };
}

async function storedBytes(ref: string, bucket: string, objectName: string): Promise<{ total: number; replaced: number }> {
  if (ref === "test_mock") return mockStorageBytes(bucket, objectName);
  try {
    const database = getProjectDb(await resolveDbName(ref)) as unknown as SqlTag;
    const [row] = await database`
      SELECT
        COALESCE(SUM(CASE WHEN metadata->>'size' ~ '^[0-9]+$' THEN (metadata->>'size')::bigint ELSE 0 END), 0)::text AS total,
        COALESCE(SUM(CASE WHEN bucket_id = ${bucket} AND name = ${objectName} AND metadata->>'size' ~ '^[0-9]+$' THEN (metadata->>'size')::bigint ELSE 0 END), 0)::text AS replaced
      FROM storage.objects
    `;
    return {
      total: byteCount(row?.total),
      replaced: byteCount(row?.replaced),
    };
  } catch (error) {
    if (error instanceof TenantCapacityUnavailable) throw error;
    throw new TenantCapacityUnavailable();
  }
}

function byteCount(value: unknown): number {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "0");
  if (!/^\d+$/.test(text)) return 0;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export async function storageCapacityRejection(input: {
  ref: string;
  bucket: string;
  objectName: string;
  additionalBytes: number;
}): Promise<null | { status: 429 | 503; body: Record<string, unknown> }> {
  let budget: TenantCapacityBudget | null;
  try {
    budget = await loadTenantCapacityBudget(input.ref);
  } catch (error) {
    if (!(error instanceof TenantCapacityUnavailable)) throw error;
    return { status: 503, body: { statusCode: "503", error: "Service Unavailable", message: "Tenant capacity is unavailable", code: error.message } };
  }
  if (!budget) return null;
  if (!Number.isSafeInteger(input.additionalBytes) || input.additionalBytes < 0) {
    return { status: 503, body: { statusCode: "503", error: "Service Unavailable", message: "Tenant capacity is unavailable", code: "TENANT_CAPACITY_UNAVAILABLE" } };
  }
  let accounted: { total: number; replaced: number };
  try {
    accounted = await storedBytes(input.ref, input.bucket, input.objectName);
  } catch (error) {
    if (!(error instanceof TenantCapacityUnavailable)) throw error;
    return { status: 503, body: { statusCode: "503", error: "Service Unavailable", message: "Tenant capacity is unavailable", code: error.message } };
  }
  const used = Math.max(0, accounted.total - accounted.replaced);
  const decision = evaluateTenantCapacity({
    projectRef: input.ref,
    budget,
    usage: { ...emptyTenantCapacity(), storageBytes: used },
    requested: { storageBytes: input.additionalBytes },
    enforce: ["storageBytes"],
  });
  if (decision.admitted) return null;
  return { status: 429, body: tenantCapacityHttpBody(decision) };
}

export function tenantCapacityHttpBody(decision: TenantCapacityDecision): Record<string, unknown> {
  return {
    statusCode: "429",
    error: "Too Many Requests",
    message: "Tenant capacity exceeded",
    code: "TENANT_CAPACITY_EXCEEDED",
    projectRef: decision.projectRef,
    dimension: decision.dimension,
    limit: decision.limit,
    usage: decision.usage,
    requested: decision.requested,
  };
}
