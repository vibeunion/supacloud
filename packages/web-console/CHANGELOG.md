# Changelog

## [0.8.4](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.3...web-console-v0.8.4) (2026-04-24)


### 🐛 Bug Fixes

* harden realtime tasks and data-plane boundaries ([f6bdfd1](https://github.com/zuohuadong/supacloud/commit/f6bdfd1b92d501507e27ad6ed73ecd3b46cc3e97))

## [0.8.3](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.2...web-console-v0.8.3) (2026-04-23)


### 🐛 Bug Fixes

* **web-console:** allow editing project routing domains ([7ea7eb7](https://github.com/zuohuadong/supacloud/commit/7ea7eb7b28168a329fdc2a9a936d06654579aa48))
* **web-console:** restore settings and task management UI ([3f7ef75](https://github.com/zuohuadong/supacloud/commit/3f7ef756f3e151a9678f998d8e638f324ab7f77a))

## [0.8.2](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.1...web-console-v0.8.2) (2026-04-19)


### 🔧 Miscellaneous Chores

* release main ([239aea7](https://github.com/zuohuadong/supacloud/commit/239aea7e22bae05cc3c7840bc6c0fd7b322a8862))
* release main ([8d020be](https://github.com/zuohuadong/supacloud/commit/8d020be4e8d374f0cf0498a97e4beb6a88e57fb0))

## [0.8.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.0...web-console-v0.8.1) (2026-04-19)


### 🔧 Miscellaneous Chores

* **ts:** finish TypeScript 6 typecheck migration ([5e2ae90](https://github.com/zuohuadong/supacloud/commit/5e2ae9024cf356eb6892402a62bf4036b8ad00dc))

## [0.8.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.7.0...web-console-v0.8.0) (2026-04-17)


### 🚀 Features

* **tasks:** deploy background task and message queue features to servers ([e66cdac](https://github.com/zuohuadong/supacloud/commit/e66cdac9c34f34990de5675ca75bfca9894cc3b4))
* updates and fixes based on recent local changes ([449c710](https://github.com/zuohuadong/supacloud/commit/449c71089721658d25737ac7df1c196b3bc9bb1d))

## [0.7.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.6.2...web-console-v0.7.0) (2026-04-14)


### 🚀 Features

* add MCP settings page in Web Console platform sidebar ([150a7b0](https://github.com/zuohuadong/supacloud/commit/150a7b051b026aa4ea85827cdb8790a7660ce619))
* **api:** complete architecture hardening and Elysia schema validation implementation ([5d93b9a](https://github.com/zuohuadong/supacloud/commit/5d93b9ad1303efda36a3069e208096c5187f70ed))
* complete v3-v9 comprehensive compliance audit and bump version 0.0.1 ([8e3ac9f](https://github.com/zuohuadong/supacloud/commit/8e3ac9f5285611d2366bc0f652827befce822cde))
* custom domain support, edge-runtime auto-deps, test fixes ([3fb55a9](https://github.com/zuohuadong/supacloud/commit/3fb55a950d262da432e5eaa29fd455135709491a))
* **edge-functions:** implement per-function verify_jwt configuration ([d9e060b](https://github.com/zuohuadong/supacloud/commit/d9e060b68f89ddca5e87e59bfb4c34f9f4e49c4f))
* integrate web-console with Management API for /admin route ([12ab321](https://github.com/zuohuadong/supacloud/commit/12ab3212e33678f356c0327fd9eb9e859f9763a2))
* **management-api:** add web console tasks tracking & custom rate limits UI ([2f6baa1](https://github.com/zuohuadong/supacloud/commit/2f6baa120d9bf9c0ecbb6d20c7071eada5756595))
* **sdk/e2e:** finalize sdk proxy passthrough and structural snapshot tests ([b316f93](https://github.com/zuohuadong/supacloud/commit/b316f938906863fa7563e33ebe92d1ee656c006a))
* simplify frontend deployment with docker and mcp integration ([e2baff2](https://github.com/zuohuadong/supacloud/commit/e2baff230fd4f116610c9084b4a23444aa8768bf))
* simplify frontend deployment with docker and mcp integration ([61ace10](https://github.com/zuohuadong/supacloud/commit/61ace1046ebf0300c234a92a3d837cba79f1eb7a))
* **studio:** implement fully functional pg_cron, table data browser, and live container logs ([6810655](https://github.com/zuohuadong/supacloud/commit/681065598cc5c0502edad7747a84f2dbfa0c45be))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([def0c30](https://github.com/zuohuadong/supacloud/commit/def0c30fe63502a6717a760f19d98c0962ba76ab))
* v0.4.0 - SupaCloud Pages hosting, Platform Management, Studio login auth ([dc53e9d](https://github.com/zuohuadong/supacloud/commit/dc53e9df13006c01cc82d381da023e8e4c55325c))
* **v0.5.1:** add provider toggle switch, ignore .claude/.agents ([b89f4c9](https://github.com/zuohuadong/supacloud/commit/b89f4c976d6483ea32d6d6cadfdc82a8cbb60751))
* **web-console:** integrate ChatDialog AI assistant globally ([1d7abbf](https://github.com/zuohuadong/supacloud/commit/1d7abbf5b8c93c6bd429be3978927b681cd3bc8c))
* **web-console:** integrate realtime health, custom domains and oauth panels ([b316f93](https://github.com/zuohuadong/supacloud/commit/b316f938906863fa7563e33ebe92d1ee656c006a))
* **web-console:** rewrite home page — real API data, solid icons, system status panel, quick actions ([04fd67f](https://github.com/zuohuadong/supacloud/commit/04fd67fa7168afbc2ef258fa5cf9fa52405afc5a))


### 🐛 Bug Fixes

* **auth,infra:** 401 pre-flight and all-in-one local docker ([b7fb005](https://github.com/zuohuadong/supacloud/commit/b7fb00575e04cfec3a46df4209e214c6016f0bea))
* repair 2 failing getProjectHealth tests, fix providers page undefined variable, bump v0.5.2 ([c3883a5](https://github.com/zuohuadong/supacloud/commit/c3883a5a67e85340de081b130d8dd9940fc9322f))
* resolve auth endpoints and pigsty infra config ([babda5b](https://github.com/zuohuadong/supacloud/commit/babda5bfdedbc308737a824407e1306849e47af4))
* resolve core bugs, secure webhooks, and separate platform UI ([d4a2832](https://github.com/zuohuadong/supacloud/commit/d4a28327a40392ad869cb1cdd2ec8f3f1958f9a9))
* **security:** enforce API auth middleware and fix SPA routing ([7d1d288](https://github.com/zuohuadong/supacloud/commit/7d1d288428aa1a0e5e961ca791b63870e08f4f23))
* **web-console:** await svelte-i18n init in root layout to prevent synchronous translation crash on page load ([765449d](https://github.com/zuohuadong/supacloud/commit/765449dec8d203280e4361ba66c7cd9cf1a863e9))
* **web-console:** complete i18n localization for ChatDialog and main layout ([4f8fa8a](https://github.com/zuohuadong/supacloud/commit/4f8fa8a26cffe5985d4403f4ae147ba3c2cf4ab6))
* **web-console:** correct Svelte 5 store syntax for svelte-query rune data access ([f5199d7](https://github.com/zuohuadong/supacloud/commit/f5199d763f21cd7763a7b9dec1dcc822efa262b0))
* **web-console:** fix issue where project switcher did not work and admin page did not enforce login ([a203c9d](https://github.com/zuohuadong/supacloud/commit/a203c9dd04904e8d846f4bbe32588b36b10e903a))
* **web-console:** force full remount on project switch to refresh content ([7cb839c](https://github.com/zuohuadong/supacloud/commit/7cb839cd368711c4954c01776be96738d8ad8ac4))
* **web-console:** include [@svadmin](https://github.com/svadmin) components in tailwind v4 class scanner via [@source](https://github.com/source) directives to restore dashboard styling ([617bf60](https://github.com/zuohuadong/supacloud/commit/617bf60b6676964de5116b2d4b64526c9a45af05))
* **web-console:** initialize SVAdmin UI component registry to fix undefined Breadcrumbs during Layout rendering ([d4491a0](https://github.com/zuohuadong/supacloud/commit/d4491a07df4f30f4cc97798c29308ba7c1692105))
* **web-console:** inject chat translations to svadmin core locales ([d38c083](https://github.com/zuohuadong/supacloud/commit/d38c083f7a4346d3ce26ccabd6a493357bbf5372))
* **web-console:** register full locale strings in svelte-i18n and import synchronously to prevent initialization race conditions ([fc5dc36](https://github.com/zuohuadong/supacloud/commit/fc5dc36988b0fcfb3f4d5a61a5f2289c6a3b030b))
* **web-console:** resolve Svelte 5 auth provider deadlock and add legacy hash redirect ([073fedf](https://github.com/zuohuadong/supacloud/commit/073fedf6fa2e5bd33605014b1f5244357fa9817d))
* **web-console:** restore original custom Sidebar and layout shell while retaining svadmin data provider pipelines ([2b1b1ea](https://github.com/zuohuadong/supacloud/commit/2b1b1eaa19bb6875c3d172dc8219e8e64b70dc76))


### 💅 Elegance & Refactoring

* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([75c7dfd](https://github.com/zuohuadong/supacloud/commit/75c7dfd272ee2c9ca4f638a8493596c20a4ae4bf))
* eliminate technical debt — split projects.ts, centralize env vars, remove all any types ([13500d1](https://github.com/zuohuadong/supacloud/commit/13500d172805cfe3af14dac3f250de3550a8b7b0))
* simplify AutoTable with columns map definition ([a6a40f8](https://github.com/zuohuadong/supacloud/commit/a6a40f8a2b2f26384f27a225886fe8939b340c2f))
* **web-console:** complete svadmin migration with functions, secrets, and hosting lists ([4e5ef12](https://github.com/zuohuadong/supacloud/commit/4e5ef12c921bc6ad2fad275e92dcc53c2af125de))
* **web-console:** finalize AutoTable hybrid migration for auth and tables pages ([209608b](https://github.com/zuohuadong/supacloud/commit/209608b1f53e2cefb3f1b39dd33614c70b83ab34))
* **web-console:** finalize svadmin migration for all previously modified and untracked components ([d9ff5ba](https://github.com/zuohuadong/supacloud/commit/d9ff5ba8585ce08e8a614c43c2ee36a806a6453e))


### 📝 Documentation

* document SVAdmin Hybrid Mount architecture and useList patterns ([ca5435d](https://github.com/zuohuadong/supacloud/commit/ca5435d7df15aa014f8df927c2ea1b62c701afca))
* **web-console:** add pure SPA architecture annotations and adapter-static compatibility instructions ([1d2fc73](https://github.com/zuohuadong/supacloud/commit/1d2fc73d2c0ea822dbbbbe6d2b2a9abb9d09c76c))


### 🔧 Miscellaneous Chores

* **deps:** update [@svadmin](https://github.com/svadmin) components to latest versions in console and api ([0d30e5b](https://github.com/zuohuadong/supacloud/commit/0d30e5b73b63875bd9f5763a2a17ff1c5487e774))
* flush remaining test suite fixes and project modifications ([b678a77](https://github.com/zuohuadong/supacloud/commit/b678a77bf72e4bcaf75f9963153f8802ec0d869e))
* remove legacy studio configs ([65eab8f](https://github.com/zuohuadong/supacloud/commit/65eab8ffb08ec7fa2d9e9e37b5ede7bbbb4f80ab))
* setup release-please for automated versioning and update svadmin dependencies ([3c62ac6](https://github.com/zuohuadong/supacloud/commit/3c62ac6f096850471bd55226a84d2605e293d751))
* update @modelcontextprotocol/sdk and @svadmin/ui versions and remove @svadmin/editor dependency ([37df3a7](https://github.com/zuohuadong/supacloud/commit/37df3a7601e64a7be15bbda1ec504be1864a808c))
* update svadmin to latest version in web-console ([2e4e415](https://github.com/zuohuadong/supacloud/commit/2e4e415e229cd76c8752f5fbc837d16fc44e6422))
* upgrade svadmin framework to core@0.19.2, ui@0.23.0, elysia@0.10.0 ([c6b1fdf](https://github.com/zuohuadong/supacloud/commit/c6b1fdf93a486116a64656baac563a7791a76be6))
* upgrade svadmin framework to core@0.19.3, ui@0.23.2, elysia@0.10.1 ([212387f](https://github.com/zuohuadong/supacloud/commit/212387fb11ab8031317b69c74c3389529a6fa547))
* upgrade svadmin to latest version and fix breaking changes in query/mutation hooks ([58dd961](https://github.com/zuohuadong/supacloud/commit/58dd96111cbdfb481e89a68b4ea28c8a9d83cf93))
* **web-console:** delete orphaned mock projects/sql page ([5d24ba9](https://github.com/zuohuadong/supacloud/commit/5d24ba966783014a2ceb039ca8cd0d56849b7f22))
* **web-console:** fix vite 8 compile bug via rollup external config and fix missing markdown dependencies ([78df86c](https://github.com/zuohuadong/supacloud/commit/78df86ce60ab76ce402e2c1d344f561d38b2cc7d))
* **web-console:** remove orphaned mock pages (/dashboard, /monitoring, /system) that duplicated API-driven routes ([9abe8a9](https://github.com/zuohuadong/supacloud/commit/9abe8a9ef5e56a525e1be17329a21ee91fbba40d))
* **web-console:** update vite to 8.0.3 and fix prerender dynamic imports ([9ac9147](https://github.com/zuohuadong/supacloud/commit/9ac91476b02de4455db781e74d96bf9b136a2c7a))
* **web-console:** upgrade [@svadmin](https://github.com/svadmin) to latest and fix AutoTable cellRenderer breaking change ([e4a77ad](https://github.com/zuohuadong/supacloud/commit/e4a77ad86a95c65aacbddd3329a76cdb2e1e754d))
