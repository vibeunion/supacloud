// Deno serve() shim — Edge Functions don't need to listen on ports
// If user code imports this, it's a no-op with a friendly warning

export function serve(_handler: unknown) {
  console.warn(
    "[Compat] Deno.serve() is handled automatically in Edge Functions — no manual call needed",
  );
}

export function serveTls(_handler: unknown) {
  console.warn(
    "[Compat] Deno.serveTls() is handled automatically in Edge Functions",
  );
}
