
import { Hono } from "hono";
import { serve } from "bun";
import { uiApp } from "./routes/ui";
import { apiApp } from "./routes/api";
import { authApp, authMiddleware } from "./routes/auth";
import { initManager, checkAndInstallDockerCompose, startBase, upgradeManager } from "./lib/system";
import { deps, exists } from "./lib/deps";
import { createProject, getNextPorts, createDatabase } from "./lib/projects";

// --- Main App ---
const app = new Hono();

// Middleware
app.use('*', authMiddleware);

// Routes
app.route('/', authApp); // Login routes
app.route('/', uiApp);   // UI routes
app.route('/', apiApp);  // API routes

// Static Assets (if any, currently loaded from CDN or inline)
app.get('/favicon.ico', (c) => c.text('')); // Placeholder


// --- Export for Testing ---
const handler = app.fetch;
export {
    deps,
    createProject,
    getNextPorts,
    exists,
    createDatabase,
    initManager,
    handler,
    upgradeManager
};

// --- Main Entry Point ---
if (import.meta.main) {
    const argOffset = 2; // Approximate
    const command = process.argv[argOffset] || "help";

    await initManager();
    await checkAndInstallDockerCompose();

    if (command === "start") {
        await startBase();
        console.log("Starting Manager API...");
        serve({
            fetch: app.fetch,
            port: 8888,
        });
        console.log(`Manager listening on http://localhost:8888`);
    } else if (command === "create") {
        // CLI Create
        const name = process.argv[argOffset + 1];
        if (name) await createProject(name);
    } else if (command === "upgrade") {
        await upgradeManager();
    }
    // ... Other CLI commands (status, help)
}
