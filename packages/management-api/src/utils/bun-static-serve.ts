/**
 * bun-static-serve — Nginx-style static file server for Bun
 *
 * Unlike sirv-cli / @elysiajs/static which index files at startup and cache
 * content in memory, this reads directly from disk on every request using
 * Bun.file() (which internally uses sendfile(2) — zero-copy, kernel-level).
 *
 * Result: deploy new files → next request serves them. No restart needed.
 *
 * Usage:
 *   bun run bun-static-serve.ts /path/to/build 3000
 *
 * Behavior mirrors Nginx `try_files $uri $uri/index.html /index.html`:
 *   1. Exact file match → serve with proper MIME + cache headers
 *   2. Hashed asset miss → 404 (never SPA-fallback for /_app/ etc.)
 *   3. No extension (SPA route) → serve /index.html with no-cache
 */

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

/** Check if a file exists on disk (fast stat, no content read) */
function fileExists(fullPath: string): boolean {
  try {
    const f = Bun.file(fullPath);
    return f.size > 0;
  } catch {
    return false;
  }
}

export function startStaticServer(root: string, port: number) {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);

      // Security: prevent path traversal
      if (path.includes("..")) {
        return new Response("Forbidden", { status: 403 });
      }

      // Normalize: / → /index.html
      if (path === "/") path = "/index.html";

      // --- Step 1: try exact file on disk ---
      const acceptEncoding = req.headers.get("accept-encoding") || "";
      let diskPath: string | null = null;
      let encoding: string | null = null;

      // Content negotiation: brotli > gzip > raw
      if (acceptEncoding.includes("br") && fileExists(`${root}${path}.br`)) {
        diskPath = `${root}${path}.br`;
        encoding = "br";
      } else if (acceptEncoding.includes("gzip") && fileExists(`${root}${path}.gz`)) {
        diskPath = `${root}${path}.gz`;
        encoding = "gzip";
      } else if (fileExists(`${root}${path}`)) {
        diskPath = `${root}${path}`;
      }

      if (diskPath) {
        const file = Bun.file(diskPath);
        const ext = getExt(path);
        const mime = MIME_TYPES[ext] || "application/octet-stream";

        // ETag based on mtime + size (same as Nginx weak ETag)
        const etag = `W/"${file.lastModified.toString(36)}-${file.size.toString(36)}"`;
        if (req.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304 });
        }

        // Cache policy: immutable hashed assets get 1 year; HTML gets no-cache
        let cacheControl: string;
        if (ext === ".html") {
          cacheControl = "no-cache";
        } else if (isImmutableAsset(path) || /\.[0-9a-f]{8,}\./i.test(path)) {
          cacheControl = "public, max-age=31536000, immutable";
        } else {
          cacheControl = "public, max-age=3600";
        }

        const headers: Record<string, string> = {
          "Content-Type": mime,
          "Cache-Control": cacheControl,
          "ETag": etag,
        };

        if (encoding) {
          headers["Content-Encoding"] = encoding;
          headers["Vary"] = "Accept-Encoding";
        }

        return new Response(file, { headers });
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
    },
  });

  console.log(`[bun-static-serve] Serving ${root} on port ${port}`);
}

// --- CLI entrypoint ---
if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = args[0] || ".";
  const port = parseInt(args[1] || "3000", 10);

  if (!fileExists(`${root}/index.html`)) {
    console.error(`[bun-static-serve] Error: ${root}/index.html not found`);
    process.exit(1);
  }

  startStaticServer(root, port);
}
