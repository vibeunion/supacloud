import { expect, test } from "bun:test";
import { runAppTool } from "./app-tools";

function receipt(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
const scope = { project_ref: "project-a", application_id: "reviews", environment_id: "test" };
const request = { action: "evidence" as const, ref: "project-a", id: "reviews", environment_id: "test" };

test("evidence delegates one read and explains absent evidence without claiming success", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await runAppTool(request, {
    getApplications: () => async args => {
      calls.push(args);
      return receipt({ ...scope, evidence: null });
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.["action"]).toBe("get_deployment_evidence");
  expect(result.content[0]!.text).toContain("incomplete");
  expect(result.content[0]!.text).toContain("authenticated");
});

test("JSON evidence preserves the validated delegate receipt", async () => {
  const original = receipt({ ...scope, evidence: null });
  const result = await runAppTool({ ...request, format: "json" }, { getApplications: () => async () => original });
  expect(result).toBe(original);
});

test("foreign evidence is not rendered and never starts recovery", async () => {
  let calls = 0;
  const result = await runAppTool(request, { getApplications: () => async () => {
    calls++;
    return receipt({ ...scope, project_ref: "foreign-secret", evidence: null });
  } });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).not.toContain("foreign-secret");
  expect(calls).toBe(1);
});
