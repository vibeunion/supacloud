FROM caddy:2.11.4-builder@sha256:522c540599fa8f6a340b18dea8ee12dfd9d8198347cefa2c4c54344159ae6c0b AS builder

RUN GOBIN=/usr/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5 \
    && xcaddy build v2.11.4 \
        --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db \
        --output /usr/bin/caddy

FROM caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY entrypoint.sh /usr/local/bin/supacloud-caddy-entrypoint
RUN chmod 0755 /usr/local/bin/supacloud-caddy-entrypoint

ENTRYPOINT ["/usr/local/bin/supacloud-caddy-entrypoint"]
