
import { serve, file as bunFile, write as bunWrite, spawn as bunSpawn, Glob as BunGlob } from "bun";
import { readdir, mkdir, rename, rm, stat } from "node:fs/promises";
import { $ } from "bun";

export const deps = {
    $,
    serve,
    file: bunFile,
    write: bunWrite,
    spawn: bunSpawn,
    Glob: BunGlob,
    readdir,
    mkdir,
    rename,
    rm,
    stat
};

export async function exists(path: string) {
    try {
        await deps.stat(path);
        return true;
    } catch {
        return false;
    }
}

// Project name validation - prevents SQL injection and path traversal
const PROJECT_NAME_REGEX = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export function validateProjectName(name: string): { valid: boolean; error?: string } {
    if (!name || typeof name !== 'string') {
        return { valid: false, error: "Project name is required" };
    }
    if (name.length < 3 || name.length > 32) {
        return { valid: false, error: "Project name must be 3-32 characters" };
    }
    if (!PROJECT_NAME_REGEX.test(name)) {
        return { valid: false, error: "Project name must start with a letter, contain only lowercase letters, numbers, and hyphens, and end with a letter or number" };
    }
    if (name.includes('--')) {
        return { valid: false, error: "Project name cannot contain consecutive hyphens" };
    }
    // Reserved names
    const reserved = ['postgres', 'template0', 'template1', 'admin', 'root', 'supabase', 'public', 'system'];
    if (reserved.includes(name)) {
        return { valid: false, error: `Project name '${name}' is reserved` };
    }
    return { valid: true };
}

// Sanitize identifier for PostgreSQL (double-quote escaping)
export function sanitizeIdentifier(name: string): string {
    const validation = validateProjectName(name);
    if (!validation.valid) {
        throw new Error(validation.error);
    }
    // Even after validation, escape double quotes for safety
    return name.replace(/"/g, '""');
}
