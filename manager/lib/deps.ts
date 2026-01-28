
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
