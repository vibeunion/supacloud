import { readable } from "svelte/store";
import en from "../lib/i18n/locales/en.json";

export function resolve(path: string, params?: { ref: string }): string {
  return params ? path.replace("[ref]", encodeURIComponent(params.ref)) : path;
}
export let destination: string | undefined;
export async function goto(path: string): Promise<void> { destination = path; }
export const t = readable((key: string): string => {
  const [section, name] = key.split(".");
  const group: unknown = section === undefined ? undefined : Object.entries(en).find(([key]) => key === section)?.[1];
  if (typeof group !== "object" || group === null) throw new Error(`Missing translation ${key}`);
  const value: unknown = Object.entries(group).find(([key]) => key === name)?.[1];
  if (typeof value !== "string") throw new Error(`Missing translation ${key}`);
  return value;
});

export const systemFixture = {
  cpu: "25.0%", memory: "1024 / 2048 MB", uptime: "1d 2h 3m", version: "1.2.3-beta+sha",
};
