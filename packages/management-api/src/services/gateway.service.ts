import { shellService } from './shell.service';

export interface GatewayConfig {
    rateLimitTier?: 'free' | 'pro' | 'enterprise';
    corsOrigins?: string;
    jwtEnabled?: boolean;
    jwtSecret?: string;
}

export class GatewayService {
    /**
     * 为项目初始化网关配置
     */
    static async setupProject(projectRef: string, jwtSecret: string): Promise<boolean> {
        const { success, error } = await shellService.execute('gateway_manager.sh', ['setup-project', projectRef, jwtSecret]);
        if (!success) {
            console.error(`Failed to setup gateway for ${projectRef}:`, error);
            return false;
        }
        return true;
    }

    /**
     * 更新限流策略
     */
    static async setRateLimit(projectRef: string, tier: string): Promise<boolean> {
        const { success, error } = await shellService.execute('gateway_manager.sh', ['set-rate-limit', projectRef, tier]);
        if (!success) {
            console.error(`Failed to set rate limit for ${projectRef}:`, error);
            return false;
        }
        return true;
    }

    /**
     * 更新跨域配置
     */
    static async setCors(projectRef: string, origins: string): Promise<boolean> {
        const { success, error } = await shellService.execute('gateway_manager.sh', ['set-cors', projectRef, origins]);
        if (!success) {
            console.error(`Failed to set CORS for ${projectRef}:`, error);
            return false;
        }
        return true;
    }

    /**
     * 启用 JWT 验证
     */
    static async enableJwtAuth(projectRef: string): Promise<boolean> {
        const { success, error } = await shellService.execute('gateway_manager.sh', ['enable-jwt', projectRef]);
        if (!success) {
            console.error(`Failed to enable JWT for ${projectRef}:`, error);
            return false;
        }
        return true;
    }

    /**
     * 统一应用网关配置
     */
    static async applyConfig(projectRef: string, config: GatewayConfig): Promise<{ success: boolean; message: string }> {
        if (config.jwtSecret) {
            await this.setupProject(projectRef, config.jwtSecret);
        }

        if (config.rateLimitTier) {
            await this.setRateLimit(projectRef, config.rateLimitTier);
        }

        if (config.corsOrigins) {
            await this.setCors(projectRef, config.corsOrigins);
        }

        if (config.jwtEnabled) {
            await this.enableJwtAuth(projectRef);
        }

        return { success: true, message: "网关配置已更新" };
    }
}
