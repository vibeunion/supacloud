# http-provider-import-mismatch

Root `withInterceptors` returns a legacy interceptor array, not an HTTP feature.
Use `withInterceptors` from `@supacloud/app/http` with `provideHttpClient` from
`@supacloud/app/runtime`.

```ts
import { provideHttpClient } from '@supacloud/app/runtime';
import { withInterceptors } from '@supacloud/app/http';
const providers = provideHttpClient(withInterceptors(auth));
```

Preview the registered `http-provider-entrypoint` source migration before writing.
It preserves aliases and refuses mixed or namespace uses. Direct constructor /
custom pipeline array uses remain on the old API; do not change them blindly.
`/http` does not export the inject-based `HttpClient`.
