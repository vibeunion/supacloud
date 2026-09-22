import { readFile } from "node:fs/promises";
import { posix as path } from "node:path";

export type MemoryPressureSnapshot = {
  cgroup: string;
  currentBytes: number;
  highBytes: number;
  highEvents: number;
};

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
      const [current, high, events] = await Promise.all([
        readText(path.join(directory, "memory.current")),
        readText(path.join(directory, "memory.high")),
        readText(path.join(directory, "memory.events")),
      ]);
      const currentBytes = parseCounter(current);
      const highBytes = parseCounter(high);
      const highLine = events.split("\n").find((line) => /^high\s/.test(line));
      const highEvents = highLine ? parseCounter(highLine.replace(/^high\s+/, "")) : null;
      if (currentBytes === null || highBytes === null || highEvents === null) continue;
      const snapshot = { cgroup: directory, currentBytes, highBytes, highEvents };
      if (!highest || currentBytes / Math.max(1, highBytes)
        > highest.currentBytes / Math.max(1, highest.highBytes)) highest = snapshot;
    } catch {
      // The hierarchy root may have no controller files.
    }
  }
  return highest;
}

export function createMemoryPressureMonitor(options: {
  sample: () => Promise<MemoryPressureSnapshot | null>;
  onPressure: (snapshot: MemoryPressureSnapshot) => void;
  onError: (error: unknown) => void;
}) {
  let inFlight = false;
  let stopped = false;
  let pressureSamples = 0;
  let pressureCgroup: string | null = null;
  return {
    stop() { stopped = true; },
    async poll(): Promise<void> {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const snapshot = await options.sample();
        if (stopped) return;
        // Leave headroom for draining before memory.high starts reclaim throttling.
        // Historical high events alone must never trigger a restart.
        if (!snapshot || snapshot.currentBytes < snapshot.highBytes * 0.9) {
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
        pressureSamples = 0;
        pressureCgroup = null;
        options.onError(error);
      } finally {
        inFlight = false;
      }
    },
  };
}
