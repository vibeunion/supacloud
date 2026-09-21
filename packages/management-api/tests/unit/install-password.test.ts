import { expect, test } from "bun:test";
import { generateSecurePassword } from "../../src/install";

test.each([1, 24, 40, 4096])("generates an alphanumeric password of exactly %s characters", (length) => {
  const password = generateSecurePassword(length);
  expect(password).toHaveLength(length);
  expect(password).toMatch(/^[A-Za-z0-9]+$/);
});

test.each([0, -1, 1.5, NaN, Infinity, 4097])("rejects an invalid password length %s", (length) => {
  expect(() => generateSecurePassword(length)).toThrow("Password length");
});
