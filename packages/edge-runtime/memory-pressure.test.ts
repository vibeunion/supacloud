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
  currentBytes: 4 * 1024 ** 3,
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

  test("does not restart at the production idle-cache plateau without fresh high events", async () => {
    for (const highEvents of [0, 34_940_000]) {
      const events: MemoryPressureSnapshot[] = [];
      const monitor = createMemoryPressureMonitor({
        sample: async () => ({
          ...pressure, currentBytes: 3_872_747_520, highEvents,
        }),
        onPressure: (snapshot) => events.push(snapshot),
        onError: () => {},
      });
      for (let i = 0; i < 10; i++) await monitor.poll();
      expect(events).toEqual([]);
    }
  });

  test("recovers below the limit when fresh throttling persists near memory.high", async () => {
    let highEvents = 100;
    const events: MemoryPressureSnapshot[] = [];
    const monitor = createMemoryPressureMonitor({
      sample: async () => ({
        ...pressure, currentBytes: pressure.highBytes * 0.95, highEvents: highEvents++,
      }),
      onPressure: (snapshot) => events.push(snapshot),
      onError: () => {},
    });
    await monitor.poll(); // Establish the counter baseline.
    await monitor.poll();
    await monitor.poll();
    expect(events).toEqual([]);
    await monitor.poll();
    await monitor.poll();
    expect(events).toHaveLength(1);
  });

  test("blocks admission near memory.high and resumes with hysteresis", async () => {
    let sample = { ...pressure, currentBytes: pressure.highBytes * 0.86, highEvents: 10 };
    const states: boolean[] = [];
    const monitor = createMemoryPressureMonitor({
      sample: async () => sample,
      onPressure: () => {},
      onAdmissionStateChange: ({ blocked }) => states.push(blocked),
      onError: () => {},
    });

    await monitor.poll();
    sample = { ...sample, highEvents: 11 };
    await monitor.poll();
    expect(states).toEqual([true]);

    sample = { ...sample, currentBytes: pressure.highBytes * 0.8, highEvents: 12 };
    await monitor.poll();
    expect(states).toEqual([true]);

    sample = { ...sample, highEvents: 12 };
    await monitor.poll();
    expect(states.at(-1)).toBe(false);

    sample = { ...sample, currentBytes: pressure.highBytes * 0.86, highEvents: 13 };
    await monitor.poll();
    expect(states.at(-1)).toBe(true);

    sample = { ...sample, currentBytes: pressure.highBytes * 0.74 };
    await monitor.poll();
    expect(states.at(-1)).toBe(false);
  });

  test("stalled counters and cgroup changes do not accumulate near-limit pressure", async () => {
    let sample = { ...pressure, currentBytes: pressure.highBytes * 0.95, highEvents: 100 };
    const events: MemoryPressureSnapshot[] = [];
    const monitor = createMemoryPressureMonitor({
      sample: async () => sample,
      onPressure: (snapshot) => events.push(snapshot),
      onError: () => {},
    });
    await monitor.poll();
    for (let i = 0; i < 2; i++) {
      sample = { ...sample, highEvents: sample.highEvents + 1 };
      await monitor.poll();
    }
    await monitor.poll(); // No new throttling: reset the streak.
    sample = { ...sample, highEvents: sample.highEvents + 1 };
    await monitor.poll();
    sample = { ...sample, cgroup: "/other", highEvents: 1000 };
    await monitor.poll();
    sample = { ...sample, highEvents: 1001 };
    await monitor.poll();
    expect(events).toEqual([]);
  });

  test("recovers a blocked idle-cache plateau through limited admission", async () => {
    let sample = { ...pressure, currentBytes: pressure.highBytes * 0.95, highEvents: 10 };
    const states: Array<{ blocked: boolean; recovering: boolean }> = [];
    let recycles = 0;
    const monitor = createMemoryPressureMonitor({
      sample: async () => sample,
      onPressure: () => { recycles++; },
      onAdmissionStateChange: ({ blocked, recovering }) => states.push({ blocked, recovering }),
      onError: error => { throw error; },
    });
    await monitor.poll();
    sample = { ...sample, highEvents: 11 };
    await monitor.poll();
    for (let i = 0; i < 2; i++) await monitor.poll();
    expect(states).toEqual([{ blocked: true, recovering: false }]);
    await monitor.poll();
    expect(states.at(-1)).toEqual({ blocked: false, recovering: true });
    for (let i = 0; i < 3; i++) await monitor.poll();
    expect(states.at(-1)).toEqual({ blocked: false, recovering: false });
    expect(states).toHaveLength(3);
    expect(recycles).toBe(0);
  });

  test.each(["throttling", "growth"] as const)("reblocks a recovering pool on %s", async reason => {
    let sample = { ...pressure, currentBytes: pressure.highBytes * 0.95, highEvents: 10 };
    const states: Array<{ blocked: boolean; recovering: boolean }> = [];
    const monitor = createMemoryPressureMonitor({
      sample: async () => sample,
      onPressure: () => {},
      onAdmissionStateChange: ({ blocked, recovering }) => states.push({ blocked, recovering }),
      onError: error => { throw error; },
    });
    await monitor.poll();
    sample = { ...sample, highEvents: 11 };
    await monitor.poll();
    for (let i = 0; i < 3; i++) await monitor.poll();
    expect(states.at(-1)).toEqual({ blocked: false, recovering: true });
    sample = reason === "throttling"
      ? { ...sample, highEvents: 12 }
      : { ...sample, currentBytes: pressure.highBytes * 0.96 };
    await monitor.poll();
    expect(states.at(-1)).toEqual({ blocked: true, recovering: false });
  });

  test.each(["missing", "error", "cgroup", "limit", "counter"] as const)(
    "does not count %s samples as recovery evidence",
    async reset => {
      let sample: MemoryPressureSnapshot | null = {
        ...pressure, currentBytes: pressure.highBytes * 0.95, highEvents: 10,
      };
      let fail = false;
      const states: boolean[] = [];
      const monitor = createMemoryPressureMonitor({
        sample: async () => {
          if (fail) throw new Error("unavailable");
          return sample;
        },
        onPressure: () => {},
        onAdmissionStateChange: ({ blocked }) => states.push(blocked),
        onError: () => {},
      });
      await monitor.poll();
      sample = { ...sample, highEvents: 11 };
      await monitor.poll();
      await monitor.poll();
      await monitor.poll();
      const healthy = sample;
      if (reset === "missing") sample = null;
      if (reset === "error") fail = true;
      if (reset === "cgroup") sample = { ...healthy, cgroup: "/other" };
      if (reset === "limit") sample = { ...healthy, highBytes: healthy.highBytes + 1 };
      if (reset === "counter") sample = { ...healthy, highEvents: 0 };
      await monitor.poll();
      fail = false;
      sample = healthy;
      await monitor.poll();
      expect(states).toEqual([true]);
    },
  );

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
