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
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { OAuthProvider, OAuthProviderConfig } from "../types/oauth";
import { OAUTH_ENV_MAPPINGS } from "../types/oauth";
import { assertSafeConfigValue, renderSystemdEnvLine } from "./tenant-runtime-config";

export interface TenantOAuthServiceOptions {
    tenantConfigDir?: string;
    chownPath?: (targetPath: string, runtimeUser: string) => Promise<void>;
    renamePath?: (sourcePath: string, targetPath: string) => Promise<void>;
    chmodPath?: (targetPath: string, mode: number) => Promise<void>;
    reloadAndPoll?: (ref: string, message: string) => Promise<void>;
}

interface PreparedTenantEnvFile {
    targetPath: string;
    stagePath: string;
    backupPath: string;
    existed: boolean;
    originalMode: number;
    rollbackReady: boolean;
}

export class TenantOAuthService {
    private readonly TENANT_CONFIG_DIR: string;
    private readonly chownPathOverride?: TenantOAuthServiceOptions["chownPath"];
    private readonly renamePathOverride?: TenantOAuthServiceOptions["renamePath"];
    private readonly chmodPathOverride?: TenantOAuthServiceOptions["chmodPath"];
    private readonly reloadAndPollOverride?: TenantOAuthServiceOptions["reloadAndPoll"];

    constructor(options: TenantOAuthServiceOptions = {}) {
        this.TENANT_CONFIG_DIR = options.tenantConfigDir || config.tenantConfigDir;
        this.chownPathOverride = options.chownPath;
        this.renamePathOverride = options.renamePath;
        this.chmodPathOverride = options.chmodPath;
        this.reloadAndPollOverride = options.reloadAndPoll;
    }

    private tenantRuntimeUser(ref: string): string {
        if (!/^[a-z0-9-]{1,20}$/.test(ref)) {
            throw new Error("Invalid tenant project ref");
        }
        return `supacloud-${ref}`;
    }

    private async ensureRealDirectory(directory: string, mode: number): Promise<void> {
        await fs.mkdir(directory, { recursive: true, mode });
        const directoryStat = await fs.lstat(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
            throw new Error(`Refusing to use non-directory tenant config path: ${directory}`);
        }
        await fs.chmod(directory, mode);
    }

    private async chownPath(targetPath: string, runtimeUser: string): Promise<void> {
        if (this.chownPathOverride) {
            await this.chownPathOverride(targetPath, runtimeUser);
            return;
        }

        const child = Bun.spawn({
            cmd: ["chown", `${runtimeUser}:${runtimeUser}`, targetPath],
            stdout: "ignore",
            stderr: "pipe",
        });
        const [stderr, exitCode] = await Promise.all([
            new Response(child.stderr).text(),
            child.exited,
        ]);
        if (exitCode !== 0) {
            throw new Error(`Failed to set tenant ownership on ${path.basename(targetPath)}: ${stderr.trim().slice(0, 300)}`);
        }
    }

    private async stageTenantEnvFile(targetPath: string, content: string, runtimeUser: string): Promise<string> {
        const temporaryPath = path.join(
            path.dirname(targetPath),
            `.${path.basename(targetPath)}.${randomUUID()}.stage`,
        );
        try {
            await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
            await fs.chmod(temporaryPath, 0o600);
            await this.chownPath(temporaryPath, runtimeUser);
            return temporaryPath;
        } catch (error: unknown) {
            try {
                await fs.rm(temporaryPath, { force: true });
            } catch (cleanupError: unknown) {
                throw new AggregateError(
                    [error, cleanupError],
                    `Failed to stage and clean up ${path.basename(targetPath)}`,
                );
            }
            throw error;
        }
    }

    private async prepareTenantEnvFile(
        prepared: PreparedTenantEnvFile,
        runtimeUser: string,
    ): Promise<void> {
        try {
            const targetStat = await fs.lstat(prepared.targetPath);
            if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
                throw new Error(`Refusing to replace non-regular tenant env file: ${prepared.targetPath}`);
            }
            prepared.existed = true;
            prepared.originalMode = targetStat.mode & 0o777;
        } catch (error: unknown) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
                throw error;
            }
        }

        if (prepared.existed) {
            prepared.backupPath = path.join(
                path.dirname(prepared.targetPath),
                `.${path.basename(prepared.targetPath)}.${randomUUID()}.backup`,
            );
            await fs.copyFile(prepared.targetPath, prepared.backupPath, fsConstants.COPYFILE_EXCL);
            await fs.chmod(prepared.backupPath, prepared.originalMode);
            await this.chownPath(prepared.backupPath, runtimeUser);
        }
        prepared.rollbackReady = true;
    }

    private async cleanupPreparedFiles(
        preparedFiles: PreparedTenantEnvFile[],
        includeBackups = true,
    ): Promise<void> {
        const cleanupErrors: unknown[] = [];
        for (const prepared of preparedFiles) {
            if (prepared.stagePath) {
                try {
                    await fs.rm(prepared.stagePath, { force: true });
                    prepared.stagePath = "";
                } catch (error: unknown) {
                    cleanupErrors.push(error);
                }
            }
            if (includeBackups && prepared.backupPath) {
                try {
                    await fs.rm(prepared.backupPath, { force: true });
                    prepared.backupPath = "";
                } catch (error: unknown) {
                    cleanupErrors.push(error);
                }
            }
        }
        if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "Failed to clean up tenant OAuth transaction files");
        }
    }

    private async restorePreparedFiles(
        preparedFiles: PreparedTenantEnvFile[],
        runtimeUser: string,
    ): Promise<void> {
        const restorationErrors: unknown[] = [];
        for (const prepared of preparedFiles) {
            try {
                if (!prepared.rollbackReady) {
                    continue;
                }
                if (prepared.existed) {
                    if (!prepared.backupPath) {
                        throw new Error(`Missing rollback backup for ${prepared.targetPath}`);
                    }
                    await fs.rename(prepared.backupPath, prepared.targetPath);
                    prepared.backupPath = "";
                    await fs.chmod(prepared.targetPath, prepared.originalMode);
                    await this.chownPath(prepared.targetPath, runtimeUser);
                } else {
                    await fs.rm(prepared.targetPath, { force: true });
                }
                prepared.rollbackReady = false;
            } catch (error: unknown) {
                restorationErrors.push(error);
            }
        }
        try {
            await this.cleanupPreparedFiles(preparedFiles, restorationErrors.length === 0);
        } catch (error: unknown) {
            restorationErrors.push(error);
        }
        if (restorationErrors.length > 0) {
            throw new AggregateError(restorationErrors, "Failed to restore tenant OAuth EnvironmentFiles");
        }
    }

    private async commitChmod(targetPath: string, mode: number): Promise<void> {
        if (this.chmodPathOverride) {
            await this.chmodPathOverride(targetPath, mode);
            return;
        }
        await fs.chmod(targetPath, mode);
    }

    private gotrueConfigDir(ref: string): string {
        this.tenantRuntimeUser(ref);
        return path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.d`);
    }

    private gotrueRuntimeEnvPath(ref: string): string {
        return path.join(this.gotrueConfigDir(ref), "runtime.env");
    }

    private gotrueLegacyEnvPath(ref: string): string {
        this.tenantRuntimeUser(ref);
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
        const runtimeUser = this.tenantRuntimeUser(ref);
        const runtimeDirectory = this.gotrueConfigDir(ref);
        await this.ensureRealDirectory(this.TENANT_CONFIG_DIR, 0o711);
        await this.ensureRealDirectory(runtimeDirectory, 0o700);
        await this.chownPath(runtimeDirectory, runtimeUser);

        const normalizedContent = content.replace(/\r\n/g, "\n");
        if (normalizedContent.includes("\r") || normalizedContent.includes("\0")) {
            throw new Error("GoTrue EnvironmentFile content contains a forbidden control character");
        }
        const durableContent = normalizedContent.endsWith("\n") ? normalizedContent : `${normalizedContent}\n`;
        const runtimePath = this.gotrueRuntimeEnvPath(ref);
        const legacyPath = this.gotrueLegacyEnvPath(ref);
        const preparedFiles: PreparedTenantEnvFile[] = [runtimePath, legacyPath].map((targetPath) => ({
            targetPath,
            stagePath: "",
            backupPath: "",
            existed: false,
            originalMode: 0o600,
            rollbackReady: false,
        }));

        try {
            const runtimeTemporaryPath = await this.stageTenantEnvFile(runtimePath, durableContent, runtimeUser);
            preparedFiles[0].stagePath = runtimeTemporaryPath;
            const legacyTemporaryPath = await this.stageTenantEnvFile(legacyPath, durableContent, runtimeUser);
            preparedFiles[1].stagePath = legacyTemporaryPath;

            await this.prepareTenantEnvFile(preparedFiles[0], runtimeUser);
            await this.prepareTenantEnvFile(preparedFiles[1], runtimeUser);

            if (this.renamePathOverride) {
                await this.renamePathOverride(runtimeTemporaryPath, runtimePath);
            } else {
                await fs.rename(runtimeTemporaryPath, runtimePath);
            }
            preparedFiles[0].stagePath = "";
            if (this.renamePathOverride) {
                await this.renamePathOverride(legacyTemporaryPath, legacyPath);
            } else {
                await fs.rename(legacyTemporaryPath, legacyPath);
            }
            preparedFiles[1].stagePath = "";
            await this.commitChmod(runtimePath, 0o600);
            await this.commitChmod(legacyPath, 0o600);
        } catch (error: unknown) {
            try {
                await this.restorePreparedFiles(preparedFiles, runtimeUser);
            } catch (restoreError: unknown) {
                throw new AggregateError(
                    [error, restoreError],
                    "Tenant OAuth EnvironmentFile commit failed and rollback was incomplete",
                );
            }
            throw error;
        }
        await this.cleanupPreparedFiles(preparedFiles);
    }

    private async reloadAndPollGoTrue(ref: string, message: string): Promise<void> {
        this.tenantRuntimeUser(ref);
        if (this.reloadAndPollOverride) {
            await this.reloadAndPollOverride(ref, message);
            return;
        }

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
        const mapping = OAUTH_ENV_MAPPINGS[provider];
        if (!mapping) {
            throw new Error(`Unsupported OAuth provider: ${provider}`);
        }
        this.tenantRuntimeUser(ref);

        const enabledKey = `GOTRUE_EXTERNAL_${provider.toUpperCase()}_ENABLED`;
        const renderedClientId = renderSystemdEnvLine(mapping.clientId, providerConfig.client_id);
        const renderedClientSecret = renderSystemdEnvLine(mapping.clientSecret, providerConfig.client_secret);
        const renderedRedirectUri = mapping.redirectUri && providerConfig.redirect_uri
            ? renderSystemdEnvLine(mapping.redirectUri, providerConfig.redirect_uri)
            : null;
        const renderedUrl = mapping.url && providerConfig.url
            ? renderSystemdEnvLine(mapping.url, providerConfig.url)
            : null;
        const envContent = await this.readGoTrueEnv(ref);

        const lines = envContent.split("\n");
        const updatedLines: string[] = [];
        const addedKeys = new Set<string>();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
                updatedLines.push(line);
                continue;
            }

            const [key] = trimmed.split("=");
            const keyTrimmed = key?.trim();

            if (keyTrimmed === mapping.clientId) {
                updatedLines.push(renderedClientId);
                addedKeys.add(mapping.clientId);
            } else if (keyTrimmed === enabledKey) {
                updatedLines.push(`${enabledKey}=true`);
                addedKeys.add(enabledKey);
            } else if (keyTrimmed === mapping.clientSecret) {
                updatedLines.push(renderedClientSecret);
                addedKeys.add(mapping.clientSecret);
            } else if (mapping.redirectUri && keyTrimmed === mapping.redirectUri) {
                if (renderedRedirectUri) {
                    updatedLines.push(renderedRedirectUri);
                }
                addedKeys.add(mapping.redirectUri);
            } else if (mapping.url && keyTrimmed === mapping.url) {
                if (renderedUrl) {
                    updatedLines.push(renderedUrl);
                }
                addedKeys.add(mapping.url);
            } else {
                updatedLines.push(line);
            }
        }

        const newLines: string[] = [];
        if (!addedKeys.has(enabledKey)) {
            newLines.push(`${enabledKey}=true`);
        }
        if (!addedKeys.has(mapping.clientId)) {
            newLines.push(renderedClientId);
        }
        if (!addedKeys.has(mapping.clientSecret)) {
            newLines.push(renderedClientSecret);
        }
        if (mapping.redirectUri && renderedRedirectUri && !addedKeys.has(mapping.redirectUri)) {
            newLines.push(renderedRedirectUri);
        }
        if (mapping.url && renderedUrl && !addedKeys.has(mapping.url)) {
            newLines.push(renderedUrl);
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
        this.tenantRuntimeUser(ref);
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
        this.tenantRuntimeUser(ref);
        assertSafeConfigValue("Custom OAuth provider name", oauthConfig.name);
        if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(oauthConfig.name)) {
            throw new Error("Custom OAuth provider name must be a safe environment variable fragment");
        }

        const prefix = `GOTRUE_EXTERNAL_${oauthConfig.name.toUpperCase()}`;
        const customOAuthLines = [
            `# Custom OAuth Provider: ${oauthConfig.name}`,
            `${prefix}_ENABLED=true`,
            renderSystemdEnvLine(`${prefix}_CLIENT_ID`, oauthConfig.client_id),
            renderSystemdEnvLine(`${prefix}_SECRET`, oauthConfig.client_secret),
            renderSystemdEnvLine(`${prefix}_REDIRECT_URI`, oauthConfig.redirect_uri),
            renderSystemdEnvLine(`${prefix}_URL`, oauthConfig.authorize_url),
            renderSystemdEnvLine(`${prefix}_TOKEN_URL`, oauthConfig.token_url),
            renderSystemdEnvLine(`${prefix}_USER_INFO_URL`, oauthConfig.user_url),
            oauthConfig.auth_scheme
                ? renderSystemdEnvLine(`${prefix}_AUTH_SCHEME`, oauthConfig.auth_scheme)
                : "",
        ].filter(Boolean);
        const envContent = await this.readGoTrueEnv(ref);

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
            updatedLines.push("");
            updatedLines.push(...customOAuthLines);
        } else {
            const sectionStartIndex = updatedLines.findIndex(l =>
                l.includes(`# Custom OAuth Provider: ${oauthConfig.name}`)
            );
            if (sectionStartIndex >= 0) {
                updatedLines.splice(sectionStartIndex + 1, 0, ...customOAuthLines.slice(1));
            }
        }

        await this.writeGoTrueEnv(ref, updatedLines.join("\n"));
        await this.reloadAndPollGoTrue(ref, `Custom OAuth config updated for ${oauthConfig.name} in project ${ref}`);
    }
}

export const tenantOAuthService = new TenantOAuthService();
