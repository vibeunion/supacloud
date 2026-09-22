import { describe, expect, test } from "bun:test";
import {
  decodeValidatedCommandIdentity,
  decodeValidatedCommandReference,
} from "./receipts.js";

describe("validated command identity", () => {
  test("keeps wire decoding separate from branded internal identity", () => {
    const identity = decodeValidatedCommandIdentity({
      tenantId: "tenant-1",
      actorId: "actor-1",
    });
    expect<string>(identity.tenantId).toBe("tenant-1");
    expect<string>(identity.actorId).toBe("actor-1");
  });

  test("validates command references at the boundary", () => {
    const reference = decodeValidatedCommandReference({
      tenantId: "tenant-1",
      actorId: "actor-1",
      command: "project.create",
      operationId: "operation-1",
    });
    expect<string>(reference.command).toBe("project.create");
    expect<string>(reference.operationId).toBe("operation-1");
    expect(() => decodeValidatedCommandReference({
      tenantId: "tenant-1",
      actorId: "actor-1",
      command: "",
      operationId: "operation-1",
    })).toThrow(TypeError);
  });
});
