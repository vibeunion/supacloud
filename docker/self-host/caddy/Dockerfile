FROM caddy:2.11.9-builder@sha256:f9beaa5ddbe7df6f26ebbcf9cbf44e05a1917b9bba464f0c3229038d7e2e6e13 AS builder

ARG GOPROXY=https://proxy.golang.org,direct
ENV GOTOOLCHAIN=go1.27.1

RUN go version \
    && GOBIN=/usr/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7 \
    && xcaddy build v2.11.9 \
        --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db \
        --with github.com/caddyserver/cache-handler@07d7af2130699eb840e1f4ed49ef817da4201c2e \
        --with github.com/darkweak/storages/simplefs/caddy@81250fe6fc63358ff9f12faa72b01f36e48ed60c \
        --with github.com/darkweak/storages/badger/caddy@v0.0.23 \
        --output /usr/bin/caddy

FROM caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY entrypoint.sh /usr/local/bin/supacloud-caddy-entrypoint
RUN chmod 0755 /usr/local/bin/supacloud-caddy-entrypoint

ENTRYPOINT ["/usr/local/bin/supacloud-caddy-entrypoint"]
