import { readFile } from "node:fs/promises";
import { posix as path } from "node:path";

export type MemoryPressureSnapshot = {
  cgroup: string;
  source?: "max" | "rss";
  currentBytes: number;
  highBytes: number;
  highEvents: number;
};

export type MemoryPressureAdmissionState = {
  blocked: boolean;
  recovering: boolean;
  snapshot: MemoryPressureSnapshot | null;
};

const ADMISSION_BLOCK_RATIO = 0.85;
const ADMISSION_RESUME_RATIO = 0.75;
const ADMISSION_STABLE_SAMPLES = 3;

type ReadText = (path: string) => Promise<string>;
const readTextFile: ReadText = (file) => readFile(file, "utf8");

function parseCounter(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)));
}

function isWithin(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return relative === "" || (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveMemoryCgroups(readText: ReadText = readTextFile): Promise<string[]> {
  try {
    const [membership, mounts] = await Promise.all([
      readText("/proc/self/cgroup"),
      readText("/proc/self/mountinfo"),
    ]);
    const group = membership.split("\n").find((line) => line.startsWith("0::"))?.slice(3);
    if (!group?.startsWith("/") || group.split("/").includes("..")) return [];
    for (const line of mounts.split("\n")) {
      const [mount, filesystem] = line.split(" - ");
      if (!mount || !filesystem?.startsWith("cgroup2 ")) continue;
      const fields = mount.split(" ");
      if (!fields[3] || !fields[4]) continue;
      const root = unescapeMountPath(fields[3]);
      const mountPoint = unescapeMountPath(fields[4]);
      if (!isWithin(group, root)) continue;
      let directory = path.resolve(mountPoint, path.relative(root, group));
      const directories: string[] = [];
      // Compare every ancestor's usage with its own limit, never with child RSS.
      while (isWithin(directory, mountPoint)) {
        directories.push(directory);
        if (directory === mountPoint) break;
        directory = path.dirname(directory);
      }
      return directories;
    }
  } catch {
    // cgroup v1 and local macOS development do not expose these files.
  }
  return [];
}

export async function readMemoryPressureSnapshot(
  directories: readonly string[],
  readText: ReadText = readTextFile,
): Promise<MemoryPressureSnapshot | null> {
  let highest: MemoryPressureSnapshot | null = null;
  for (const directory of directories) {
    try {
      const [current, high, maximum, events] = await Promise.all([
        readText(path.join(directory, "memory.current")),
        readText(path.join(directory, "memory.high")).catch(() => "max"),
        readText(path.join(directory, "memory.max")).catch(() => "max"),
        readText(path.join(directory, "memory.events")).catch(() => "high 0"),
      ]);
      const currentBytes = parseCounter(current);
      const configuredHigh = parseCounter(high);
      const maxBytes = parseCounter(maximum);
      // Reserve 10% headroom before a hard OOM boundary when memory.high is absent.
      const maxThreshold = maxBytes && Math.floor(maxBytes * 0.9);
      const useMax = !!maxThreshold && (!configuredHigh || maxThreshold < configuredHigh);
      const highBytes = useMax ? maxThreshold : configuredHigh;
      const highLine = events.split("\n").find((line) => /^high\s/.test(line));
      const highEvents = highLine ? parseCounter(highLine.replace(/^high\s+/, "")) : null;
      if (currentBytes === null || !highBytes || highEvents === null) continue;
      const snapshot: MemoryPressureSnapshot = { cgroup: directory, currentBytes, highBytes, highEvents, ...(useMax ? { source: "max" as const } : {}) };
      if (!highest || currentBytes / Math.max(1, highBytes)
        > highest.currentBytes / Math.max(1, highest.highBytes)) highest = snapshot;
    } catch {
      // The hierarchy root may have no controller files.
    }
  }
  return highest;
}

/** Explicit RSS budget also works outside Linux/cgroup v2. Never infer it from host RAM. */
export async function sampleRuntimeMemory(
  directories: readonly string[], rssBudget: number | undefined,
  rss = process.memoryUsage().rss, readText: ReadText = readTextFile,
): Promise<MemoryPressureSnapshot | null> {
  const cgroup = await readMemoryPressureSnapshot(directories, readText);
  const processSnapshot: MemoryPressureSnapshot | null = rssBudget ? {
    cgroup: "process-rss", source: "rss", currentBytes: rss, highBytes: rssBudget, highEvents: 0,
  } : null;
  if (!processSnapshot) return cgroup;
  if (!cgroup || rss / rssBudget! > cgroup.currentBytes / cgroup.highBytes) return processSnapshot;
  return cgroup;
}

export function createMemoryPressureMonitor(options: {
  sample: () => Promise<MemoryPressureSnapshot | null>;
  onPressure: (snapshot: MemoryPressureSnapshot) => void;
  onAdmissionStateChange?: (state: MemoryPressureAdmissionState) => void;
  onError: (error: unknown) => void;
}) {
  let inFlight = false;
  let stopped = false;
  let admissionBlocked = false;
  let admissionRecovering = false;
  let stableSamples = 0;
  let pressureSamples = 0;
  let pressureCgroup: string | null = null;
  let previous: MemoryPressureSnapshot | null = null;

  const updateAdmissionState = (
    snapshot: MemoryPressureSnapshot | null,
    throttling: boolean,
  ) => {
    const previousBlocked = admissionBlocked;
    const previousRecovering = admissionRecovering;
    if (snapshot) {
      const ratio = snapshot.currentBytes / Math.max(1, snapshot.highBytes);
      const comparable = previous !== null
        && previous.cgroup === snapshot.cgroup
        && previous.highBytes === snapshot.highBytes;
      const stable = previous !== null && comparable && !throttling
        && snapshot.highEvents === previous.highEvents
        && snapshot.currentBytes <= previous.currentBytes;
      if (ratio >= 1 || (snapshot.source !== undefined && ratio >= ADMISSION_BLOCK_RATIO) || (ratio >= ADMISSION_BLOCK_RATIO
        && (throttling || (admissionRecovering && comparable && !stable)))) {
        admissionBlocked = true;
        admissionRecovering = false;
        stableSamples = 0;
      } else if (
        (admissionBlocked || admissionRecovering)
        && (ratio <= ADMISSION_RESUME_RATIO
          || (ratio < ADMISSION_BLOCK_RATIO && !throttling))
      ) {
        admissionBlocked = false;
        admissionRecovering = false;
        stableSamples = 0;
      } else if (admissionBlocked || admissionRecovering) {
        // Idle caches can plateau below memory.high indefinitely. Probe with
        // limited concurrency before reopening instead of latching a 503.
        stableSamples = stable ? stableSamples + 1 : 0;
        if (stableSamples >= ADMISSION_STABLE_SAMPLES) {
          admissionRecovering = admissionBlocked;
          admissionBlocked = false;
          stableSamples = 0;
        }
      }
    } else {
      stableSamples = 0;
    }
    if (admissionBlocked !== previousBlocked || admissionRecovering !== previousRecovering) {
      options.onAdmissionStateChange?.({
        blocked: admissionBlocked, recovering: admissionRecovering, snapshot,
      });
    }
  };

  return {
    stop() { stopped = true; },
    async poll(): Promise<void> {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const snapshot = await options.sample();
        if (stopped) return;
        const newHighEvents = snapshot !== null
          && previous?.cgroup === snapshot.cgroup
          && previous.highBytes === snapshot.highBytes
          && snapshot.highEvents > previous.highEvents;
        updateAdmissionState(snapshot, newHighEvents);
        previous = snapshot;
        // Near-limit occupancy alone is not pressure (for example, idle module caches).
        // Recover below memory.high only while reclaim throttling is still increasing;
        // at the limit, retain protection even if the kernel counter has not advanced.
        if (!snapshot || snapshot.currentBytes < snapshot.highBytes * 0.9
          || (snapshot.currentBytes < snapshot.highBytes && !newHighEvents)) {
          pressureSamples = 0;
          pressureCgroup = null;
          return;
        }
        pressureSamples = pressureCgroup === snapshot.cgroup ? pressureSamples + 1 : 1;
        pressureCgroup = snapshot.cgroup;
        if (pressureSamples < 3) return;
        stopped = true;
        options.onPressure(snapshot);
      } catch (error: unknown) {
        previous = null;
        stableSamples = 0;
        pressureSamples = 0;
        pressureCgroup = null;
        options.onError(error);
      } finally {
        inFlight = false;
      }
    },
  };
}
