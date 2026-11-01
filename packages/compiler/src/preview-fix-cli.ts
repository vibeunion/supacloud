import { PreviewFixError, runPreviewFixLoop, type PreviewFixLoopInput } from "./preview-fix-loop";

const FLAGS = [
  "--production", "--preview", "--preview-id", "--project-ref", "--application-id",
  "--environment-id", "--property", "--value",
] as const;

function fail(code: string): never {
  console.error(`Error: ${code}`);
  process.exitCode = 1;
  throw new Error(code);
}

/** Local preview fix loop. Prints a receipt and does not deploy. */
export async function runPreviewFixCommand(args: readonly string[]): Promise<void> {
  try {
    const values = new Map<string, string>();
    let json = false;
    for (let index = 0; index < args.length; index++) {
      const option = args[index];
      if (option === "--json") {
        if (json) fail("PREVIEW_FIX_POLICY_REQUIRED");
        json = true;
        continue;
      }
      if (!FLAGS.includes(option as typeof FLAGS[number])) fail("PREVIEW_FIX_POLICY_REQUIRED");
      const value = args[++index];
      if (!value || value.startsWith("-") || values.has(option) || /[\u0000-\u001f\u007f]/.test(value) || value.length > 4096) {
        fail("PREVIEW_FIX_POLICY_REQUIRED");
      }
      values.set(option, value);
    }
    const required = FLAGS.map(flag => values.get(flag));
    if (required.some(value => value === undefined)) fail("PREVIEW_FIX_POLICY_REQUIRED");
    const [productionRoot, previewRoot, previewId, projectRef, applicationId, environmentId, property, value] = required as string[];
    if ((property !== "transaction" && property !== "idempotency") || (value !== "required" && value !== "none")) {
      fail("PREVIEW_FIX_POLICY_REQUIRED");
    }
    const input: PreviewFixLoopInput = {
      productionRoot, previewRoot, previewId, projectRef, applicationId, environmentId, property, value,
    };
    const receipt = await runPreviewFixLoop(input);
    if (json) {
      console.log(JSON.stringify(receipt, null, 2));
      return;
    }
    console.log([
      "preview-fix recorded",
      `  preview: ${receipt.preview_id}`,
      `  branch: ${receipt.branch_ref}`,
      `  diagnosis: ${receipt.diagnosis.errorCode}`,
      `  test: ${receipt.test.operation} ok`,
      "  deployed: false",
      "  published: false",
      "  production written: false",
      "  production approval: required",
    ].join("\n"));
  } catch (error) {
    if (process.exitCode === 1) return;
    console.error(`Error: ${error instanceof PreviewFixError ? error.code : "PREVIEW_FIX_FAILED"}`);
    process.exitCode = 1;
  }
}
