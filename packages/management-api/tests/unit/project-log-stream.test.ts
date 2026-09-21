import { describe, expect, test } from "bun:test";
import {
  createProjectLogStream, getProjectLogUnits, MAX_PROJECT_LOG_LINE_BYTES, normalizePersistedLogService,
} from "../../src/utils/project-log-stream";

const encoder = new TextEncoder();
function journal(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    __CURSOR: "cursor", __REALTIME_TIMESTAMP: "0",
    _SYSTEMD_UNIT: "supacloud-gotrue@proj_1.service",
    MESSAGE: "Authorization: Bearer synthetic", PRIORITY: "3", ...fields,
  }) + "\n";
}

function bytes(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const next = chunks[index++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
}

describe("project log streams", () => {
  test("validates project identity and does not resolve inherited service names", () => {
    for (const ref of ["*", "proj_?", "../proj_1", "proj_1\n", ""]) {
      expect(() => getProjectLogUnits(ref)).toThrow("Invalid project ref");
    }
    for (const service of ["constructor", "__proto__", "toString", "realtime", "caddy"]) {
      expect(() => getProjectLogUnits("proj_1", service)).toThrow("project-isolated");
      expect(normalizePersistedLogService(service)).toBe(service);
    }
    expect(getProjectLogUnits("proj_1", "api")).toEqual(["supacloud-pgrst@proj_1"]);
  });

  test("only validated selected-project records reach SSE, with redaction and epoch timestamps", async () => {
    let closed = 0;
    const payload = [
      "not json\n", "[]\n", journal({ _SYSTEMD_UNIT: "supacloud-gotrue@other.service" }),
      journal({ _SYSTEMD_UNIT: "supacloud-pgrst@proj_1.service" }),
      journal({ __REALTIME_TIMESTAMP: false }), journal({ MESSAGE: { password: "secret" } }),
      journal({ _SYSTEMD_UNIT: "supacloud-gotrue@proj_1" }),
      journal(), '{"MESSAGE":"incomplete',
    ].join("");
    const stream = createProjectLogStream(bytes([encoder.encode(payload)]), "proj_1", "auth", {
      signal: new AbortController().signal, onClose() { closed++; },
    });
    const output = await new Response(stream).text();
    expect(output).toBe(': connected\n\ndata: {"timestamp":"1970-01-01T00:00:00.000Z","service":"supacloud-gotrue@proj_1.service","message":"Authorization=[REDACTED]","severity":"error"}\n\n');
    expect(closed).toBe(1);
  });

  test("preserves split multibyte characters and JSON message newlines without injecting SSE frames", async () => {
    const payload = encoder.encode(journal({ MESSAGE: "\u4e2d\u6587\n\ndata: forged" }));
    const stream = createProjectLogStream(bytes(Array.from(payload, (byte) => new Uint8Array([byte]))), "proj_1", undefined, {
      signal: new AbortController().signal, onClose() {},
    });
    const output = await new Response(stream).text();
    expect(output).toContain("\\n\\ndata: forged");
    expect(output.match(/^data:/gm)).toHaveLength(1);
    expect(output).toContain("\u4e2d\u6587");
  });

  test("discards oversized lines and malformed UTF-8 without forwarding their tails", async () => {
    const stream = createProjectLogStream(bytes([
      encoder.encode("x".repeat(MAX_PROJECT_LOG_LINE_BYTES)),
      encoder.encode(journal({ MESSAGE: "must not become a tail event" })),
      new Uint8Array([0xff, 10]),
      encoder.encode(journal({ MESSAGE: "valid after discarded records" })),
    ]), "proj_1", undefined, { signal: new AbortController().signal, onClose() {} });
    const output = await new Response(stream).text();
    expect(output).not.toContain("tail event");
    expect(output).toContain("valid after discarded records");
    expect(output.match(/^data:/gm)).toHaveLength(1);
  });

  test("consumer cancellation settles an in-flight read and releases the source exactly once", async () => {
    let cancelled = 0;
    let closed = 0;
    const source = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    const abort = new AbortController();
    const stream = createProjectLogStream(source, "proj_1", undefined, {
      signal: abort.signal, onClose() { closed++; },
    });
    const reader = stream.getReader();
    await reader.read();
    const pending = reader.read();
    await reader.cancel();
    abort.abort();
    expect((await pending).done).toBe(true);
    await Bun.sleep(0);
    expect(cancelled).toBe(1);
    expect(closed).toBe(1);
    expect(source.locked).toBe(false);
  });

  test("request abort closes an idle stream, including abort before creation", async () => {
    for (const alreadyAborted of [false, true]) {
      let closed = 0;
      const abort = new AbortController();
      if (alreadyAborted) abort.abort();
      const stream = createProjectLogStream(bytes([]), "proj_1", undefined, {
        signal: abort.signal, onClose() { closed++; },
      });
      abort.abort();
      await new Response(stream).text();
      expect(closed).toBe(1);
    }
    const abort = new AbortController();
    const stream = createProjectLogStream(new ReadableStream<Uint8Array>(), "proj_1", undefined, {
      signal: abort.signal, onClose() {},
    });
    const reading = new Response(stream).text();
    abort.abort();
    expect(await reading).toBe(": connected\n\n");
  });

  test("backpressure prevents eager draining and source errors are sanitized", async () => {
    let pulls = 0;
    let closed = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(encoder.encode(journal())); },
    });
    const stream = createProjectLogStream(source, "proj_1", undefined, {
      signal: new AbortController().signal, onClose() { closed++; },
    });
    await Bun.sleep(0);
    expect(pulls).toBeLessThanOrEqual(1);
    await stream.cancel();
    expect(closed).toBe(1);

    const broken = createProjectLogStream(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("private process details")); },
    }), "proj_1", undefined, { signal: new AbortController().signal, onClose() {} });
    await expect(new Response(broken).text()).rejects.toThrow("Project log stream failed");
  });

  test("native Bun process output is parsed and cancellation terminates the producer", async () => {
    const proc = Bun.spawn([
      process.execPath, "-e",
      `process.stdout.write(${JSON.stringify(journal())}); setInterval(() => {}, 1000);`,
    ], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    try {
      const abort = new AbortController();
      const stream = createProjectLogStream(proc.stdout, "proj_1", undefined, {
        signal: abort.signal, onClose() { proc.kill(); },
      });
      const reader = stream.getReader();
      await reader.read();
      const event = await reader.read();
      expect(new TextDecoder().decode(event.value)).toContain("Authorization=[REDACTED]");
      await reader.cancel();
      await proc.exited;
      expect(proc.killed).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("a real HTTP client disconnect releases the streaming producer", async () => {
    const abort = new AbortController();
    let closed = 0;
    let cancelled = 0;
    let resolveClosed = () => {};
    const closing = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        return new Response(createProjectLogStream(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(encoder.encode(journal())); },
          cancel() { cancelled++; },
        }), "proj_1", undefined, {
          signal: request.signal,
          onClose() { closed++; resolveClosed(); },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}`, { signal: abort.signal });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected an SSE response body");
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(": connected");
      abort.abort();
      await Promise.race([closing, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP disconnect did not release the producer")), 1000);
      })]);
      expect(closed).toBe(1);
      expect(cancelled).toBe(1);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.abort();
      await server.stop(true);
    }
  });
});
