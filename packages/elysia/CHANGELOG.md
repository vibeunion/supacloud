# Changelog

## [0.11.1](https://github.com/vibeunion/supacloud/compare/elysia-v0.11.0...elysia-v0.11.1) (2026-09-11)


### Miscellaneous Chores

* **deps:** upgrade Bun runtime baseline from 1.4.0 to 1.4.2 ([#1271](https://github.com/vibeunion/supacloud/issues/1271)) ([f53aee5](https://github.com/vibeunion/supacloud/commit/f53aee52e93c25e017e9c693a920de5752fe3ddc))

## [0.11.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.10.0...elysia-v0.11.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **commands:** HTTP JSON methods return unknown unless decoded through a contract; writes default to no replay. Durable adapters require explicit authorization and input codecs. See docs/command-migration.md for import, auth, schema, and deployment migration steps.

### Features

* **commands:** unify durable execution with existing workflows ([#1243](https://github.com/vibeunion/supacloud/issues/1243)) ([6da15d4](https://github.com/vibeunion/supacloud/commit/6da15d459e1883ab94e240834200a57e9a41676b))

## [0.10.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.9.0...elysia-v0.10.0) (2026-09-08)


### Features

* add SupAuth identity and FA-driven command governance ([#1220](https://github.com/vibeunion/supacloud/issues/1220)) ([66a77ca](https://github.com/vibeunion/supacloud/commit/66a77caea086bb1282772dd9401bd2adb9c04342))

## [0.9.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.8.1...elysia-v0.9.0) (2026-09-08)


### Features

* **elysia:** add validated native JSON responses ([#1210](https://github.com/vibeunion/supacloud/issues/1210)) ([28e73fe](https://github.com/vibeunion/supacloud/commit/28e73feff26d77010c23fd439c31b334a7705885))

## [0.8.1](https://github.com/vibeunion/supacloud/compare/elysia-v0.8.0...elysia-v0.8.1) (2026-09-07)


### Bug Fixes

* **elysia:** distinguish response contract failures and scope error mapping ([#1200](https://github.com/vibeunion/supacloud/issues/1200)) ([a6fd97b](https://github.com/vibeunion/supacloud/commit/a6fd97b95ec394098eedffbf0626785fff18ce8c))

## [0.8.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.7.0...elysia-v0.8.0) (2026-09-07)


### Features

* **cli:** add governed application starter ([#1193](https://github.com/vibeunion/supacloud/issues/1193)) ([f33561b](https://github.com/vibeunion/supacloud/commit/f33561bfb05e0a63ce08de0153a4fa95f02ac2d6))

## [0.7.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.6.0...elysia-v0.7.0) (2026-09-06)


### Features

* complete compiler runtime roadmap ([cb4618a](https://github.com/vibeunion/supacloud/commit/cb4618aef455853f7ad408f06d67004d49155ffb))

## [0.6.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.5.1...elysia-v0.6.0) (2026-09-06)


### Features

* **app:** provide zero-config project defaults ([#1173](https://github.com/vibeunion/supacloud/issues/1173)) ([489824d](https://github.com/vibeunion/supacloud/commit/489824db5137e4675248cfc789d9d86e8139775e))

## [0.5.1](https://github.com/vibeunion/supacloud/compare/elysia-v0.5.0...elysia-v0.5.1) (2026-09-05)


### Bug Fixes

* **compiler:** close job scope review gaps ([#1161](https://github.com/vibeunion/supacloud/issues/1161)) ([2784942](https://github.com/vibeunion/supacloud/commit/278494285d6225d98619e3df76071418539894e6))

## [0.5.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.4.0...elysia-v0.5.0) (2026-09-05)


### Features

* add statically compiled AOP boundaries and jobs ([#1160](https://github.com/vibeunion/supacloud/issues/1160)) ([66c962a](https://github.com/vibeunion/supacloud/commit/66c962a923ed6c4dbd3a354715346878793bb14c))
* migrate compiler and strengthen type safety ([81ffb9d](https://github.com/vibeunion/supacloud/commit/81ffb9dae9a09b5561f90e655f1503514d3fe1d7))

## [0.4.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.3.0...elysia-v0.4.0) (2026-09-04)


### Features

* **compiler:** add checkProject drift detection, capabilities governance, and CLI ([#1134](https://github.com/vibeunion/supacloud/issues/1134)) ([831225a](https://github.com/vibeunion/supacloud/commit/831225a6d8d5c79392c4e261ddbffb092125c97f))

## [0.3.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.2.0...elysia-v0.3.0) (2026-09-03)


### Features

* **compiler,app:** add module tags and boundary governance with Nx workspace configuration ([#1110](https://github.com/vibeunion/supacloud/issues/1110)) ([dda9635](https://github.com/vibeunion/supacloud/commit/dda96355ba25a53f1b550e8e95011b1c806a2003))

## [0.2.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.1.0...elysia-v0.2.0) (2026-09-02)


### Features

* **app:** add command governance boundaries ([#1104](https://github.com/vibeunion/supacloud/issues/1104)) ([48b6f4f](https://github.com/vibeunion/supacloud/commit/48b6f4f1dc9c8f474faa325172ee9f20b42d8332))
* **app:** add DB_CLIENT token and composeCommandExecutors pipeline ([#1103](https://github.com/vibeunion/supacloud/issues/1103)) ([cbba56f](https://github.com/vibeunion/supacloud/commit/cbba56f400ecb0b6948969c1ab16a75eed82c6f4))
* **app:** enforce command governance at runtime ([#1096](https://github.com/vibeunion/supacloud/issues/1096)) ([63f59e0](https://github.com/vibeunion/supacloud/commit/63f59e09bb98835ba3dc414e9fcc3806295850e4))

## 0.1.0 (2026-09-02)


### Features

* add application framework packages (app, compiler, elysia) ([#1082](https://github.com/vibeunion/supacloud/issues/1082)) ([7e6ccca](https://github.com/vibeunion/supacloud/commit/7e6cccaef340ea18b10040b32871cded1206fe91))
