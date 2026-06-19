import { describe, expect, test } from "bun:test";
import {
  buildCurlExample,
  buildFunctionTaskConsolePath,
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

  test("buildCurlExample points to a background route without custom async headers", () => {
    const snippet = buildCurlExample("mockup-generator");
    expect(snippet).toContain(`/functions/v1/mockup-generator/generate`);
    expect(snippet).not.toContain(`x-supacloud-async`);
  });

  test("build JS and TS examples preserve official supabase.functions.invoke usage", () => {
    expect(buildJsInvokeExample("image-render")).toContain(`supabase.functions.invoke("image-render"`);
    expect(buildTsInvokeExample("image-render")).toContain(`type AsyncTaskResponse`);
    expect(buildJsInvokeExample("image-render")).not.toContain(`x-supacloud-async`);
    expect(buildTsInvokeExample("image-render")).not.toContain(`x-supacloud-idempotency-key`);
  });

  test("buildFunctionTasksPath scopes by function_slug and limit", () => {
    expect(buildFunctionTasksPath("proj_123", "hello/world", 5)).toBe(
      "/v1/projects/proj_123/tasks?function_slug=hello%2Fworld&limit=5",
    );
  });

  test("buildFunctionTaskConsolePath deep-links into the tasks console", () => {
    expect(buildFunctionTaskConsolePath("proj_123", "hello/world")).toBe(
      "/project/proj_123/tasks?function_slug=hello%2Fworld",
    );
    expect(buildFunctionTaskConsolePath("proj_123", "hello/world", "tsk_1")).toBe(
      "/project/proj_123/tasks?function_slug=hello%2Fworld&task_id=tsk_1",
    );
  });

  test("getStatusBadgeClass maps terminal and running states", () => {
    expect(getStatusBadgeClass("running")).toContain("text-blue-700");
    expect(getStatusBadgeClass("dead_lettered")).toContain("text-red-700");
    expect(getStatusBadgeClass("cancelled")).toContain("text-slate-700");
    expect(getStatusBadgeClass("unknown")).toContain("text-muted-foreground");
  });
});
