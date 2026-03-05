import { config } from "./packages/management-api/src/config";

const BASE_URL = `http://localhost:${config.port}/api`;

async function testRoute(path: string, expectedStatus = 200) {
    console.log(`Testing ${path}...`);
    try {
        const resp = await fetch(`${BASE_URL}${path}`);
        console.log(`Status: ${resp.status}`);
        if (resp.status !== expectedStatus) {
            console.error(`FAILED: Expected ${expectedStatus}, got ${resp.status}`);
            return false;
        }
        const data = await resp.json();
        console.log(`Response length/count: ${Array.isArray(data) ? data.length : "object"}`);
        return true;
    } catch (e) {
        console.error(`ERROR: ${e}`);
        return false;
    }
}

async function runTests() {
    console.log("Starting Studio Compatibility API Tests...");

    // Platform API
    await testRoute("/platform/organizations");
    await testRoute("/platform/projects");
    await testRoute("/platform/projects/default/pg-meta/tables");
    await testRoute("/platform/projects/default/api-keys");

    // V1 API
    await testRoute("/v1/organizations");
    await testRoute("/v1/projects");
    await testRoute("/v1/projects/default/api-keys");
    await testRoute("/v1/projects/default/analytics/log-drains");

    console.log("Tests completed.");
}

runTests();
