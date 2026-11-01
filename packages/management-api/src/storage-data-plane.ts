/**
 * Storage data plane.
 *
 * Public /storage/v1 traffic prefers the Management API and, when that listener
 * refuses the connection, uses this process. It is not a child of the Management
 * API and it is not a standby database. PostgreSQL remains the metadata store.
 */
import { Elysia } from "elysia";
import { config } from "./config";
import { storageCompatRoutes } from "./routes/storage-compat";

const hostname = process.env.STORAGE_DATA_PLANE_HOST || "127.0.0.1";

export function createStorageDataPlaneApp(): Elysia {
    return new Elysia()
        .get("/health", () => ({ status: "ok", role: "storage-data-plane" }))
        .use(storageCompatRoutes)
        .group("/storage/v1", (group) => group.use(storageCompatRoutes));
}

if (import.meta.main) {
    const app = createStorageDataPlaneApp();
    app.listen({ hostname, port: config.storageDataPlanePort });
    console.log(`[storage-data-plane] listening on ${hostname}:${config.storageDataPlanePort}`);
}
