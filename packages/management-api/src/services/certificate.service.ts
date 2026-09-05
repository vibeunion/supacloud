import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { projectRepository } from "../repositories/project.repository";
import { logger } from "../utils/logger";
import { mergeProjectConfig, normalizeProjectConfig } from "../utils/project-config";
import {
  normalizeProjectRoutingConfig,
  resolveProjectApiHosts,
  resolveProjectStudioHost,
} from "../utils/project-routing";
import { normalizeFrontendCertificateDomain } from "../utils/frontend-security";
import { gatewayService } from "./gateway.service";

export type CertificateMode = "lego" | "manual";
export type CertificateChallenge = "dns-01" | "http-01";

export interface ProjectCertificateSettings {
  mode: CertificateMode;
  challenge: CertificateChallenge;
  email: string;
  dns_provider: string;
  dns_env: string[];
  domains: string[];
  auto_renew: boolean;
  status: "not_configured" | "configured" | "issued" | "deployed" | "error";
  certificate_id?: string;
  issued_at?: string;
  last_error?: string;
}

const DEFAULT_SETTINGS: ProjectCertificateSettings = {
  mode: "lego",
  challenge: "dns-01",
  email: "",
  dns_provider: "cloudflare",
  dns_env: ["CLOUDFLARE_DNS_API_TOKEN"],
  domains: [],
  auto_renew: true,
  status: "not_configured",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDomain(value: string): string {
  try {
    return normalizeFrontendCertificateDomain(value);
  } catch {
    return "";
  }
}

function normalizeDomains(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : [];
  return Array.from(new Set(input.map((item) => normalizeDomain(String(item))).filter(Boolean)));
}

function normalizeSettings(value: unknown, fallbackDomains: string[]): ProjectCertificateSettings {
  const raw = isRecord(value) ? value : {};
  const mode = raw.mode === "manual" ? "manual" : "lego";
  const challenge = raw.challenge === "http-01" ? "http-01" : "dns-01";
  const domains = normalizeDomains(raw.domains);
  const status =
    raw.status === "configured" || raw.status === "issued" || raw.status === "deployed" || raw.status === "error"
      ? raw.status
      : "not_configured";

  return {
    ...DEFAULT_SETTINGS,
    mode,
    challenge,
    email: typeof raw.email === "string" ? raw.email : "",
    dns_provider: typeof raw.dns_provider === "string" && raw.dns_provider.trim() ? raw.dns_provider.trim() : DEFAULT_SETTINGS.dns_provider,
    dns_env: Array.isArray(raw.dns_env) ? raw.dns_env.map(String).filter(Boolean) : DEFAULT_SETTINGS.dns_env,
    domains: domains.length > 0 ? domains : fallbackDomains,
    auto_renew: raw.auto_renew !== false,
    status,
    certificate_id: typeof raw.certificate_id === "string" ? raw.certificate_id : undefined,
    issued_at: typeof raw.issued_at === "string" ? raw.issued_at : undefined,
    last_error: typeof raw.last_error === "string" ? raw.last_error : undefined,
  };
}

function legoCertificateBaseName(domain: string): string {
  return domain.replace(/^\*\./, "_.");
}

async function runCommand(command: string, args: string[], env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function readLegoCertificate(acmePath: string, firstDomain: string): Promise<{ cert: string; key: string }> {
  const certDir = join(acmePath, "certificates");
  const preferred = legoCertificateBaseName(firstDomain);
  const candidates = [
    preferred,
    normalizeDomain(firstDomain),
  ];

  const files: string[] = await readdir(certDir).catch(() => [] as string[]);
  for (const base of candidates) {
    if (files.includes(`${base}.crt`) && files.includes(`${base}.key`)) {
      return {
        cert: await readFile(join(certDir, `${base}.crt`), "utf8"),
        key: await readFile(join(certDir, `${base}.key`), "utf8"),
      };
    }
  }

  const crt = files.find((file) => file.endsWith(".crt"));
  if (!crt) throw new Error(`lego certificate output not found in ${certDir}`);
  const base = crt.slice(0, -4);
  return {
    cert: await readFile(join(certDir, `${base}.crt`), "utf8"),
    key: await readFile(join(certDir, `${base}.key`), "utf8"),
  };
}

export class CertificateService {
  private fallbackDomains(ref: string, projectConfig: Record<string, unknown>): string[] {
    const routing = normalizeProjectRoutingConfig(projectConfig);
    return Array.from(new Set([
      ...resolveProjectApiHosts(ref, routing),
      resolveProjectStudioHost(ref, routing),
    ].map(normalizeDomain).filter(Boolean)));
  }

  async getSettings(ref: string): Promise<ProjectCertificateSettings | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    const projectConfig = normalizeProjectConfig(project.config);
    return normalizeSettings(projectConfig.certificate, this.fallbackDomains(ref, projectConfig));
  }

  async updateSettings(ref: string, patch: Partial<ProjectCertificateSettings>): Promise<ProjectCertificateSettings | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;
    const projectConfig = normalizeProjectConfig(project.config);
    const current = normalizeSettings(projectConfig.certificate, this.fallbackDomains(ref, projectConfig));
    const next = normalizeSettings({
      ...current,
      ...patch,
      domains: patch.domains ?? current.domains,
      status: patch.status ?? "configured",
    }, this.fallbackDomains(ref, projectConfig));

    await projectRepository.updateConfig(ref, mergeProjectConfig(project.config, { certificate: next }));
    return next;
  }

  async deployCertificate(ref: string, input: { cert: string; key: string; domains?: string[] }): Promise<{ success: boolean; settings?: ProjectCertificateSettings; error?: string }> {
    const settings = await this.getSettings(ref);
    if (!settings) return { success: false, error: "Project not found" };
    const domains = normalizeDomains(input.domains).length > 0 ? normalizeDomains(input.domains) : settings.domains;

    const result = await gatewayService.upsertCertificateForSnis({
      projectRef: ref,
      cert: input.cert,
      key: input.key,
      snis: domains,
      existingCertificateId: settings.certificate_id,
    });
    if (!result.success || !result.certificateId) {
      await this.updateSettings(ref, { ...settings, domains, status: "error", last_error: result.error || "Failed to deploy certificate" });
      return { success: false, error: result.error || "Failed to deploy certificate" };
    }

    const updated = await this.updateSettings(ref, {
      ...settings,
      mode: "manual",
      domains,
      certificate_id: result.certificateId,
      status: "deployed",
      issued_at: new Date().toISOString(),
      last_error: undefined,
    });
    return { success: true, settings: updated || undefined };
  }

  async issueWithLego(ref: string, opts: Partial<ProjectCertificateSettings> & { renew?: boolean }): Promise<{ success: boolean; settings?: ProjectCertificateSettings; output?: string; error?: string }> {
    const saved = await this.updateSettings(ref, opts);
    if (!saved) return { success: false, error: "Project not found" };
    if (!saved.email) return { success: false, error: "ACME email is required" };
    if (saved.domains.length === 0) return { success: false, error: "At least one certificate domain is required" };

    await mkdir(config.acmeStateDir, { recursive: true });
    await mkdir(config.acmeHttpWebroot, { recursive: true });

    const args = [
      "--path", config.acmeStateDir,
      "--accept-tos",
      "--email", saved.email,
      "--pem",
    ];
    for (const domain of saved.domains) {
      args.push("--domains", domain);
    }

    if (saved.challenge === "dns-01") {
      if (!saved.dns_provider) return { success: false, error: "DNS provider is required for DNS-01" };
      const missingEnv = saved.dns_env.filter((name) => !process.env[name]);
      if (missingEnv.length > 0) {
        return { success: false, error: `Missing DNS credential environment variables: ${missingEnv.join(", ")}` };
      }
      args.push("--dns", saved.dns_provider);
    } else {
      args.push("--http", "--http.webroot", config.acmeHttpWebroot);
    }
    args.push(opts.renew ? "renew" : "run");
    if (opts.renew) args.push("--days", "30");

    const command = await runCommand(config.legoBin, args, {});
    const output = `${command.stdout}\n${command.stderr}`.trim();
    if (command.exitCode !== 0) {
      logger.error("[CertificateService] lego failed", { ref, output });
      await this.updateSettings(ref, { ...saved, status: "error", last_error: output.slice(-2000) });
      return { success: false, error: output || `lego exited with ${command.exitCode}`, output };
    }

    try {
      const { cert, key } = await readLegoCertificate(config.acmeStateDir, saved.domains[0]);
      const deploy = await this.deployCertificate(ref, { cert, key, domains: saved.domains });
      if (!deploy.success) return { ...deploy, output };
      const settings = await this.updateSettings(ref, {
        ...(deploy.settings || saved),
        mode: "lego",
        challenge: saved.challenge,
        email: saved.email,
        dns_provider: saved.dns_provider,
        dns_env: saved.dns_env,
        auto_renew: saved.auto_renew,
      });
      return { success: true, settings: settings || deploy.settings, output };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateSettings(ref, { ...saved, status: "error", last_error: message });
      return { success: false, error: message, output };
    }
  }
}

export const certificateService = new CertificateService();
