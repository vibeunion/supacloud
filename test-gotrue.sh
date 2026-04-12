#!/bin/bash
docker run --rm -d --name test-gotrue -p 9999:9999 \
  -e GOTRUE_LOG_LEVEL=info \
  -e GOTRUE_API_HOST=0.0.0.0 \
  -e GOTRUE_API_PORT=9999 \
  -e GOTRUE_SITE_URL=http://127.0.0.1:9090 \
  -e GOTRUE_URI_ALLOW_LIST=http://127.0.0.1:9090 \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  -e GOTRUE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long \
  -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_JWT_EXP=3600 \
  supabase/gotrue:v2.188.1

sleep 3
docker logs test-gotrue
docker stop test-gotrue
