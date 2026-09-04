import { describe, expect, test } from "bun:test";
import { booleanAttribute, numberAttribute } from "./input_transform";

describe("Angular 16+ input transforms (booleanAttribute & numberAttribute)", () => {
  test("booleanAttribute coerces values following Angular semantics", () => {
    expect(booleanAttribute(true)).toBe(true);
    expect(booleanAttribute(false)).toBe(false);
    expect(booleanAttribute("")).toBe(true);
    expect(booleanAttribute("true")).toBe(true);
    expect(booleanAttribute("any-truthy-string")).toBe(true);
    expect(booleanAttribute("false")).toBe(false);
    expect(booleanAttribute(null)).toBe(false);
    expect(booleanAttribute(undefined)).toBe(false);
    expect(booleanAttribute(0)).toBe(false);
    expect(booleanAttribute(1)).toBe(true);
  });

  test("numberAttribute coerces numeric values and strings with fallback", () => {
    expect(numberAttribute(42)).toBe(42);
    expect(numberAttribute(3.14)).toBe(3.14);
    expect(numberAttribute("100")).toBe(100);
    expect(numberAttribute("20.5")).toBe(20.5);
    expect(isNaN(numberAttribute("not-a-number"))).toBe(true);
    expect(numberAttribute("not-a-number", 10)).toBe(10);
    expect(numberAttribute(null, 0)).toBe(0);
    expect(numberAttribute(undefined, -1)).toBe(-1);
    expect(numberAttribute({}, 99)).toBe(99);
  });
});
