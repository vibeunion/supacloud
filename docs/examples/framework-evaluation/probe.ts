import "reflect-metadata";
import { strict as assert } from "node:assert";
import { Elysia } from "elysia";

// Keep import/bootstrap failures inside each probe so both candidates are measured.
const probes = {
  async native() {
    return new Elysia().get("/probe", () => ({ ok: true }));
  },
  async nestelia() {
    const { Controller, Get, Module, createElysiaApplication } = await import("nestelia");
    @Controller("/")
    class ProbeController {
      @Get("/probe")
      read() { return { ok: true }; }
    }
    @Module({ controllers: [ProbeController] })
    class ProbeModule {}
    return await createElysiaApplication(ProbeModule);
  },
  async aponia() {
    const { Controller, Get, Module } = await import("@aponiajs/common");
    const { AponiaFactory } = await import("@aponiajs/platform-elysia");
    @Controller("/")
    class ProbeController {
      @Get("/probe")
      read() { return { ok: true }; }
    }
    @Module({ controllers: [ProbeController] })
    class ProbeModule {}
    return await AponiaFactory.create(ProbeModule, { logger: false });
  },
};

let failed = false;
for (const [candidate, create] of Object.entries(probes)) {
  let stage = "bootstrap";
  try {
    const app = await create();
    stage = "request";
    const response = await app.handle(new Request("http://localhost/probe"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    console.log(JSON.stringify({ candidate, status: "passed", stage, bun: Bun.version }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({
      candidate, status: "failed", stage, bun: Bun.version,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));
  }
}
process.exitCode = failed ? 1 : 0;
