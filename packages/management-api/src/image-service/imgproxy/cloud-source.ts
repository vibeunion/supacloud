import { AwsClient } from "aws4fetch";
import { ImgproxyError } from "./errors";
import type { ImgproxyConfig } from "./config";

export type CloudSourceResponse = {
    response: Response;
    url: string;
};

export async function fetchCloudSource(
    url: string,
    config: ImgproxyConfig,
    signal?: AbortSignal,
): Promise<CloudSourceResponse | undefined> {
    const parsed = parseCloudUrl(url);
    if (!parsed) return undefined;

    const headers = new Headers({
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "SupaCloud-Image/1.0 (+https://github.com/vibeunion/supacloud)",
    });
    let response: Response;

    if (parsed.provider === "s3") {
        const target = buildS3Url(parsed.bucket, parsed.key, config);
        if (config.s3AccessKeyId && config.s3SecretAccessKey) {
            const client = new AwsClient({
                accessKeyId: config.s3AccessKeyId,
                secretAccessKey: config.s3SecretAccessKey,
                sessionToken: config.s3SessionToken || undefined,
                service: "s3",
                region: config.s3Region,
                retries: 0,
            });
            response = await client.fetch(target, { signal, headers });
        } else {
            response = await fetch(target, { signal, headers });
        }
    } else if (parsed.provider === "gcs") {
        const target = `${config.gcsEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(parsed.bucket)}/${encodePath(parsed.key)}`;
        if (config.gcsToken) headers.set("Authorization", `Bearer ${config.gcsToken}`);
        response = await fetch(target, { signal, headers });
    } else if (parsed.provider === "azure") {
        if (!config.azureEndpoint) {
            throw new ImgproxyError("Azure source support is not configured", 503);
        }
        const target = `${config.azureEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(parsed.bucket)}/${encodePath(parsed.key)}${config.azureSasToken ? `?${config.azureSasToken.replace(/^\?/, "")}` : ""}`;
        if (config.azureBearerToken) headers.set("Authorization", `Bearer ${config.azureBearerToken}`);
        response = await fetch(target, { signal, headers });
    } else {
        if (!config.swiftEndpoint) {
            throw new ImgproxyError("Swift source support is not configured", 503);
        }
        const target = `${config.swiftEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(parsed.bucket)}/${encodePath(parsed.key)}`;
        if (config.swiftToken) headers.set("X-Auth-Token", config.swiftToken);
        response = await fetch(target, { signal, headers });
    }

    return { response, url: parsed.originalUrl };
}

type ParsedCloudUrl = {
    provider: "s3" | "gcs" | "azure" | "swift";
    bucket: string;
    key: string;
    originalUrl: string;
};

function parseCloudUrl(value: string): ParsedCloudUrl | undefined {
    const parsed = (() => {
        try {
            return new URL(value);
        } catch {
            return undefined;
        }
    })();
    if (!parsed) return undefined;

    const providerByProtocol: Record<string, ParsedCloudUrl["provider"] | undefined> = {
        "s3:": "s3",
        "gs:": "gcs",
        "gcs:": "gcs",
        "az:": "azure",
        "azure:": "azure",
        "swift:": "swift",
    };
    const provider = providerByProtocol[parsed.protocol];
    if (!provider || !parsed.hostname) return undefined;
    const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!key) throw new ImgproxyError("Cloud source object key is empty", 400);
    return { provider, bucket: decodeURIComponent(parsed.hostname), key, originalUrl: value };
}

function buildS3Url(bucket: string, key: string, config: ImgproxyConfig): string {
    const endpoint = config.s3Endpoint.replace(/\/+$/, "");
    const encodedKey = encodePath(key);
    if (config.s3VirtualHostStyle) {
        const parsed = new URL(endpoint);
        parsed.hostname = `${bucket}.${parsed.hostname}`;
        parsed.pathname = `/${encodedKey}`;
        return parsed.toString();
    }
    return `${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`;
}

function encodePath(value: string): string {
    return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
