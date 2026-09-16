import { Elysia } from "elysia";

export type DocumentationSource<T> = T | (() => T | Promise<T>);

export interface OpenApiDocumentationOptions {
  /** Generated OpenAPI document, usually imported from generated/openapi.ts. */
  document: DocumentationSource<Record<string, unknown>>;
  /** JSON specification endpoint. */
  specPath?: string;
  /** Human-readable documentation page. */
  uiPath?: string;
  title?: string;
}

export interface GraphqlDocumentationOptions {
  /** Role-scoped SDL snapshot, usually loaded from graphql/schema.graphql. */
  schema: DocumentationSource<string>;
  /** SDL endpoint. */
  schemaPath?: string;
  /** Human-readable schema page. */
  uiPath?: string;
  title?: string;
}

export interface ApplicationDocumentationOptions {
  openApi?: OpenApiDocumentationOptions;
  graphql?: GraphqlDocumentationOptions;
}

function normalizePath(value: string | undefined, fallback: string): string {
  const path = value ?? fallback;
  if (!path.trim() || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error(`Documentation path must be an absolute path without query or fragment: ${path}`);
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function resolveSource<T>(source: DocumentationSource<T>): Promise<T> {
  if (typeof source === "function") {
    return Promise.resolve((source as () => T | Promise<T>)());
  }
  return Promise.resolve(source);
}

function jsonResponse(document: Record<string, unknown>): Response {
  const serialized = JSON.stringify(document);
  if (serialized === undefined) throw new Error("OpenAPI documentation must be JSON-serializable");
  return new Response(serialized, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(schema: string): Response {
  return new Response(schema, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderViewerPage(title: string, resourcePath: string, mode: "json" | "text"): string {
  const parse = mode === "json"
    ? "const value = await response.json(); output.textContent = JSON.stringify(value, null, 2);"
    : "output.textContent = await response.text();";
  const safeTitle = escapeHtml(title);
  const safeResourcePath = escapeHtml(resourcePath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
    header { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
    h1 { font: 600 20px system-ui, sans-serif; margin: 0; }
    a { color: LinkText; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
  </style>
</head>
<body>
  <header><h1>${safeTitle}</h1><a href="${safeResourcePath}">${safeResourcePath}</a></header>
  <pre id="output">Loading...</pre>
  <script>
    const output = document.getElementById("output");
    fetch(${scriptString(resourcePath)}, { headers: { "accept": "${mode === "json" ? "application/json" : "text/plain"}" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        ${parse}
      })
      .catch((error) => { output.textContent = "Unable to load documentation: " + error.message; });
  </script>
</body>
</html>`;
}

/**
 * Mount opt-in, read-only documentation endpoints for a compiled application.
 * The plugin has no external UI dependency and does not enable GraphQL introspection.
 */
export function createDocumentationPlugin(
  options: ApplicationDocumentationOptions = {},
): Elysia {
  const app = new Elysia({ name: "supacloud:documentation" });
  const paths = new Set<string>();
  const reserve = (path: string): void => {
    if (paths.has(path)) throw new Error(`Duplicate documentation path: ${path}`);
    paths.add(path);
  };

  if (options.openApi) {
    const specPath = normalizePath(options.openApi.specPath, "/openapi.json");
    const uiPath = normalizePath(options.openApi.uiPath, "/docs");
    reserve(specPath);
    reserve(uiPath);
    const title = options.openApi.title ?? "OpenAPI Documentation";
    app.get(specPath, async () => jsonResponse(await resolveSource(options.openApi!.document)), {
      detail: { hide: true },
    });
    app.get(uiPath, () => new Response(renderViewerPage(title, specPath, "json"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    }), { detail: { hide: true } });
  }

  if (options.graphql) {
    const schemaPath = normalizePath(options.graphql.schemaPath, "/graphql/schema.graphql");
    const uiPath = normalizePath(options.graphql.uiPath, "/graphql/docs");
    reserve(schemaPath);
    reserve(uiPath);
    const title = options.graphql.title ?? "GraphQL Schema";
    app.get(schemaPath, async () => textResponse(await resolveSource(options.graphql!.schema)), {
      detail: { hide: true },
    });
    app.get(uiPath, () => new Response(renderViewerPage(title, schemaPath, "text"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    }), { detail: { hide: true } });
  }

  return app;
}
