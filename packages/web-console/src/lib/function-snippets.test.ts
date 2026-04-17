import { describe, expect, test } from "bun:test";
import {
  buildCurlExample,
  buildFunctionTasksPath,
  buildInvokeAsyncExample,
  buildJsInvokeExample,
  buildTsInvokeExample,
  getStatusBadgeClass,
} from "./function-snippets";

describe("function snippets", () => {
  test("buildInvokeAsyncExample injects current slug and idempotency key", () => {
    const snippet = buildInvokeAsyncExample("video-transcode");
    expect(snippet).toContain(`invokeAsync(supabase, "video-transcode"`);
    expect(snippet).toContain(`video-transcode-job_123-v1`);
  });

  test("buildCurlExample generates async invocation headers", () => {
    const snippet = buildCurlExample("mockup-generator");
    expect(snippet).toContain(`/functions/v1/mockup-generator`);
    expect(snippet).toContain(`x-supacloud-async: true`);
    expect(snippet).toContain(`mockup-generator-job_123-v1`);
  });

  test("build JS and TS examples preserve official supabase.functions.invoke usage", () => {
    expect(buildJsInvokeExample("image-render")).toContain(`supabase.functions.invoke("image-render"`);
    expect(buildTsInvokeExample("image-render")).toContain(`type AsyncTaskResponse`);
    expect(buildTsInvokeExample("image-render")).toContain(`"x-supacloud-idempotency-key": "image-render-job_123-v1"`);
  });

  test("buildFunctionTasksPath scopes by function_slug and limit", () => {
    expect(buildFunctionTasksPath("proj_123", "hello/world", 5)).toBe(
      "/api/query?path=/v1/projects/proj_123/tasks?function_slug=hello%2Fworld&limit=5",
    );
  });

  test("getStatusBadgeClass maps terminal and running states", () => {
    expect(getStatusBadgeClass("running")).toContain("text-blue-700");
    expect(getStatusBadgeClass("dead_lettered")).toContain("text-red-700");
    expect(getStatusBadgeClass("cancelled")).toContain("text-slate-700");
    expect(getStatusBadgeClass("unknown")).toContain("text-muted-foreground");
  });
});
