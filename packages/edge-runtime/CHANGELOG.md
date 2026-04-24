# Changelog

## [0.3.3](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.2...edge-runtime-v0.3.3) (2026-04-24)


### 🐛 Bug Fixes

* harden realtime tasks and data-plane boundaries ([f6bdfd1](https://github.com/zuohuadong/supacloud/commit/f6bdfd1b92d501507e27ad6ed73ecd3b46cc3e97))

## [0.3.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.1...edge-runtime-v0.3.2) (2026-04-19)


### 🔧 Miscellaneous Chores

* release main ([239aea7](https://github.com/zuohuadong/supacloud/commit/239aea7e22bae05cc3c7840bc6c0fd7b322a8862))
* release main ([8d020be](https://github.com/zuohuadong/supacloud/commit/8d020be4e8d374f0cf0498a97e4beb6a88e57fb0))

## [0.3.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.0...edge-runtime-v0.3.1) (2026-04-18)


### 🐛 Bug Fixes

* **edge-runtime:** avoid double-managed runtime restarts ([5a27175](https://github.com/zuohuadong/supacloud/commit/5a271758fff9bbe008f8d8aade559e4d8dffab3e))


### 💅 Elegance & Refactoring

* **edge-functions:** migrate version artifacts into internal revisions ([e9c0890](https://github.com/zuohuadong/supacloud/commit/e9c0890013bb23b0189dd089c3e7d79507ee37b2))


### 🔧 Miscellaneous Chores

* **systemd:** add canonical service templates ([9f1c42c](https://github.com/zuohuadong/supacloud/commit/9f1c42c4fabd1da1d24a35c9f699f92f22e0bcad))

## [0.3.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.2.1...edge-runtime-v0.3.0) (2026-04-17)


### 🚀 Features

* **tasks:** deploy background task and message queue features to servers ([e66cdac](https://github.com/zuohuadong/supacloud/commit/e66cdac9c34f34990de5675ca75bfca9894cc3b4))
* updates and fixes based on recent local changes ([449c710](https://github.com/zuohuadong/supacloud/commit/449c71089721658d25737ac7df1c196b3bc9bb1d))

## [0.2.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.2.0...edge-runtime-v0.2.1) (2026-04-16)


### 🐛 Bug Fixes

* **edge-runtime:** bust Bun import() cache on function redeploy ([fae6e90](https://github.com/zuohuadong/supacloud/commit/fae6e90ea414b38326c553d0751970e0e7386576))
* **edge-runtime:** use EDGE_RUNTIME_PORT to avoid port conflict with management API ([69b6f44](https://github.com/zuohuadong/supacloud/commit/69b6f448c25e8e57ec68e462ed31ee0b623e5d7b))


### 💅 Elegance & Refactoring

* **edge-runtime:** replace query-param hack with Worker replacement for module invalidation ([777c7d2](https://github.com/zuohuadong/supacloud/commit/777c7d242d9ffb8d78082afbd75f3fcaf0553a16))

## [0.2.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.1.1...edge-runtime-v0.2.0) (2026-04-14)


### 🚀 Features

* add Signed URLs, TUS resumable upload, and Edge Functions SDK compatibility ([cdaeca1](https://github.com/zuohuadong/supacloud/commit/cdaeca12094796ac92f38114cf23b6728e63a057))
* **api:** complete architecture hardening and Elysia schema validation implementation ([5d93b9a](https://github.com/zuohuadong/supacloud/commit/5d93b9ad1303efda36a3069e208096c5187f70ed))
* **core:** Native Supabase compatibility fixes for Realtime, Storage RLS, and Edge Functions ([44ba883](https://github.com/zuohuadong/supacloud/commit/44ba8836347e8c2d04911330cd4bb8546eed71e5))
* custom domain support, edge-runtime auto-deps, test fixes ([3fb55a9](https://github.com/zuohuadong/supacloud/commit/3fb55a950d262da432e5eaa29fd455135709491a))
* **edge-functions:** implement per-function verify_jwt configuration ([d9e060b](https://github.com/zuohuadong/supacloud/commit/d9e060b68f89ddca5e87e59bfb4c34f9f4e49c4f))
* **edge-runtime:** add jsr/npm import matching and expand Deno std lib shims ([8d1758a](https://github.com/zuohuadong/supacloud/commit/8d1758ad074ef0bd2d6d8bb4562c91a9351e03e4))
* **edge-runtime:** merge Deno.serve() compatibility into WorkerPool sandbox ([25feca2](https://github.com/zuohuadong/supacloud/commit/25feca24a09287bcb34866b5923cc676a67ba60a))
* **edge:** module cache invalidation on deploy + Angie CORS template ([456df57](https://github.com/zuohuadong/supacloud/commit/456df57c65876aa80adea84d545a9ae4a6d2d274))
* **edge:** server-side Bun.build() bundling pipeline + multi-file bundle deploy ([4010992](https://github.com/zuohuadong/supacloud/commit/401099230b49a9ba08f5ef4cee6beab143d02b37))
* **platform:** massive stabilization update across edge-runtime, mcp, routing, and sdk-proxy compatibility ([38f010a](https://github.com/zuohuadong/supacloud/commit/38f010ac111ef2cd098f63c328d2d6e2cebafbe3))
* **secrets:** DB-backed project secrets with dynamic runtime injection ([0b06bc6](https://github.com/zuohuadong/supacloud/commit/0b06bc6775adae14060fae7cffe8f2b7c5b14dea))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([def0c30](https://github.com/zuohuadong/supacloud/commit/def0c30fe63502a6717a760f19d98c0962ba76ab))


### 🐛 Bug Fixes

* **auth,infra:** 401 pre-flight and all-in-one local docker ([b7fb005](https://github.com/zuohuadong/supacloud/commit/b7fb00575e04cfec3a46df4209e214c6016f0bea))
* **edge-runtime:** add missing jose dependency ([67e75fb](https://github.com/zuohuadong/supacloud/commit/67e75fb40be325ec93f72c9fa8b5c4aa302946e8))
* **edge-runtime:** add stripped path routing fallbacks to support Kong strip_path: true ([02bde5c](https://github.com/zuohuadong/supacloud/commit/02bde5c63fc99af0f80a2a877773aa99fb3baf26))
* **edge-runtime:** bypass verifyJwt for CORS preflight OPTIONS requests to prevent 401 errors ([62c3918](https://github.com/zuohuadong/supacloud/commit/62c3918186beb78aac4d496ffee24f7d1c7c0798))
* **edge-runtime:** cache project secrets to prevent DOMException TimeoutError under load and accept apikey header ([37bb41c](https://github.com/zuohuadong/supacloud/commit/37bb41c93f938bc70135d06d36b76e3dd4a3b829))
* **edge-runtime:** exact ipv4 binding for localhost healthchecks ([cfa16d2](https://github.com/zuohuadong/supacloud/commit/cfa16d22696429eecdf19d72d760dcfdc88d1072))
* **edge-runtime:** remove suicidal killStaleListeners to break restart loop ([4c06386](https://github.com/zuohuadong/supacloud/commit/4c06386b8f9c214d6ffc137439d57109cbfe7614))
* **edge:** increase pool timeout to 5min (300s) ([69185d1](https://github.com/zuohuadong/supacloud/commit/69185d1f33f30a13a6711200de24c15a19e1e384))
* **edge:** increase timeouts for AI streaming (20s→120s pool, 300s proxy) ([66a146f](https://github.com/zuohuadong/supacloud/commit/66a146f9188fb7ce0ec31a02f86b3687a28faf73))
* explicit @sinclair/typebox dependency to prevent elysia/edge-runtime crash during CI e2e tests proxy boot ([3a288e0](https://github.com/zuohuadong/supacloud/commit/3a288e0317bceba940145f9e2aa8e306ab17b10d))
* **gw:** route mcp over native gateway internally, bump dep ([19084ea](https://github.com/zuohuadong/supacloud/commit/19084ea79c9e2a18f0548c2d9d45ffa7fcaa6af7))


### 💅 Elegance & Refactoring

* remove legacy supabase-vector/auth container deps, fix ASSETS null guard ([4bb0323](https://github.com/zuohuadong/supacloud/commit/4bb032334fea13bc09eb99042100c14d6bab1ba9))


### 🔧 Miscellaneous Chores

* better jwt error logging ([7d9e862](https://github.com/zuohuadong/supacloud/commit/7d9e862f435e93281c4ae35ca4b21241c52eb5e4))
* flush remaining test suite fixes and project modifications ([b678a77](https://github.com/zuohuadong/supacloud/commit/b678a77bf72e4bcaf75f9963153f8802ec0d869e))
* push all accumulated compliance and runtime integrations ([adba09c](https://github.com/zuohuadong/supacloud/commit/adba09ca0752da3ad240f728873f460076246ab2))
