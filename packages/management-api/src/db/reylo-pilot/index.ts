import type { ReyloPilotQueries } from "./queries";

export type ReyloPilot = { queries: ReyloPilotQueries };

export async function loadReyloPilot(): Promise<ReyloPilot | null> {
  if (process.env.SUPACLOUD_REYLO_PILOT !== "1") return null;
  const { queries } = await import("./queries");
  if (typeof queries?.getTask !== "function") {
    throw new Error("Reylo pilot loader is not registered; start Bun with reylo/register preload");
  }
  return { queries };
}
