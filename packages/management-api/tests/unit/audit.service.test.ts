import { describe, expect, test } from "bun:test";
import { enqueueBoundedAuditEvent } from "../../src/services/audit.service";

describe("audit queue backpressure", () => {
  test("drops new events after the hard queue limit instead of growing without bound", () => {
    const queue = [{ id: 1 }, { id: 2 }];
    let drops = 0;

    expect(enqueueBoundedAuditEvent(queue, { id: 3 }, 2, () => { drops += 1; })).toBe(false);
    expect(queue).toEqual([{ id: 1 }, { id: 2 }]);
    expect(drops).toBe(1);

    queue.shift();
    expect(enqueueBoundedAuditEvent(queue, { id: 4 }, 2, () => { drops += 1; })).toBe(true);
    expect(queue).toEqual([{ id: 2 }, { id: 4 }]);
    expect(drops).toBe(1);
  });
});
