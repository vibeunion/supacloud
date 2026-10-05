import { evaluateWorkerPerformance } from "../src/performance.js";

try {
  if (process.argv.length !== 3) throw new Error("INVALID_ARGUMENTS");
  const input: unknown = await Bun.file(process.argv[2]!).json();
  const result = evaluateWorkerPerformance(input);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch {
  console.error("WORKER_PERFORMANCE_EVIDENCE_INVALID: expected one measurement file path");
  process.exitCode = 1;
}
