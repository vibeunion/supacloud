import { renderWorkerService } from "../src/delivery.js";

// Rendering only: never install units, start services or access a remote host.
try {
  if (process.argv.length !== 3) throw new Error("INVALID_ARGUMENTS");
  const input: unknown = await Bun.file(process.argv[2]!).json();
  process.stdout.write(renderWorkerService(input));
} catch {
  console.error("WORKER_DELIVERY_INVALID: expected one non-secret manifest path");
  process.exitCode = 1;
}
