import { afterAll, describe, expect, test } from "bun:test";
import { SQL, type ReservedSQL } from "bun";

interface OrganizationDomainsRow {
  jit_domains: string[];
}

const database = new SQL({
  url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
  max: 1,
});

async function withRollback(operation: (transaction: ReservedSQL) => Promise<void>): Promise<void> {
  const connection = await database.reserve();
  await connection.unsafe("BEGIN");
  try {
    await operation(connection);
  } finally {
    await connection.unsafe("ROLLBACK");
    connection.release();
  }
}

async function insertDomains(transaction: ReservedSQL, fixtureId: string, domains: string[]): Promise<string[]> {
  const jitDomains = transaction.array(domains, "TEXT");
  const [organization] = await transaction<OrganizationDomainsRow[]>`
    INSERT INTO project_organization_array_binding (fixture_id, jit_domains)
    VALUES (${fixtureId}, ${jitDomains})
    RETURNING jit_domains
  `;
  return organization.jit_domains;
}

async function updateDomains(transaction: ReservedSQL, fixtureId: string, domains: string[]): Promise<string[]> {
  const jitDomains = transaction.array(domains, "TEXT");
  const [organization] = await transaction<OrganizationDomainsRow[]>`
    UPDATE project_organization_array_binding
    SET jit_domains = ${jitDomains}
    WHERE fixture_id = ${fixtureId}
    RETURNING jit_domains
  `;
  return organization.jit_domains;
}

afterAll(async () => {
  await database.close();
}, 30_000);

describe("project organization TEXT[] binding", () => {
  test("round trips empty, non-empty, and escaped domain arrays", async () => {
    await withRollback(async (transaction) => {
      await transaction`
        CREATE TEMPORARY TABLE project_organization_array_binding (
          fixture_id TEXT PRIMARY KEY,
          jit_domains TEXT[] NOT NULL
        ) ON COMMIT DROP
      `;

      expect(await insertDomains(transaction, "empty", [])).toEqual([]);
      expect(await insertDomains(transaction, "non-empty", ["example.com", "second.test"]))
        .toEqual(["example.com", "second.test"]);
      expect(await insertDomains(transaction, "escaped", ["comma,domain.test", "back\\slash.test"]))
        .toEqual(["comma,domain.test", "back\\slash.test"]);
      expect(await updateDomains(transaction, "empty", ["example.com", "second.test"]))
        .toEqual(["example.com", "second.test"]);
      expect(await updateDomains(transaction, "empty", [])).toEqual([]);
    });
  }, 30_000);
});
