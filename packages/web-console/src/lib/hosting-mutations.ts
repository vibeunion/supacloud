import { apiClient, ensureMutationSucceeded } from "./api";

type HostingMutation =
  | { operation: "redeploy" }
  | { operation: "delete_deployment" }
  | { operation: "remove_domain"; domain: string }
  | { operation: "delete_token"; tokenId: string };

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function hostingReceipt(
  projectRef: string, deploymentId: string, mutation: HostingMutation,
): (value: unknown) => void {
  const expected = { ...mutation };
  if (!SAFE_ID.test(projectRef) || !SAFE_ID.test(deploymentId)
    || expected.operation === "delete_token" && !SAFE_ID.test(expected.tokenId)
    || expected.operation === "remove_domain" && (
      !expected.domain || expected.domain.length > 253 || /[\s/\\?#]/.test(expected.domain)
    )) throw new Error("Invalid hosting mutation");
  return (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hosting receipt");
    const data: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    if (data.success !== true || data.project_ref !== projectRef || data.deployment_id !== deploymentId
      || data.operation !== expected.operation) throw new Error("Invalid hosting receipt");
    switch (expected.operation) {
      case "delete_deployment": return;
      case "delete_token":
        if (data.token_id !== expected.tokenId) throw new Error("Invalid hosting receipt");
        return;
      case "remove_domain":
        if (data.domain !== expected.domain || data.id !== deploymentId || !Array.isArray(data.custom_domains)
          || !data.custom_domains.every((domain: unknown) => typeof domain === "string")
          || data.custom_domains.some((domain: string) => domain.toLowerCase() === expected.domain.toLowerCase())) {
          throw new Error("Invalid hosting receipt");
        }
        return;
      case "redeploy": {
        if (typeof data.url !== "string" || typeof data.build_log !== "string"
          || data.error !== undefined) throw new Error("Invalid hosting receipt");
        const url = new URL(data.url);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Invalid hosting receipt");
      }
    }
  };
}

export async function runHostingMutation(
  projectRef: string | undefined, deploymentId: string, mutation: HostingMutation,
  options: Pick<RequestInit, "signal"> = {},
): Promise<void> {
  if (!projectRef) throw new Error("Missing hosting project");
  const captured = { ...mutation };
  const requestOptions = { ...options };
  const decode = hostingReceipt(projectRef, deploymentId, captured);
  const suffix = captured.operation === "redeploy" ? "/redeploy"
    : captured.operation === "remove_domain" ? `/domains/${encodeURIComponent(captured.domain)}`
    : captured.operation === "delete_token" ? `/tokens/${encodeURIComponent(captured.tokenId)}` : "";
  const response = await apiClient(
    `/v1/projects/${projectRef}/frontend/deployments/${deploymentId}${suffix}`,
    { ...requestOptions, method: captured.operation === "redeploy" ? "POST" : "DELETE",
      timeoutMs: captured.operation === "redeploy" ? 5 * 60 * 1000 : 15_000 },
  );
  await ensureMutationSucceeded(response, "Hosting operation could not be confirmed", decode, requestOptions);
}
