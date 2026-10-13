export const DEPLOYMENT_UPGRADE = "DEPLOYMENT_UPGRADE_REQUIRED: Legacy deployment is no longer supported. Upgrade with `npm install -g @supacloud/cli@latest`, bind application.id and application.environmentId in supacloud.json (or SUPACLOUD_APPLICATION_ID and SUPACLOUD_ENV), then run `supacloud deploy`. SupaCloud owns deployment planning and activation; do not retry with legacy commands.";

const removedFrontendActions = new Set([
    "deploy_git", "deploy_upload", "redeploy", "upload_release", "activate_release",
]);
const removedDeployFlags = ["target", "id", "build_command", "output_dir", "plan", "diff", "dry_run"];

export function assertCurrentDeploymentInput(tool: string, input: unknown): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const args = input as Record<string, unknown>;
    if (tool === "frontend" && typeof args.action === "string" && removedFrontendActions.has(args.action)) {
        throw new Error(DEPLOYMENT_UPGRADE);
    }
    if (tool === "deploy" && removedDeployFlags.some(flag => Object.hasOwn(args, flag))) {
        throw new Error(`${DEPLOYMENT_UPGRADE} Put build settings in the frontend configuration. For read-only review use \`supacloud app deploy-plan\`.`);
    }
}
