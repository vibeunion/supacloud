import { expect, test } from "bun:test";

function object(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Expected workflow object");
  }
  return candidate as Record<string, unknown>;
}

async function jobs() {
  const contents = await Bun.file(new URL("../../../../.github/workflows/management-api.yml", import.meta.url)).text();
  return object(object(Bun.YAML.parse(contents)).jobs);
}

test("public integration fixtures initialize without unavailable fork PR secrets", async () => {
  const integration = object((await jobs())["integration-test"]);
  const services = object(integration.services);
  for (const [name, image] of [
    ["postgres", "supabase/postgres:17.6.1.177"],
    ["postgrest", "postgrest/postgrest:v16.4"],
    ["gotrue", "supabase/gotrue:v2.197.0"],
  ]) {
    const service = object(services[name!]);
    expect(service.image).toBe(image);
    expect(service.credentials).toBeUndefined();
    expect(service.env).toBeDefined();
  }
  expect(integration.if).toBeUndefined();
});

test("integration remains a required hard gate rather than an optional fork job", async () => {
  const workflowJobs = await jobs();
  const required = object(workflowJobs["required-checks"]);
  expect(required.needs).toContain("integration-test");
  expect(required.if).toBe("${{ always() }}");
  const steps = required.steps;
  if (!Array.isArray(steps)) throw new Error("Expected required check steps");
  const verification = steps.map(object).find(step => step.name === "Verify required jobs");
  if (!verification) throw new Error("Required verification step missing");
  expect(object(verification.env).INTEGRATION_TESTS).toBe("${{ needs.integration-test.result }}");
  expect(verification.run).toContain('"$INTEGRATION_TESTS"');
  expect(verification.run).toContain('if [[ "$result" != "success" ]]');
});
