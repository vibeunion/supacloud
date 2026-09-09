# Changelog

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
