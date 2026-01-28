
import { join } from "node:path";
import { homedir } from "node:os";

// Hardcoded for now, or imported from deps if needed, but simple constants are fine
export const RC_FILE = join(homedir(), ".supacloudrc");

// Determine BASE_DIR
// We need to resolve this logic properly since it used async file check in index.tsx
// But top-level await is fine in modules.

// However, to keep it simple and avoid circular dependency or waiting on deps, 
// we might want to make BASE_DIR a function or initialize it explicitly?
// For now, let's keep the logic but we need 'bun' imports if we want to read files.
// To avoid duplication, let's just default to standard paths and maybe move the rc check logic 
// to an async init function or keep it simple.

// Let's assume standard behavior for now to avoid complexity in this file.
// We'll read process.env.SUPACLOUD_HOME or default relative.
export let BASE_DIR = process.env.SUPACLOUD_HOME || join(import.meta.dir, "..", "..");
// Note: In development, BASE_DIR is project root. 
// In production (/opt/supacloud), BASE_DIR is /opt/supacloud.

export const INSTANCES_DIR = join(BASE_DIR, "instances");
export const BASE_COMPOSE = join(BASE_DIR, "templates", "base", "docker-compose.yml");
export const AUTH_FILE = join(BASE_DIR, ".manager_auth");

export const ROOT_DOMAIN = process.env.ROOT_DOMAIN || "localhost";
