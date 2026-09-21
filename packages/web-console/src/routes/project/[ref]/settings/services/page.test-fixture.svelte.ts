export const page = $state<{ params: { ref: string | undefined } }>({ params: { ref: "a" } });
export const notifications: string[] = [];
export const toast = { error(message: string) { notifications.push(message); } };
export function resolve(path: string, params: { ref: string }) {
  return path.replace("[ref]", encodeURIComponent(params.ref));
}
