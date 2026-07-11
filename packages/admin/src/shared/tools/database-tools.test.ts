import { describe, expect, test } from "bun:test";
import { registerDatabaseTools } from "./database-tools";

function captureDatabaseTool(http: Record<string, unknown>) {
  let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
  registerDatabaseTools({
    tool(name: string, _description: string, _schema: Record<string, unknown>, toolCallback: typeof callback) {
      if (name === "database") callback = toolCallback;
    },
  }, http as never);
  if (!callback) throw new Error("database tool was not registered");
  return callback;
}

describe("Admin database RLS helper", () => {
  test("defaults to deny-all and supports explicit auth.uid owner policies", async () => {
    const posts: Array<{ body: { sql?: string } }> = [];
    const callback = captureDatabaseTool({
      post: async (_path: string, body: { sql?: string }) => {
        posts.push({ body });
        return { ok: true, status: 200, data: { rows: [] } };
      },
    });

    const denyResult = await callback({
      action: "create_table_rls",
      ref: "proj",
      table: "todos",
      columns: "id uuid primary key, owner_id uuid not null",
    });
    expect(denyResult.content[0]?.text).toContain("deny-all");
    expect(posts[0]?.body.sql).not.toContain("USING (true)");

    const ownerResult = await callback({
      action: "create_table_rls",
      ref: "proj",
      table: "todos",
      columns: "id uuid primary key, owner_id uuid not null",
      policy_mode: "owner",
      owner_column: "owner_id",
    });
    expect(ownerResult.content[0]?.text).toContain("owner policy");
    expect(posts[1]?.body.sql).toContain('FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL AND auth.uid() = "owner_id")');
    expect(posts[1]?.body.sql).toContain('DROP POLICY IF EXISTS "SupaCloud owner select"');
  });
});
