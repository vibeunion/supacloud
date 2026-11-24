// Default-off evaluation of the GraphQL surface compiled into the pinned
// Postrust REST process. Public project GraphQL stays /graphql/v1 → pg_graphql.
// See docs/postrust-graphql-evaluation.md.

export const POSTRUST_GRAPHQL_EVALUATION_ENV = "SUPACLOUD_POSTRUST_GRAPHQL";

export const POSTRUST_GRAPHQL_EVALUATION_ROUTE_KIND = "postrust-graphql";

/** Project-host paths. The trailing slash is the same route, not a second API. */
export const POSTRUST_GRAPHQL_EVALUATION_PATHS = [
    "/internal/postrust/graphql",
    "/internal/postrust/graphql/",
] as const;

/** Path on the tenant REST port. Not published as a project-host match. */
export const POSTRUST_GRAPHQL_UPSTREAM_URI = "/v1/graphql";

/**
 * Only the exact string `true` opens the evaluation route.
 * Unset, empty, `false`, `1`, and `yes` stay closed.
 */
export function postrustGraphqlEvaluationEnabled(
    value: string | undefined = process.env[POSTRUST_GRAPHQL_EVALUATION_ENV],
): boolean {
    return value === "true";
}
