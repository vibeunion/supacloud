import { readable } from "svelte/store";
export const page = $state<{ params: { ref: string | undefined } }>({ params: { ref: "a" } });
export const notifications: Array<{ kind: string; message: string }> = [];
export const toast = {
  success(message: string) { notifications.push({ kind: "success", message }); },
  error(message: string) { notifications.push({ kind: "error", message }); },
  warning(message: string) { notifications.push({ kind: "warning", message }); },
};
const translations: Record<string, string> = {
  "OAuthServer.title": "OAuth Server",
  "OAuthServer.no_clients": "尚无客户端",
  "OAuthServer.client_created": "客户端已创建",
  "OAuthServer.client_deleted": "客户端已删除",
  "OAuthServer.client_delete_confirmation": "确认删除客户端",
  "OAuthServer.endpoint_jwks": "JWKS",
  "Common.copy": "复制", "Common.copied": "已复制", "Common.copy_failed": "复制失败",
  "Common.delete": "删除", "Common.refresh": "刷新",
};
export const t = readable((key: string) => translations[key] ?? key);
