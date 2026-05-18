import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const projectConfigSource = readFileSync(
  new URL("../../src/routes/project-config.ts", import.meta.url),
  "utf8",
);

describe("project config route source guards", () => {
  test("config route helper does not duplicate the /v1/projects prefix", () => {
    expect(projectConfigSource).toContain(
      "export const projectConfigRoutes = new Elysia({ prefix: \"/v1/projects\" })",
    );
    expect(projectConfigSource).toContain("function addConfigRoutes(section: string)");
    expect(projectConfigSource).not.toContain(
      "function addConfigRoutes(section: string) {\n  return new Elysia({ prefix: \"/v1/projects\" })",
    );
  });
});
