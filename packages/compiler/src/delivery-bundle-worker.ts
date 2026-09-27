import { bundleDeliveryTargetInProcess } from "./delivery-bundle";
import { parseDeliveryBundleRequest, type DeliveryBundleResponse } from "./delivery-bundle-protocol";

let parent: number | undefined;
// A terminated caller must not leave an unowned compiler process running.
const watchdog = setInterval(() => {
  if (parent === undefined) return;
  if (process.ppid !== parent) process.exit(1);
  try { process.kill(parent, 0); } catch { process.exit(1); }
}, 250);
try {
  const request = parseDeliveryBundleRequest(JSON.parse(await Bun.stdin.text()));
  parent = request.parentPid;
  if (process.ppid !== parent) throw new Error("Bundle caller is no longer active.");
  const bundled = await bundleDeliveryTargetInProcess(
    request.name, request.code, request.project, request.generatedDirectory, request.options,
  );
  const response: DeliveryBundleResponse = {
    ok: true,
    files: [...bundled.files].map(([path, bytes]) => [path, Buffer.from(bytes).toString("base64")]),
    inputs: [...bundled.inputs],
    runtimeImports: bundled.runtimeImports,
  };
  await Bun.write(Bun.stdout, JSON.stringify(response));
} catch {
  // Source diagnostics and environment values do not cross this process boundary.
  await Bun.write(Bun.stdout, JSON.stringify({ ok: false }));
  process.exitCode = 1;
} finally {
  clearInterval(watchdog);
}
