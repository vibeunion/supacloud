import { logger } from "../utils/logger";
import { gatewayService } from "./gateway.service";
import {
  resolveProjectBaseHost,
  resolveProjectApiHost,
  resolveProjectApiUrl,
  resolveProjectStudioHost,
  resolveProjectStudioUrl,
} from "../utils/project-routing";
import { normalizeFrontendCustomDomain } from "../utils/frontend-security";

export interface ProjectDomains {
  apiDomain: string;
  studioDomain: string;
}

export class RouterService {
  getProjectApiUrl(projectRef: string, customDomain?: string): string {
    return resolveProjectApiUrl(projectRef, { custom_domain: customDomain });
  }

  getProjectStudioUrl(projectRef: string, customDomain?: string): string {
    return resolveProjectStudioUrl(projectRef, { custom_domain: customDomain });
  }

  getProjectDomain(projectRef: string): string {
    return resolveProjectBaseHost(projectRef);
  }

  async addRoute(projectRef: string, domains?: ProjectDomains): Promise<{ success: boolean; error?: string }> {
    try {
      const apiDomain = domains?.apiDomain || resolveProjectApiHost(projectRef, null);
      const studioDomain = domains?.studioDomain || resolveProjectStudioHost(projectRef, null);
      
      // Domain registration is owned by the selected gateway provider.
      await gatewayService.addProjectDomains(projectRef, [apiDomain], [studioDomain]);

      logger.info(`Gateway routes dynamically added for ${projectRef} (api: ${apiDomain})`);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async removeRoute(projectRef: string): Promise<{ success: boolean; error?: string }> {
    try {
      await gatewayService.removeService(projectRef);
      logger.info(`Gateway routes explicitly removed for ${projectRef}`);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async bindCustomDomain(projectRef: string, customDomain: string): Promise<{ success: boolean; error?: string }> {
    try {
      const normalizedDomain = normalizeFrontendCustomDomain(customDomain);
      const apiDomain = resolveProjectApiHost(projectRef, { custom_domain: normalizedDomain });
      const studioDomain = resolveProjectStudioHost(projectRef, { custom_domain: normalizedDomain });
      await gatewayService.addProjectDomains(projectRef, [apiDomain], [studioDomain]);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async removeCustomDomain(projectRef: string, customDomain: string): Promise<{ success: boolean; error?: string }> {
    try {
      const normalizedDomain = normalizeFrontendCustomDomain(customDomain);
      const apiDomain = resolveProjectApiHost(projectRef, { custom_domain: normalizedDomain });
      const studioDomain = resolveProjectStudioHost(projectRef, { custom_domain: normalizedDomain });
      await gatewayService.removeProjectDomains(projectRef, [apiDomain], [studioDomain]);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async updateNetworkRestrictions(projectRef: string, allowedIps: string[]): Promise<{ success: boolean; error?: string }> {
    try {
      await gatewayService.setIpRestriction(projectRef, allowedIps);
      logger.info(`Gateway network IP restrictions explicitly updated for ${projectRef}`);
      return { success: true };
    } catch (error: unknown) {
        return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }
}

export const routerService = new RouterService();
