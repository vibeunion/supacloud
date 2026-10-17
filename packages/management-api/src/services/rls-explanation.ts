export type RlsExplanationOutcome = "allowed" | "filtered" | "denied" | "unknown";

export interface RlsExplanation {
  outcome: RlsExplanationOutcome;
  reasons: string[];
  relations: Array<{
    schema: string;
    table: string;
    rls_enabled: boolean | null;
    applicable_policies: string[];
  }>;
}

export function explainRlsAccess(input: {
  role: "anon" | "authenticated";
  relations: ReadonlyArray<{ schema: string; table: string }>;
  relationSecurity: ReadonlyArray<{
    schema: string;
    table: string;
    rlsEnabled: boolean;
    rlsForced: boolean;
  }>;
  policies: ReadonlyArray<{
    schema: string;
    table: string;
    name: string;
    appliesToRole: boolean;
  }>;
  rowCount: number;
}): RlsExplanation {
  const security = new Map(
    input.relationSecurity.map((item) => [`${item.schema}\0${item.table}`, item]),
  );
  const policyNames = new Map<string, string[]>();
  for (const policy of input.policies) {
    if (!policy.appliesToRole) continue;
    const key = `${policy.schema}\0${policy.table}`;
    policyNames.set(key, [...(policyNames.get(key) ?? []), policy.name]);
  }
  const relations = input.relations.map((relation) => {
    const key = `${relation.schema}\0${relation.table}`;
    return {
      schema: relation.schema,
      table: relation.table,
      rls_enabled: security.get(key)?.rlsEnabled ?? null,
      applicable_policies: [...(policyNames.get(key) ?? [])].sort(),
    };
  });
  if (relations.length === 0) {
    return { outcome: "unknown", reasons: ["No base table relation was found in the query plan."], relations };
  }
  const denied = relations.filter((relation) => relation.rls_enabled === true && relation.applicable_policies.length === 0);
  if (denied.length > 0) {
    return {
      outcome: "denied",
      reasons: denied.map((relation) =>
        `${relation.schema}.${relation.table} has RLS enabled but no policy applies to role ${input.role}.`),
      relations,
    };
  }
  if (relations.some((relation) => relation.rls_enabled === null)) {
    return {
      outcome: "unknown",
      reasons: ["RLS catalog state was not available for every relation; PostgreSQL grants remain authoritative."],
      relations,
    };
  }
  const noRls = relations.filter((relation) => relation.rls_enabled === false);
  if (input.rowCount > 0) {
    return {
      outcome: "allowed",
      reasons: [
        "The role returned rows under the current query predicates and claims.",
        ...(noRls.length > 0
          ? [`${noRls.map((relation) => `${relation.schema}.${relation.table}`).join(", ")} has RLS disabled; PostgreSQL grants govern access.`]
          : []),
      ],
      relations,
    };
  }
  if (relations.some((relation) => relation.rls_enabled === true)) {
    return {
      outcome: "filtered",
      reasons: ["Applicable RLS policies exist, but the query returned no rows; policy filtering and query predicates may both contribute."],
      relations,
    };
  }
  return {
    outcome: "unknown",
    reasons: ["The query returned no rows and no RLS policy decision could be inferred."],
    relations,
  };
}

export function explainRlsDatabaseError(error: unknown): RlsExplanation {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "";
  const message = error instanceof Error ? error.message : String(record.message ?? error);
  if (code === "42501" || /permission denied|row-level security policy/i.test(message)) {
    return {
      outcome: "denied",
      reasons: [`PostgreSQL denied the operation${code ? ` (${code})` : ""}: ${message}`],
      relations: [],
    };
  }
  return {
    outcome: "unknown",
    reasons: ["PostgreSQL returned an error before a permission decision could be explained."],
    relations: [],
  };
}
