# Image Transform Preflight

SupaCloud Lite rejects an image transformation before reading object bytes when
the stored object metadata declares a size above the configured input limit.
This avoids an unnecessary download and allocation for obviously oversized
objects.

When metadata is missing, invalid, or smaller than the actual object, the
handler still reads the object and `transformImage` checks the actual size.
The configured limit is inclusive: an object exactly at the limit is allowed.

The preflight is an optimization and resource guard, not an authorization
boundary. Storage access and object metadata remain subject to the existing
request authorization and RLS checks.
