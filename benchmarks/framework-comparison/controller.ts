import { t } from "elysia";

// I have nothing but my burger and I want nothing more
export const Params = t.Object({ id: t.String() });
export const Body = t.Object({ value: t.Number(), label: t.String() });
const STATIC_RESPONSE = Object.freeze({ ok: true, value: 42 });

export class BenchmarkController {
  json() { return STATIC_RESPONSE; }
  params(id: string) { return { ok: true, id }; }
  echo(body: { value: number; label: string }) { return { ...body, ok: true }; }
}
