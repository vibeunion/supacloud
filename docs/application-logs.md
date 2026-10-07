# Application Logs

`app logs` is the application-scoped observability entry point:

```sh
supacloud-cli app logs \
  --ref PROJECT \
  --id orders \
  --environment_id test \
  --service api \
  --search "request failed"
```

The Management API resolves the current immutable activation for the requested
project, application, and environment, then queries the existing VictoriaLogs
store using the activation-owned systemd units. A stopped or never-activated
environment returns an empty, scoped result; it is not treated as a project-wide
log query.

The existing `project logs` endpoint remains unchanged and continues to provide
project-wide logs for Supabase-compatible consumers. Application logs add a
developer entry point without changing `/rest/v1`, Auth, Storage, Realtime,
Functions, or the existing project logs contract.
