/**
 * Tenant OAuth Service
 *
 * Extracted from tenant-runtime.service.ts — handles GoTrue OAuth provider
 * configuration management (update, remove, custom providers).
 */
import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OAuthProvider, OAuthProviderConfig } from "../types/oauth";
import { OAUTH_ENV_MAPPINGS } from "../types/oauth";

export class TenantOAuthService {
    private readonly TENANT_CONFIG_DIR = config.tenantConfigDir;

    private gotrueConfigDir(ref: string): string {
        return path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.d`);
    }

    private gotrueRuntimeEnvPath(ref: string): string {
        return path.join(this.gotrueConfigDir(ref), "runtime.env");
    }

    private gotrueLegacyEnvPath(ref: string): string {
        return path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`);
    }

    private async readGoTrueEnv(ref: string): Promise<string> {
        const runtimeEnvPath = this.gotrueRuntimeEnvPath(ref);
        if (await Bun.file(runtimeEnvPath).exists()) {
            return Bun.file(runtimeEnvPath).text();
        }

        const legacyEnvPath = this.gotrueLegacyEnvPath(ref);
        if (await Bun.file(legacyEnvPath).exists()) {
            return Bun.file(legacyEnvPath).text();
        }

        throw new Error(`GoTrue config file not found for project ${ref}`);
    }

    private async writeGoTrueEnv(ref: string, content: string): Promise<void> {
        await fs.mkdir(this.gotrueConfigDir(ref), { recursive: true });
        await Bun.write(this.gotrueRuntimeEnvPath(ref), content);
        // Keep the legacy flat env file in sync for older units and diagnostics.
        await Bun.write(this.gotrueLegacyEnvPath(ref), content);
    }

    private async reloadAndPollGoTrue(ref: string, message: string): Promise<void> {
        const reloadResult = await $`systemctl reload supacloud-gotrue@${ref}`.nothrow().quiet();
        if (reloadResult.exitCode !== 0) {
            await $`systemctl restart supacloud-gotrue@${ref}`.nothrow().quiet();
        }
        logger.info(message);

        try {
            const { tenantRuntimeService } = await import("./tenant-runtime.service");
            // Poll for up to 15 seconds for GoTrue to become healthy
            for (let i = 0; i < 15; i++) {
                await Bun.sleep(1000);
                const status = await tenantRuntimeService.checkStatus(ref);
                if (status.health === "healthy" || status.health === "degraded") {
                    logger.info(`GoTrue for ${ref} is back online.`);
                    return;
                }
            }
            logger.warn(`GoTrue for ${ref} did not return healthy status within 15 seconds.`);
        } catch (err: unknown) {
            logger.debug(`Suppressed error while polling GoTrue health for ${ref}`, { error: err });
        }
    }

    async updateOAuthConfig(ref: string, provider: OAuthProvider, providerConfig: OAuthProviderConfig): Promise<void> {
        const envContent = await this.readGoTrueEnv(ref);

        const mapping = OAUTH_ENV_MAPPINGS[provider];
        if (!mapping) {
            throw new Error(`Unsupported OAuth provider: ${provider}`);
        }

        const lines = envContent.split("\n");
        const updatedLines: string[] = [];
        const addedKeys = new Set<string>();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                updatedLines.push(line);
                continue;
            }

            const enabledKey = `GOTRUE_EXTERNAL_${provider.toUpperCase()}_ENABLED`;

            const [key] = trimmed.split("=");
            const keyTrimmed = key?.trim();

            if (keyTrimmed === mapping.clientId) {
                updatedLines.push(`${mapping.clientId}=${providerConfig.client_id}`);
                addedKeys.add(mapping.clientId);
            } else if (keyTrimmed === enabledKey) {
                updatedLines.push(`${enabledKey}=true`);
                addedKeys.add(enabledKey);
            } else if (keyTrimmed === mapping.clientSecret) {
                updatedLines.push(`${mapping.clientSecret}=${providerConfig.client_secret}`);
                addedKeys.add(mapping.clientSecret);
            } else if (mapping.redirectUri && keyTrimmed === mapping.redirectUri) {
                if (providerConfig.redirect_uri) {
                    updatedLines.push(`${mapping.redirectUri}=${providerConfig.redirect_uri}`);
                }
                addedKeys.add(mapping.redirectUri);
            } else if (mapping.url && keyTrimmed === mapping.url) {
                if (providerConfig.url) {
                    updatedLines.push(`${mapping.url}=${providerConfig.url}`);
                }
                addedKeys.add(mapping.url);
            } else {
                updatedLines.push(line);
            }
        }

        const newLines: string[] = [];
        const enabledKeyNew = `GOTRUE_EXTERNAL_${provider.toUpperCase()}_ENABLED`;
        if (!addedKeys.has(enabledKeyNew)) {
            newLines.push(`${enabledKeyNew}=true`);
        }
        if (!addedKeys.has(mapping.clientId)) {
            newLines.push(`${mapping.clientId}=${providerConfig.client_id}`);
        }
        if (!addedKeys.has(mapping.clientSecret)) {
            newLines.push(`${mapping.clientSecret}=${providerConfig.client_secret}`);
        }
        if (mapping.redirectUri && providerConfig.redirect_uri && !addedKeys.has(mapping.redirectUri)) {
            newLines.push(`${mapping.redirectUri}=${providerConfig.redirect_uri}`);
        }
        if (mapping.url && providerConfig.url && !addedKeys.has(mapping.url)) {
            newLines.push(`${mapping.url}=${providerConfig.url}`);
        }

        if (newLines.length > 0) {
            updatedLines.push("");
            updatedLines.push(`# OAuth Provider: ${provider}`);
            updatedLines.push(...newLines);
        }

        await this.writeGoTrueEnv(ref, updatedLines.join("\n"));
        await this.reloadAndPollGoTrue(ref, `OAuth config updated for ${provider} in project ${ref}`);
    }

    async removeOAuthConfig(ref: string, provider: OAuthProvider): Promise<void> {
        let envContent: string;
        try {
            envContent = await this.readGoTrueEnv(ref);
        } catch {
            return;
        }

        const mapping = OAUTH_ENV_MAPPINGS[provider];
        if (!mapping) {
            throw new Error(`Unsupported OAuth provider: ${provider}`);
        }

        const enabledKey = `GOTRUE_EXTERNAL_${provider.toUpperCase()}_ENABLED`;
        const keysToRemove = new Set<string>([mapping.clientId, mapping.clientSecret, enabledKey]);
        if (mapping.redirectUri) keysToRemove.add(mapping.redirectUri);
        if (mapping.url) keysToRemove.add(mapping.url);

        const lines = envContent.split("\n");
        const updatedLines: string[] = [];
        let wroteDisabledFlag = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                updatedLines.push(line);
                continue;
            }
            const [key] = trimmed.split("=");
            const keyTrimmed = key?.trim();
            if (keyTrimmed === enabledKey) {
                updatedLines.push(`${enabledKey}=false`);
                wroteDisabledFlag = true;
                continue;
            }
            if (keyTrimmed && keysToRemove.has(keyTrimmed)) continue;
            updatedLines.push(line);
        }

        if (!wroteDisabledFlag) {
            updatedLines.push("");
            updatedLines.push(`# OAuth Provider: ${provider}`);
            updatedLines.push(`${enabledKey}=false`);
        }

        await this.writeGoTrueEnv(ref, updatedLines.join("\n"));
        await this.reloadAndPollGoTrue(ref, `OAuth config removed for ${provider} in project ${ref}`);
    }

    async updateGoTrueCustomOAuth(ref: string, oauthConfig: {
        name: string;
        client_id: string;
        client_secret: string;
        redirect_uri: string;
        authorize_url: string;
        token_url: string;
        user_url: string;
        auth_scheme?: string;
    }): Promise<void> {
        const envContent = await this.readGoTrueEnv(ref);

        const prefix = `GOTRUE_EXTERNAL_${oauthConfig.name.toUpperCase()}`;
        const customOAuthEnv = `
# Custom OAuth Provider: ${oauthConfig.name}
${prefix}_ENABLED=true
${prefix}_CLIENT_ID=${oauthConfig.client_id}
${prefix}_SECRET=${oauthConfig.client_secret}
${prefix}_REDIRECT_URI=${oauthConfig.redirect_uri}
${prefix}_URL=${oauthConfig.authorize_url}
${prefix}_TOKEN_URL=${oauthConfig.token_url}
${prefix}_USER_INFO_URL=${oauthConfig.user_url}
${oauthConfig.auth_scheme ? `${prefix}_AUTH_SCHEME=${oauthConfig.auth_scheme}` : ''}
`;

        const keysToRemove = new Set<string>([
            `${prefix}_ENABLED`,
            `${prefix}_CLIENT_ID`,
            `${prefix}_SECRET`,
            `${prefix}_REDIRECT_URI`,
            `${prefix}_URL`,
            `${prefix}_TOKEN_URL`,
            `${prefix}_USER_INFO_URL`,
            `${prefix}_AUTH_SCHEME`,
        ]);

        const lines = envContent.split("\n");
        const updatedLines: string[] = [];
        let hasCustomSection = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                if (trimmed.includes(`# Custom OAuth Provider: ${oauthConfig.name}`)) {
                    hasCustomSection = true;
                }
                updatedLines.push(line);
                continue;
            }
            const [key] = trimmed.split("=");
            const keyTrimmed = key?.trim();
            if (keyTrimmed && keysToRemove.has(keyTrimmed)) continue;
            updatedLines.push(line);
        }

        if (!hasCustomSection) {
            updatedLines.push(customOAuthEnv);
        } else {
            const sectionStartIndex = updatedLines.findIndex(l =>
                l.includes(`# Custom OAuth Provider: ${oauthConfig.name}`)
            );
            if (sectionStartIndex >= 0) {
                updatedLines.splice(sectionStartIndex + 1, 0, ...customOAuthEnv.trim().split("\n").slice(1));
            }
        }

        await this.writeGoTrueEnv(ref, updatedLines.join("\n"));
        await this.reloadAndPollGoTrue(ref, `Custom OAuth config updated for ${oauthConfig.name} in project ${ref}`);
    }
}

export const tenantOAuthService = new TenantOAuthService();
