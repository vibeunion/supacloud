import authJwtHelpersSql from "./sql-modules/auth-jwt-helpers.sql" with { type: "text" };
import backgroundTaskMirrorDownSql from "./sql-modules/background-task-mirror-down.sql" with { type: "text" };
import backgroundTaskMirrorUpSql from "./sql-modules/background-task-mirror-up.sql" with { type: "text" };
import pgmqPublicSql from "./sql-modules/pgmq-public.sql" with { type: "text" };
import postgrestRequestContextSql from "./sql-modules/postgrest-request-context.sql" with { type: "text" };
import realtimeAutoAttachTriggerSql from "./sql-modules/realtime-auto-attach-trigger.sql" with { type: "text" };
import realtimeNotifyPayloadSql from "./sql-modules/realtime-notify-payload.sql" with { type: "text" };
import storagePathHelpersSql from "./sql-modules/storage-path-helpers.sql" with { type: "text" };

export const SQL_MODULES = {
  "auth-jwt-helpers": authJwtHelpersSql.trim(),
  "background-task-mirror-down": backgroundTaskMirrorDownSql.trim(),
  "background-task-mirror-up": backgroundTaskMirrorUpSql.trim(),
  "pgmq-public": pgmqPublicSql.trim(),
  "postgrest-request-context": postgrestRequestContextSql.trim(),
  "realtime-auto-attach-trigger": realtimeAutoAttachTriggerSql.trim(),
  "realtime-notify-payload": realtimeNotifyPayloadSql.trim(),
  "storage-path-helpers": storagePathHelpersSql.trim(),
} as const;

export type SqlModuleId = keyof typeof SQL_MODULES;
