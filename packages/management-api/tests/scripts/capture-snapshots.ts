import fs from "fs";
import path from "path";

// Recursively iterate over any JSON object to map it to its TypeScript-like schema representation
export function buildSchemaObject(obj: any): any {
    if (obj === null) return "null";
    if (Array.isArray(obj)) {
        if (obj.length === 0) return ["any"];
        // For array, assume uniform type, just take the first element's type
        return [buildSchemaObject(obj[0])];
    }
    if (typeof obj === "object") {
        const schema: any = {};
        for (const key of Object.keys(obj).sort()) { // sort to ensure consistent snapshots
            schema[key] = buildSchemaObject(obj[key]);
        }
        return schema;
    }
    // Return base type scalar
    return typeof obj;
}

async function capture() {
    const url = process.env.OFFICIAL_SUPABASE_URL;
    const key = process.env.OFFICIAL_SUPABASE_ANON_KEY;

    if (!url || !key) {
        console.warn("Skipping capture: OFFICIAL_SUPABASE_URL or OFFICIAL_SUPABASE_ANON_KEY not set.");
        console.warn("Set these to a real Supabase project to update ground truth snapshots.");
        process.exit(0);
    }

    const outputDir = path.join(__dirname, "../snapshots/ground_truth");
    fs.mkdirSync(outputDir, { recursive: true });

    async function recordEndpoint(method: string, endpoint: string, bodyObj: any | undefined, name: string) {
        console.log(`Capturing: ${name} (${method} ${endpoint})`);
        const res = await fetch(`${url}${endpoint}`, {
            method,
            headers: {
                "apikey": key!,
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json",
            },
            body: bodyObj ? JSON.stringify(bodyObj) : undefined
        });

        // We capture even error responses because we want to know the EXACT error payload shape!
        let data: any;
        const text = await res.text();
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }

        const schema = buildSchemaObject(data);
        fs.writeFileSync(
            path.join(outputDir, `${name}.json`), 
            JSON.stringify({ 
                status: res.status, 
                payloadType: typeof data,
                schema 
            }, null, 2)
        );
    }

    // Capture Auth Formats - 400 Bad Request shape
    await recordEndpoint("POST", "/auth/v1/signup", { email: "invalid", password: "1" }, "auth_signup_error");
    
    // Capture Storage Formats - List empty bucket (or 404 bucket)
    await recordEndpoint("POST", "/storage/v1/object/list/unknown_bucket", undefined, "storage_list_error");

    console.log("Snapshots captured successfully.");
}

if (require.main === module) {
    capture().catch(console.error);
}
