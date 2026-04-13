import { $ } from "bun";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ProjectService } from "../../src/services/project.service";

const SUPA_OPENAPI_URL = "https://api.supabase.com/api/v1-json";
const LOCAL_API_URL = "http://127.0.0.1:9090";

async function run() {
    console.log("\\n🚀 [OpenAPI Fuzzer] Initializing Strict OpenAPI Schema Compliance Checker...");

    // 1. Download official schema
    console.log(`📥 Fetching official OpenAPI Schema from ${SUPA_OPENAPI_URL}...`);
    let schemaJson: any;
    try {
        const res = await fetch(SUPA_OPENAPI_URL);
        if (!res.ok) throw new Error(\`Failed to fetch schema: \${res.statusText}\`);
        schemaJson = await res.json();
        console.log(\`✅ Successfully loaded Supabase OpenAPI v1 Schema (Keys: \${Object.keys(schemaJson.components.schemas).length})\`);
    } catch (e: any) {
        console.error("❌ Schema fetch failed:", e.message);
        process.exit(1);
    }

    // 2. Initialize strict JSON Schema validator
    const ajv = new Ajv({
        allErrors: true,
        strict: false,       // The official schema uses openapi extensions we don't need to strictly check
        removeAdditional: false // Don't strip our extensions, but flag them if schema says no AdditionalProperties
    });
    addFormats(ajv);

    // Register all schemas for $ref resolving
    for (const [key, schema] of Object.entries(schemaJson.components.schemas || {})) {
        ajv.addSchema(schema as object, \`#/components/schemas/\${key}\`);
    }

    // 3. Setup test data
    const projectService = new ProjectService();
    let projectRef = "openapi_validator1";
    let projectId: string;
    try {
        const project = await projectService.createProject({
            name: "openapi_test_tenant",
            region: "local"
        });
        projectId = project.id;
        projectRef = project.ref;
    } catch(e) {
         console.warn("Could not create project, using fallback routing...");
    }

    // Wait for systems
    await new Promise(r => setTimeout(r, 1000));

    // 4. Test suites definition mapping Endpoint -> Expected OpenAPI Schema Ref
    // Note: Supabase GET /v1/projects returns an Array of projects.
    const validationSuites = [
        {
            name: "GET /v1/projects",
            endpoint: \`\${LOCAL_API_URL}/v1/projects\`,
            schemaType: "array",          // Expects an array
            itemSchemaRef: "#/components/schemas/V1ProjectResponse" // Typical Supabase Project schema
        },
        {
            name: \`GET /v1/projects/:ref/api-keys\`,
            endpoint: \`\${LOCAL_API_URL}/v1/projects/\${projectRef}/api-keys\`,
            schemaType: "array",
            itemSchemaRef: "#/components/schemas/V1ApiKeyResponse"
        }
    ];

    console.log("\\n🔍 Commencing Schema Structural Interrogation...");
    let failureCount = 0;

    for (const suite of validationSuites) {
        try {
            console.log(\`\\n➡️  Probing \${suite.name}...\`);
            const res = await fetch(suite.endpoint, { headers: { 'Authorization': 'Bearer test' }});
            if (!res.ok) {
                 console.error(\`   ❌ HTTP Error \${res.status} \${res.statusText}\`);
                 failureCount++;
                 continue;
            }
            
            const data = await res.json();
            
            let validator;
            if (suite.schemaType === "array") {
                 validator = ajv.compile({
                      type: "array",
                      items: { $ref: suite.itemSchemaRef }
                 });
            } else {
                 validator = ajv.compile({ $ref: suite.itemSchemaRef });
            }

            const isValid = validator(data);
            if (!isValid) {
                console.error(\`   ❌ Schema Mismatch Detected!\`);
                // Print detailed validation errors
                validator.errors?.forEach(e => {
                    console.error(\`      - Path '\${e.instancePath}': \${e.message}\`);
                });
                failureCount++;
            } else {
                console.log(\`   ✅ Response perfectly mirrors official schema: \${suite.itemSchemaRef}\`);
            }
        } catch(e: any) {
             console.error(\`   ❌ Execution Error: \${e.message}\`);
             failureCount++;
        }
    }

    // Teardown
    console.log("\\n🧹 Cleaning up OpenAPI Fuzzer Environment...");
    if (projectId!) {
        await projectService.deleteProject(projectRef).catch(() => {});
    }

    if (failureCount > 0) {
         console.error(\`\\n💥 OpenAPI Compliance failed with \${failureCount} schema deviations.\`);
         // process.exit(1); // Allow failure reporting but in a real CI this would be fatal!
         // Wait, the user specifically requested "如果错发...测试程序也会无情地亮起红灯报错"
         process.exit(1);
    } else {
         console.log("\\n🎉 SUCCESS: All Management Payload Schemas achieved 100% parity!");
         process.exit(0);
    }
}

run();
