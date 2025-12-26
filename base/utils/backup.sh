#!/bin/sh
set -e

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/backup_${TIMESTAMP}.sql.gz"
S3_PATH="s3://${BACKUP_BUCKET}/global_db_${TIMESTAMP}.sql.gz"

echo "[${TIMESTAMP}] Starting backup..."

# Dump all databases
# We use PGPASSWORD env var for auth
pg_dumpall -h "$POSTGRES_HOST" -U "$POSTGRES_USER" --clean --if-exists | gzip > "$BACKUP_FILE"

FILE_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup created at ${BACKUP_FILE}. Size: ${FILE_SIZE}"

# Upload to S3
echo "Uploading to ${S3_PATH}..."
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$BACKUP_FILE" "$S3_PATH"

# Cleanup
rm "$BACKUP_FILE"
echo "Backup completed successfully."
