export const page = $state<{ params: { ref: string | undefined } }>({ params: { ref: "a" } });
export const notifications: string[] = [];
export const toast = {
  error(message: string) { notifications.push(`error:${message}`); },
  success(message: string) { notifications.push(`success:${message}`); },
};
