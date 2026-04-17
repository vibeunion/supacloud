import { describe, expect, test } from "bun:test";
import {
  normalizeBackgroundTaskTimeout,
  normalizeBackgroundTaskMaxAttempts,
} from "../../src/services/background-task.service";

describe("BackgroundTaskService: normalizeBackgroundTaskTimeout", () => {
  test("undefined returns default 300", () => {
    expect(normalizeBackgroundTaskTimeout(undefined)).toBe(300);
  });

  test("0 returns default 300", () => {
    expect(normalizeBackgroundTaskTimeout(0)).toBe(300);
  });

  test("NaN returns default 300", () => {
    expect(normalizeBackgroundTaskTimeout(NaN)).toBe(300);
  });

  test("Infinity returns default 300", () => {
    expect(normalizeBackgroundTaskTimeout(Infinity)).toBe(300);
  });

  test("negative value is clamped to 1", () => {
    expect(normalizeBackgroundTaskTimeout(-10)).toBe(1);
  });

  test("value exceeding 900 is clamped to 900", () => {
    expect(normalizeBackgroundTaskTimeout(2000)).toBe(900);
  });

  test("valid value 60 passes through", () => {
    expect(normalizeBackgroundTaskTimeout(60)).toBe(60);
  });

  test("exact boundary 900 passes through", () => {
    expect(normalizeBackgroundTaskTimeout(900)).toBe(900);
  });

  test("exact boundary 1 passes through", () => {
    expect(normalizeBackgroundTaskTimeout(1)).toBe(1);
  });

  test("float values are floored", () => {
    expect(normalizeBackgroundTaskTimeout(59.9)).toBe(59);
    expect(normalizeBackgroundTaskTimeout(300.7)).toBe(300);
  });
});

describe("BackgroundTaskService: normalizeBackgroundTaskMaxAttempts", () => {
  test("undefined returns default 3", () => {
    expect(normalizeBackgroundTaskMaxAttempts(undefined)).toBe(3);
  });

  test("0 returns default 3", () => {
    expect(normalizeBackgroundTaskMaxAttempts(0)).toBe(3);
  });

  test("NaN returns default 3", () => {
    expect(normalizeBackgroundTaskMaxAttempts(NaN)).toBe(3);
  });

  test("negative value is clamped to 1", () => {
    expect(normalizeBackgroundTaskMaxAttempts(-5)).toBe(1);
  });

  test("value exceeding 10 is clamped to 10", () => {
    expect(normalizeBackgroundTaskMaxAttempts(50)).toBe(10);
  });

  test("valid value 5 passes through", () => {
    expect(normalizeBackgroundTaskMaxAttempts(5)).toBe(5);
  });

  test("exact boundary 1 passes through", () => {
    expect(normalizeBackgroundTaskMaxAttempts(1)).toBe(1);
  });

  test("exact boundary 10 passes through", () => {
    expect(normalizeBackgroundTaskMaxAttempts(10)).toBe(10);
  });

  test("float values are floored", () => {
    expect(normalizeBackgroundTaskMaxAttempts(2.9)).toBe(2);
    expect(normalizeBackgroundTaskMaxAttempts(5.1)).toBe(5);
  });
});
