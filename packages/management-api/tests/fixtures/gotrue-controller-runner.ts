import { GotrueRuntimeController } from "../../src/services/tenant-runtime.service";
import {
  resolveAuthExecutionPolicy,
  type AuthExecutionPolicy,
} from "../../src/services/auth-execution-policy";

let reads = 0;
const controller = new GotrueRuntimeController(async (): Promise<AuthExecutionPolicy> => {
  reads++;
  if (process.env.TEST_AUTH_MODE === "invalid") {
    return resolveAuthExecutionPolicy({ mode: "local", authority_project_ref: "project-a" }, "invalid");
  }
  if (process.env.TEST_AUTH_MODE === "external" || (process.env.TEST_AUTH_MODE === "transition" && reads > 1)) {
    return { mode: "external", localGoTrue: false, upstream: "127.0.0.1:3367" };
  }
  return { mode: "local", localGoTrue: true, authorityRef: "project-a" };
});

try {
  if (process.argv[2] === "stop") {
    await controller.stopAndDisable("project-a");
  } else if (process.argv[2] === "activate") {
    await controller.enable("project-a");
    await controller.start("project-a");
    await controller.restart("project-a");
  } else if (process.argv[2] === "observe-stopped") {
    console.log(JSON.stringify(await controller.observeStopped("project-a", 4101)));
  } else {
    throw new Error("Unknown controller test operation");
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "Controller test failed");
  process.exitCode = 1;
}
