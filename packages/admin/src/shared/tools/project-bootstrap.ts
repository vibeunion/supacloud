import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HttpResult, HttpTransport } from "../transports/http";

export interface ProjectBootstrapSpec {
    name: string;
    region?: string;
    organization_id?: string;
    domain?: string;
    api_domain?: string;
    auth_domain?: string;
    studio_domain?: string;
    environment?: string;
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function valueString(value: unknown, field: string, required = false): string | undefined {
    if (value === undefined || value === null || value === "") {
        if (required) throw new Error(`${field} is required in bootstrap config`);
        return undefined;
    }
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
    return value.trim();
}

function parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
        const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (!match) throw new Error("Unsupported bootstrap YAML; use simple key/value pairs");
        const value = match[2].trim();
        result[match[1].replaceAll("-", "_")] = value.replace(/^['\"]|['\"]$/g, "");
    }
    return result;
}

export async function readProjectBootstrapSpec(path: string): Promise<ProjectBootstrapSpec> {
    const resolved = resolve(path);
    if (!existsSync(resolved)) throw new Error(`Bootstrap config not found: ${resolved}`);
    const content = await readFile(resolved, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        parsed = parseSimpleYaml(content);
    }
    const value = record(parsed);
    if (!value) throw new Error("Bootstrap config must contain an object");
    const project = record(value.project) ?? value;
    return {
        name: valueString(project.name, "name", true)!,
        region: valueString(project.region, "region"),
        organization_id: valueString(project.organization_id ?? project.organizationId, "organization_id"),
        domain: valueString(project.domain, "domain"),
        api_domain: valueString(project.api_domain ?? project.apiDomain, "api_domain"),
        auth_domain: valueString(project.auth_domain ?? project.authDomain, "auth_domain"),
        studio_domain: valueString(project.studio_domain ?? project.studioDomain, "studio_domain"),
        environment: valueString(project.environment, "environment"),
    };
}

export interface BootstrapTask {
    id?: string;
    task_type?: string;
    status?: string;
    error?: string | null;
    completed_at?: string | null;
}

function taskList(data: unknown): BootstrapTask[] {
    if (!Array.isArray(data)) return [];
    return data.filter(item => item && typeof item === "object").map(item => item as BootstrapTask);
}

export function summarizeBootstrapTasks(tasks: BootstrapTask[]) {
    const provisioning = tasks.filter(task => typeof task.task_type === "string" && task.task_type.startsWith("provision_"));
    const failed = provisioning.filter(task => ["failed", "dead_lettered"].includes(String(task.status)));
    const pending = provisioning.filter(task => !["succeeded", "failed", "dead_lettered"].includes(String(task.status)));
    return {
        total: provisioning.length,
        succeeded: provisioning.filter(task => task.status === "succeeded").length,
        failed: failed.length,
        pending: pending.length,
        status: failed.length ? "failed" : pending.length ? "provisioning" : provisioning.length ? "ready" : "unknown",
        failed_tasks: failed.map(task => ({ id: task.id ?? null, task_type: task.task_type ?? null, error: task.error ?? null })),
    };
}

export async function readBootstrapTasks(http: HttpTransport, ref: string): Promise<BootstrapTask[]> {
    const response = await http.get(`/v1/projects/${encodeURIComponent(ref)}/tasks?limit=100`, { maxResponseBytes: 256 * 1024 });
    if (!response.ok) throw new Error(`Unable to read provisioning tasks (${response.status})`);
    return taskList(response.data);
}

export async function waitForBootstrap(
    http: HttpTransport,
    ref: string,
    timeoutMs: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
): Promise<BootstrapTask[]> {
    const deadline = Date.now() + timeoutMs;
    let tasks: BootstrapTask[] = [];
    while (Date.now() < deadline) {
        tasks = await readBootstrapTasks(http, ref);
        const summary = summarizeBootstrapTasks(tasks);
        if (summary.status === "ready" || summary.status === "failed") return tasks;
        await sleep(500);
    }
    return tasks;
}

export async function retryFailedBootstrapTasks(http: HttpTransport, ref: string, tasks: BootstrapTask[]): Promise<string[]> {
    const retried: string[] = [];
    for (const task of tasks) {
        if (!task.id || !["failed", "dead_lettered"].includes(String(task.status))) continue;
        const response = await http.post(`/v1/projects/${encodeURIComponent(ref)}/tasks/${encodeURIComponent(task.id)}/retry`);
        if (!response.ok) throw new Error(`Unable to retry task ${task.id} (${response.status})`);
        retried.push(task.id);
    }
    return retried;
}

export function bootstrapReceipt(
    response: HttpResult<unknown>,
    spec: ProjectBootstrapSpec,
    ref: string | null,
    tasks: BootstrapTask[],
    wait: boolean,
) {
    const summary = summarizeBootstrapTasks(tasks);
    return {
        schema: "supacloud.project-bootstrap.v1",
        operation: "project.bootstrap",
        ok: response.ok && Boolean(ref) && summary.status !== "failed",
        project_ref: ref,
        project_name: spec.name,
        environment: spec.environment ?? null,
        provisioning: summary,
        waited: wait,
        retry_safe: false,
        next: ref
            ? summary.status === "failed"
                ? [`supacloud-admin project bootstrap_reconcile --ref ${ref}`]
                : [`supacloud-admin project bootstrap_status --ref ${ref}`]
            : ["Inspect the original request outcome before creating another project"],
    };
}
