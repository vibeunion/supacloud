import { expect, test } from "bun:test";
import "./deno-compat";

test("Deno.openKv does not retain cache data in the shared Worker process", async () => {
  await expect((globalThis as any).Deno.openKv()).rejects.toThrow(
    "use the request-scoped SupaCloud.pgredis binding",
  );
});
