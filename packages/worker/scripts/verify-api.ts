const base = process.env.SUPACLOUD_API_URL ?? "http://127.0.0.1:9090";
const project = process.env.SUPACLOUD_PROJECT_REF;
const run = process.env.PGFLOW_ACCEPTANCE_RUN;
const token = process.env.SUPACLOUD_API_TOKEN ?? process.env.MASTER_TOKEN;
if (!project || !run || !token) throw new Error("API_ACCEPTANCE_CONFIG_REQUIRED");
const path = `/v1/projects/${encodeURIComponent(project)}/tasks`;
async function call(suffix: string, authenticated = true, method = "GET") {
  return fetch(base + path + suffix, {
    method, headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
  });
}
const denied = await call("?task_type=pgflow", false);
if (![401,403].includes(denied.status)) throw new Error("ANONYMOUS_TASK_ACCESS_NOT_DENIED");
const list = await call("?task_type=pgflow");
const tasks: unknown = await list.json();
if (!list.ok || !Array.isArray(tasks) || !tasks.some((task: unknown) =>
  task !== null && typeof task === "object" && "id" in task && task.id === `pgflow:${run}`))
  throw new Error("PGFLOW_LIST_ACCEPTANCE_FAILED");
const detail = await call(`/pgflow:${run}`);
const task: unknown = await detail.json();
if (!detail.ok || !task || typeof task !== "object" || !("status" in task) || task.status !== "succeeded")
  throw new Error("PGFLOW_DETAIL_ACCEPTANCE_FAILED");
for (const action of ["cancel", "retry"]) {
  const response = await call(`/pgflow:${run}/${action}`, true, "POST");
  if (response.status !== 409) throw new Error("UNSUPPORTED_ACTION_NOT_REJECTED");
}
console.log(JSON.stringify({ project, run, list: list.status, detail: detail.status, anonymous: denied.status, unsupportedActions: 409 }));
