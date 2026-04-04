import { logger } from "../utils/logger";
import { config } from "../config";
import { gatewayService } from "./gateway.service";

export interface ProjectDomains {
  apiDomain: string;
  studioDomain: string;
}

export class RouterService {
  private get BASE_DOMAIN() { return config.baseDomain; }

  getProjectApiUrl(projectRef: string, customDomain?: string): string {
    return customDomain ? `https://api.${customDomain}` : `https://${projectRef}.api.${this.BASE_DOMAIN}`;
  }

  getProjectStudioUrl(projectRef: string, customDomain?: string): string {
    return customDomain ? `https://studio.${customDomain}` : `https://studio-${projectRef}.${this.BASE_DOMAIN}`;
  }

  getProjectDomain(projectRef: string): string {
    return `${projectRef}.${this.BASE_DOMAIN}`;
  }

  async addRoute(projectRef: string, domains?: ProjectDomains): Promise<{ success: boolean; error?: string }> {
    try {
      const apiDomain = domains?.apiDomain || `${projectRef}.api.${this.BASE_DOMAIN}`;
      const studioDomain = domains?.studioDomain || `studio-${projectRef}.${this.BASE_DOMAIN}`;
      
      // We map the domain through Native Kong API using GatewayService
      // This function now delegates domain registration to Kong
      await gatewayService.addProjectDomains(projectRef, [apiDomain], [studioDomain]);

      logger.info(`Kong routes dynamically added for ${projectRef} (api: ${apiDomain})`);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async removeRoute(projectRef: string): Promise<{ success: boolean; error?: string }> {
    try {
      await gatewayService.removeService(projectRef);
      logger.info(`Kong routes explicitly removed for ${projectRef}`);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async bindCustomDomain(projectRef: string, customDomain: string): Promise<{ success: boolean; error?: string }> {
    try {
      const apiDomain = `api.${customDomain}`;
      const studioDomain = `studio.${customDomain}`;
      await gatewayService.addProjectDomains(projectRef, [apiDomain], [studioDomain]);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async removeCustomDomain(projectRef: string, customDomain: string): Promise<{ success: boolean; error?: string }> {
    try {
      const apiDomain = `api.${customDomain}`;
      const studioDomain = `studio.${customDomain}`;
      await gatewayService.removeProjectDomains(projectRef, [apiDomain], [studioDomain]);
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }

  async updateNetworkRestrictions(projectRef: string, allowedIps: string[]): Promise<{ success: boolean; error?: string }> {
    try {
      await gatewayService.setIpRestriction(projectRef, allowedIps);
      logger.info(`Kong Network IP restrictions explicitly updated for ${projectRef}`);
      return { success: true };
    } catch (error: unknown) {
        return { success: false, error: (error instanceof Error ? error.message : String(error)) };
    }
  }
}

export const routerService = new RouterService();
