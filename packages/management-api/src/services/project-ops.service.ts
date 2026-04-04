/**
 * Project Operations Service
 *
 * Extracted from project.service.ts — handles backups, network restrictions,
 * and custom domain management.
 */
import { projectRepository } from "../repositories/project.repository";
import { shellService } from "./shell.service";
import { routerService } from "./router.service";
import { logger } from "../utils/logger";
import type { BackupResponse } from "./project.service";

export class ProjectOpsService {
  // --- Backup Management ---

  async listBackups(ref: string): Promise<BackupResponse[]> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return [];

    const result = await shellService.execute("backup_manager.sh", ["list", ref]);
    if (!result.success) return [];
    try {
      return JSON.parse(result.output);
    } catch (err: unknown) {
      logger.warn("[ProjectOpsService] Failed to parse backup list", { error: err });
      return [];
    }
  }

  async restoreBackup(ref: string, backupId: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await shellService.execute("backup_manager.sh", ["restore", ref, backupId]);
    return result.success;
  }

  // --- Network Restrictions ---

  async updateNetworkRestrictions(ref: string, allowedIps: string[]): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await routerService.updateNetworkRestrictions(ref, allowedIps);
    return result.success;
  }

  // --- Custom Domain ---

  async getCustomDomain(ref: string): Promise<{ custom_hostname: string; status: string } | null> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return null;

    const domain = project.config?.custom_domain as string | undefined;
    if (domain) {
      return { custom_hostname: domain, status: "active" };
    }
    return { custom_hostname: "", status: "not_configured" };
  }

  async bindCustomDomain(ref: string, domain: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const result = await routerService.bindCustomDomain(ref, domain);
    if (result.success) {
      await projectRepository.updateConfig(ref, { ...project.config, custom_domain: domain });
    }
    return result.success;
  }

  async deleteCustomDomain(ref: string): Promise<boolean> {
    const project = await projectRepository.findByRef(ref);
    if (!project) return false;

    const domain = project.config?.custom_domain as string | undefined;
    if (!domain) return true;

    const result = await routerService.removeCustomDomain(ref, domain);
    if (result.success) {
      const newConfig = { ...project.config };
      delete newConfig.custom_domain;
      await projectRepository.updateConfig(ref, newConfig);
    }
    return result.success;
  }
}

export const projectOpsService = new ProjectOpsService();
