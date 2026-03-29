/**
 * SupaCloud Management CLI
 * 
 * Provides utility commands for cluster administrators.
 */
import { $ } from "bun";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./utils/logger";
import { config as appConfig } from "./config";
import { shellService } from "./services/shell.service";

async function setupStudioDomain(domain: string) {
  if (!domain) {
    logger.error("Usage: bun run src/cli.ts setup-studio-domain <domain>");
    process.exit(1);
  }

  const ANGIE_SITES_DIR = appConfig.angieSitesDir;
  const MANAGEMENT_API_INTERNAL = appConfig.managementApiInternal;
  const STUDIO_INTERNAL = appConfig.studioInternal;
  const ACME_CLIENT = appConfig.acmeClient;
  
  const configFile = path.join(ANGIE_SITES_DIR, `studio-global.conf`);

  const ENABLE_SSL = appConfig.enableSsl;

  let config = "";
  if (ENABLE_SSL) {
    config = `# SupaCloud Global Studio & Management API
# Generated: ${new Date().toISOString()}

server {
    listen 80;
    listen 443 ssl;
    server_name ${domain};

    acme ${ACME_CLIENT};
    ssl_certificate $acme_cert_${ACME_CLIENT};
    ssl_certificate_key $acme_cert_key_${ACME_CLIENT};

    # Hijack /api/platform/* to Management API for multi-project support
    location /api/platform/ {
        proxy_pass http://${MANAGEMENT_API_INTERNAL}/platform/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Hijack /api/auth/* to Management API for auth support
    location /api/auth/ {
        proxy_pass http://${MANAGEMENT_API_INTERNAL}/auth/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Proxy to Web Console Next.js/SvelteKit server
    location / {
        proxy_pass http://${STUDIO_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
  } else {
    config = `# SupaCloud Global Studio & Management API (SSL Disabled)
# Generated: ${new Date().toISOString()}

server {
    listen 80;
    server_name ${domain};

    location /api/platform/ {
        proxy_pass http://${MANAGEMENT_API_INTERNAL}/platform/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/auth/ {
        proxy_pass http://${MANAGEMENT_API_INTERNAL}/auth/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        proxy_pass http://${STUDIO_INTERNAL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
  }

  logger.info(`Generating global Studio Angie config at ${configFile} for domain ${domain}...`);
  await fs.mkdir(ANGIE_SITES_DIR, { recursive: true });
  await fs.writeFile(configFile, config, "utf-8");

  logger.info(`Testing Angie configuration...`);
  const testResult = await shellService.executeCommand("angie", ["-t"]);
  if (!testResult.success) {
    logger.error("Angie config test failed. Reverting changes.");
    logger.error(testResult.output);
    await fs.unlink(configFile).catch(() => {});
    process.exit(1);
  }

  logger.info(`Reloading Angie...`);
  const reloadResult = await shellService.executeCommand("angie", ["-s", "reload"]);
  if (!reloadResult.success) {
    logger.error("Angie reload failed. Reverting changes.");
    logger.error(reloadResult.output);
    await fs.unlink(configFile).catch(() => {});
    process.exit(1);
  }

  logger.info(`\\n\\n✅ Successfully bound Global Studio to: https://${domain}`);
  logger.info(`Make sure to point your DNS A record for ${domain} to this server's IP address.\\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(`
SupaCloud CLI

Usage:
  bun run src/cli.ts <command> [args]

Available Commands:
  setup-studio-domain <domain>   Bind a global custom domain to the SupaCloud Studio & API
    `);
    process.exit(0);
  }

  switch (command) {
    case "setup-studio-domain":
      await setupStudioDomain(args[1]);
      break;
    default:
      logger.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(err => {
  logger.error(err);
  process.exit(1);
});
