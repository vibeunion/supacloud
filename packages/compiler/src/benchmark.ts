import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { compileProject } from "./compile";
import { createDependencyGraphCache } from "./incremental";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { writeFixtureProject } from "./fixtures/helpers";
import { generateApplication, renderApplication, writeRenderedApplication, type GenerateOptions } from "./generate";
import type { ApplicationGraph } from "./types";

export interface CompilerBenchmarkResult {
  fixtureFiles: number;
  coldCompileMs: number;
  incrementalCompileMs: number;
  dependencyInvalidationMs: number;
  generatedBytes: number;
  reusedModules: string[];
  reanalyzedModules: string[];
  generation: {
    iterationsPerSample: number;
    samples: number;
    legacyMedianMs: number;
    reusedRenderMedianMs: number;
  };
}

export async function runCompilerBenchmark(): Promise<CompilerBenchmarkResult> {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-benchmark-"));
  try {
    return await benchmarkProject(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function benchmarkProject(rootDir: string): Promise<CompilerBenchmarkResult> {
  const files = {
    ...GOOD_PROJECT_FILES,
    "src/tsconfig.json": FIXTURE_TSCONFIG,
    "src/runtime.ts": RUNTIME_SOURCE,
  };
  await writeFixtureProject(rootDir, files);
  const outDir = join(rootDir, "generated");
  const cache = createDependencyGraphCache();
  const options = { rootDir: join(rootDir, "src"), outDir, cache, writeOnError: true };
  const measure = async (): Promise<number> => {
    const start = performance.now();
    const compiled = await compileProject(options);
    if (compiled.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new Error("Benchmark fixture must compile without errors");
    }
    return performance.now() - start;
  };
  const coldCompileMs = await measure();
  const incrementalCompileMs = await measure();
  const service = join(rootDir, "src/features/case/case.service.ts");
  await writeFile(service, `${await readFile(service, "utf8")}\n`, "utf8");
  const start = performance.now();
  const invalidated = await compileProject({ ...options, changedPaths: ["features/case/case.service.ts"] });
  const dependencyInvalidationMs = performance.now() - start;
  const generatedBytes = (await readFile(join(outDir, "application.ts"))).byteLength;
  return {
    fixtureFiles: Object.keys(files).length,
    coldCompileMs: round(coldCompileMs),
    incrementalCompileMs: round(incrementalCompileMs),
    dependencyInvalidationMs: round(dependencyInvalidationMs),
    generatedBytes,
    reusedModules: invalidated.stats?.reusedModules ?? [],
    reanalyzedModules: invalidated.stats?.reanalyzedModules ?? [],
    generation: await benchmarkGeneration(invalidated.graph, {
      ...options, artifactHashes: new Map<string, string>(),
    }),
  };
}

async function benchmarkGeneration(
  graph: ApplicationGraph,
  options: GenerateOptions,
): Promise<CompilerBenchmarkResult["generation"]> {
  const iterationsPerSample = 25;
  const samples = 7;
  const legacy = async () => {
    renderApplication(graph, options);
    await generateApplication(graph, options);
  };
  const reused = async () => writeRenderedApplication(renderApplication(graph, options), options);
  const measure = async (run: () => Promise<unknown>) => {
    const start = performance.now();
    for (let index = 0; index < iterationsPerSample; index++) await run();
    return performance.now() - start;
  };
  await legacy();
  await reused();
  const legacyTimes: number[] = [];
  const reusedTimes: number[] = [];
  // Alternate order with the same warm artifact cache to limit ordering and I/O bias.
  for (let sample = 0; sample < samples; sample++) {
    if (sample % 2 === 0) legacyTimes.push(await measure(legacy));
    reusedTimes.push(await measure(reused));
    if (sample % 2 !== 0) legacyTimes.push(await measure(legacy));
  }
  const median = (times: number[]) => round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!);
  return {
    iterationsPerSample, samples,
    legacyMedianMs: median(legacyTimes),
    reusedRenderMedianMs: median(reusedTimes),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

if (import.meta.main) {
  console.log(JSON.stringify(await runCompilerBenchmark(), null, 2));
}
