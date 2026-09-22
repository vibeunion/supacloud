import { expect, test } from "bun:test";
import { readLogDrains, publicLogDrain, sanitizeLogDrain, type LogDrainConfig } from "../../src/utils/log-drain-contract";

const drain = {
  id: "d1", name: "Logs", type: "webhook", url: "https://example.com/log", enabled: true, token: "synthetic-secret",
} satisfies LogDrainConfig;

test("decodes stored drain configuration without exposing arbitrary persisted fields", () => {
  for (const config of [{ log_drains: [{ ...drain, extra_secret: "hidden" }] }, JSON.stringify({ log_drains: [drain] })]) {
    expect(readLogDrains(config)).toEqual([drain]);
  }
  expect(publicLogDrain(drain)).toEqual({ ...drain, has_token: true, token: "********" });
  expect(sanitizeLogDrain({ ...drain, token: " " })).not.toHaveProperty("token");
  expect(publicLogDrain(sanitizeLogDrain({ ...drain, token: " " }))).toMatchObject({ has_token: false });
});

test("rejects malformed stored data atomically instead of silently deleting drain entries", () => {
  for (const config of ["not-json", "[]", true, [], { log_drains: {} },
    { log_drains: [drain, null] }, { log_drains: [drain, drain] }, { log_drains: new Array(1) }]) {
    expect(() => readLogDrains(config)).toThrow("Invalid stored log drain configuration");
  }
  for (const patch of [{ id: "" }, { name: " " }, { type: "other" }, { token: false }, { token: "x\r\ny" },
    { token: "\0" }, { enabled: "false" }, { url: 1 }]) {
    expect(() => readLogDrains({ log_drains: [{ ...drain, ...patch }] })).toThrow();
  }
});

test("preserves optional and false fields without fabricating defaults", () => {
  expect(readLogDrains({})).toEqual([]);
  expect(readLogDrains(null)).toEqual([]);
  const { token, ...withoutToken } = drain;
  expect(readLogDrains({ log_drains: [{ ...withoutToken, enabled: false }] })).toEqual([{ ...withoutToken, enabled: false }]);
  expect(readLogDrains({ log_drains: [withoutToken] })[0]).not.toHaveProperty("token");
  expect(sanitizeLogDrain({ ...drain, token: ` ${token} ` })).toEqual(drain);
});
