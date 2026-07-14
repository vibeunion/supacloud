import { $ } from "bun";
import * as p from "@clack/prompts";
import { config } from "../config";

const API_URL = config.supacloudApiUrl;

async function getMasterToken(): Promise<string> {
    if (config.masterToken && config.masterToken !== "dev-master-token") {
        return config.masterToken;
    }
    console.error("Error: MASTER_TOKEN environment variable is required");
    console.error("Set it with: export MASTER_TOKEN=your-token");
    process.exit(1);
}

let cachedToken: string | null = null;

async function apiRequest(method: string, path: string, body?: unknown) {
    if (!cachedToken) {
        cachedToken = await getMasterToken();
    }
    const response = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${cachedToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error: ${response.status} - ${error}`);
    }
    return response.json();
}

export async function handleProjectCreate(args: string[]) {
    p.intro("🚀 Creating a new SupaCloud project...");

    const nameIndex = args.indexOf("--name");
    const domainIndex = args.indexOf("--domain");
    const regionIndex = args.indexOf("--region");

    const name = nameIndex !== -1 ? args[nameIndex + 1] : undefined;
    const domain = domainIndex !== -1 ? args[domainIndex + 1] : undefined;
    const region = regionIndex !== -1 ? args[regionIndex + 1] : undefined;

    let projectName: string | undefined = name;
    let projectDomain: string | undefined = domain;
    let projectRegion: string | undefined = region;

    if (!projectName) {
        const input = await p.text({
            message: "Enter project name:",
            placeholder: "my-project",
            validate: (value) => {
                if (!value || value.length < 1) return "Project name is required";
                if (value.length > 100) return "Project name must be less than 100 characters";
            },
        });
        if (p.isCancel(input)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }
        projectName = input;
    }

    if (!projectDomain) {
        const useCustomDomain = await p.confirm({
            message: "Do you want to use a custom domain?",
            initialValue: false,
        });
        if (p.isCancel(useCustomDomain)) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }
        if (useCustomDomain) {
            const input = await p.text({
                message: "Enter custom domain (e.g., example.com):",
                placeholder: "example.com",
                validate: (value) => {
                    if (!value) return "Domain is required";
                    if (!/^[a-z0-9.-]+$/.test(value)) return "Invalid domain format";
                },
            });
            if (p.isCancel(input)) {
                p.cancel("Operation cancelled");
                process.exit(0);
            }
            projectDomain = input;
        }
    }

    const s = p.spinner();
    s.start("Creating project...");

    try {
        const body: Record<string, string> = { name: projectName! };
        if (projectDomain) body.domain = projectDomain;
        if (projectRegion) body.region = projectRegion;

        const result = await apiRequest("POST", "/v1/projects", body);
        s.stop("Project created successfully!");

        p.log.success(`Project: ${result.name}`);
        p.log.info(`Ref: ${result.ref}`);
        p.log.info(`Status: ${result.status}`);
        p.log.info(`API URL: ${result.api.url}`);
        p.log.info(`Studio URL: ${result.studio.url}`);

        console.log("\n  API credentials (shown once):");
        console.log(`  Publishable key: ${result.publishable_key}`);
        console.log(`  Secret key: ${result.secret_key}`);
        console.log(`  Legacy anon key: ${result.anon_key}`);
        console.log(`  Legacy service_role key: ${result.service_role_key}`);
        console.log("");

        p.outro("✅ Project creation initiated. Store the secret credentials now; they will be masked later.");
    } catch (error: unknown) {
        s.stop("Failed to create project");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectList() {
    p.intro("📋 Listing all SupaCloud projects...");

    const s = p.spinner();
    s.start("Fetching projects...");

    try {
        const result = await apiRequest("GET", "/v1/projects");
        s.stop(`Found ${result.length} project(s)`);

        if (result.length === 0) {
            p.log.info("No projects found. Create one with 'supacloud project create'");
        } else {
            console.log("\n");
            for (const project of result) {
                console.log(`  📦 ${project.name} (${project.ref})`);
                console.log(`     Status: ${project.status}`);
                console.log(`     API: ${project.api.url}`);
                console.log(`     Studio: ${project.studio.url}`);
                console.log("");
            }
        }

        p.outro("Done");
    } catch (error: unknown) {
        s.stop("Failed to fetch projects");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectGet(ref: string) {
    p.intro(`🔍 Getting project details: ${ref}`);

    const s = p.spinner();
    s.start("Fetching project...");

    try {
        const result = await apiRequest("GET", `/v1/projects/${ref}`);
        s.stop("Project found");

        console.log("\n");
        console.log(`  Name: ${result.name}`);
        console.log(`  Ref: ${result.ref}`);
        console.log(`  Status: ${result.status}`);
        console.log(`  Region: ${result.region}`);
        console.log(`  Created: ${result.created_at}`);
        console.log(`  API URL: ${result.api.url}`);
        console.log(`  Studio URL: ${result.studio.url}`);
        console.log(`  Database: ${result.database.name}`);
        console.log("");

        p.outro("Done");
    } catch (error: unknown) {
        s.stop("Failed to fetch project");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectDelete(ref: string, args: string[]) {
    p.intro(`🗑️ Deleting project: ${ref}`);

    const skipConfirm = args.includes("--yes") || args.includes("-y");

    if (!skipConfirm) {
        const confirm = await p.confirm({
            message: `Are you sure you want to delete project ${ref}? This action cannot be undone.`,
            initialValue: false,
        });

        if (p.isCancel(confirm) || !confirm) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }
    }

    const s = p.spinner();
    s.start("Deleting project...");

    try {
        await apiRequest("DELETE", `/v1/projects/${ref}`);
        s.stop("Project deletion initiated");

        p.outro(`✅ Project ${ref} is being deleted. Resources will be cleaned up shortly.`);
    } catch (error: unknown) {
        s.stop("Failed to delete project");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectPause(ref: string) {
    p.intro(`⏸️ Pausing project: ${ref}`);

    const s = p.spinner();
    s.start("Pausing project...");

    try {
        const result = await apiRequest("POST", `/v1/projects/${ref}/pause`);
        s.stop("Project paused");

        p.outro(`✅ Project ${ref} is now paused`);
    } catch (error: unknown) {
        s.stop("Failed to pause project");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectRestore(ref: string) {
    p.intro(`▶️ Restoring project: ${ref}`);

    const s = p.spinner();
    s.start("Restoring project...");

    try {
        const result = await apiRequest("POST", `/v1/projects/${ref}/restore`);
        s.stop("Project restored");

        p.outro(`✅ Project ${ref} is now active`);
    } catch (error: unknown) {
        s.stop("Failed to restore project");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectRestart(ref: string) {
    p.intro(`🔄 Restarting project: ${ref}`);

    const s = p.spinner();
    s.start("Restarting project...");

    try {
        const result = await apiRequest("POST", `/v1/projects/${ref}/restart`);
        s.stop("Project restart initiated");

        p.outro(`✅ Project ${ref} is restarting`);
    } catch (error: unknown) {
        s.stop("Failed to restart project");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectKeys(ref: string) {
    p.intro(`🔑 Getting API keys for project: ${ref}`);

    const s = p.spinner();
    s.start("Fetching API keys...");

    try {
        const result = await apiRequest("GET", `/v1/projects/${ref}/api-keys`) as Array<{
            name: string;
            api_key: string;
        }>;
        s.stop("API keys retrieved");

        const keys = Object.fromEntries(result.map((item) => [item.name, item.api_key]));

        console.log("\n");
        console.log(`  publishable key: ${keys.publishable || ""}`);
        console.log(`  secret key: ${keys.secret || "********"}`);
        console.log(`  legacy anon key: ${keys.anon || ""}`);
        console.log(`  legacy service_role key: ${keys.service_role || "********"}`);
        console.log("");

        p.outro("⚠️ Keep these keys secure!");
    } catch (error: unknown) {
        s.stop("Failed to fetch API keys");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectRotateKeys(ref: string, args: string[]) {
    p.intro(`🔄 Rotating API keys for project: ${ref}`);

    const skipConfirm = args.includes("--yes") || args.includes("-y");

    if (!skipConfirm) {
        const confirm = await p.confirm({
            message: `Are you sure you want to rotate API keys for ${ref}? Existing keys will stop working.`,
            initialValue: false,
        });

        if (p.isCancel(confirm) || !confirm) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }
    }

    const s = p.spinner();
    s.start("Rotating API keys...");

    try {
        const result = await apiRequest("POST", `/v1/projects/${ref}/api-keys/rotate`);
        s.stop("API keys rotated");

        console.log("\n");
        console.log(`  New anon key: ${result.anon_key}`);
        console.log(`  New service_role key: ${result.service_role_key || "********"}`);
        console.log("");

        p.outro("✅ Legacy JWT API keys have been rotated. Existing user sessions and legacy keys are revoked.");
    } catch (error: unknown) {
        s.stop("Failed to rotate API keys");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export async function handleProjectRotateOpaqueKeys(ref: string, args: string[]) {
    p.intro(`🔄 Rotating opaque API keys for project: ${ref}`);

    const skipConfirm = args.includes("--yes") || args.includes("-y");
    if (!skipConfirm) {
        const confirm = await p.confirm({
            message: `Rotate the Publishable and Secret keys for ${ref}? Legacy JWT sessions will remain valid.`,
            initialValue: false,
        });
        if (p.isCancel(confirm) || !confirm) {
            p.cancel("Operation cancelled");
            process.exit(0);
        }
    }

    const s = p.spinner();
    s.start("Rotating opaque API keys...");
    try {
        const result = await apiRequest("POST", `/v1/projects/${ref}/api-keys/rotate-opaque`);
        s.stop("Opaque API keys rotated");
        console.log("\n");
        console.log(`  New publishable key: ${result.publishable_key}`);
        console.log(`  New secret key (shown once): ${result.secret_key}`);
        console.log("");
        p.outro("✅ Opaque API keys rotated without changing JWT_SECRET or legacy JWT keys.");
    } catch (error: unknown) {
        s.stop("Failed to rotate opaque API keys");
        p.log.error((error instanceof Error ? error.message : String(error)));
        process.exit(1);
    }
}

export function printProjectHelp() {
    console.log(`
    SupaCloud Project Management CLI
    
    Usage:
      supacloud project create [--name <name>] [--domain <domain>] [--region <region>]
                              Create a new project
      supacloud project list    List all projects
      supacloud project get <ref>    Get project details
      supacloud project delete <ref> [--yes] Delete a project
      supacloud project pause <ref>  Pause a project
      supacloud project restore <ref> Restore a paused project
      supacloud project restart <ref> Restart a project
      supacloud project keys <ref>   Get API keys
      supacloud project rotate-keys <ref> [--yes] Rotate legacy JWT API keys
      supacloud project rotate-opaque-keys <ref> [--yes]
                              Rotate Publishable/Secret keys only
    
    Options:
      --name <name>     Project name
      --domain <domain> Custom domain (e.g., example.com)
                        API will be at api.<domain>, Studio at studio.<domain>
      --region <region> Project region (default: local)
      --yes, -y         Skip confirmation prompts
    
    Examples:
      supacloud project create --name myapp --domain example.com
      supacloud project list
      supacloud project delete abc123 --yes
  `);
}
