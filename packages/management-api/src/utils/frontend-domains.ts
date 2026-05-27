/**
 * Scans frontend deployment directories for custom_domains.
 * Used by the Caddy on-demand TLS ask endpoint to authorize certificate issuance
 * for domains registered in frontend deployments but not present in projects.config.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const FRONTEND_BASE_DIR = "/var/supacloud/frontends";

interface DeploymentJson {
  domain?: string;
  custom_domains?: string[];
  status?: string;
}

/**
 * Returns true if the given domain appears as a `domain` or `custom_domains`
 * entry in any active frontend deployment on disk.
 */
export async function isFrontendDomain(domain: string): Promise<boolean> {
  try {
    const projectDirs = await readdir(FRONTEND_BASE_DIR, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      try {
        const deployDirs = await readdir(join(FRONTEND_BASE_DIR, entry.name), { withFileTypes: true });
        for (const deploy of deployDirs) {
          if (!deploy.isDirectory()) continue;
          try {
            const cfg: DeploymentJson = await Bun.file(
              join(FRONTEND_BASE_DIR, entry.name, deploy.name, "deployment.json"),
            ).json();
            if (cfg.status === "deleted") continue;
            if (cfg.domain === domain) return true;
            if (Array.isArray(cfg.custom_domains) && cfg.custom_domains.includes(domain)) return true;
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // base dir missing — no frontend deployments
  }
  return false;
}
