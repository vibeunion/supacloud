// @supacloud-test-isolate
import { describe, expect, spyOn, test } from "bun:test";
import { app } from "../../src/index";
import { config } from "../../src/config";
import { extensionService } from "../../src/services/extension.service";

describe("delivery HTTP compatibility", () => {
  test("database extension list wins over the SPA fallback with either slash spelling", async () => {
    const list = spyOn(extensionService, "listExtensions").mockResolvedValue([]);
    try {
      for (const suffix of ["", "/"]) {
        const response = await app.handle(new Request(
          `http://localhost/v1/projects/proj_1/database/extensions${suffix}`,
          { headers: { Authorization: `Bearer ${config.masterToken}` } },
        ));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
      }
      expect(list).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenCalledWith("proj_1");
    } finally {
      list.mockRestore();
    }
  });

  for (const body of ["", "{"]) {
    test(`Storage parse errors retain the SDK error shape for ${body ? "malformed" : "empty"} JSON`, async () => {
      const response = await app.handle(new Request(
        "http://localhost/storage/v1/object/list/unknown_bucket",
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
      ));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        statusCode: "400", error: "Bad Request", message: "Invalid JSON body",
      });
    });
  }
});
