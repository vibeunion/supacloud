import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { mount, tick, unmount } from "svelte";
import Harness from "./env.test-harness.svelte";
import { page, readFixtureMutationState } from "./env.test-fixture.svelte";
import { hostingDeployment } from "../../../../../lib/hosting-list.test-fixtures";

async function eventually(assertion: () => void) {
  const deadline = performance.now() + 4000;
  let error: unknown;
  do {
    try { assertion(); return; } catch (failure) { error = failure; }
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (performance.now() < deadline);
  throw error;
}
function saveButton() {
  const heading = [...document.querySelectorAll("h3")].find(item => item.textContent?.includes("环境变量"));
  const button = [...(heading?.parentElement?.querySelectorAll("button") ?? [])]
    .find(item => item.textContent?.trim() === "保存");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Missing environment save button");
  return button;
}
const originalFetch = globalThis.fetch;
let writes = 0;
const pending = Promise.withResolvers<Response>();
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options: RequestInit = {}) => {
  const url = String(input);
  const ref = url.includes("/projects/b/") ? "b" : "a";
  if (options.method === "PUT") {
    writes++;
    strictEqual(url, "/v1/projects/a/frontend/deployments/dep-a/env");
    deepStrictEqual(JSON.parse(String(options.body)), {
      mode: "replace", expected_revision: "enc:v1:envFixture",
      env_entries: [{ name: "TOKEN", value: "********" }],
    });
    if (writes === 1) return pending.promise;
    return Response.json({});
  }
  if (url.endsWith("/tokens")) return Response.json({ project_ref: ref, deployment_id: "dep-a", tokens: [] });
  if (url.endsWith("/logs")) return Response.json({ project_ref: ref, deployment_id: "dep-a", logs: "" });
  return Response.json({
    ...hostingDeployment(ref), id: "dep-a", build_command: "", output_dir: ".",
    install_command: "", node_version: "20", env_vars: { TOKEN: "********" }, env_revision: "enc:v1:envFixture",
    configuration_revision: "enc:v1:configurationFixture",
  });
}, originalFetch);
const target = document.body.appendChild(document.createElement("div"));
const component = mount(Harness, { target });
try {
  await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
  const nameInput = document.querySelector('input[placeholder="KEY"]');
  if (!(nameInput instanceof HTMLInputElement)) throw new Error("Missing environment name input");
  for (const name of ["", "   "]) {
    nameInput.value = name;
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    saveButton().click();
    await tick();
    await eventually(() => ok(document.body.textContent?.includes("环境变量名称不能为空")));
    strictEqual(writes, 0, "An incomplete row must not become a destructive empty replacement");
    strictEqual(saveButton().disabled, false);
    strictEqual(nameInput.value, name);
  }
  nameInput.value = "TOKEN";
  nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  const previousSave = saveButton();
  page.params.ref = "b";
  previousSave.click();
  await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site b"));
  strictEqual(writes, 0, "A form must not write after switching to B before the DOM flush");
  page.params.ref = "a";
  await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
  const previousDeploymentSave = saveButton();
  page.url = new URL("http://localhost/project/a/hosting/dep-b");
  previousDeploymentSave.click();
  await tick();
  strictEqual(writes, 0, "An old deployment form must not write to the next deployment");
  page.url = new URL("http://localhost/project/a/hosting/dep-a");
  await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
  const save = saveButton();
  save.click();
  save.click();
  await eventually(() => strictEqual(writes, 1));
  await tick();
  strictEqual(saveButton().disabled, true);
  page.params.ref = "b";
  await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site b"));
  strictEqual(saveButton().disabled, true);
  page.params.ref = "a";
  await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
  pending.resolve(Response.json({
    success: true, operation: "update_env", mode: "replace",
    project_ref: "a", deployment_id: "dep-a", id: "dep-a", env_vars: { TOKEN: "********" },
    env_revision: "enc:v1:nextFixture", previous_env_revision: "enc:v1:envFixture",
  }));
  await eventually(() => strictEqual(saveButton().disabled, false));
  strictEqual(document.body.textContent?.includes("环境变量已保存"), false);
  strictEqual(writes, 1);
  saveButton().click();
  await eventually(() => ok(document.body.textContent?.includes("结果无法确认")));
  strictEqual(writes, 2);
  strictEqual(saveButton().disabled, false);
} finally {
  pending.resolve(Response.json({}));
  await unmount(component);
  target.remove();
  globalThis.fetch = originalFetch;
}

async function revisionLifecycle() {
  let serverRevision = "enc:v1:initial";
  let accepted = 0;
  let reads = 0;
  const submissions: unknown[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = String(input);
    if (options.method === "PUT") {
      strictEqual(url, "/v1/projects/a/frontend/deployments/dep-a/env");
      const body: unknown = JSON.parse(String(options.body));
      submissions.push(body);
      if (!body || typeof body !== "object" || !("expected_revision" in body)) {
        throw new Error("Missing expected revision");
      }
      if (body.expected_revision !== serverRevision) {
        return Response.json({
          code: "ENVIRONMENT_CONFLICT", message: "Environment changed; reload before saving",
          project_ref: "a", deployment_id: "dep-a", expected_revision: body.expected_revision,
        }, { status: 409 });
      }
      const previous = serverRevision;
      serverRevision = `enc:v1:accepted${++accepted}`;
      return Response.json({
        success: true, operation: "update_env", mode: "replace",
        project_ref: "a", deployment_id: "dep-a", id: "dep-a",
        env_vars: { TOKEN: "********" }, previous_env_revision: previous, env_revision: serverRevision,
      });
    }
    if (url.endsWith("/tokens")) return Response.json({ project_ref: "a", deployment_id: "dep-a", tokens: [] });
    if (url.endsWith("/logs")) return Response.json({ project_ref: "a", deployment_id: "dep-a", logs: "" });
    reads++;
    return Response.json({
      ...hostingDeployment(), id: "dep-a", build_command: "", output_dir: ".",
      install_command: "", node_version: "20", env_vars: { TOKEN: "********" }, env_revision: serverRevision,
      configuration_revision: "enc:v1:configurationFixture",
    });
  }, originalFetch);
  function valueInput() {
    const input = document.querySelector('input[placeholder="value"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing environment value input");
    return input;
  }
  async function edit(value: string) {
    const input = valueInput();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  }
  async function mounted(run: () => Promise<void>) {
    const target = document.body.appendChild(document.createElement("div"));
    const component = mount(Harness, { target });
    try {
      await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
      await run();
    } finally {
      await unmount(component);
      target.remove();
    }
  }
  try {
    await mounted(async () => {
      await edit("unsaved-local");
      serverRevision = "enc:v1:remote";
      const before = reads;
      saveButton().click();
      await eventually(() => ok(document.body.textContent?.includes("已被其他操作修改")));
      await eventually(() => ok(reads > before));
      await tick();
      strictEqual(valueInput().value, "unsaved-local");
      strictEqual(accepted, 0);
      strictEqual(submissions.length, 1, "A conflict must not retry automatically");
      saveButton().click();
      await eventually(() => strictEqual(submissions.length, 2));
      await eventually(() => strictEqual(saveButton().disabled, false));
      deepStrictEqual(submissions, Array.from({ length: 2 }, () => ({
        mode: "replace", expected_revision: "enc:v1:initial",
        env_entries: [{ name: "TOKEN", value: "unsaved-local" }],
      })));
      strictEqual(accepted, 0, "A background refetch must not rebase an old draft");
    });
    await mounted(async () => {
      await edit("saved-first");
      saveButton().click();
      await eventually(() => strictEqual(accepted, 1));
      await eventually(() => strictEqual(saveButton().disabled, false));
      ok(document.body.textContent?.includes("环境变量已保存"));
      await edit("saved-second");
      saveButton().click();
      await eventually(() => strictEqual(accepted, 2));
      await eventually(() => strictEqual(saveButton().disabled, false));
      deepStrictEqual(submissions.slice(2), [
        {
          mode: "replace", expected_revision: "enc:v1:remote",
          env_entries: [{ name: "TOKEN", value: "saved-first" }],
        },
        {
          mode: "replace", expected_revision: "enc:v1:accepted1",
          env_entries: [{ name: "TOKEN", value: "saved-second" }],
        },
      ]);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await revisionLifecycle();

async function configurationLifecycle() {
  const saveResponse = Promise.withResolvers<Response>();
  const mutations: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = String(input);
    const ref = url.includes("/projects/b/") ? "b" : "a";
    if (options.method === "PATCH" || options.method === "PUT") {
      const body: unknown = JSON.parse(String(options.body));
      mutations.push({ url, method: options.method, body });
      return saveResponse.promise;
    }
    if (url.endsWith("/tokens")) return Response.json({ project_ref: ref, deployment_id: "dep-a", tokens: [] });
    if (url.endsWith("/logs")) return Response.json({ project_ref: ref, deployment_id: "dep-a", logs: "" });
    return Response.json({
      ...hostingDeployment(ref), id: "dep-a", build_command: `build-${ref}`, output_dir: ".",
      install_command: "", node_version: "20", env_vars: {}, env_revision: "enc:v1:fixture",
      configuration_revision: "enc:v1:configurationFixture",
      git_url: `https://example.com/${ref}.git`, git_branch: "main",
    });
  }, originalFetch);
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Harness, { target });
  function configSave() {
    const heading = [...document.querySelectorAll("h3")].find(item => item.textContent?.includes("构建与 Git 配置"));
    const button = heading?.parentElement?.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing configuration save button");
    return button;
  }
  try {
    await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
    const button = configSave();
    button.click();
    button.click();
    await eventually(() => strictEqual(mutations.length, 1));
    await tick();
    strictEqual(configSave().disabled, true);
    page.params.ref = "b";
    await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site b"));
    strictEqual(configSave().disabled, true);
    deepStrictEqual(mutations, [
      {
        url: "/v1/projects/a/frontend/deployments/dep-a/configuration", method: "PUT",
        body: {
          configuration: { build_command: "build-a", output_dir: ".", install_command: "", node_version: "20", health_check_path: "/" },
          git: { url: "https://example.com/a.git", branch: "main" },
          expected_revision: "enc:v1:configurationFixture",
        },
      },
    ]);
    strictEqual(document.body.textContent?.includes("构建配置已保存"), false);
    page.params.ref = "a";
    await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
    saveResponse.resolve(Response.json({
      success: true, operation: "update_configuration", project_ref: "a", deployment_id: "dep-a", id: "dep-a",
      build_command: "build-a", output_dir: ".", install_command: "", node_version: "20", health_check_path: "/",
      git_url: "https://example.com/a.git", git_branch: "main",
      previous_configuration_revision: "enc:v1:configurationFixture", configuration_revision: "enc:v1:nextConfiguration",
    }));
    await eventually(() => strictEqual(configSave().disabled, false));
    strictEqual(document.body.textContent?.includes("构建配置已保存"), false);
  } finally {
    saveResponse.resolve(Response.json({}));
    await unmount(component);
    target.remove();
    globalThis.fetch = originalFetch;
    page.params.ref = "a";
  }
}

await configurationLifecycle();

async function configurationRevisionLifecycle() {
  let revision = "enc:v1:configInitial";
  let build = "initial-build";
  let accepted = 0;
  let reads = 0;
  let envWrites = 0;
  const submittedRevisions: unknown[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = String(input);
    if (options.method === "PUT") {
      const body: unknown = JSON.parse(String(options.body));
      if (url.endsWith("/env")) {
        deepStrictEqual(body, {
          mode: "replace", expected_revision: "enc:v1:envStable",
          env_entries: [{ name: "TOKEN", value: "********" }],
        });
        envWrites++;
        return Response.json({
          success: true, operation: "update_env", mode: "replace",
          project_ref: "a", deployment_id: "dep-a", id: "dep-a", env_vars: { TOKEN: "********" },
          previous_env_revision: "enc:v1:envStable", env_revision: "enc:v1:envNext",
        });
      }
      strictEqual(url, "/v1/projects/a/frontend/deployments/dep-a/configuration");
      if (!body || typeof body !== "object" || !("expected_revision" in body)
        || !("configuration" in body) || !body.configuration || typeof body.configuration !== "object"
        || !("build_command" in body.configuration) || typeof body.configuration.build_command !== "string") {
        throw new Error("Invalid configuration fixture input");
      }
      submittedRevisions.push(body.expected_revision);
      if (body.expected_revision !== revision) return Response.json({
        code: "CONFIGURATION_CONFLICT", message: "Configuration changed; reload before saving",
        project_ref: "a", deployment_id: "dep-a", expected_revision: body.expected_revision,
      }, { status: 409 });
      const previous = revision;
      revision = `enc:v1:configAccepted${++accepted}`;
      build = body.configuration.build_command;
      return Response.json({
        ...body.configuration, success: true, operation: "update_configuration",
        project_ref: "a", deployment_id: "dep-a", id: "dep-a",
        git_url: "https://example.com/site.git", git_branch: "main",
        previous_configuration_revision: previous, configuration_revision: revision,
      });
    }
    if (url.endsWith("/tokens")) return Response.json({ project_ref: "a", deployment_id: "dep-a", tokens: [] });
    if (url.endsWith("/logs")) return Response.json({ project_ref: "a", deployment_id: "dep-a", logs: "" });
    reads++;
    return Response.json({
      ...hostingDeployment(), build_command: build, output_dir: ".", install_command: "", node_version: "20",
      git_url: "https://example.com/site.git", git_branch: "main",
      env_vars: { TOKEN: "********" }, env_revision: envWrites ? "enc:v1:envNext" : "enc:v1:envStable",
      configuration_revision: revision,
    });
  }, originalFetch);
  function configSave() {
    const heading = [...document.querySelectorAll("h3")].find(item => item.textContent?.includes("构建与 Git 配置"));
    const button = heading?.parentElement?.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing configuration save button");
    return button;
  }
  function buildInput() {
    const input = document.querySelector('input[placeholder="npm run build"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing build command input");
    return input;
  }
  async function edit(value: string) {
    const input = buildInput();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  }
  async function mounted(run: () => Promise<void>) {
    const target = document.body.appendChild(document.createElement("div"));
    const component = mount(Harness, { target });
    try {
      await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
      await run();
    } finally {
      await unmount(component);
      target.remove();
    }
  }
  try {
    await mounted(async () => {
      await edit("local-draft");
      revision = "enc:v1:configRemote";
      build = "remote-build";
      const before = reads;
      configSave().click();
      await eventually(() => ok(document.body.textContent?.includes("构建或 Git 配置已被其他操作修改")));
      await eventually(() => ok(reads > before));
      await tick();
      strictEqual(buildInput().value, "local-draft");
      strictEqual(accepted, 0);
      strictEqual(submittedRevisions.length, 1);
      configSave().click();
      await eventually(() => strictEqual(submittedRevisions.length, 2));
      await eventually(() => strictEqual(configSave().disabled, false));
      deepStrictEqual(submittedRevisions, ["enc:v1:configInitial", "enc:v1:configInitial"]);
      strictEqual(accepted, 0);
    });
    await mounted(async () => {
      for (const [value, count] of [["first-save", 1], ["second-save", 2]] as const) {
        await edit(value);
        configSave().click();
        await eventually(() => strictEqual(accepted, count));
        await eventually(() => strictEqual(configSave().disabled, false));
      }
      saveButton().click();
      await eventually(() => strictEqual(envWrites, 1));
      await eventually(() => strictEqual(saveButton().disabled, false));
      await edit("after-env-save");
      configSave().click();
      await eventually(() => strictEqual(accepted, 3));
      await eventually(() => strictEqual(configSave().disabled, false));
      deepStrictEqual(submittedRevisions.slice(2), [
        "enc:v1:configRemote", "enc:v1:configAccepted1", "enc:v1:configAccepted2",
      ]);
      strictEqual(build, "after-env-save");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await configurationRevisionLifecycle();

async function tokenClipboardLifecycle() {
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copies: string[] = [];
  let writeClipboard: () => Promise<void> = async () => { throw new Error("clipboard-private-error"); };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (value: string) => { copies.push(value); return writeClipboard(); } },
  });
  let issued = 0;
  let holdIssue = false;
  const delayedIssue = Promise.withResolvers<void>();
  const secret = (index: number) => `supa_deploy_${index.toString(16).padStart(32, "0")}`;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = String(input);
    const ref = url.includes("/projects/b/") ? "b" : "a";
    if (options.method === "POST") {
      issued++;
      const index = issued;
      if (holdIssue) await delayedIssue.promise;
      return Response.json({
        operation: "create_token", project_ref: ref, deployment_id: "dep-a",
        id: `token-${index}`, name: "ci", token: secret(index),
      });
    }
    if (url.endsWith("/tokens")) return Response.json({ project_ref: ref, deployment_id: "dep-a", tokens: [] });
    if (url.endsWith("/logs")) return Response.json({ project_ref: ref, deployment_id: "dep-a", logs: "" });
    return Response.json({
      ...hostingDeployment(ref), id: "dep-a", build_command: "", output_dir: ".", install_command: "", node_version: "20",
      env_vars: {}, env_revision: "enc:v1:envFixture", configuration_revision: "enc:v1:configurationFixture",
    });
  }, originalFetch);
  function command(label: string) {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
    if (!button) throw new Error(`Missing token command ${label}`);
    return button;
  }
  async function issue() {
    const input = document.querySelector('input[placeholder="Token 名称 (如 github-actions)"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing token name input");
    input.value = "ci";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    command("创建").click();
    await eventually(() => strictEqual(document.querySelector("code")?.textContent, secret(issued)));
    await eventually(() => strictEqual(command("创建").disabled, false));
    strictEqual(JSON.stringify(readFixtureMutationState()).includes(secret(issued)), false,
      "One-time tokens must not enter shared mutation state");
  }
  const copied = Promise.withResolvers<void>();
  const stale = Promise.withResolvers<void>();
  const target = document.body.appendChild(document.createElement("div"));
  const component = mount(Harness, { target });
  try {
    await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
    await issue();
    command("复制并关闭").click();
    await eventually(() => ok(document.body.textContent?.includes("复制失败，令牌仍保留")));
    strictEqual(document.querySelector("code")?.textContent, secret(1));
    strictEqual(document.body.textContent?.includes("clipboard-private-error"), false);
    strictEqual(command("复制并关闭").disabled, false);
    writeClipboard = () => copied.promise;
    const copy = command("复制并关闭");
    copy.click();
    copy.click();
    await tick();
    strictEqual(command("复制并关闭").disabled, true);
    deepStrictEqual(copies, [secret(1), secret(1)]);
    strictEqual(document.querySelector("code")?.textContent, secret(1));
    copied.resolve();
    await eventually(() => strictEqual(document.querySelector("code"), null));
    strictEqual(JSON.stringify(readFixtureMutationState()).includes(secret(1)), false);
    strictEqual(document.body.textContent?.includes("复制失败，令牌仍保留"), false);
    await issue();
    writeClipboard = () => stale.promise;
    command("复制并关闭").click();
    await eventually(() => strictEqual(copies.length, 3));
    page.params.ref = "b";
    await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site b"));
    await issue();
    strictEqual(document.querySelector("code")?.textContent, secret(3));
    stale.resolve();
    await eventually(() => strictEqual(command("复制并关闭").disabled, false));
    strictEqual(document.querySelector("code")?.textContent, secret(3));
    deepStrictEqual(copies, [secret(1), secret(1), secret(2)]);
    holdIssue = true;
    const name = document.querySelector('input[placeholder="Token 名称 (如 github-actions)"]');
    if (!(name instanceof HTMLInputElement)) throw new Error("Missing token name input");
    name.value = "ci";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    command("创建").click();
    await eventually(() => strictEqual(issued, 4));
    page.params.ref = "a";
    await eventually(() => strictEqual(document.querySelector("h2")?.textContent, "Site a"));
    delayedIssue.resolve();
    await eventually(() => strictEqual(command("创建").disabled, false));
    strictEqual(document.querySelector("code"), null);
    for (let index = 1; index <= issued; index++) {
      strictEqual(JSON.stringify(readFixtureMutationState()).includes(secret(index)), false);
    }
  } finally {
    copied.resolve();
    stale.resolve();
    delayedIssue.resolve();
    await unmount(component);
    target.remove();
    globalThis.fetch = originalFetch;
    if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    page.params.ref = "a";
  }
}

await tokenClipboardLifecycle();
