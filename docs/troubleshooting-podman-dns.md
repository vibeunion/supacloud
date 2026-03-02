# Podman Environment Edge Functions External DNS Resolution Failure Troubleshooting

## Problem Description

In environments using **podman** instead of Docker (RHEL / OpenCloudOS / RockyLinux, etc.), after starting Supabase Stack via `docker compose` (podman's docker compatibility layer), the Edge Functions container (`supabase-edge-functions`) fails when loading Deno functions with remote CDN dependencies:

```
worker boot error: failed to bootstrap runtime: could not find an appropriate entrypoint
```

Or when making external requests inside functions:

```json
{"message": "name resolution failed"}
```

## Root Cause

`docker compose` (via podman compatibility layer) automatically sets when creating `supabase_default` network:

```json
"options": {
  "isolate": "true"
}
```

This option puts podman's built-in DNS service (`aardvark-dns`) in isolated mode, **only resolving internal names between containers, not forwarding any external domain queries** (like `deno.land`, `esm.sh`, etc.).

Therefore, the Edge Functions container cannot download Deno module dependencies via CDN when first loading functions, causing startup failure.

> **Note**: If restarting a container that already has Deno module cache, this issue won't trigger. The issue is exposed each time a container is recreated after `docker rm`.

## Fix Steps

> **Applicable Systems**: RHEL 8/9, OpenCloudOS, RockyLinux, CentOS Stream, etc. using podman

### 1. Modify Network Config File

```bash
python3 - <<'EOF'
import json

path = "/etc/containers/networks/supabase_default.json"
data = json.load(open(path))

# Remove isolate restriction
data["options"].pop("isolate", None)

# Add upstream DNS (use DNS actually available on host)
data["dns_servers"] = ["8.8.8.8", "114.114.114.114"]

json.dump(data, open(path, "w"), indent=5)
print("Done:", path)
EOF
```

> If your host uses custom DNS (like Pigsty's `10.6.0.7`), add it to the `dns_servers` list.

### 2. Restart aardvark-dns to Apply Config

```bash
# After kill, podman will automatically restart aardvark-dns on next network operation
kill $(pgrep aardvark-dns)
sleep 1
```

### 3. Recreate Edge Functions Container

```bash
cd /path/to/supabase  # Your docker-compose.yml directory
docker compose up -d --force-recreate functions
```

### 4. Verify Fix

```bash
# Should return DNS resolution result (not NXDOMAIN or timeout)
nslookup deno.land 10.89.0.1
```

## Ongoing Maintenance

Modifying `supabase_default.json` is a manual fix for **already created networks**.  
If you encounter the same issue on a new machine or fresh deployment, repeat the above steps.

For permanent effect, configure global DNS in `/etc/containers/containers.conf`:

```toml
[network]
dns_servers = ["8.8.8.8", "114.114.114.114"]
```

Then write this config **before creating the network**, and new podman networks will automatically inherit this DNS setting.
