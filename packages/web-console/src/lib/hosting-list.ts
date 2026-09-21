import { requestValidatedJson } from "./validated-json";

const frameworks = ["static", "react", "vue", "svelte", "nextjs", "nuxt", "sveltekit", "sveltekit-static", "astro", "remix"] as const;
const statuses = ["pending", "building", "success", "failed"] as const;

export interface HostingDeployment {
  id: string;
  project_ref: string;
  name: string;
  framework: typeof frameworks[number];
  domain: string;
  custom_domains: string[];
  status: typeof statuses[number];
  deployment_url: string;
  created_at: string;
  git_url?: string;
  git_branch?: string;
  last_deployed_at?: string;
}

function invalid(): never { throw new Error("Invalid hosting list response"); }
export function isHostingId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
function text(value: unknown, max = 4096): string {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) return invalid();
  return result;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  for (const candidate of values) if (value === candidate) return candidate;
  return invalid();
}
function domain(value: unknown): string {
  const result = text(value, 253);
  if (!result || !result.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return invalid();
  return result;
}
function publicUrl(value: unknown): string {
  const result = text(value);
  try {
    const url = new URL(result);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /\s|\\/.test(result)) return invalid();
    return result;
  } catch { return invalid(); }
}

export function parseHostingList(value: unknown, projectRef: string): HostingDeployment[] {
  if (!isHostingId(projectRef)) return invalid();
  const envelope = record(value);
  if (!Array.isArray(envelope.deployments) || envelope.deployments.length > 10_000) return invalid();
  const ids = new Set<string>();
  return envelope.deployments.map((value: unknown): HostingDeployment => {
    const row = record(value);
    if (!isHostingId(row.id) || ids.has(row.id) || row.project_ref !== projectRef) return invalid();
    ids.add(row.id);
    const name = text(row.name, 100);
    if (!name.trim() || !Array.isArray(row.custom_domains) || row.custom_domains.length > 1000) return invalid();
    const customDomains = row.custom_domains.map(domain);
    if (new Set(customDomains.map(value => value.toLowerCase())).size !== customDomains.length) return invalid();
    return {
      id: row.id, project_ref: projectRef, name,
      framework: choice(row.framework, frameworks), status: choice(row.status, statuses),
      domain: domain(row.domain), custom_domains: customDomains,
      deployment_url: publicUrl(row.deployment_url), created_at: timestamp(row.created_at),
      ...(row.git_url === undefined ? {} : { git_url: text(row.git_url) }),
      ...(row.git_branch === undefined ? {} : { git_branch: text(row.git_branch) }),
      ...(row.last_deployed_at === undefined ? {} : { last_deployed_at: timestamp(row.last_deployed_at) }),
    };
  });
}

export async function loadHostingList(
  projectRef: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<HostingDeployment[]> {
  if (!isHostingId(projectRef)) throw new Error("Missing hosting project");
  return requestValidatedJson(
    `/v1/projects/${projectRef}/frontend/deployments`,
    request, value => parseHostingList(value, projectRef), { signal },
  );
}
