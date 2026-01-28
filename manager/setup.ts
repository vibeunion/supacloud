import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

const BASE_DIR = join(import.meta.dir, "..");
const BASE_ENV_PATH = join(BASE_DIR, "base", ".env");
const BASE_COMPOSE_PATH = join(BASE_DIR, "base", "docker-compose.yml");

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

    console.log("\n🎉 Configuration Complete!");
    console.log("You can now start the infrastructure with:");
    console.log("  cd ../base && docker compose up -d");
    console.log("  cd .. && bun run manager/index.ts");
}

main().catch(console.error);
