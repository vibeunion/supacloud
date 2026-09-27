import { t } from "elysia";

// A JSON response cannot be a handler function. Avoid t.Any()/t.Unknown()
// here, which erase Elysia's contextual handler inference.
export const jsonResponseSchema = t.Union([
  t.Record(t.String(), t.Unknown()),
  t.Array(t.Unknown()),
  t.String(),
  t.Number(),
  t.Boolean(),
  t.Null(),
]);
