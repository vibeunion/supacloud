import { SQL } from "bun";
import { FrontendService } from "../../src/services/frontend.service";
import { createFrontendDeploymentLock } from "../../src/services/frontend-deployment-lock";
import { FrontendEnvironmentConflictError } from "../../src/utils/frontend-environment-revision";
import { FrontendConfigurationConflictError } from "../../src/utils/frontend-configuration-revision";

const [url, baseDir, deploymentId, revision, value, mode = "environment"] = Bun.argv.slice(2);
if (!url || !baseDir || !deploymentId || !revision || !value) throw new Error("Missing fixture arguments");
if (mode !== "environment" && mode !== "configuration") throw new Error("Invalid fixture mode");
const database = new SQL(url, { max: 1, connectionTimeout: 3 });
try {
  const service = new FrontendService(baseDir, createFrontendDeploymentLock(database));
  try {
    const deployment = mode === "configuration"
      ? await service.saveBuildConfiguration("proj123", deploymentId, {
        build_command: value, output_dir: ".", install_command: "", node_version: "20", health_check_path: "/",
      }, `https://example.com/${value}.git`, value, revision)
      : await service.setEnvVars("proj123", deploymentId, { TOKEN: value }, "replace", revision);
    if (!deployment) throw new Error("Missing fixture deployment");
    console.log(JSON.stringify({ outcome: "saved", value: mode === "configuration" ? deployment.build_command : deployment.env_vars["TOKEN"] }));
  } catch (error: unknown) {
    if (!(mode === "configuration" ? error instanceof FrontendConfigurationConflictError : error instanceof FrontendEnvironmentConflictError)) throw error;
    console.log(JSON.stringify({ outcome: "conflict" }));
  }
} finally {
  await database.close({ timeout: 1 });
}
