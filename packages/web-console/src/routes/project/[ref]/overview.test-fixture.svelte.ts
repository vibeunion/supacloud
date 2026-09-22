import { readable } from "svelte/store";
import en from "../../../lib/i18n/locales/en.json";

export const page = $state<{ params: { ref: string | undefined } }>({ params: { ref: "a" } });
export function resolve(path: string, params?: { ref: string }): string {
  return params ? path.replace("[ref]", encodeURIComponent(params.ref)) : path;
}
export const t = readable((key: string, options?: { default?: string }): string => {
  const [section, name] = key.split(".");
  const group: unknown = Object.entries(en).find(([key]) => key === section)?.[1];
  if (typeof group !== "object" || group === null) return options?.default ?? key;
  const value: unknown = Object.entries(group).find(([key]) => key === name)?.[1];
  return typeof value === "string" ? value : options?.default ?? key;
});
