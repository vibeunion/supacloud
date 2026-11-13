FROM caddy:2.11.7-builder@sha256:b25f47453fa02f7e66c0828b4b1343658808b9000950b6825c4a1cb0c988f5f8 AS builder

ARG GOPROXY=https://proxy.golang.org,direct
ENV GOTOOLCHAIN=go1.27.1

RUN go version \
    && GOBIN=/usr/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7 \
    && xcaddy build v2.11.7 \
        --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db \
        --with github.com/caddyserver/cache-handler@07d7af2130699eb840e1f4ed49ef817da4201c2e \
        --with github.com/darkweak/storages/simplefs/caddy@81250fe6fc63358ff9f12faa72b01f36e48ed60c \
        --with github.com/darkweak/storages/badger/caddy@v0.0.23 \
        --output /usr/bin/caddy

FROM caddy:2.11.7@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY entrypoint.sh /usr/local/bin/supacloud-caddy-entrypoint
RUN chmod 0755 /usr/local/bin/supacloud-caddy-entrypoint

ENTRYPOINT ["/usr/local/bin/supacloud-caddy-entrypoint"]
