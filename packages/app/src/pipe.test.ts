import { describe, expect, test } from "bun:test";
import {
  DatePipe,
  JsonPipe,
  LowerCasePipe,
  Pipe,
  TrimPipe,
  UpperCasePipe,
  getPipeMetadata,
  type PipeTransform,
} from "./pipe";

describe("Angular-style Pipes & Transformation Suite (@angular/core)", () => {
  test("@Pipe records metadata on class", () => {
    @Pipe({ name: "customPrefix" })
    class CustomPrefixPipe implements PipeTransform<string, string> {
      transform(value: string, prefix = ">>"): string {
        return `${prefix} ${value}`;
      }
    }

    const meta = getPipeMetadata(CustomPrefixPipe);
    expect(meta).toBeDefined();
    expect(meta?.name).toBe("customPrefix");
    expect(meta?.pure).toBe(true);

    const instance = new CustomPrefixPipe();
    expect(instance.transform("hello")).toBe(">> hello");
    expect(instance.transform("hello", "##")).toBe("## hello");
  });

  test("UpperCasePipe and LowerCasePipe transform text correctly", () => {
    const upper = new UpperCasePipe();
    expect(upper.transform("hello world")).toBe("HELLO WORLD");
    expect(upper.transform(null)).toBe("");

    const lower = new LowerCasePipe();
    expect(lower.transform("HELLO WORLD")).toBe("hello world");
    expect(lower.transform(undefined)).toBe("");
  });

  test("TrimPipe strips leading and trailing whitespace", () => {
    const trim = new TrimPipe();
    expect(trim.transform("   spaced   ")).toBe("spaced");
    expect(trim.transform(null)).toBe("");
  });

  test("JsonPipe serializes object with indentation", () => {
    const json = new JsonPipe();
    const obj = { key: "value", num: 123 };
    expect(json.transform(obj)).toBe(JSON.stringify(obj, null, 2));
    expect(json.transform(obj, 0)).toBe(JSON.stringify(obj));
  });

  test("DatePipe formats dates and timestamps to ISO and locale strings", () => {
    const datePipe = new DatePipe();
    const sample = new Date("2026-09-05T12:00:00.000Z");
    expect(datePipe.transform(sample, "iso")).toBe("2026-09-05T12:00:00.000Z");
    expect(datePipe.transform(sample.getTime(), "iso")).toBe("2026-09-05T12:00:00.000Z");
    expect(datePipe.transform(null)).toBe("");
    expect(datePipe.transform("invalid-date-string")).toBe("");
  });
});
