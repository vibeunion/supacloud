import { expect, test } from "bun:test";
import { parseApplicationConfigurationWrite } from "./application-configuration";

function input() {
  return {
    configuration_id: "01234567-89ab-4def-8123-456789abcdef", expected_configuration_id: null,
    configuration: { bun_version: "1.4.2", targets: [
      { name: "api", kind: "http", hosts: ["reviews.example.test"], environment: { APP_SETTING: "value" } },
      { name: "jobs", kind: "worker", hosts: [], environment: {} },
    ] },
  };
}
test("configuration parsing returns an isolated, systemd-compatible value", () => {
  const original = input(), parsed = parseApplicationConfigurationWrite(original);
  parsed.configuration.targets[0]!.environment.APP_SETTING = "changed";
  expect(original.configuration.targets[0]!.environment.APP_SETTING).toBe("value");
});
test("invalid targets, domains, identity and runtime-owned values are rejected", () => {
  for (const change of [
    (value: ReturnType<typeof input>) => { value.configuration.targets[1]!.name = "api"; },
    (value: ReturnType<typeof input>) => { value.configuration.targets[1]!.hosts = ["worker.example.test"]; },
    (value: ReturnType<typeof input>) => { value.configuration.targets[0]!.hosts = []; },
    (value: ReturnType<typeof input>) => { value.configuration.targets[0]!.hosts = ["UPPER.example.test"]; },
    (value: ReturnType<typeof input>) => { value.configuration.targets[0]!.hosts = ["*.example.test"]; },
    (value: ReturnType<typeof input>) => { value.configuration.targets[0]!.environment = { APP_SETTING: "\n" }; },
    (value: ReturnType<typeof input>) => { value.configuration_id = "../outside"; },
  ]) {
    const value = input();
    change(value);
    expect(() => parseApplicationConfigurationWrite(value)).toThrow();
  }
  for (const name of ["PORT", "NODE_OPTIONS", "SUPACLOUD_TARGET", "lowercase", "BAD-NAME"]) {
    const value = input();
    value.configuration.targets[0]!.environment = { [name]: "bad" } as { APP_SETTING: string };
    expect(() => parseApplicationConfigurationWrite(value)).toThrow();
  }
});
