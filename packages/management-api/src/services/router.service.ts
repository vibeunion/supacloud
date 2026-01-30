import { shellService } from "./shell.service";
import { config } from "../config";

export class RouterService {
  // 添加项目路由配置
  async addRoute(projectRef: string, domain?: string): Promise<{ success: boolean; error?: string }> {
    const targetDomain = domain || `${projectRef}.${config.baseDomain}`;
    const result = await shellService.execute("router_manager.sh", ["add", projectRef, targetDomain]);
    return result;
  }

  // 移除项目路由配置
  async removeRoute(projectRef: string): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("router_manager.sh", ["remove", projectRef]);
    return result;
  }

  // 重载 Nginx 配置
  async reload(): Promise<{ success: boolean; error?: string }> {
    const result = await shellService.execute("router_manager.sh", ["reload"]);
    return result;
  }

  // 获取项目域名
  getProjectDomain(projectRef: string): string {
    return `${projectRef}.${config.baseDomain}`;
  }

  // 获取项目 API URL
  getProjectApiUrl(projectRef: string): string {
    return `https://${projectRef}.api.${config.baseDomain}`;
  }

  // 获取项目 Studio URL
  getProjectStudioUrl(projectRef: string): string {
    return `https://studio-${projectRef}.${config.baseDomain}`;
  }
}

export const routerService = new RouterService();
