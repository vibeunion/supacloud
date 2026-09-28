import { readable } from "svelte/store";
import en from "../../../../lib/i18n/locales/en.json";

export const page = $state({
  params: { ref: "demo" },
  url: new URL("http://localhost/project/demo/applications?application=reviews&environment=test"),
});
export async function goto(path: string) { page.url = new URL(path, page.url); }
export const t = readable((key: string) => {
  const [section, name] = key.split(".");
  const group = en[section as keyof typeof en];
  return (group as Record<string, string>)[name!] ?? key;
});
