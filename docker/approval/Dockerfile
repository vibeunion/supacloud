FROM postgres:18.4-bookworm

# Upstream pg_durable currently publishes amd64 binaries only.
RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
    && curl --fail --location --retry 3 --max-time 180 \
      https://github.com/microsoft/pg_durable/releases/download/v0.2.8/pg-durable-postgresql-18_0.2.8-1_amd64.deb \
      -o /tmp/durable.deb \
    && echo '090028f59b003613b150e61ccd5cdbebe70e69e65361913ad29b1f0b6af9e2bb  /tmp/durable.deb' | sha256sum -c - \
    && curl --fail --location --retry 3 --max-time 180 \
      https://github.com/supabase/pg_jsonschema/releases/download/v0.3.4/pg_jsonschema-v0.3.4-pg18-amd64-linux-gnu.deb \
      -o /tmp/jsonschema.deb \
    && echo '5c7fe6c810835e4242fb0365b57581c0009b0155200dd4f1266cee434295732f  /tmp/jsonschema.deb' | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/durable.deb /tmp/jsonschema.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/*.deb

COPY init.sql /docker-entrypoint-initdb.d/01-extensions.sql
