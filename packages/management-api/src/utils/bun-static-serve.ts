/**
 * bun-static-serve — Nginx-grade static file server for Bun
 *
 * Unlike sirv-cli / @elysiajs/static which index files at startup and cache
 * content in memory, this reads directly from disk on every request using
 * Bun.file() (which internally uses sendfile(2) — zero-copy, kernel-level).
 *
 * Result: deploy new files → next request serves them. No restart needed.
 *
 * Multi-core: On Linux, spawns N worker processes sharing the same port via
 * SO_REUSEPORT, letting the kernel load-balance connections across all CPUs.
 * This matches (and can exceed) Caddy/Nginx throughput on multi-core servers.
 *
 * Usage:
 *   bun run bun-static-serve.ts /path/to/build 3000
 *   bun run bun-static-serve.ts /path/to/build 3000 --workers=4
 *   bun run bun-static-serve.ts /path/to/build 3000 --workers=auto
 *
 * Behavior mirrors Nginx `try_files $uri $uri.html $uri/index.html /index.html`:
 *   1. Exact file or route file match → serve with proper MIME + cache headers
 *   2. Hashed asset miss → 404 (never SPA-fallback for /_app/ etc.)
 *   3. No extension (SPA route) → serve /index.html with no-cache
 */

import { availableParallelism } from "os";
import { spawn } from "bun";
import { statSync } from "node:fs";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

function getExt(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > -1 ? path.slice(dot).toLowerCase() : "";
}

function isImmutableAsset(path: string): boolean {
  // SvelteKit /_app/immutable/ and generic /assets/ with content hashes
  return path.startsWith("/_app/") || path.startsWith("/assets/");
}

function hasFileExtension(path: string): boolean {
  const last = path.split("/").pop() || "";
  return last.includes(".");
}

/** Check if a real file exists on disk. Directories must not be served as files. */
function fileExists(fullPath: string): boolean {
  try {
    return statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

function unique(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function getRouteCandidates(path: string): string[] {
  if (path === "/") return ["/index.html"];
  if (hasFileExtension(path)) return [path];

  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return ["/index.html"];

  return unique([trimmed, `${trimmed}.html`, `${trimmed}/index.html`]);
}

function resolveStaticFile(root: string, requestPath: string, acceptEncoding: string) {
  for (const path of getRouteCandidates(requestPath)) {
    if (acceptEncoding.includes("br") && fileExists(`${root}${path}.br`)) {
      return { diskPath: `${root}${path}.br`, logicalPath: path, encoding: "br" };
    }
    if (acceptEncoding.includes("gzip") && fileExists(`${root}${path}.gz`)) {
      return { diskPath: `${root}${path}.gz`, logicalPath: path, encoding: "gzip" };
    }
    if (fileExists(`${root}${path}`)) {
      return { diskPath: `${root}${path}`, logicalPath: path, encoding: null };
    }
  }

  return null;
}

// ─── Worker: HTTP request handler ───────────────────────────────────────────

export function createFetchHandler(root: string) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);

    // Security: prevent path traversal
    if (path.includes("..")) {
      return new Response("Forbidden", { status: 403 });
    }

    // Security: deny dotfiles (.env, .git, .htaccess, etc.)
    const lastSegment = path.split("/").pop() || "";
    if (lastSegment.startsWith(".") && !path.startsWith("/.well-known")) {
      return new Response("Forbidden", { status: 403 });
    }

    const acceptEncoding = req.headers.get("accept-encoding") || "";
    const resolved = resolveStaticFile(root, path, acceptEncoding);

    if (resolved) {
      const file = Bun.file(resolved.diskPath);
      const ext = getExt(resolved.logicalPath);
      // Use hardcoded table first, then Bun's built-in MIME detection as fallback
      const mime = MIME_TYPES[ext] || file.type || "application/octet-stream";

      // ETag based on mtime + size (same as Nginx weak ETag)
      const etag = `W/"${file.lastModified.toString(36)}-${file.size.toString(36)}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304 });
      }

      // Cache policy: immutable hashed assets get 1 year; HTML gets no-cache
      let cacheControl: string;
      if (ext === ".html") {
        cacheControl = "no-cache";
      } else if (isImmutableAsset(resolved.logicalPath) || /\.[0-9a-f]{8,}\./i.test(resolved.logicalPath)) {
        cacheControl = "public, max-age=31536000, immutable";
      } else {
        cacheControl = "public, max-age=3600";
      }

      // Range support (206 Partial Content)
      const rangeHeader = req.headers.get("Range");
      let start = 0;
      let end = file.size - 1;
      let isRange = false;

      if (rangeHeader && rangeHeader.startsWith("bytes=")) {
        const parts = rangeHeader.replace("bytes=", "").split("-");
        const parsedStart = parseInt(parts[0], 10);
        const parsedEnd = parseInt(parts[1], 10);
        
        if (!isNaN(parsedStart)) {
          start = parsedStart;
          if (!isNaN(parsedEnd)) {
            end = Math.min(parsedEnd, file.size - 1);
          }
          isRange = true;
        }

        // Check bounds
        if (start >= file.size || end >= file.size || start > end) {
          return new Response("Range Not Satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${file.size}` }
          });
        }
      }

      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Cache-Control": cacheControl,
        "ETag": etag,
        "Accept-Ranges": "bytes",
      };

      if (isRange) {
        headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
        headers["Content-Length"] = (end - start + 1).toString();
      }

      if (resolved.encoding) {
        headers["Content-Encoding"] = resolved.encoding;
        headers["Vary"] = "Accept-Encoding";
      }

      const body = isRange ? file.slice(start, end + 1) : file;
      return new Response(body, { 
        status: isRange ? 206 : 200, 
        headers 
      });
    }

    // --- Step 2: immutable / file-extension miss → strict 404 ---
    if (isImmutableAsset(path) || hasFileExtension(path)) {
      return new Response("Not Found", { status: 404 });
    }

    // --- Step 3: SPA fallback → serve index.html from disk (no memory cache!) ---
    const indexPath = `${root}/index.html`;
    if (fileExists(indexPath)) {
      const file = Bun.file(indexPath);
      return new Response(file, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  };
}

/** Start a single-process static server (also used by each worker in cluster mode) */
export function startStaticServer(root: string, port: number, reusePort = false) {
  const server = Bun.serve({
    port,
    reusePort,
    fetch: createFetchHandler(root),
  });

  // Graceful shutdown handling
  const shutdown = () => {
    // stop(false) closes listeners but waits for active connections to finish before shutting down
    server.stop(false);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

// ─── Cluster Manager: spawns N workers sharing the same port ─────────────────

function startCluster(root: string, port: number, workerCount: number) {
  console.log(`[bun-static-serve] Cluster mode: spawning ${workerCount} workers on port ${port}`);
  console.log(`[bun-static-serve] Serving ${root}`);

  const workers: ReturnType<typeof spawn>[] = [];
  let isShuttingDown = false;

  for (let i = 0; i < workerCount; i++) {
    workers.push(
      spawn({
        cmd: ["bun", "run", import.meta.path, root, String(port), "--worker"],
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, BUN_STATIC_WORKER_ID: String(i) },
      })
    );
  }

  // Graceful shutdown: forward signals to all workers
  function shutdown() {
    isShuttingDown = true;
    console.log(`\n[bun-static-serve] Shutting down ${workers.length} workers gracefully...`);
    for (const w of workers) {
      w.kill("SIGTERM"); // Ask workers to exit gracefully
    }
    // Give workers up to 10 seconds to finish pending requests before forcefully exiting
    setTimeout(() => process.exit(0), 10000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Monitor workers — respawn on crash
  (async () => {
    while (!isShuttingDown) {
      for (let i = 0; i < workers.length; i++) {
        const w = workers[i];
        // Check if worker exited
        if (w.exitCode !== null) {
          console.warn(`[bun-static-serve] Worker ${i} exited (code=${w.exitCode}), respawning...`);
          workers[i] = spawn({
            cmd: ["bun", "run", import.meta.path, root, String(port), "--worker"],
            stdout: "inherit",
            stderr: "inherit",
            env: { ...process.env, BUN_STATIC_WORKER_ID: String(i) },
          });
        }
      }
      await Bun.sleep(2000); // check every 2s
    }
  })();
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = args[0] || ".";
  const port = parseInt(args[1] || "3000", 10);
  const isWorker = args.includes("--worker");

  // Parse --workers=N or --workers=auto
  const workersArg = args.find(a => a.startsWith("--workers="));
  let workerCount = 0;
  if (workersArg) {
    const val = workersArg.split("=")[1];
    workerCount = val === "auto" ? availableParallelism() : parseInt(val, 10);
    // Clamp to reasonable range
    workerCount = Math.max(1, Math.min(workerCount, 64));
  }

  if (!fileExists(`${root}/index.html`)) {
    console.error(`[bun-static-serve] Error: ${root}/index.html not found`);
    process.exit(1);
  }

  if (isWorker) {
    // Worker mode: start server with reusePort, minimal logging
    const wid = process.env.BUN_STATIC_WORKER_ID || "?";
    startStaticServer(root, port, true);
    console.log(`[bun-static-serve] Worker ${wid} ready on port ${port}`);
  } else if (workerCount > 1) {
    // Cluster mode: spawn N workers
    startCluster(root, port, workerCount);
  } else {
    // Single-process mode (default, backward compatible)
    startStaticServer(root, port, false);
    console.log(`[bun-static-serve] Serving ${root} on port ${port}`);
  }
}
