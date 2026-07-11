import { config } from "../config";
import { sql } from "../db";
import {
  isCaddyRouteDomain,
  isCaddyTlsBlockedDomain,
  isValidCaddyDomain,
  normalizeCaddyHost,
} from "../utils/caddy-domains";
import { isFrontendDomain as isRegisteredFrontendDomain } from "../utils/frontend-domains";
import {
  normalizeProjectRoutingConfig,
  normalizeBaseDomain,
  resolveProjectApiHosts,
  resolveProjectAuthHost,
  resolveProjectStudioHost,
} from "../utils/project-routing";

type ProjectDomainRecord = {
  ref: string;
  config: unknown;
};

export type CaddyDomainAuthorization =
  | { allowed: true; status: 200; domain: string; reason: "platform" | "project" | "frontend" | "persisted_route" }
  | { allowed: false; status: 400 | 403 | 429; domain: string; reason: "invalid" | "blocked" | "not_registered" | "quota_exceeded"; retryAfterSeconds?: number };

type CaddyDomainAllowlistOptions = {
  baseDomain?: string;
  blockedDomains?: string[];
  loadProjects?: () => Promise<ProjectDomainRecord[]>;
  isPersistedRouteDomain?: (domain: string) => Promise<boolean>;
  isFrontendDomain?: (domain: string) => Promise<boolean>;
  unknownDomainLimit?: number;
  unknownGlobalLimit?: number;
  unknownDomainWindowMs?: number;
  now?: () => number;
};

type UnknownDomainBucket = {
  count: number;
  resetAt: number;
};

async function loadActiveProjects(): Promise<ProjectDomainRecord[]> {
  const rows = await sql`
    SELECT ref, config
    FROM projects
    WHERE status != 'deleted' AND deleted_at IS NULL
  `;
  return rows as unknown as ProjectDomainRecord[];
}

function addDomain(domains: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const normalized = normalizeCaddyHost(value);
  if (isValidCaddyDomain(normalized)) domains.add(normalized);
}

function projectDomains(project: ProjectDomainRecord, baseDomain: string): Set<string> {
  const domains = new Set<string>();
  const routing = normalizeProjectRoutingConfig(project.config);
  addDomain(domains, `${project.ref}.${baseDomain}`);
  addDomain(domains, `${project.ref}.api.${baseDomain}`);
  addDomain(domains, `studio-${project.ref}.${baseDomain}`);
  for (const host of resolveProjectApiHosts(project.ref, routing)) addDomain(domains, host);
  addDomain(domains, resolveProjectAuthHost(project.ref, routing));
  addDomain(domains, resolveProjectStudioHost(project.ref, routing));
  return domains;
}

export function createCaddyDomainAllowlistService(options: CaddyDomainAllowlistOptions = {}) {
  const baseDomain = normalizeBaseDomain(
    normalizeCaddyHost(options.baseDomain ?? config.baseDomain),
  );
  const blockedDomains = options.blockedDomains ?? config.caddyTlsBlockedDomains;
  const loadProjects = options.loadProjects ?? loadActiveProjects;
  const isPersistedRouteDomain = options.isPersistedRouteDomain ?? isCaddyRouteDomain;
  const isFrontendDomain = options.isFrontendDomain ?? isRegisteredFrontendDomain;
  const unknownDomainLimit = Math.max(1, options.unknownDomainLimit ?? 20);
  const unknownGlobalLimit = Math.max(1, options.unknownGlobalLimit ?? 200);
  const unknownDomainWindowMs = Math.max(1, options.unknownDomainWindowMs ?? 60_000);
  const now = options.now ?? Date.now;
  const unknownDomainBuckets = new Map<string, UnknownDomainBucket>();
  let globalUnknownBucket: UnknownDomainBucket | null = null;

  function ensureGlobalBucket(timestamp: number): UnknownDomainBucket {
    if (!globalUnknownBucket || globalUnknownBucket.resetAt <= timestamp) {
      globalUnknownBucket = { count: 0, resetAt: timestamp + unknownDomainWindowMs };
      // Unknown domains are useful only for the active quota window. Clearing
      // them prevents an attacker rotating hostnames from growing this map forever.
      unknownDomainBuckets.clear();
    }
    return globalUnknownBucket;
  }

  function unknownDomainQuota(domain: string): { limited: boolean; retryAfterSeconds?: number } {
    const timestamp = now();
    const globalBucket = ensureGlobalBucket(timestamp);
    if (globalBucket.count >= unknownGlobalLimit) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((globalBucket.resetAt - timestamp) / 1000)),
      };
    }

    const current = unknownDomainBuckets.get(domain);
    if (!current || current.resetAt <= timestamp) return { limited: false };
    if (current.count >= unknownDomainLimit) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - timestamp) / 1000)),
      };
    }
    return { limited: false };
  }

  function recordUnknownDomain(domain: string): void {
    const timestamp = now();
    ensureGlobalBucket(timestamp).count += 1;
    const current = unknownDomainBuckets.get(domain);
    if (!current || current.resetAt <= timestamp) {
      unknownDomainBuckets.set(domain, { count: 1, resetAt: timestamp + unknownDomainWindowMs });
      return;
    }
    current.count += 1;
  }

  return {
    async authorize(rawDomain: string): Promise<CaddyDomainAuthorization> {
      const domain = normalizeCaddyHost(rawDomain);
      if (!isValidCaddyDomain(domain)) {
        return { allowed: false, status: 400, domain, reason: "invalid" };
      }
      if (isCaddyTlsBlockedDomain(domain, blockedDomains)) {
        return { allowed: false, status: 403, domain, reason: "blocked" };
      }
      if (domain === baseDomain || domain === `api.${baseDomain}`) {
        return { allowed: true, status: 200, domain, reason: "platform" };
      }
      if (await isPersistedRouteDomain(domain)) {
        return { allowed: true, status: 200, domain, reason: "persisted_route" };
      }
      if (await isFrontendDomain(domain)) {
        return { allowed: true, status: 200, domain, reason: "frontend" };
      }

      const projects = await loadProjects();
      for (const project of projects) {
        if (projectDomains(project, baseDomain).has(domain)) {
          return { allowed: true, status: 200, domain, reason: "project" };
        }
      }

      // Quotas apply only after every authoritative registration source has
      // rejected the hostname. Otherwise an attacker could exhaust the global
      // unknown-domain bucket and temporarily block a newly registered custom
      // domain from obtaining its first certificate.
      const quota = unknownDomainQuota(domain);
      if (quota.limited) {
        return {
          allowed: false,
          status: 429,
          domain,
          reason: "quota_exceeded",
          retryAfterSeconds: quota.retryAfterSeconds,
        };
      }
      recordUnknownDomain(domain);
      return { allowed: false, status: 403, domain, reason: "not_registered" };
    },
  };
}

export const caddyDomainAllowlistService = createCaddyDomainAllowlistService();
