// Example Bun Edge Function
// Compatible with supabase.functions.invoke('hello', { body: { name: 'World' } })

export interface FunctionContext {
    req: Request;
    headers: Record<string, string>;
    body: unknown;
    params: Record<string, string>;
    query: Record<string, string>;
    env: {
        SUPABASE_URL?: string;
        SUPABASE_ANON_KEY?: string;
        SUPABASE_SERVICE_ROLE_KEY?: string;
    };
}

interface HelloBody {
    name?: string;
}

interface HelloQuery {
    name?: string;
}

export default async function handler(ctx: FunctionContext) {
    const body = ctx.body as HelloBody | null;
    const query = ctx.query as HelloQuery;
    const name = body?.name || query?.name || "World";

    return {
        message: `Hello, ${name}!`,
        runtime: "bun",
        version: typeof Bun !== "undefined" ? Bun.version : "unknown",
        timestamp: new Date().toISOString(),
    };
}
