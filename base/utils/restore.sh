#!/bin/sh
set -e

# Usage: ./restore.sh <backup_filename>
# Example: ./restore.sh global_db_20251227_120000.sql.gz

BACKUP_FILE="$1"

if [ -z "$BACKUP_FILE" ]; then
  echo "Error: No backup filename provided."
  exit 1
fi

LOCAL_PATH="/tmp/${BACKUP_FILE}"
S3_PATH="s3://${BACKUP_BUCKET}/${BACKUP_FILE}"

echo "Starting restore process for ${BACKUP_FILE}..."

# 1. Download from S3
echo "Downloading from ${S3_PATH}..."
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$S3_PATH" "$LOCAL_PATH"

if [ ! -f "$LOCAL_PATH" ]; then
  echo "Error: Failed to download backup file."
  exit 1
fi

# 2. Restore to Postgres
echo "Restoring to database..."
# We use gunzip -c to pipe directly to psql
# --clean: Drop database objects before creating them
# --if-exists: Use IF EXISTS when dropping objects
gunzip -c "$LOCAL_PATH" | psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" --clean --if-exists postgres

# 3. Cleanup
rm "$LOCAL_PATH"

echo "Restore completed successfully."
