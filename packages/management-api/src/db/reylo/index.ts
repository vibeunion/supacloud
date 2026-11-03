import type { ControlPlaneQueries } from "./queries";

const enabled = (typeof __SUPACLOUD_REYLO_QUERIES__ !== "undefined" && __SUPACLOUD_REYLO_QUERIES__)
  || process.env["SUPACLOUD_REYLO_QUERIES"] === "1";
let pending: Promise<ControlPlaneQueries | null> | undefined;

export function loadControlPlaneQueries(): Promise<ControlPlaneQueries | null> {
  if (!enabled) return Promise.resolve(null);
  pending ??= import("./queries").then((module) => module.queries);
  return pending;
}
