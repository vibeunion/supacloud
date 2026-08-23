# Third-Party Notices

## Upstream protocol implementation

SupaCloud Lite 的 Supabase 兼容协议实现包含从一个 MIT 许可的上游协议实现派生并修改的源代码。

- Copyright: 2026 Sanket Sahu
- License: MIT
- Local license copy: `LICENSES/UPSTREAM-PROTOCOL-MIT.txt`

主要修改包括：删除 Admin UI、Node HTTP server 和 pg-mem 路径；默认使用单项目 PGlite，并提供可选 native PostgreSQL 引擎；改用 Bun.serve 和 Bun.build；增加 SupaCloud Lite 密钥、CLI、测试、文档和发布集成。

## PGlite

SupaCloud Lite 使用 ElectricSQL PGlite 作为嵌入式 PostgreSQL 引擎。

- License: Apache-2.0
- Upstream: `https://github.com/electric-sql/pglite`
- Local license copy: `LICENSES/PGLITE-APACHE-2.0.txt`

## Native PostgreSQL binaries

Linux/macOS 上的可选 native 引擎会按需下载 Theseus 发布的 PostgreSQL 17.7.0 预编译包；该二进制不会内嵌到 npm 包或 Lite 单文件发布物中。

- PostgreSQL license: PostgreSQL License
- Binary source: `https://github.com/theseus-rs/postgresql-binaries`
- PostgreSQL copyright copy: `LICENSES/POSTGRESQL-17-COPYRIGHT.txt`
- Theseus distribution license copy: `LICENSES/THESEUS-POSTGRESQL-LICENSE.txt`
- Integrity: Lite 对默认版本的四个平台归档使用内置 SHA-256 固定校验和

## Supabase JavaScript SDK

`@supabase/supabase-js` 仅作为开发和兼容性测试依赖使用，没有 vendored 到发布产物中。

## node-tar

SupaCloud Lite 使用 `tar` 作为跨平台流式快照归档依赖，避免把完整 PGlite 数据目录加载到内存。

- Version: 7.5.22
- License: BlueOak-1.0.0
- Upstream: `https://github.com/isaacs/node-tar`
- Local license copy: `LICENSES/NODE-TAR-BLUEOAK-1.0.0.txt`
- Distribution: npm 模式作为独立依赖安装；单二进制模式编入可执行文件

### node-tar runtime dependencies

单二进制会连同 `tar` 实际使用的完整运行时依赖树一起编入可执行文件：

| Package | Version | License | Upstream | Local license copy |
| --- | --- | --- | --- | --- |
| `@isaacs/fs-minipass` | 4.0.1 | ISC | `https://github.com/npm/fs-minipass` | `LICENSES/FS-MINIPASS-ISC.txt` |
| `chownr` | 3.0.0 | BlueOak-1.0.0 | `https://github.com/isaacs/chownr` | `LICENSES/CHOWNR-BLUEOAK-1.0.0.txt` |
| `minipass` | 7.1.3 | BlueOak-1.0.0 | `https://github.com/isaacs/minipass` | `LICENSES/MINIPASS-BLUEOAK-1.0.0.txt` |
| `minizlib` | 3.1.0 | MIT | `https://github.com/isaacs/minizlib` | `LICENSES/MINIZLIB-MIT.txt` |
| `yallist` | 5.0.0 | BlueOak-1.0.0 | `https://github.com/isaacs/yallist` | `LICENSES/YALLIST-BLUEOAK-1.0.0.txt` |

## Bun runtime

SupaCloud Lite 单二进制由 Bun 1.4.0 编译并内嵌 Bun runtime，最终用户无需另外安装 Bun、Node.js 或 npm。

- Version: 1.4.0
- Bun license: MIT
- Upstream: `https://github.com/oven-sh/bun`
- Local runtime notice: `LICENSES/BUN-1.4.0-RUNTIME-NOTICES.txt`
- Notice source: Bun 1.4.0 `docs/project/license.mdx` 的逐字副本
- Linked-library coverage: JavaScriptCore/WebKit、`boringssl`、`brotli`、`libarchive`、`lol-html`、`ls-hpack`、`ls-qpack`、`lsquic`、`mimalloc`、`picohttp`、`zstd`、`simdutf`、`tinycc`、`uSockets`、`zlib-ng`、`c-ares`、`libicu` 78、`libbase64`、Windows 上的 `libuv`、`libdeflate`、`libjpeg-turbo`、`libspng`、`libwebp`、`highway`、`HdrHistogram_c`、Linux/Windows 上的 `sqlite`、uWebSockets fork 和 Tigerbeetle IO 代码
- Polyfill coverage: `acorn`、`acorn-walk`、`assert`、`browserify-zlib`、`buffer`、`constants-browserify`、`crypto-browserify`、`domain-browser`、`events`、`https-browserify`、`os-browserify`、`path-browserify`、`process`、`punycode`、`querystring-es3`、`stream-browserify`、`stream-http`、`string_decoder`、`timers-browserify`、`tty-browserify`、`url`、`util`、`vm-browserify`

Bun runtime notice 包含 JavaScriptCore/WebKit 的 LGPL-2 说明、静态链接库许可证链接及内嵌 polyfill 许可证清单；发布资产按原文分发，不以本摘要替代。

## Standalone release license bundle

GitHub Release 在校验和与 provenance 生成前同时加入以下许可证资产：

- SupaCloud Lite 自身 Apache-2.0 许可证：从 `LICENSE` 复制为 `SUPACLOUD-LITE-APACHE-2.0.txt`
- 本文件：`THIRD_PARTY_NOTICES.md`
- `LICENSES/*.txt` 下的全部第三方许可证及 runtime notices
