-- lua-resty-auto-ssl PostgreSQL storage adapter
-- 依赖: opm get leafo/pgmoon
--
-- 配置示例 (nginx.conf init_by_lua_block):
--   auto_ssl:set("storage_adapter", "resty.auto-ssl.storage_adapters.postgres")
--   auto_ssl:set("postgres", {
--     host     = "127.0.0.1",
--     port     = 5432,
--     database = "postgres",
--     user     = "autossl",
--     password = "your_password",
--     schema   = "autossl",
--     table    = "certificates",
--     pool_size = 5,
--   })

local pgmoon = require "pgmoon"

local _M = {}

-- 构造适配器实例，从 auto_ssl 配置中读取 postgres 连接参数
function _M.new(auto_ssl_instance)
  local opts = auto_ssl_instance:get("postgres") or {}

  if not opts["host"]     then opts["host"]     = "127.0.0.1"    end
  if not opts["port"]     then opts["port"]     = 5432           end
  if not opts["database"] then opts["database"] = "postgres"     end
  if not opts["user"]     then opts["user"]     = "autossl"      end
  if not opts["schema"]   then opts["schema"]   = "autossl"      end
  if not opts["table"]    then opts["table"]    = "certificates" end
  if not opts["pool_size"] then opts["pool_size"] = 5            end

  return setmetatable({ options = opts }, { __index = _M })
end

-- 获取（或复用）当前请求的 PG 连接
local function get_connection(self)
  -- 在同一请求上下文内复用同一连接，避免重复握手
  local ctx_key = "auto_ssl_pg:" .. self.options["database"]
  local conn = ngx.ctx[ctx_key]
  if conn then
    return conn
  end

  local pg = pgmoon.new({
    host     = self.options["host"],
    port     = self.options["port"],
    database = self.options["database"],
    user     = self.options["user"],
    password = self.options["password"],
  })

  local ok, err = pg:connect()
  if not ok then
    return nil, "auto-ssl postgres: connect failed: " .. (err or "unknown")
  end

  -- 设置 search_path，让后续 SQL 不必写完整 schema 前缀
  local schema = pg:escape_identifier(self.options["schema"])
  pg:query("SET search_path TO " .. schema .. ", public")

  ngx.ctx[ctx_key] = pg
  return pg
end

-- 请求周期结束后将连接归还连接池（在 log_by_lua_block 中调用）
function _M.release_connection(self)
  local ctx_key = "auto_ssl_pg:" .. self.options["database"]
  local conn = ngx.ctx[ctx_key]
  if conn then
    conn:keepalive(60000, self.options["pool_size"])
    ngx.ctx[ctx_key] = nil
  end
end

-- setup / setup_worker：auto-ssl 框架在初始化时调用，此处无需操作
function _M.setup()
end

function _M.setup_worker()
end

-- 读取 key 对应的值；同时过滤已过期行（惰性删除）
function _M.get(self, key)
  local pg, err = get_connection(self)
  if err then
    return nil, err
  end

  local tbl = pg:escape_identifier(self.options["table"])
  local res, query_err = pg:query(
    "SELECT value FROM " .. tbl ..
    " WHERE key = " .. pg:escape_literal(key) ..
    " AND (expires_at IS NULL OR expires_at > NOW())" ..
    " LIMIT 1"
  )

  if query_err then
    return nil, "auto-ssl postgres: get failed: " .. query_err
  end

  if res and #res > 0 then
    return res[1].value
  end

  return nil  -- key 不存在或已过期
end

-- 写入/更新 key；支持 options.exptime（TTL 秒数）
function _M.set(self, key, value, options)
  local pg, err = get_connection(self)
  if err then
    return false, err
  end

  local tbl = pg:escape_identifier(self.options["table"])

  -- 计算 expires_at
  local expires_at_sql
  if options and options["exptime"] and options["exptime"] > 0 then
    expires_at_sql = string.format("NOW() + INTERVAL '%d seconds'", options["exptime"])
  else
    expires_at_sql = "NULL"
  end

  -- UPSERT：key 冲突时覆盖更新
  local sql = string.format(
    [[INSERT INTO %s (key, value, expires_at, updated_at)
      VALUES (%s, %s, %s, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value      = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()]],
    tbl,
    pg:escape_literal(key),
    pg:escape_literal(value),
    expires_at_sql
  )

  local res, query_err = pg:query(sql)
  if query_err then
    return false, "auto-ssl postgres: set failed: " .. query_err
  end

  return true
end

-- 删除指定 key
function _M.delete(self, key)
  local pg, err = get_connection(self)
  if err then
    return false, err
  end

  local tbl = pg:escape_identifier(self.options["table"])
  local res, query_err = pg:query(
    "DELETE FROM " .. tbl .. " WHERE key = " .. pg:escape_literal(key)
  )

  if query_err then
    return false, "auto-ssl postgres: delete failed: " .. query_err
  end

  return true
end

-- 返回所有以 suffix 结尾的 key，用于证书续期扫描
-- auto-ssl 内部调用 keys_with_suffix(":latest") 枚举需要续期的证书
function _M.keys_with_suffix(self, suffix)
  local pg, err = get_connection(self)
  if err then
    return nil, err
  end

  local tbl = pg:escape_identifier(self.options["table"])
  -- 使用 LIKE 匹配后缀；suffix 本身是框架内部硬编码值（":latest" 等），无注入风险
  -- 但仍通过 escape_literal 处理以应对未来变化
  local pattern = pg:escape_literal("%" .. suffix)
  local res, query_err = pg:query(
    "SELECT key FROM " .. tbl ..
    " WHERE key LIKE " .. pattern ..
    " AND (expires_at IS NULL OR expires_at > NOW())"
  )

  if query_err then
    return nil, "auto-ssl postgres: keys_with_suffix failed: " .. query_err
  end

  local keys = {}
  if res then
    for _, row in ipairs(res) do
      table.insert(keys, row.key)
    end
  end

  return keys
end

return _M
