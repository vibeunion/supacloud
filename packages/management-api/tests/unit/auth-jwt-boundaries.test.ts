import { expect, mock, test } from "bun:test";
import type { ProjectJwtVerification } from "../../src/utils/project-jwt";

const verification: ProjectJwtVerification = {
  payload: { role: "service_role" },
  protectedHeader: { alg: "HS256" },
  isServiceRole: false,
};
const verifyPayload = mock(async (): Promise<ProjectJwtVerification | null> => verification);
mock.module("../../src/utils/project-jwt", () => ({ verifyProjectJwtPayload: verifyPayload }));
import { verifyProjectJwt } from "../../src/middleware/auth";

function token(header: unknown, payload: unknown): string {
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
}

test.each([
  [null, { role: "service_role" }],
  [[], { role: "service_role" }],
  [{ alg: "HS256" }, null],
  [{ alg: "HS256" }, []],
  [{ alg: "HS256" }, { role: 1 }],
  [{ alg: "HS256" }, { role: "" }],
])("rejects malformed JWT envelopes before verification %#", async (header, payload) => {
  verifyPayload.mockClear();
  expect(await verifyProjectJwt(token(header, payload), "project")).toBeNull();
  expect(verifyPayload).not.toHaveBeenCalled();
});

test("uses verified claims and omits absent subject", async () => {
  verification.payload = { role: "authenticated" };
  const result = await verifyProjectJwt(token({ alg: "HS256" }, { role: "service_role" }), "project");
  expect(result).toEqual({ ref: "project", role: "authenticated" });
  expect(result && Object.hasOwn(result, "sub")).toBe(false);
});

test.each([null, 0, {}, ""])("rejects invalid verified role %#", async (role) => {
  verification.payload = { role };
  expect(await verifyProjectJwt(token({ alg: "HS256" }, { role: "service_role" }), "project")).toBeNull();
});

test("retains a verified subject", async () => {
  verification.payload = { role: "authenticated", sub: "subject" };
  expect(await verifyProjectJwt(token({ alg: "HS256" }, { role: "authenticated" }), "project"))
    .toEqual({ ref: "project", role: "authenticated", sub: "subject" });
});
