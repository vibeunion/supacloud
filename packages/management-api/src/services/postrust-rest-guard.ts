/**
 * Paths the pinned Postrust image serves beside PostgREST-compatible REST.
 * v3.4.0 has no environment switch for them. The public gateway and the
 * project REST proxy both refuse these suffixes before a request can be
 * stripped onto the tenant process.
 */
export const BLOCKED_POSTRUST_REST_PATH_REGEXP =
    "^/rest/v1/(?:admin(?:/.*)?|_(?:/.*)?|api/graphql(?:/.*)?|v1/graphql(?:/.*)?|v1alpha1/graphql(?:/.*)?)/?$";

/**
 * Caddy rewrites the `columns` query value with these operations, in order.
 * The first pattern strips one pair of surrounding quotes from each field.
 * The second turns a doubled quote, which is how a quote inside a name is
 * escaped, back into one quote. Kept in this shape so the gateway JSON and
 * the proxy helper stay the same translation.
 */
export const POSTRUST_COLUMNS_QUOTE_PATTERN = String.raw`\s*"((?:[^"]|"")*)"\s*`;

export const POSTRUST_COLUMNS_QUERY_REPLACE = [
    {
        key: "columns",
        search_regexp: POSTRUST_COLUMNS_QUOTE_PATTERN,
        replace: "$1",
    },
    {
        key: "columns",
        search: "\"\"",
        replace: "\"",
    },
] as const;

/** supabase-js quotes bulk-insert column names. Postrust keeps those quotes in the name. */
export function normalizePostgrestColumnsParam(value: string): string {
    return value.split(",").map((part) => {
        const trimmed = part.trim();
        if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            return trimmed.slice(1, -1).replaceAll("\"\"", "\"");
        }
        return trimmed;
    }).join(",");
}

/** The same translation Caddy applies on the public `/rest/v1*` route. */
export function applyPublicColumnsQueryRewrite(value: string): string {
    const stripped = value.replace(new RegExp(POSTRUST_COLUMNS_QUOTE_PATTERN, "g"), "$1");
    return stripped.replaceAll("\"\"", "\"");
}

export function isBlockedPostrustUpstreamPath(targetPath: string): boolean {
    let path = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
    try {
        path = decodeURIComponent(path);
    } catch {
        return true;
    }
    const resolved: string[] = [];
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    const [first, second] = resolved;
    if (first === "admin" || first === "_") return true;
    return (first === "api" || first === "v1" || first === "v1alpha1") && second === "graphql";
}
