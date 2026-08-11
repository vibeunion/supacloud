import { describe, expect, test } from "bun:test";
import { requestImmutableFunctionVersion } from "./function-version-details";

describe("immutable Function version detail requests", () => {
  test("does not request legacy version zero", async () => {
    const requestedPaths: string[] = [];
    const response = await requestImmutableFunctionVersion(async (path) => {
      requestedPaths.push(path);
      return new Response();
    }, {
      projectRef: "proj_1",
      slug: "legacy-hook",
      version: "0",
    });

    expect(response).toBeNull();
    expect(requestedPaths).toEqual([]);
  });

  test("rejects invalid versions and missing context without a request", async () => {
    const requestedPaths: string[] = [];
    const requester = async (path: string) => {
      requestedPaths.push(path);
      return new Response();
    };

    for (const version of ["", "00", "-1", "1.5", "9007199254740992"]) {
      await expect(requestImmutableFunctionVersion(requester, {
        projectRef: "proj_1",
        slug: "hello",
        version,
      })).rejects.toThrow("函数版本详情请求无效，请刷新后重试");
    }
    await expect(requestImmutableFunctionVersion(requester, {
      projectRef: "",
      slug: "hello",
      version: "1",
    })).rejects.toThrow("函数版本详情上下文缺失，请刷新后重试");
    await expect(requestImmutableFunctionVersion(requester, {
      projectRef: undefined,
      slug: "hello",
      version: "1",
    })).rejects.toThrow("函数版本详情上下文缺失，请刷新后重试");

    expect(requestedPaths).toEqual([]);
  });

  test("requests a canonical positive version with encoded identifiers", async () => {
    const requestedPaths: string[] = [];
    const response = await requestImmutableFunctionVersion(async (path) => {
      requestedPaths.push(path);
      return new Response(null, { status: 200 });
    }, {
      projectRef: "proj/1",
      slug: "hello world",
      version: "12",
    });

    expect(response?.status).toBe(200);
    expect(requestedPaths).toEqual([
      "/v1/projects/proj%2F1/functions/hello%20world/versions/12",
    ]);
  });
});
