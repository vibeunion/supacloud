import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { createBunCommandHost } from "./command-bun";

test("Bun command host keeps pool shutdown outside the application database", async () => {
  let closed = false;
  const sql = {
    close: async () => { closed = true; },
  } as unknown as SQL;
  const host = createBunCommandHost(sql);

  expect(host.database).toBeDefined();
  expect(closed).toBe(false);
  await host.close();
  expect(closed).toBe(true);
});
