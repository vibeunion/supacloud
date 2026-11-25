# Patched Postrust v3.4.0.
# Upstream release: https://github.com/postrust/postrust/releases/tag/v3.4.0
# Toolchain and features match the official Dockerfile (admin-ui,otel on
# rust 1.98.1). The null-RPC patch is applied to the pinned tag archive
# before cargo build. This image is not docker.io/postrust/postrust:v3.4.0.
# See docs/postrust-v3.4.0-adoption.md.

FROM rust:1.98.1-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        patch \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/lib/postrust_pin.sh /usr/local/lib/supacloud/postrust_pin.sh
COPY scripts/build_supacloud_postrust.sh /usr/local/bin/build_supacloud_postrust.sh
COPY docs/patches/postrust-v3.4.0-null-rpc-args.patch /opt/supacloud/patches/postrust-v3.4.0-null-rpc-args.patch

ENV SUPACLOUD_POSTRUST_PIN=/usr/local/lib/supacloud/postrust_pin.sh \
    SUPACLOUD_POSTRUST_PATCH=/opt/supacloud/patches/postrust-v3.4.0-null-rpc-args.patch \
    SUPACLOUD_POSTRUST_SKIP_RUST_INSTALL=1 \
    OUT_DIR=/out

RUN chmod 0755 /usr/local/bin/build_supacloud_postrust.sh \
    && /usr/local/bin/build_supacloud_postrust.sh

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 postrust \
    && mkdir -p /usr/local/lib/supacloud

COPY --from=builder /out/postrust /usr/local/bin/postrust
COPY --from=builder /out/postrust.postrust-patch /usr/local/lib/supacloud/postrust-patch
COPY --from=builder /out/SHA256SUMS.postrust /usr/local/lib/supacloud/SHA256SUMS.postrust

LABEL org.supacloud.postrust.version="v3.4.0" \
      org.supacloud.postrust.patch="postrust-v3.4.0-null-rpc-args" \
      org.supacloud.postrust.features="admin-ui,otel" \
      org.supacloud.postrust.rustc="1.98.1"

ENV PGRST_SERVER_HOST=0.0.0.0
USER postrust
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/_/health || exit 1
CMD ["postrust"]
