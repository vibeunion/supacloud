import { MAX_PAYLOAD_BYTES } from "./engine";
import { createImageServiceHandler, ENGINE_NAME, ENGINE_VERSION } from "./server";
import { configureWatermarkFont } from "./watermark";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
    console.log(`supacloud-image ${ENGINE_VERSION} (napi-rs)`);
    process.exit(0);
}

configureWatermarkFont();

const hostname = process.env.IMAGE_SERVICE_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.IMAGE_SERVICE_PORT || "9010", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid IMAGE_SERVICE_PORT: ${process.env.IMAGE_SERVICE_PORT}`);
    process.exit(1);
}

const server = Bun.serve({
    hostname,
    port,
    maxRequestBodySize: MAX_PAYLOAD_BYTES,
    fetch: createImageServiceHandler(),
});

console.log(`SupaCloud Image Service (${ENGINE_NAME}) listening on http://${server.hostname}:${server.port}`);
