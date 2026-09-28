import { Type } from "typebox";

// Database drivers return Date objects, not JSON date strings.
export const dateSchema = Type.Refine(
  Type.Unsafe<Date>({ type: "object" }),
  (value) => value instanceof Date && Number.isFinite(value.getTime()),
);
