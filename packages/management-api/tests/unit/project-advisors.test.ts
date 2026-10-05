import { expect, test } from "bun:test";
import { advisorErrorRate } from "../../src/routes/project-advisors";
import type { VictoriaProjectLog } from "../../src/services/victorialogs.service";

const log = (service: string, status?: number): VictoriaProjectLog => ({
  id: crypto.randomUUID(), service, timestamp: "2026-10-05T00:00:00Z", severity: "error",
  event_message: "error mentioned in diagnostic", metadata: status === undefined ? {} : { http_status: status },
});
test("health advisors distinguish request error rates from log severity and missing telemetry", () => {
  for (const service of ["data_api", "auth", "storage", "edge_functions"] as const) {
    expect(advisorErrorRate(service, null).status).toBe("unknown");
    expect(advisorErrorRate(service, [log(service)]).error_rate).toBe(null);
    const rows = [log(service, 200), log(service, 500), log(service, 401), log(service)];
    const result = advisorErrorRate(service, rows);
    expect(result.observations).toBe(3);
    expect(result.errors).toBe(1);
    expect(result.status).toBe("warning");
    expect(advisorErrorRate(service, [log(service, 200)]).status).toBe("ok");
    expect(advisorErrorRate(service, Array.from({ length: 1000 }, () => log(service, 200))).status).toBe("unknown");
  }
});
