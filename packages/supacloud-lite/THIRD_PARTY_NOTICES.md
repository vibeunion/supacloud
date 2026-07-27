# Third-Party Notices

## Tinbase

SupaCloud Lite 的 Supabase 兼容协议实现包含从 Tinbase 0.10.0 派生并修改的源代码。

- Copyright: 2026 Sanket Sahu
- License: MIT
- Upstream: `https://github.com/sanketmysore/tinbase`
- Local license copy: `LICENSES/TINBASE-MIT.txt`

主要修改包括：删除 Admin UI、Node HTTP server、native PostgreSQL 和 pg-mem 路径；固定为单项目 PGlite；改用 Bun.serve 和 Bun.build；增加 SupaCloud Lite 密钥、CLI、测试、文档和发布集成。

## PGlite

SupaCloud Lite 使用 ElectricSQL PGlite 作为嵌入式 PostgreSQL 引擎。

- License: Apache-2.0
- Upstream: `https://github.com/electric-sql/pglite`
- Local license copy: `LICENSES/PGLITE-APACHE-2.0.txt`

## Supabase JavaScript SDK

`@supabase/supabase-js` 仅作为开发和兼容性测试依赖使用，没有 vendored 到发布产物中。
