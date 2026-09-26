# @supacloud/devtools-contract

Compatibility shim re-exporting `@vibeunion/devtools-protocol`.

The JSON-safe DevTools contract (trace/correlation metadata, diagnostics,
events, snapshots, cache vocabulary, and recursive credential/signed-URL
redaction) is owned by `@vibeunion/devtools-protocol` so frontend, svadmin,
and SupaCloud adapters share a single source of truth.

SupaCloud-specific compiler/task mapping lives in
`@vibeunion/devtools-supacloud`.