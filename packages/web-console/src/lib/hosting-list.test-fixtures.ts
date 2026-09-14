import type { HostingDeployment } from "./hosting-list";

export function hostingDeployment(projectRef = "a", id = "dep-a"): HostingDeployment {
  return {
    id, project_ref: projectRef, name: `Site ${projectRef}`, framework: "static",
    domain: "site.example.com", custom_domains: [], status: "success",
    deployment_url: "https://site.example.com", created_at: "2026-09-09T00:00:00.000Z",
  };
}
