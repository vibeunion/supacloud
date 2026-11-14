import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import { registerTool, type ToolResult, type ToolServer } from "../tool-server";

export interface PipelineToolOptions {
    cwd?: string;
}

export const pipelineToolSchema: ToolSchema = {
    action: withDescription(stringEnum(["connect"]), "Pipeline configuration action"),
    provider: optional(stringEnum(["github", "gitlab"]), "[connect] Git provider (default: github)"),
    root: optional(Type.String(), "[connect] Repository root (default: current directory)"),
    write: optional(Type.Boolean(), "[connect] Write the generated workflow"),
    preview: optional(Type.Boolean(), "[connect] Include pull request Preview lifecycle"),
    format: optional(stringEnum(["text", "json"]), "Output format (default: text)"),
};

function textResult(text: string, isError = false): ToolResult {
    return { isError, content: [{ type: "text", text }] };
}

function jsonResult(value: unknown, isError = false): ToolResult {
    return textResult(JSON.stringify(value, null, 2), isError);
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return record(parsed) ?? {};
}

function workflow(provider: string, preview: boolean): string {
    if (provider !== "github") {
        return [
            "stages:",
            "  - deploy",
            "",
            "supacloud_deploy:",
            "  stage: deploy",
            "  image: node:24",
            "  rules:",
            "    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'",
            "  variables:",
            "    SUPACLOUD_API_URL: $SUPACLOUD_API_URL",
            "    SUPACLOUD_API_TOKEN: $SUPACLOUD_DEPLOY_TOKEN",
            "    SUPACLOUD_PROJECT_REF: $SUPACLOUD_PROJECT_REF",
            "  script:",
            "    - npx @supacloud/cli deploy",
            "",
        ].join("\n");
    }
    const events = preview ? "  push:\n    branches: [main]\n  pull_request:\n    types: [opened, synchronize, reopened, closed]" : "  push:\n    branches: [main]";
    const previewSteps = preview ? [
        "      - name: Provision or reclaim PR Preview",
        "        if: \${{ github.event_name == 'pull_request' }}",
        "        env:",
        "          SUPACLOUD_API_TOKEN: \${{ secrets.SUPACLOUD_DEPLOY_TOKEN }}",
        "          SUPACLOUD_API_URL: \${{ secrets.SUPACLOUD_API_URL }}",
        "          SUPACLOUD_PROJECT_REF: \${{ secrets.SUPACLOUD_PROJECT_REF }}",
        "        run: >-",
        "          npx @supacloud/cli --env test app preview-pr",
        "          --id \${{ vars.SUPACLOUD_APPLICATION_ID }}",
        "          --environment_id \${{ vars.SUPACLOUD_ENVIRONMENT_ID }}",
        "          --pull_request_action \${{ github.event.action == 'closed' && 'closed' || 'opened' }}",
        "          --repository \${{ github.repository }}",
        "          --pull_request_number \${{ github.event.pull_request.number }}",
        "          --release_id \${{ vars.SUPACLOUD_RELEASE_ID }}",
    ].join("\n") : "";
    return `name: SupaCloud deploy\n\non:\n${events}\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Deploy to SupaCloud\n        if: \${{ github.event_name == 'push' || github.event.action == '' }}\n        env:\n          SUPACLOUD_API_URL: \${{ secrets.SUPACLOUD_API_URL }}\n          SUPACLOUD_API_TOKEN: \${{ secrets.SUPACLOUD_DEPLOY_TOKEN }}\n          SUPACLOUD_PROJECT_REF: \${{ secrets.SUPACLOUD_PROJECT_REF }}\n        run: npx @supacloud/cli deploy\n${previewSteps}`;
}

export async function connectPipeline(args: Record<string, unknown>, options: PipelineToolOptions = {}): Promise<ToolResult> {
    const root = resolve(typeof args.root === "string" ? args.root : options.cwd ?? process.cwd());
    const provider = typeof args.provider === "string" ? args.provider : "github";
    const config = await readJson(join(root, "supacloud.json"));
    const frontend = record(config.frontend);
    const packageJson = await readJson(join(root, "package.json"));
    const scripts = record(packageJson.scripts);
    const buildCommand = typeof frontend?.buildCommand === "string"
        ? frontend.buildCommand
        : typeof scripts?.build === "string" ? scripts.build : "(configure package.json build script)";
    const outputDirectory = typeof frontend?.outputDirectory === "string" ? frontend.outputDirectory : "dist";
    const workflowPath = provider === "github"
        ? join(root, ".github", "workflows", "supacloud-deploy.yml")
        : join(root, ".gitlab-ci.yml");
    const result = {
        schema: "supacloud.pipeline-connection.v1",
        provider,
        root,
        detected: { build_command: buildCommand, output_directory: outputDirectory },
        workflow: workflowPath,
        secrets: ["SUPACLOUD_DEPLOY_TOKEN", "SUPACLOUD_API_URL", "SUPACLOUD_PROJECT_REF"],
        variables: args.preview === true
            ? ["SUPACLOUD_APPLICATION_ID", "SUPACLOUD_ENVIRONMENT_ID", "SUPACLOUD_RELEASE_ID"]
            : [],
        preview: args.preview === true,
        safety: ["workflow contains no secret values", "provider token remains in the provider secret store"],
    };
    if (args.write !== true) return args.format === "json" ? jsonResult({ ...result, written: false }) : textResult([
        `Pipeline provider: ${provider}`,
        `build: ${buildCommand}`,
        `output: ${outputDirectory}`,
        `workflow: ${workflowPath}`,
        "No files were changed. Re-run with --write after reviewing the generated workflow.",
    ].join("\n"));
    if (provider === "gitlab" && existsSync(workflowPath)) {
        throw new Error(`Refusing to overwrite existing GitLab workflow: ${workflowPath}`);
    }
    await mkdir(resolve(workflowPath, ".."), { recursive: true });
    await writeFile(workflowPath, workflow(provider, args.preview === true), { encoding: "utf8", mode: 0o644 });
    return jsonResult({ ...result, written: true });
}

export function registerPipelineTools(server: ToolServer, options: PipelineToolOptions = {}): void {
    registerTool(server, "pipeline", "Generate a provider workflow for deployment and optional PR Preview lifecycle.", pipelineToolSchema,
        args => connectPipeline(args as Record<string, unknown>, options));
}

