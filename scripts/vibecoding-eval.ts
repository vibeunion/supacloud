import { readFile } from "node:fs/promises";

export const VIBECODING_TASKS = {
  "create-resource": {
    request: "Add a catalog read resource, register it and test allowed and denied reads.",
    allowed: ["src/features/catalog/", "src/app.module.ts", "generated/"],
  },
  "repair-contract": {
    request: "Repair a catalog response contract mismatch without weakening validation or editing generated output by hand.",
    allowed: ["src/features/catalog/", "generated/"],
  },
  "extend-command": {
    request: "Extend an existing orders command and test denied, stale-version and duplicate requests without weakening governance.",
    allowed: ["src/features/orders/", "generated/"],
  },
} as const;

interface Trial {
  id: string;
  task: keyof typeof VIBECODING_TASKS;
  elapsedMs: number;
  contextBytes: number;
  repairRounds: number;
  firstCheckExitCode: number;
  finalCheckExitCode: number;
  changedFiles: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trial(value: unknown): Trial {
  if (!record(value) || Object.keys(value).some(key => ![
    "id", "task", "elapsedMs", "contextBytes", "repairRounds",
    "firstCheckExitCode", "finalCheckExitCode", "changedFiles",
  ].includes(key))) throw new Error("Invalid benchmark trial fields; never include prompts, logs or credentials");
  const { id, task, elapsedMs, contextBytes, repairRounds, firstCheckExitCode, finalCheckExitCode, changedFiles } = value;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)
    || typeof task !== "string" || !Object.hasOwn(VIBECODING_TASKS, task)
    || ![elapsedMs, contextBytes, repairRounds, firstCheckExitCode, finalCheckExitCode]
      .every(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)
    || !Array.isArray(changedFiles) || changedFiles.length > 1000
    || !changedFiles.every(file => typeof file === "string" && file.length < 256
      && /^[A-Za-z0-9_./-]+$/.test(file) && !file.startsWith("/")
      && !file.split("/").some(part => part === ".." || part === "." || part === ""))) {
    throw new Error("Invalid benchmark trial values");
  }
  return {
    id, task: task as Trial["task"], elapsedMs: elapsedMs as number,
    contextBytes: contextBytes as number, repairRounds: repairRounds as number,
    firstCheckExitCode: firstCheckExitCode as number, finalCheckExitCode: finalCheckExitCode as number,
    changedFiles: [...new Set(changedFiles as string[])],
  };
}

/** Evaluate recorded agent runs, not synthetic claims that an agent actually ran. */
export function evaluateVibecodingRuns(value: unknown) {
  if (!record(value) || value["version"] !== 1 || Object.keys(value).some(key => !["version", "trials"].includes(key))
    || !Array.isArray(value["trials"]) || !value["trials"].length || value["trials"].length > 1000) {
    throw new Error("Expected version 1 with 1-1000 recorded trials");
  }
  const trials = value["trials"].map(trial);
  if (new Set(trials.map(item => item.id)).size !== trials.length) throw new Error("Duplicate trial ID");
  const results = trials.map(item => {
    const allowed: readonly string[] = VIBECODING_TASKS[item.task].allowed;
    const unauthorizedFiles = item.changedFiles.filter(file =>
      !allowed.some(path => path.endsWith("/") ? file.startsWith(path) : file === path));
    return {
      ...item, changedFileCount: item.changedFiles.length, unauthorizedFiles,
      passed: item.finalCheckExitCode === 0 && unauthorizedFiles.length === 0,
      firstPass: item.firstCheckExitCode === 0 && item.repairRounds === 0 && item.finalCheckExitCode === 0
        && unauthorizedFiles.length === 0,
    };
  });
  const mean = (select: (item: Trial) => number) => trials.reduce((sum, item) => sum + select(item), 0) / trials.length;
  return {
    version: 1, evidence: "recorded-agent-results-not-independently-attested",
    trials: results,
    summary: {
      count: trials.length,
      successRate: results.filter(item => item.passed).length / trials.length,
      firstPassRate: results.filter(item => item.firstPass).length / trials.length,
      meanElapsedMs: mean(item => item.elapsedMs),
      meanContextBytes: mean(item => item.contextBytes),
      meanRepairRounds: mean(item => item.repairRounds),
      meanChangedFiles: mean(item => item.changedFiles.length),
      unauthorizedTrials: results.filter(item => item.unauthorizedFiles.length).length,
    },
  };
}

if (import.meta.main) {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error("Usage: bun scripts/vibecoding-eval.ts <recorded-trials.json>");
  const input = await readFile(path, "utf8");
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Benchmark input exceeds 1 MiB");
  console.log(JSON.stringify(evaluateVibecodingRuns(JSON.parse(input)), null, 2));
}
