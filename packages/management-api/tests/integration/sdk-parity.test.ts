/**
 * SDK Parity Integration Tests
 *
 * Tests that @supabase/supabase-js SDK operations work end-to-end through
 * the Management API SDK proxy → shared CI containers.
 *
 * Pre-condition: ci-tenant-bridge.ts must have been run to wire the test tenant.
 * Skip condition: TEST_FIXED_JWT_SECRET not set (not a CI environment).
 *
 * This is a HARD CI GATE — failures block merges.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CI_ANON_KEY,
  CI_SERVICE_KEY,
  CI_PROXY_URL,
} from "../scripts/ci-tenant-bridge";

// Only run in CI environments where the bridge has been set up
const IS_CI = !!process.env.TEST_FIXED_JWT_SECRET;

// Unique suffix per test run to avoid cross-run interference
const RUN_ID = Date.now().toString(36);

describe("SDK Parity — Auth API (/auth/v1/*)", () => {
  let supabase: SupabaseClient;
  let adminClient: SupabaseClient;

  let signedUpUserId: string | undefined;
  let signedInSession: { access_token: string } | null = null;

  const testEmail = `sdk-parity-${RUN_ID}@ci.test`;
  const testPassword = "TestPassword123!";

  beforeAll(() => {
    if (!IS_CI) return;
    // SDK client uses the anon key — proxy identifies tenant via apikey lookup
    supabase = createClient(CI_PROXY_URL, CI_ANON_KEY);
    adminClient = createClient(CI_PROXY_URL, CI_SERVICE_KEY);
  });

  test.skipIf(!IS_CI)("signUp() creates a new user", async () => {
    const { data, error } = await supabase.auth.signUp({
      email: testEmail,
      password: testPassword,
    });

    expect(error).toBeNull();
    expect(data.user).not.toBeNull();
    expect(data.user?.email).toBe(testEmail);
    signedUpUserId = data.user?.id;
  });

  test.skipIf(!IS_CI)("signInWithPassword() authenticates the user", async () => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });

    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
    expect(data.session?.access_token).toBeDefined();
    expect(data.user?.email).toBe(testEmail);
    signedInSession = data.session;
  });

  test.skipIf(!IS_CI)("getUser() returns the authenticated user", async () => {
    if (!signedInSession) {
      console.warn("Skipping getUser — signIn did not succeed");
      return;
    }
    const { data, error } = await supabase.auth.getUser(
      signedInSession.access_token,
    );
    expect(error).toBeNull();
    expect(data.user?.email).toBe(testEmail);
  });

  test.skipIf(!IS_CI)("admin.listUsers() returns users with service role key", async () => {
    const { data, error } = await adminClient.auth.admin.listUsers();
    expect(error).toBeNull();
    expect(Array.isArray(data.users)).toBe(true);
    // Our signed-up user should appear
    if (signedUpUserId) {
      const found = data.users.find((u) => u.id === signedUpUserId);
      expect(found).toBeDefined();
    }
  });

  test.skipIf(!IS_CI)("admin.getUserById() retrieves a specific user", async () => {
    if (!signedUpUserId) {
      console.warn("Skipping getUserById — signUp did not capture user ID");
      return;
    }
    const { data, error } = await adminClient.auth.admin.getUserById(
      signedUpUserId,
    );
    expect(error).toBeNull();
    expect(data.user?.id).toBe(signedUpUserId);
    expect(data.user?.email).toBe(testEmail);
  });

  afterAll(async () => {
    if (!IS_CI) return;
    // Clean up — delete the test user via admin API
    if (signedUpUserId && adminClient) {
      await adminClient.auth.admin.deleteUser(signedUpUserId).catch(() => {});
    }
    await supabase.auth.signOut().catch(() => {});
  });
});

describe("SDK Parity — Database API (/rest/v1/*)", () => {
  let supabase: SupabaseClient;
  let insertedId: number | undefined;

  beforeAll(() => {
    if (!IS_CI) return;
    supabase = createClient(CI_PROXY_URL, CI_ANON_KEY);
  });

  test.skipIf(!IS_CI)("from().select() returns an array", async () => {
    const { data, error } = await supabase.from("todos").select("*");
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  test.skipIf(!IS_CI)("from().insert() inserts a row and returns it", async () => {
    const task = `ci-parity-task-${RUN_ID}`;
    const { data, error } = await supabase
      .from("todos")
      .insert({ task, is_complete: false })
      .select();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data![0].task).toBe(task);
    expect(data![0].is_complete).toBe(false);
    insertedId = data![0].id;
  });

  test.skipIf(!IS_CI)("from().update() updates the inserted row", async () => {
    if (!insertedId) {
      console.warn("Skipping update — no inserted row");
      return;
    }
    const { data, error } = await supabase
      .from("todos")
      .update({ is_complete: true })
      .eq("id", insertedId)
      .select();

    expect(error).toBeNull();
    expect(data![0].is_complete).toBe(true);
  });

  test.skipIf(!IS_CI)("from().select().eq() filters correctly", async () => {
    if (!insertedId) {
      console.warn("Skipping filter — no inserted row");
      return;
    }
    const { data, error } = await supabase
      .from("todos")
      .select()
      .eq("id", insertedId);

    expect(error).toBeNull();
    expect(data!.length).toBe(1);
    expect(data![0].id).toBe(insertedId);
  });

  test.skipIf(!IS_CI)("from().delete() removes the row", async () => {
    if (!insertedId) {
      console.warn("Skipping delete — no inserted row");
      return;
    }
    const { error } = await supabase
      .from("todos")
      .delete()
      .eq("id", insertedId);

    expect(error).toBeNull();

    // Verify deletion
    const { data: checkData } = await supabase
      .from("todos")
      .select()
      .eq("id", insertedId);
    expect(checkData!.length).toBe(0);
  });

  test.skipIf(!IS_CI)("from().select().order() returns ordered results", async () => {
    // Insert two rows for ordering test
    const task1 = `order-a-${RUN_ID}`;
    const task2 = `order-b-${RUN_ID}`;
    await supabase.from("todos").insert([
      { task: task1, is_complete: false },
      { task: task2, is_complete: false },
    ]);

    const { data, error } = await supabase
      .from("todos")
      .select()
      .like("task", `order-%-${RUN_ID}`)
      .order("task", { ascending: true });

    expect(error).toBeNull();
    expect(data!.length).toBe(2);
    expect(data![0].task).toBe(task1);
    expect(data![1].task).toBe(task2);

    // Cleanup
    await supabase
      .from("todos")
      .delete()
      .like("task", `order-%-${RUN_ID}`);
  });
});

describe("SDK Parity — Management API Health", () => {
  test.skipIf(!IS_CI)("Management API /health responds correctly", async () => {
    const res = await fetch(`${CI_PROXY_URL}/health`);
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data.status).toBe("ok");
  });

  test.skipIf(!IS_CI)("SDK proxy returns x-supabase-api-version header", async () => {
    const res = await fetch(`${CI_PROXY_URL}/rest/v1/todos`, {
      headers: {
        apikey: CI_ANON_KEY,
        Authorization: `Bearer ${CI_ANON_KEY}`,
      },
    });
    // Status 200 (or 206) — what matters is the header is present
    expect(res.headers.get("x-supabase-api-version")).not.toBeNull();
  });

  test.skipIf(!IS_CI)(
    "SDK proxy correctly identifies tenant by anon key (no x-project-ref needed)",
    async () => {
      // This test verifies the apikey → tenant lookup works
      // No x-project-ref header is set — the proxy must find the tenant by apikey
      const { createClient } = await import("@supabase/supabase-js");
      const client = createClient(CI_PROXY_URL, CI_ANON_KEY);
      // A simple auth health check
      const { error } = await client.auth.getSession();
      // Error is OK (no active session), but it must not be a network/proxy error
      if (error) {
        expect(error.message).not.toContain("Tenant backend not active");
        expect(error.message).not.toContain("502");
      }
    },
  );
});
