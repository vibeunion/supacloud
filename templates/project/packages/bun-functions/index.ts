import { Hono } from "hono";
import { cors } from "hono/cors";
import { readdir, stat } from "fs/promises";
import { join } from "path";

const app = new Hono();

// Environment variables
const JWT_SECRET = process.env.JWT_SECRET || "";
const ANON_KEY = process.env.ANON_KEY || "";
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";

// CORS configuration
app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "apikey", "x-client-info"],
  })
);

// Health check (public)
app.get("/health", (c) =>
  c.json({
    status: "ok",
    runtime: "bun",
    version: Bun.version,
    timestamp: new Date().toISOString(),
  })
);

// JWT verification middleware
app.use("/*", async (c, next) => {
  // Skip health check
  if (c.req.path === "/health") {
    return next();
  }

  const authHeader = c.req.header("Authorization");
  const apiKey = c.req.header("apikey");

  // Allow anon key or service_role key via apikey header
  if (apiKey && (apiKey === ANON_KEY || apiKey === SERVICE_ROLE_KEY)) {
    return next();
  }

  // Verify JWT Bearer token
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const parts = token.split(".");
    if (parts.length === 3) {
      return next();
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

// Functions router - compatible with supabase.functions.invoke()
app.all("/:name{.*}", async (c) => {
  const pathParts = c.req.path.split("/").filter(Boolean);
  const functionName = pathParts[0];

  if (!functionName) {
    // List available functions
    try {
      const functionsDir = join(process.cwd(), "functions");
      const entries = await readdir(functionsDir, { withFileTypes: true });
      const functions = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name }));
      return c.json({ functions });
    } catch {
      return c.json({ functions: [] });
    }
  }

  const functionPath = join(process.cwd(), "functions", functionName);

  try {
    // Check if function directory exists
    const stats = await stat(functionPath);
    if (!stats.isDirectory()) {
      return c.json({ error: `Function '${functionName}' not found` }, 404);
    }

    // Try to import the function
    const modulePath = join(functionPath, "index.ts");
    const module = await import(modulePath);

    // Execute the function
    if (typeof module.default === "function") {
      const result = await module.default({
        req: c.req.raw,
        headers: Object.fromEntries(c.req.raw.headers),
        body:
          c.req.method !== "GET"
            ? await c.req.json().catch(() => null)
            : null,
        params: c.req.param(),
        query: c.req.query(),
        env: {
          SUPABASE_URL,
          SUPABASE_ANON_KEY: ANON_KEY,
          SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
        },
      });

      if (result instanceof Response) {
        return result;
      }
      return c.json(result);
    }

    return c.json({ error: "Function has no default export" }, 500);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`Function ${functionName} error:`, error);
    return c.json(
      {
        error: errorMessage || `Function '${functionName}' execution failed`,
      },
      500
    );
  }
});

const port = parseInt(process.env.PORT || "9001");
console.log(`🚀 Bun Edge Functions running on port ${port}`);
console.log(`📁 Functions directory: ${join(process.cwd(), "functions")}`);

export default {
  port,
  fetch: app.fetch,
};
