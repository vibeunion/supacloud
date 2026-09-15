import { expect, test } from "bun:test";
import {
  commandButtonState, commandDisabledReason, decodeCommandPreview, type CommandPreview,
} from "./command_preview";

const allowed = { command: "review.approve", allowed: true, blockers: [] } satisfies CommandPreview;
const blocked = {
  command: "review.approve", allowed: false,
  blockers: [{ code: "CASE_FROZEN", message: "案件已冻结", correction: "解冻后再提交" }],
} satisfies CommandPreview;

test("allowed previews never disable the command button", () => {
  expect(decodeCommandPreview(allowed)).toEqual(allowed);
  expect(commandDisabledReason(allowed)).toBe("");
  expect(commandButtonState(allowed)).toEqual({ disabled: false, disabledReason: "" });
});

test("blocked previews join the reason the button must show", () => {
  expect(decodeCommandPreview(blocked)).toEqual(blocked);
  expect(commandDisabledReason(blocked)).toBe("案件已冻结；解冻后再提交");
  expect(commandButtonState(blocked)).toEqual({
    disabled: true, disabledReason: "案件已冻结；解冻后再提交",
  });
  expect(commandDisabledReason({
    ...blocked, blockers: [{ code: "CASE_FROZEN", message: "案件已冻结" },
      { code: "ROLE_DENIED", message: "当前角色不能签发" }],
  })).toBe("案件已冻结；当前角色不能签发");
});

test("preview payloads reject ambiguous allow or empty denial", () => {
  for (const value of [null, {}, { command: "review.approve", allowed: true, blockers: blocked.blockers },
    { command: "review.approve", allowed: false, blockers: [] },
    { command: "review.approve", allowed: false, blockers: [{ code: "", message: "x" }] },
    { command: "review.approve", allowed: false, blockers: [{ code: "X", message: "x", correction: "" }] }]) {
    expect(() => decodeCommandPreview(value)).toThrow(TypeError);
  }
});
