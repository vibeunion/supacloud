#!/bin/sh
set -eu

migration_file="${LEGACY_SECRETS_MIGRATION_FILE:-/run/secrets/supacloud-legacy-secrets-migration}"
legacy_key=""

if [ -e "$migration_file" ] || [ -L "$migration_file" ]; then
    legacy_key=$(MIGRATION_FILE="$migration_file" bun -e '
      import { lstatSync, readFileSync } from "node:fs";
      const migrationPath = process.env.MIGRATION_FILE;
      const metadata = lstatSync(migrationPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("legacy encryption migration input must be a regular file");
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error("legacy encryption migration input must not be group/world accessible");
      }
      const value = readFileSync(migrationPath, "utf8").replace(/\n$/, "");
      if (value.length > 0 && (value.length < 32 || /[\0\r\n]/.test(value))) {
        throw new Error("legacy encryption migration file must contain one 32+ character key");
      }
      process.stdout.write(value);
    ')
    if [ -n "$legacy_key" ]; then
        export LEGACY_SECRETS_ENCRYPTION_KEY="$legacy_key"
    fi
fi

bun run src/index.ts --init-db

unset LEGACY_SECRETS_ENCRYPTION_KEY
legacy_key=""
if [ -f "$migration_file" ]; then
    : > "$migration_file"
    [ ! -s "$migration_file" ] || {
        printf '%s\n' "failed to consume legacy encryption migration file" >&2
        exit 1
    }
fi

exec bun run src/index.ts
