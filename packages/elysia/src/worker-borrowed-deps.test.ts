import { expect, test } from "bun:test";
import { createWorker, type CompiledModule } from "./index";

test("worker resolves borrowed scoped dependencies without destroying the host resource", async () => {
  let hostDestroyed = 0, ownedDestroyed = 0;
  const dbClient = { marker: "host-database", onDestroy() { hostDestroyed++; } };
  const module: CompiledModule = {
    name: "attachments",
    controllers: [],
    jobs: [{ name: "attachments.verify", className: "AttachmentJob", serviceKey: "attachmentJob", scope: "job" }],
    createServices(deps) {
      return Object.defineProperty({
        owned: { onDestroy() { ownedDestroyed++; } },
      }, "dbClient", { value: deps.dbClient });
    },
    async createJobScope(services) {
      expect(services.dbClient).toBe(dbClient);
      return { attachmentJob: { run() { return dbClient.marker; } } };
    },
  };
  const worker = createWorker<{ id: string }, unknown>({
    modules: [module],
    deps: { dbClient },
    mapClaim: (claim) => ({ id: claim.id, jobName: "attachments.verify", input: {} }),
    transport: {
      async claim() { return null; },
      async ack(_claim, output) { return output; },
      async fail(_claim, error) { throw error; },
    },
  });
  await worker.start();
  try {
    expect(await worker.processClaim({ id: "test-claim" })).toMatchObject({
      status: "acknowledged", receipt: dbClient.marker,
    });
  } finally {
    await worker.stop();
  }
  expect(ownedDestroyed).toBe(1);
  expect(hostDestroyed).toBe(0);
});
