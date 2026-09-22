import { describe, expect, test } from "bun:test";
import {
  createMemoryPressureMonitor,
  readMemoryPressureSnapshot,
  resolveMemoryCgroups,
  type MemoryPressureSnapshot,
} from "./memory-pressure";

function reader(files: Record<string, string>) {
  return async (file: string): Promise<string> => {
    const value = files[file];
    if (value === undefined) throw new Error(`Missing fixture: ${file}`);
    return value;
  };
}

const pressure: MemoryPressureSnapshot = {
  cgroup: "/sys/fs/cgroup/system.slice/supacloud-edge-runtime.service",
  currentBytes: 3.7 * 1024 ** 3,
  highBytes: 4 * 1024 ** 3,
  highEvents: 34_940_000,
};

describe("cgroup memory pressure recovery", () => {
  test("resolves a systemd service and its ancestors, not just the host root", async () => {
    expect(await resolveMemoryCgroups(reader({
      "/proc/self/cgroup": "0::/system.slice/supacloud-edge-runtime.service\n",
      "/proc/self/mountinfo": "29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
    }))).toEqual([
      pressure.cgroup, "/sys/fs/cgroup/system.slice", "/sys/fs/cgroup",
    ]);
  });

  test("handles namespace root and subtree mounts", async () => {
    expect(await resolveMemoryCgroups(reader({
      "/proc/self/cgroup": "0::/\n",
      "/proc/self/mountinfo": "29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
    }))).toEqual(["/sys/fs/cgroup"]);
    expect(await resolveMemoryCgroups(reader({
      "/proc/self/cgroup": "0::/tenant/edge\n",
      "/proc/self/mountinfo": "29 23 0:26 /tenant /cgroup\\040mount rw - cgroup2 cgroup rw",
    }))).toEqual(["/cgroup mount/edge", "/cgroup mount"]);
  });

  test("does not fall back to unrelated host files on unsupported membership", async () => {
    for (const membership of ["4:memory:/edge\n", "0::/../../elsewhere", "0::/elsewhere"]) {
      expect(await resolveMemoryCgroups(reader({
        "/proc/self/cgroup": membership,
        "/proc/self/mountinfo": "29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw",
      }))).toEqual([]);
    }
    expect(await resolveMemoryCgroups(reader({}))).toEqual([]);
  });

  test("uses each ancestor's own usage and reads high separately from OOM", async () => {
    expect(await readMemoryPressureSnapshot(["/group/edge", "/group"], reader({
      "/group/edge/memory.current": "100\n",
      "/group/edge/memory.high": "1000\n",
      "/group/edge/memory.events": "high 0\noom 0\noom_kill 0\n",
      "/group/memory.current": "950\n",
      "/group/memory.high": "1000\n",
      "/group/memory.events": "low 0\nhigh 34940000\nmax 0\noom 0\noom_kill 0\n",
    }))).toEqual({ cgroup: "/group", currentBytes: 950, highBytes: 1000, highEvents: 34940000 });
  });

  test("ignores unlimited, missing, and malformed limits", async () => {
    for (const high of ["max", "", "-1", "NaN", "1e9", "9007199254740992"]) {
      expect(await readMemoryPressureSnapshot(["/group"], reader({
        "/group/memory.current": "100\n",
        "/group/memory.high": high,
        "/group/memory.events": "high 0\n",
      }))).toBeNull();
    }
    expect(await readMemoryPressureSnapshot(["/missing"], reader({}))).toBeNull();
  });

  test("recovers once after three pressure samples even without OOM or new high events", async () => {
    const events: MemoryPressureSnapshot[] = [];
    const errors: unknown[] = [];
    const monitor = createMemoryPressureMonitor({
      sample: async () => pressure,
      onPressure: (snapshot) => events.push(snapshot),
      onError: (error) => errors.push(error),
    });
    await monitor.poll();
    await monitor.poll();
    expect(events).toHaveLength(0);
    await monitor.poll();
    await monitor.poll();
    expect(events).toEqual([pressure]);
    expect(errors).toEqual([]);
  });

  test("transient peaks, historical high counts, and missing samples reset the streak", async () => {
    let sample: MemoryPressureSnapshot | null = pressure;
    const events: MemoryPressureSnapshot[] = [];
    const monitor = createMemoryPressureMonitor({
      sample: async () => sample,
      onPressure: (snapshot) => events.push(snapshot),
      onError: () => {},
    });
    for (const reset of [null, { ...pressure, currentBytes: pressure.highBytes * 0.5 }]) {
      sample = pressure;
      await monitor.poll();
      await monitor.poll();
      sample = reset;
      await monitor.poll();
      sample = pressure;
      await monitor.poll();
      expect(events).toEqual([]);
      sample = null;
      await monitor.poll();
    }
  });

  test("does not overlap slow reads and ignores a result after shutdown", async () => {
    let complete: ((value: MemoryPressureSnapshot) => void) | undefined;
    let reads = 0;
    const events: MemoryPressureSnapshot[] = [];
    const monitor = createMemoryPressureMonitor({
      sample: () => {
        reads++;
        return new Promise((resolve) => { complete = resolve; });
      },
      onPressure: (snapshot) => events.push(snapshot),
      onError: () => {},
    });
    const pending = monitor.poll();
    await monitor.poll();
    expect(reads).toBe(1);
    monitor.stop();
    complete?.(pressure);
    await pending;
    await monitor.poll();
    expect(reads).toBe(1);
    expect(events).toEqual([]);
  });

  test("sampling errors reset the streak without becoming unhandled rejections", async () => {
    let fail = false;
    const errors: unknown[] = [];
    const events: MemoryPressureSnapshot[] = [];
    const monitor = createMemoryPressureMonitor({
      sample: async () => {
        if (fail) throw new Error("unavailable");
        return pressure;
      },
      onPressure: (snapshot) => events.push(snapshot),
      onError: (error) => errors.push(error),
    });
    await monitor.poll();
    await monitor.poll();
    fail = true;
    await monitor.poll();
    fail = false;
    await monitor.poll();
    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
