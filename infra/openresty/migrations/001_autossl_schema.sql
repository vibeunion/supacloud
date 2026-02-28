-- Migration: 001_autossl_schema.sql
-- 用途: 为 lua-resty-auto-ssl PostgreSQL 适配器创建存储表
-- 执行: psql -U postgres -f 001_autossl_schema.sql

-- ──────────────────────────────────────────────
-- Schema
-- ──────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS autossl;

-- ──────────────────────────────────────────────
-- 存储表
-- key 格式示例:
--   "example.com:latest"              -- 证书+私钥（永久，expires_at IS NULL）
--   "example.com:challenge:<token>"   -- ACME challenge token（短期，秒级 TTL）
--   "example.com:lock"                -- 申请锁（防并发，秒级 TTL）
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS autossl.certificates (
    key         TEXT          NOT NULL PRIMARY KEY,
    value       TEXT          NOT NULL,
    expires_at  TIMESTAMPTZ   DEFAULT NULL,   -- NULL = 永不过期（证书数据）
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  autossl.certificates           IS 'lua-resty-auto-ssl 证书及 ACME challenge 数据存储';
COMMENT ON COLUMN autossl.certificates.key       IS 'storage key，格式: domain:type[:extra]';
COMMENT ON COLUMN autossl.certificates.value     IS '存储内容（JSON 或纯文本 PEM）';
COMMENT ON COLUMN autossl.certificates.expires_at IS 'NULL 表示永久；非 NULL 表示 ACME 临时数据过期时间';

-- 对过期索引加速 get() 的过期过滤 + 定时清理
CREATE INDEX IF NOT EXISTS idx_autossl_expires
    ON autossl.certificates (expires_at)
    WHERE expires_at IS NOT NULL;

-- ──────────────────────────────────────────────
-- 专用低权限角色（仅对该表的 DML 权限）
-- ──────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'autossl') THEN
        CREATE ROLE autossl LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
    END IF;
END $$;

GRANT USAGE ON SCHEMA autossl TO autossl;
GRANT SELECT, INSERT, UPDATE, DELETE ON autossl.certificates TO autossl;

-- ──────────────────────────────────────────────
-- 可选：通过 pg_cron 定时清理过期 ACME challenge token
-- 需要先安装 pg_cron 扩展（Pigsty 默认包含）:
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   GRANT USAGE ON SCHEMA cron TO postgres;
-- ──────────────────────────────────────────────
-- SELECT cron.schedule(
--     'autossl-cleanup-expired',
--     '*/15 * * * *',
--     $cron$
--         DELETE FROM autossl.certificates
--         WHERE expires_at IS NOT NULL AND expires_at < NOW();
--     $cron$
-- );
