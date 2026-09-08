FROM postgres:18.4-bookworm

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg; \
    install -d /etc/apt/keyrings; \
    curl -fsSL https://repo.pigsty.io/key \
      | gpg --batch --yes --dearmor -o /etc/apt/keyrings/pigsty.gpg; \
    printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/pigsty.gpg] https://repo.pigsty.io/apt/pgsql/bookworm bookworm main' \
      > /etc/apt/sources.list.d/pigsty-pgsql.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-18-pg-graphql; \
    rm -rf /var/lib/apt/lists/*
