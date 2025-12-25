import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

const BASE_DIR = join(import.meta.dir, "..");
const BASE_ENV_PATH = join(BASE_DIR, "base", ".env");
const BASE_COMPOSE_PATH = join(BASE_DIR, "base", "docker-compose.yml");
const GARAGE_CONFIG_PATH = join(BASE_DIR, "base", "volumes", "garage", "config", "garage.toml");

// Helper to generate secure secrets
function generateSecret(length = 32) {
    return randomBytes(length).toString('hex').slice(0, length);
}

function generateUUID() {
    return randomUUID();
}

async function main() {
    console.log("🚀 Initializing SupaCloud Infrastructure...");

    // 1. Generate Secrets
    const postgresPassword = generateSecret(16);
    const jwtSecret = generateSecret(40);
    const garageRpcSecret = generateSecret(32);
    const garageAdminToken = generateSecret(32);
    const garageMetricsToken = generateSecret(32);

    console.log("🔑 Generated secure credentials.");

    // 2. Setup base/.env
    const envContent = `
POSTGRES_DB=postgres
POSTGRES_PASSWORD=${postgresPassword}
JWT_SECRET=${jwtSecret}
JWT_EXP=3600
    `.trim();

    await Bun.write(BASE_ENV_PATH, envContent);
    console.log("✅ Created base/.env");

    // 3. Update garage.toml
    const garageConfigFile = Bun.file(GARAGE_CONFIG_PATH);
    if (await garageConfigFile.exists()) {
        let garageConfig = await garageConfigFile.text();
        garageConfig = garageConfig.replace(/rpc_secret = ".*"/, `rpc_secret = "${garageRpcSecret}"`);
        garageConfig = garageConfig.replace(/admin_token = ".*"/, `admin_token = "${garageAdminToken}"`);
        garageConfig = garageConfig.replace(/metrics_token = ".*"/, `metrics_token = "${garageMetricsToken}"`);

        await Bun.write(GARAGE_CONFIG_PATH, garageConfig);
        console.log("✅ Updated garage.toml with new tokens");
    } else {
        console.warn("⚠️ garage.toml not found!");
    }

    // 4. Update docker-compose.yml (Garage Admin Key)
    const composeFile = Bun.file(BASE_COMPOSE_PATH);
    if (await composeFile.exists()) {
        let composeContent = await composeFile.text();
        // Replace the placeholder or the old value
        composeContent = composeContent.replace(/API_ADMIN_KEY: .*/, `API_ADMIN_KEY: ${garageAdminToken}`);

        await Bun.write(BASE_COMPOSE_PATH, composeContent);
        console.log("✅ Updated docker-compose.yml with Garage Admin Key");
    } else {
        console.warn("⚠️ docker-compose.yml not found!");
    }

    console.log("\n🎉 Configuration Complete!");
    console.log("You can now start the infrastructure with:");
    console.log("  cd ../base && docker compose up -d");
    console.log("  cd .. && bun run manager/index.ts");
}

main().catch(console.error);
