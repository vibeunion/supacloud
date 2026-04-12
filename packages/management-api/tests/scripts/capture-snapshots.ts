import fs from "fs";
import path from "path";

export function buildSchemaObject(obj: any): any {
    if (obj === null) return "null";
    if (Array.isArray(obj)) {
        if (obj.length === 0) return ["any"];
        return [buildSchemaObject(obj[0])];
    }
    if (typeof obj === "object") {
        const schema: any = {};
        for (const key of Object.keys(obj).sort()) {
            schema[key] = buildSchemaObject(obj[key]);
        }
        return schema;
    }
    return typeof obj;
}

async function capture() {
    const url = process.env.OFFICIAL_SUPABASE_URL;
    const key = process.env.OFFICIAL_SUPABASE_ANON_KEY;
    const serviceKey = process.env.OFFICIAL_SUPABASE_SERVICE_KEY;

    if (!url || !key) {
        console.warn("Skipping capture: OFFICIAL_SUPABASE_URL or OFFICIAL_SUPABASE_ANON_KEY not set.");
        console.warn("Set these to a real Supabase project to update ground truth snapshots.");
        process.exit(0);
    }

    const outputDir = path.join(__dirname, "../snapshots/ground_truth");
    fs.mkdirSync(outputDir, { recursive: true });

    async function recordEndpoint(method: string, endpoint: string, bodyObj: any | undefined, name: string, useServiceKey = false) {
        console.log(`Capturing: ${name} (${method} ${endpoint})`);
        const effectiveKey = useServiceKey && serviceKey ? serviceKey : key;
        const res = await fetch(`${url}${endpoint}`, {
            method,
            headers: {
                "apikey": effectiveKey!,
                "Authorization": `Bearer ${effectiveKey}`,
                "Content-Type": "application/json",
            },
            body: bodyObj ? JSON.stringify(bodyObj) : undefined
        });

        let data: any;
        const text = await res.text();
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }

        const schema = buildSchemaObject(data);
        const headers: Record<string, string> = {};
        res.headers.forEach((val, key) => { headers[key] = val; });

        fs.writeFileSync(
            path.join(outputDir, `${name}.json`),
            JSON.stringify({
                status: res.status,
                payloadType: typeof data,
                schema,
                keyHeaders: {
                    'x-supabase-api-version': res.headers.get('x-supabase-api-version'),
                    'content-type': res.headers.get('content-type'),
                    'link': res.headers.get('link'),
                    'x-total-count': res.headers.get('x-total-count'),
                    'content-range': res.headers.get('content-range'),
                }
            }, null, 2)
        );
    }

    await recordEndpoint("POST", "/auth/v1/signup", { email: "invalid", password: "1" }, "auth_signup_error");
    await recordEndpoint("POST", "/storage/v1/object/list/unknown_bucket", undefined, "storage_list_error");

    await recordEndpoint("GET", "/rest/v1/", undefined, "postgrest_openapi_root");
    
    await recordEndpoint("POST", "/auth/v1/token?grant_type=password", { email: "nonexistent@test.com", password: "wrong" }, "auth_token_error");

    if (serviceKey) {
        await recordEndpoint("GET", "/auth/v1/admin/users?page=1&per_page=1", undefined, "auth_admin_list_users", true);
    }

    console.log("Snapshots captured successfully.");
}

if (typeof require !== 'undefined' && require.main === module) {
    capture().catch(console.error);
}

export { capture };
