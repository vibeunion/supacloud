# Changelog

## [0.21.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.20.0...compiler-v0.21.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **commands:** HTTP JSON methods return unknown unless decoded through a contract; writes default to no replay. Durable adapters require explicit authorization and input codecs. See docs/command-migration.md for import, auth, schema, and deployment migration steps.

### Features

* add application framework packages (app, compiler, elysia) ([#1082](https://github.com/vibeunion/supacloud/issues/1082)) ([7e6ccca](https://github.com/vibeunion/supacloud/commit/7e6cccaef340ea18b10040b32871cded1206fe91))
* add statically compiled AOP boundaries and jobs ([#1160](https://github.com/vibeunion/supacloud/issues/1160)) ([66c962a](https://github.com/vibeunion/supacloud/commit/66c962a923ed6c4dbd3a354715346878793bb14c))
* add SupAuth identity and FA-driven command governance ([#1220](https://github.com/vibeunion/supacloud/issues/1220)) ([66a77ca](https://github.com/vibeunion/supacloud/commit/66a77caea086bb1282772dd9401bd2adb9c04342))
* **app:** add command governance boundaries ([#1104](https://github.com/vibeunion/supacloud/issues/1104)) ([48b6f4f](https://github.com/vibeunion/supacloud/commit/48b6f4f1dc9c8f474faa325172ee9f20b42d8332))
* **app:** enforce command governance at runtime ([#1096](https://github.com/vibeunion/supacloud/issues/1096)) ([63f59e0](https://github.com/vibeunion/supacloud/commit/63f59e09bb98835ba3dc414e9fcc3806295850e4))
* **app:** provide zero-config project defaults ([#1173](https://github.com/vibeunion/supacloud/issues/1173)) ([489824d](https://github.com/vibeunion/supacloud/commit/489824db5137e4675248cfc789d9d86e8139775e))
* **app:** validate HTTP contracts and require route declarations ([#1201](https://github.com/vibeunion/supacloud/issues/1201)) ([6fc047b](https://github.com/vibeunion/supacloud/commit/6fc047b2349bc04fbbe0ff134558d6e45dc275eb))
* **architecture:** enforce compile-time application governance ([#1301](https://github.com/vibeunion/supacloud/issues/1301)) ([b2c1df2](https://github.com/vibeunion/supacloud/commit/b2c1df25294d0195ddf313623b965e599847d9f9))
* **cli:** add governed application starter ([#1193](https://github.com/vibeunion/supacloud/issues/1193)) ([f33561b](https://github.com/vibeunion/supacloud/commit/f33561bfb05e0a63ce08de0153a4fa95f02ac2d6))
* **commands:** unify durable execution with existing workflows ([#1243](https://github.com/vibeunion/supacloud/issues/1243)) ([6da15d4](https://github.com/vibeunion/supacloud/commit/6da15d459e1883ab94e240834200a57e9a41676b))
* **compiler,app:** add module tags and boundary governance with Nx workspace configuration ([#1110](https://github.com/vibeunion/supacloud/issues/1110)) ([dda9635](https://github.com/vibeunion/supacloud/commit/dda96355ba25a53f1b550e8e95011b1c806a2003))
* **compiler:** add built-in module boundary governance presets and profiles ([#1132](https://github.com/vibeunion/supacloud/issues/1132)) ([ff75de8](https://github.com/vibeunion/supacloud/commit/ff75de882969f2b67cbbcebe8e72fe8df84489ad))
* **compiler:** add CanDeactivate guards, tree-shakable token codegen, matchRoute helper, and redirect target validation ([#1147](https://github.com/vibeunion/supacloud/issues/1147)) ([ef0f551](https://github.com/vibeunion/supacloud/commit/ef0f551d1b93121b2cf607635170ade6407c11c8))
* **compiler:** add checkProject drift detection, capabilities governance, and CLI ([#1134](https://github.com/vibeunion/supacloud/issues/1134)) ([831225a](https://github.com/vibeunion/supacloud/commit/831225a6d8d5c79392c4e261ddbffb092125c97f))
* **compiler:** add database-first GraphQL query contracts ([#1224](https://github.com/vibeunion/supacloud/issues/1224)) ([a10e0d5](https://github.com/vibeunion/supacloud/commit/a10e0d54f87bee79c0a3a34f9b8685a994eb444b))
* **compiler:** add DestroyRef teardown lifecycle, CanMatch guards, and parameter transforms ([#1145](https://github.com/vibeunion/supacloud/issues/1145)) ([bd6b4ab](https://github.com/vibeunion/supacloud/commit/bd6b4abae8e3cc37a3fc654f810d42a46deca88d))
* **compiler:** add forwardRef, DestroyRef AbortSignal, Route title/data, and shadowed route detection ([#1146](https://github.com/vibeunion/supacloud/issues/1146)) ([2d9e488](https://github.com/vibeunion/supacloud/commit/2d9e48802683a349b00eb996a951f637cdeafa47))
* **compiler:** add local delivery planning and independent builds ([#1245](https://github.com/vibeunion/supacloud/issues/1245)) ([fd860ac](https://github.com/vibeunion/supacloud/commit/fd860ac82834f28df733ca5c91f3a3314a8ca748))
* **compiler:** configure command capabilities ([#1178](https://github.com/vibeunion/supacloud/issues/1178)) ([ccac0b6](https://github.com/vibeunion/supacloud/commit/ccac0b6b4fb709eca57de4fbcdc5b76109226976))
* **compiler:** culminate Angular architectural DX with TestBed, route pipeline, resource, and schema diagnostics ([#1149](https://github.com/vibeunion/supacloud/issues/1149)) ([c224d1f](https://github.com/vibeunion/supacloud/commit/c224d1fda08eaf221ca873d0ad94cf94f084e4ba))
* **compiler:** culminate Angular DX with DOCUMENT, APP_BASE_HREF, TitleStrategy, Location, and SC2007/SC3012 diagnostics ([#1152](https://github.com/vibeunion/supacloud/issues/1152)) ([d561d9f](https://github.com/vibeunion/supacloud/commit/d561d9f0a322ed533a02cd2d0a6dd91b5b690232))
* **compiler:** default compiled modules dependency injection to empty map ([#1102](https://github.com/vibeunion/supacloud/issues/1102)) ([9e6f911](https://github.com/vibeunion/supacloud/commit/9e6f911456ef33156fe138a07681b8c5dca0828d))
* **compiler:** enforce generated type safety ([#1157](https://github.com/vibeunion/supacloud/issues/1157)) ([1c79d4a](https://github.com/vibeunion/supacloud/commit/1c79d4af99cd144c63787a7c69a60f142bcef94a))
* **compiler:** finalize Angular DX with linkedSignal, EnvironmentInjector, TransferState, and route input binding ([#1150](https://github.com/vibeunion/supacloud/issues/1150)) ([a93f906](https://github.com/vibeunion/supacloud/commit/a93f9064f9b5a68f7f09f259bbabede90e67a504))
* **compiler:** heavy-compilation architecture with incremental cache and Angular-inspired DX ([#1144](https://github.com/vibeunion/supacloud/issues/1144)) ([ce3dc59](https://github.com/vibeunion/supacloud/commit/ce3dc59fbe42e3614ae156794951416eef5ab73e))
* **compiler:** heavy-compilation DX with INJECTOR, PLATFORM_ID, router events, and Ivy diagnostics SC2006/SC3011 ([#1151](https://github.com/vibeunion/supacloud/issues/1151)) ([be7f607](https://github.com/vibeunion/supacloud/commit/be7f6072a1fda33524187a9b8b353e1e6e42139a))
* **compiler:** heavy-compilation DX with provideHttpClient, UrlTree, ModuleDependencyGraph, and SC2008/SC3013 diagnostics ([#1153](https://github.com/vibeunion/supacloud/issues/1153)) ([68e9a8d](https://github.com/vibeunion/supacloud/commit/68e9a8d46d91a659ff225dbf4361849c784f3906))
* **compiler:** heavy-compilation DX with typed invoker, forms, RedirectCommand, Pipes, and Ivy diagnostics SC3014-SC3019 ([#1154](https://github.com/vibeunion/supacloud/issues/1154)) ([cd06d4e](https://github.com/vibeunion/supacloud/commit/cd06d4ed962b92f95cf5ffed668948e7a8505c58))
* **compiler:** heavy-compilation DX with typed routes, resolvers, Ivy diagnostics, and reactive signals ([#1148](https://github.com/vibeunion/supacloud/issues/1148)) ([4d5eb0b](https://github.com/vibeunion/supacloud/commit/4d5eb0bf34a73d44ddf6b694b708dfc57b6123a7))
* **compiler:** validate GraphQL results and expose governance config ([#1232](https://github.com/vibeunion/supacloud/issues/1232)) ([a238d56](https://github.com/vibeunion/supacloud/commit/a238d564050ba2927da426781377ce7d5bb30ab3))
* complete compiler runtime roadmap ([cb4618a](https://github.com/vibeunion/supacloud/commit/cb4618aef455853f7ad408f06d67004d49155ffb))
* **framework:** add OpenAPI generation and typed worker execution ([#1286](https://github.com/vibeunion/supacloud/issues/1286)) ([25dcffb](https://github.com/vibeunion/supacloud/commit/25dcffb9a7a33ee7205868c860126d3d2ef50ff4))
* **framework:** complete schema-first route contracts ([#1304](https://github.com/vibeunion/supacloud/issues/1304)) ([4acc3ac](https://github.com/vibeunion/supacloud/commit/4acc3aced2b6e3202705dd87071131af631abad2))
* **framework:** runtime acceptance and versioned upgrade gates ([#1318](https://github.com/vibeunion/supacloud/issues/1318)) ([69dfba4](https://github.com/vibeunion/supacloud/commit/69dfba4f44ca3bd9a35b8a5f6fca91d61c9c2f0b))
* **lite:** align runtime contracts and support real pg_graphql ([#1231](https://github.com/vibeunion/supacloud/issues/1231)) ([9dec0ce](https://github.com/vibeunion/supacloud/commit/9dec0ceca8f0457cd8f514506c4660b5148226b3))
* migrate compiler and strengthen type safety ([81ffb9d](https://github.com/vibeunion/supacloud/commit/81ffb9dae9a09b5561f90e655f1503514d3fe1d7))


### Bug Fixes

* **compiler:** align migration dependency pin with released elysia 0.15.0 ([#1324](https://github.com/vibeunion/supacloud/issues/1324)) ([459ee84](https://github.com/vibeunion/supacloud/commit/459ee840ade78b7f5891a678ef8ccbdd29631a30))
* **compiler:** avoid duplicate GraphQL enum and input types ([#1228](https://github.com/vibeunion/supacloud/issues/1228)) ([9054c41](https://github.com/vibeunion/supacloud/commit/9054c417b3e16c2d265ea2839f4aa72f9a64f513))
* **compiler:** close job scope review gaps ([#1161](https://github.com/vibeunion/supacloud/issues/1161)) ([2784942](https://github.com/vibeunion/supacloud/commit/278494285d6225d98619e3df76071418539894e6))
* **compiler:** validate generated client responses ([#1171](https://github.com/vibeunion/supacloud/issues/1171)) ([6a4f673](https://github.com/vibeunion/supacloud/commit/6a4f6730ab9a255c8b82ca2babdbdd8941fe370c))
* **elysia:** recognize only Elysia status() responses ([#1307](https://github.com/vibeunion/supacloud/issues/1307)) ([b3fa60c](https://github.com/vibeunion/supacloud/commit/b3fa60c41ec71ef703c939f9d7bd5c38791750e1))


### Performance Improvements

* **compiler,web-console:** optimize I/O with Bun APIs, Vite pre-bundling, and graph algorithms ([#1246](https://github.com/vibeunion/supacloud/issues/1246)) ([1db9458](https://github.com/vibeunion/supacloud/commit/1db9458bb620c32476597c5bf795d00e63700559))


### Miscellaneous Chores

* **deps:** bump supabase-js, ts-morph and type definitions ([#1129](https://github.com/vibeunion/supacloud/issues/1129)) ([c56c38e](https://github.com/vibeunion/supacloud/commit/c56c38e54d3b293a9a86359d79a2f3ff1db7da64))
* **deps:** upgrade Bun runtime baseline from 1.4.0 to 1.4.2 ([#1271](https://github.com/vibeunion/supacloud/issues/1271)) ([f53aee5](https://github.com/vibeunion/supacloud/commit/f53aee52e93c25e017e9c693a920de5752fe3ddc))
* release main ([3d041a4](https://github.com/vibeunion/supacloud/commit/3d041a4f2d7d6f29a9160f2c32bea959df72f5d4))
* release main ([f8262b9](https://github.com/vibeunion/supacloud/commit/f8262b9b9ad50d05433e400c88eac4ae94bc8711))
* release main ([#1086](https://github.com/vibeunion/supacloud/issues/1086)) ([1a1deea](https://github.com/vibeunion/supacloud/commit/1a1deea43217a0f831fca875e57f28b885e46511))
* release main ([#1098](https://github.com/vibeunion/supacloud/issues/1098)) ([c79ea95](https://github.com/vibeunion/supacloud/commit/c79ea95807bb09532de8b1e033c97c479b3572ba))
* release main ([#1130](https://github.com/vibeunion/supacloud/issues/1130)) ([250e7de](https://github.com/vibeunion/supacloud/commit/250e7de72d9b08968f6d346fce391d2fb444cb5b))
* release main ([#1133](https://github.com/vibeunion/supacloud/issues/1133)) ([34b54cf](https://github.com/vibeunion/supacloud/commit/34b54cf66636b3005b8a75de74e24533c9da7fe6))
* release main ([#1137](https://github.com/vibeunion/supacloud/issues/1137)) ([a1f6219](https://github.com/vibeunion/supacloud/commit/a1f6219e19a897e9f1025bd10483ca453fd6c220))
* release main ([#1142](https://github.com/vibeunion/supacloud/issues/1142)) ([2e2cce6](https://github.com/vibeunion/supacloud/commit/2e2cce60ad6265c1f2c2003fd792701bade71491))
* release main ([#1156](https://github.com/vibeunion/supacloud/issues/1156)) ([3827ba0](https://github.com/vibeunion/supacloud/commit/3827ba09bc1dd1c37e5075773900e2005aed3e0f))
* release main ([#1162](https://github.com/vibeunion/supacloud/issues/1162)) ([df72d07](https://github.com/vibeunion/supacloud/commit/df72d07f6fc025c759145d5fef8d0189e8a801f4))
* release main ([#1172](https://github.com/vibeunion/supacloud/issues/1172)) ([b542d86](https://github.com/vibeunion/supacloud/commit/b542d86f31bc2c390751924706b3cd3bd8a2c8b9))
* release main ([#1176](https://github.com/vibeunion/supacloud/issues/1176)) ([c04a50d](https://github.com/vibeunion/supacloud/commit/c04a50df7df76408208429587970fd1e66ffc789))
* release main ([#1179](https://github.com/vibeunion/supacloud/issues/1179)) ([8f186bc](https://github.com/vibeunion/supacloud/commit/8f186bc368e6ef17ed7d3e58d9429845af1bd110))
* release main ([#1183](https://github.com/vibeunion/supacloud/issues/1183)) ([07ca38e](https://github.com/vibeunion/supacloud/commit/07ca38e6db6c66a2b60f601a6561f65b2a99e65f))
* release main ([#1194](https://github.com/vibeunion/supacloud/issues/1194)) ([7d0eb27](https://github.com/vibeunion/supacloud/commit/7d0eb27ec8b118321e9085aff6cd9f77a2eec642))
* release main ([#1203](https://github.com/vibeunion/supacloud/issues/1203)) ([be4261f](https://github.com/vibeunion/supacloud/commit/be4261f41e902323f61780fdbfea732e72493934))
* release main ([#1221](https://github.com/vibeunion/supacloud/issues/1221)) ([254364e](https://github.com/vibeunion/supacloud/commit/254364e9b29bcf873773ef0e54017422e7889a0c))
* release main ([#1225](https://github.com/vibeunion/supacloud/issues/1225)) ([d6f6c78](https://github.com/vibeunion/supacloud/commit/d6f6c786ef436d24ab0ab6caaabeb7a4738af552))
* release main ([#1229](https://github.com/vibeunion/supacloud/issues/1229)) ([fef9f3a](https://github.com/vibeunion/supacloud/commit/fef9f3aa7ee93628e2e7a56e4dc57a476bbc203d))
* release main ([#1233](https://github.com/vibeunion/supacloud/issues/1233)) ([1eb95cc](https://github.com/vibeunion/supacloud/commit/1eb95cc698fb59975030ab21a567bc462527a2a9))
* release main ([#1239](https://github.com/vibeunion/supacloud/issues/1239)) ([edd8bc5](https://github.com/vibeunion/supacloud/commit/edd8bc55ed26bb0dbf94b5cef9c88bdf26eb8216))
* release main ([#1244](https://github.com/vibeunion/supacloud/issues/1244)) ([7abc6de](https://github.com/vibeunion/supacloud/commit/7abc6ded6e70fd45cd3da14960a8e4e72933e069))
* release main ([#1247](https://github.com/vibeunion/supacloud/issues/1247)) ([b21ffe3](https://github.com/vibeunion/supacloud/commit/b21ffe3dfec4d8513dfcb1ff59092b4f89ff344f))
* release main ([#1272](https://github.com/vibeunion/supacloud/issues/1272)) ([8b5c40d](https://github.com/vibeunion/supacloud/commit/8b5c40d442a3c2b7981b084d31da6c60f2d8db1c))
* release main ([#1287](https://github.com/vibeunion/supacloud/issues/1287)) ([99688d6](https://github.com/vibeunion/supacloud/commit/99688d69245cb881d14e98d0cb38037b45c3a343))
* release main ([#1303](https://github.com/vibeunion/supacloud/issues/1303)) ([7cf5889](https://github.com/vibeunion/supacloud/commit/7cf588922e5081926e34ae8b2438634e0ea16c2a))
* unify all code comments to English across packages ([#1136](https://github.com/vibeunion/supacloud/issues/1136)) ([2587201](https://github.com/vibeunion/supacloud/commit/2587201347494975cd313ff3aa4b0c5c3af48780))

## [0.20.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.19.1...compiler-v0.20.0) (2026-09-16)


### Features

* **framework:** runtime acceptance and versioned upgrade gates ([#1318](https://github.com/vibeunion/supacloud/issues/1318)) ([69dfba4](https://github.com/vibeunion/supacloud/commit/69dfba4f44ca3bd9a35b8a5f6fca91d61c9c2f0b))

## [0.19.1](https://github.com/vibeunion/supacloud/compare/compiler-v0.19.0...compiler-v0.19.1) (2026-09-15)


### Bug Fixes

* **elysia:** recognize only Elysia status() responses ([#1307](https://github.com/vibeunion/supacloud/issues/1307)) ([b3fa60c](https://github.com/vibeunion/supacloud/commit/b3fa60c41ec71ef703c939f9d7bd5c38791750e1))

## [0.19.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.18.0...compiler-v0.19.0) (2026-09-15)


### Features

* **architecture:** enforce compile-time application governance ([#1301](https://github.com/vibeunion/supacloud/issues/1301)) ([b2c1df2](https://github.com/vibeunion/supacloud/commit/b2c1df25294d0195ddf313623b965e599847d9f9))
* **framework:** complete schema-first route contracts ([#1304](https://github.com/vibeunion/supacloud/issues/1304)) ([4acc3ac](https://github.com/vibeunion/supacloud/commit/4acc3aced2b6e3202705dd87071131af631abad2))

## [0.18.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.17.1...compiler-v0.18.0) (2026-09-13)


### Features

* **framework:** add OpenAPI generation and typed worker execution ([#1286](https://github.com/vibeunion/supacloud/issues/1286)) ([25dcffb](https://github.com/vibeunion/supacloud/commit/25dcffb9a7a33ee7205868c860126d3d2ef50ff4))

## [0.17.1](https://github.com/vibeunion/supacloud/compare/compiler-v0.17.0...compiler-v0.17.1) (2026-09-11)


### Miscellaneous Chores

* **deps:** upgrade Bun runtime baseline from 1.4.0 to 1.4.2 ([#1271](https://github.com/vibeunion/supacloud/issues/1271)) ([f53aee5](https://github.com/vibeunion/supacloud/commit/f53aee52e93c25e017e9c693a920de5752fe3ddc))

## [0.17.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.16.0...compiler-v0.17.0) (2026-09-09)


### Features

* **compiler:** add local delivery planning and independent builds ([#1245](https://github.com/vibeunion/supacloud/issues/1245)) ([fd860ac](https://github.com/vibeunion/supacloud/commit/fd860ac82834f28df733ca5c91f3a3314a8ca748))


### Performance Improvements

* **compiler,web-console:** optimize I/O with Bun APIs, Vite pre-bundling, and graph algorithms ([#1246](https://github.com/vibeunion/supacloud/issues/1246)) ([1db9458](https://github.com/vibeunion/supacloud/commit/1db9458bb620c32476597c5bf795d00e63700559))

## [0.16.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.15.0...compiler-v0.16.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **commands:** HTTP JSON methods return unknown unless decoded through a contract; writes default to no replay. Durable adapters require explicit authorization and input codecs. See docs/command-migration.md for import, auth, schema, and deployment migration steps.

### Features

* **commands:** unify durable execution with existing workflows ([#1243](https://github.com/vibeunion/supacloud/issues/1243)) ([6da15d4](https://github.com/vibeunion/supacloud/commit/6da15d459e1883ab94e240834200a57e9a41676b))

## [0.15.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.14.0...compiler-v0.15.0) (2026-09-09)


### Features

* **lite:** align runtime contracts and support real pg_graphql ([#1231](https://github.com/vibeunion/supacloud/issues/1231)) ([9dec0ce](https://github.com/vibeunion/supacloud/commit/9dec0ceca8f0457cd8f514506c4660b5148226b3))

## [0.14.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.13.1...compiler-v0.14.0) (2026-09-09)


### Features

* **compiler:** validate GraphQL results and expose governance config ([#1232](https://github.com/vibeunion/supacloud/issues/1232)) ([a238d56](https://github.com/vibeunion/supacloud/commit/a238d564050ba2927da426781377ce7d5bb30ab3))

## [0.13.1](https://github.com/vibeunion/supacloud/compare/compiler-v0.13.0...compiler-v0.13.1) (2026-09-08)


### Bug Fixes

* **compiler:** avoid duplicate GraphQL enum and input types ([#1228](https://github.com/vibeunion/supacloud/issues/1228)) ([9054c41](https://github.com/vibeunion/supacloud/commit/9054c417b3e16c2d265ea2839f4aa72f9a64f513))

## [0.13.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.12.0...compiler-v0.13.0) (2026-09-08)


### Features

* **compiler:** add database-first GraphQL query contracts ([#1224](https://github.com/vibeunion/supacloud/issues/1224)) ([a10e0d5](https://github.com/vibeunion/supacloud/commit/a10e0d54f87bee79c0a3a34f9b8685a994eb444b))

## [0.12.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.11.0...compiler-v0.12.0) (2026-09-08)


### Features

* add SupAuth identity and FA-driven command governance ([#1220](https://github.com/vibeunion/supacloud/issues/1220)) ([66a77ca](https://github.com/vibeunion/supacloud/commit/66a77caea086bb1282772dd9401bd2adb9c04342))

## [0.11.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.10.0...compiler-v0.11.0) (2026-09-07)


### Features

* **app:** validate HTTP contracts and require route declarations ([#1201](https://github.com/vibeunion/supacloud/issues/1201)) ([6fc047b](https://github.com/vibeunion/supacloud/commit/6fc047b2349bc04fbbe0ff134558d6e45dc275eb))

## [0.10.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.9.0...compiler-v0.10.0) (2026-09-07)


### Features

* **cli:** add governed application starter ([#1193](https://github.com/vibeunion/supacloud/issues/1193)) ([f33561b](https://github.com/vibeunion/supacloud/commit/f33561bfb05e0a63ce08de0153a4fa95f02ac2d6))

## [0.9.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.8.0...compiler-v0.9.0) (2026-09-06)


### Features

* complete compiler runtime roadmap ([cb4618a](https://github.com/vibeunion/supacloud/commit/cb4618aef455853f7ad408f06d67004d49155ffb))

## [0.8.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.7.0...compiler-v0.8.0) (2026-09-06)


### Features

* **compiler:** configure command capabilities ([#1178](https://github.com/vibeunion/supacloud/issues/1178)) ([ccac0b6](https://github.com/vibeunion/supacloud/commit/ccac0b6b4fb709eca57de4fbcdc5b76109226976))

## [0.7.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.6.2...compiler-v0.7.0) (2026-09-06)


### Features

* **app:** provide zero-config project defaults ([#1173](https://github.com/vibeunion/supacloud/issues/1173)) ([489824d](https://github.com/vibeunion/supacloud/commit/489824db5137e4675248cfc789d9d86e8139775e))

## [0.6.2](https://github.com/vibeunion/supacloud/compare/compiler-v0.6.1...compiler-v0.6.2) (2026-09-06)


### Bug Fixes

* **compiler:** validate generated client responses ([#1171](https://github.com/vibeunion/supacloud/issues/1171)) ([6a4f673](https://github.com/vibeunion/supacloud/commit/6a4f6730ab9a255c8b82ca2babdbdd8941fe370c))

## [0.6.1](https://github.com/vibeunion/supacloud/compare/compiler-v0.6.0...compiler-v0.6.1) (2026-09-05)


### Bug Fixes

* **compiler:** close job scope review gaps ([#1161](https://github.com/vibeunion/supacloud/issues/1161)) ([2784942](https://github.com/vibeunion/supacloud/commit/278494285d6225d98619e3df76071418539894e6))

## [0.6.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.5.0...compiler-v0.6.0) (2026-09-05)


### Features

* add statically compiled AOP boundaries and jobs ([#1160](https://github.com/vibeunion/supacloud/issues/1160)) ([66c962a](https://github.com/vibeunion/supacloud/commit/66c962a923ed6c4dbd3a354715346878793bb14c))
* **compiler:** enforce generated type safety ([#1157](https://github.com/vibeunion/supacloud/issues/1157)) ([1c79d4a](https://github.com/vibeunion/supacloud/commit/1c79d4af99cd144c63787a7c69a60f142bcef94a))
* migrate compiler and strengthen type safety ([81ffb9d](https://github.com/vibeunion/supacloud/commit/81ffb9dae9a09b5561f90e655f1503514d3fe1d7))

## [0.5.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.4.1...compiler-v0.5.0) (2026-09-04)


### Features

* **compiler:** add CanDeactivate guards, tree-shakable token codegen, matchRoute helper, and redirect target validation ([#1147](https://github.com/vibeunion/supacloud/issues/1147)) ([ef0f551](https://github.com/vibeunion/supacloud/commit/ef0f551d1b93121b2cf607635170ade6407c11c8))
* **compiler:** add DestroyRef teardown lifecycle, CanMatch guards, and parameter transforms ([#1145](https://github.com/vibeunion/supacloud/issues/1145)) ([bd6b4ab](https://github.com/vibeunion/supacloud/commit/bd6b4abae8e3cc37a3fc654f810d42a46deca88d))
* **compiler:** add forwardRef, DestroyRef AbortSignal, Route title/data, and shadowed route detection ([#1146](https://github.com/vibeunion/supacloud/issues/1146)) ([2d9e488](https://github.com/vibeunion/supacloud/commit/2d9e48802683a349b00eb996a951f637cdeafa47))
* **compiler:** culminate Angular architectural DX with TestBed, route pipeline, resource, and schema diagnostics ([#1149](https://github.com/vibeunion/supacloud/issues/1149)) ([c224d1f](https://github.com/vibeunion/supacloud/commit/c224d1fda08eaf221ca873d0ad94cf94f084e4ba))
* **compiler:** culminate Angular DX with DOCUMENT, APP_BASE_HREF, TitleStrategy, Location, and SC2007/SC3012 diagnostics ([#1152](https://github.com/vibeunion/supacloud/issues/1152)) ([d561d9f](https://github.com/vibeunion/supacloud/commit/d561d9f0a322ed533a02cd2d0a6dd91b5b690232))
* **compiler:** finalize Angular DX with linkedSignal, EnvironmentInjector, TransferState, and route input binding ([#1150](https://github.com/vibeunion/supacloud/issues/1150)) ([a93f906](https://github.com/vibeunion/supacloud/commit/a93f9064f9b5a68f7f09f259bbabede90e67a504))
* **compiler:** heavy-compilation architecture with incremental cache and Angular-inspired DX ([#1144](https://github.com/vibeunion/supacloud/issues/1144)) ([ce3dc59](https://github.com/vibeunion/supacloud/commit/ce3dc59fbe42e3614ae156794951416eef5ab73e))
* **compiler:** heavy-compilation DX with INJECTOR, PLATFORM_ID, router events, and Ivy diagnostics SC2006/SC3011 ([#1151](https://github.com/vibeunion/supacloud/issues/1151)) ([be7f607](https://github.com/vibeunion/supacloud/commit/be7f6072a1fda33524187a9b8b353e1e6e42139a))
* **compiler:** heavy-compilation DX with provideHttpClient, UrlTree, ModuleDependencyGraph, and SC2008/SC3013 diagnostics ([#1153](https://github.com/vibeunion/supacloud/issues/1153)) ([68e9a8d](https://github.com/vibeunion/supacloud/commit/68e9a8d46d91a659ff225dbf4361849c784f3906))
* **compiler:** heavy-compilation DX with typed invoker, forms, RedirectCommand, Pipes, and Ivy diagnostics SC3014-SC3019 ([#1154](https://github.com/vibeunion/supacloud/issues/1154)) ([cd06d4e](https://github.com/vibeunion/supacloud/commit/cd06d4ed962b92f95cf5ffed668948e7a8505c58))
* **compiler:** heavy-compilation DX with typed routes, resolvers, Ivy diagnostics, and reactive signals ([#1148](https://github.com/vibeunion/supacloud/issues/1148)) ([4d5eb0b](https://github.com/vibeunion/supacloud/commit/4d5eb0bf34a73d44ddf6b694b708dfc57b6123a7))

## [0.4.1](https://github.com/vibeunion/supacloud/compare/compiler-v0.4.0...compiler-v0.4.1) (2026-09-04)


### Miscellaneous Chores

* unify all code comments to English across packages ([#1136](https://github.com/vibeunion/supacloud/issues/1136)) ([2587201](https://github.com/vibeunion/supacloud/commit/2587201347494975cd313ff3aa4b0c5c3af48780))

## [0.4.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.3.1...compiler-v0.4.0) (2026-09-04)


### Features

* **compiler:** add built-in module boundary governance presets and profiles ([#1132](https://github.com/vibeunion/supacloud/issues/1132)) ([ff75de8](https://github.com/vibeunion/supacloud/commit/ff75de882969f2b67cbbcebe8e72fe8df84489ad))
* **compiler:** add checkProject drift detection, capabilities governance, and CLI ([#1134](https://github.com/vibeunion/supacloud/issues/1134)) ([831225a](https://github.com/vibeunion/supacloud/commit/831225a6d8d5c79392c4e261ddbffb092125c97f))

## [0.3.1](https://github.com/vibeunion/supacloud/compare/compiler-v0.3.0...compiler-v0.3.1) (2026-09-04)


### Miscellaneous Chores

* **deps:** bump supabase-js, ts-morph and type definitions ([#1129](https://github.com/vibeunion/supacloud/issues/1129)) ([c56c38e](https://github.com/vibeunion/supacloud/commit/c56c38e54d3b293a9a86359d79a2f3ff1db7da64))

## [0.3.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.2.0...compiler-v0.3.0) (2026-09-03)


### Features

* **compiler,app:** add module tags and boundary governance with Nx workspace configuration ([#1110](https://github.com/vibeunion/supacloud/issues/1110)) ([dda9635](https://github.com/vibeunion/supacloud/commit/dda96355ba25a53f1b550e8e95011b1c806a2003))

## [0.2.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.1.0...compiler-v0.2.0) (2026-09-02)


### Features

* **app:** add command governance boundaries ([#1104](https://github.com/vibeunion/supacloud/issues/1104)) ([48b6f4f](https://github.com/vibeunion/supacloud/commit/48b6f4f1dc9c8f474faa325172ee9f20b42d8332))
* **app:** enforce command governance at runtime ([#1096](https://github.com/vibeunion/supacloud/issues/1096)) ([63f59e0](https://github.com/vibeunion/supacloud/commit/63f59e09bb98835ba3dc414e9fcc3806295850e4))
* **compiler:** default compiled modules dependency injection to empty map ([#1102](https://github.com/vibeunion/supacloud/issues/1102)) ([9e6f911](https://github.com/vibeunion/supacloud/commit/9e6f911456ef33156fe138a07681b8c5dca0828d))

## 0.1.0 (2026-09-02)


### Features

* add application framework packages (app, compiler, elysia) ([#1082](https://github.com/vibeunion/supacloud/issues/1082)) ([7e6ccca](https://github.com/vibeunion/supacloud/commit/7e6cccaef340ea18b10040b32871cded1206fe91))
