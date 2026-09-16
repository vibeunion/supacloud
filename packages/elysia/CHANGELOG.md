# Changelog

## [0.16.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.15.0...elysia-v0.16.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **commands:** HTTP JSON methods return unknown unless decoded through a contract; writes default to no replay. Durable adapters require explicit authorization and input codecs. See docs/command-migration.md for import, auth, schema, and deployment migration steps.

### Features

* add application framework packages (app, compiler, elysia) ([#1082](https://github.com/vibeunion/supacloud/issues/1082)) ([7e6ccca](https://github.com/vibeunion/supacloud/commit/7e6cccaef340ea18b10040b32871cded1206fe91))
* add statically compiled AOP boundaries and jobs ([#1160](https://github.com/vibeunion/supacloud/issues/1160)) ([66c962a](https://github.com/vibeunion/supacloud/commit/66c962a923ed6c4dbd3a354715346878793bb14c))
* add SupAuth identity and FA-driven command governance ([#1220](https://github.com/vibeunion/supacloud/issues/1220)) ([66a77ca](https://github.com/vibeunion/supacloud/commit/66a77caea086bb1282772dd9401bd2adb9c04342))
* **app:** add command governance boundaries ([#1104](https://github.com/vibeunion/supacloud/issues/1104)) ([48b6f4f](https://github.com/vibeunion/supacloud/commit/48b6f4f1dc9c8f474faa325172ee9f20b42d8332))
* **app:** add DB_CLIENT token and composeCommandExecutors pipeline ([#1103](https://github.com/vibeunion/supacloud/issues/1103)) ([cbba56f](https://github.com/vibeunion/supacloud/commit/cbba56f400ecb0b6948969c1ab16a75eed82c6f4))
* **app:** enforce command governance at runtime ([#1096](https://github.com/vibeunion/supacloud/issues/1096)) ([63f59e0](https://github.com/vibeunion/supacloud/commit/63f59e09bb98835ba3dc414e9fcc3806295850e4))
* **app:** provide zero-config project defaults ([#1173](https://github.com/vibeunion/supacloud/issues/1173)) ([489824d](https://github.com/vibeunion/supacloud/commit/489824db5137e4675248cfc789d9d86e8139775e))
* **architecture:** enforce compile-time application governance ([#1301](https://github.com/vibeunion/supacloud/issues/1301)) ([b2c1df2](https://github.com/vibeunion/supacloud/commit/b2c1df25294d0195ddf313623b965e599847d9f9))
* **cli:** add governed application starter ([#1193](https://github.com/vibeunion/supacloud/issues/1193)) ([f33561b](https://github.com/vibeunion/supacloud/commit/f33561bfb05e0a63ce08de0153a4fa95f02ac2d6))
* **commands:** unify durable execution with existing workflows ([#1243](https://github.com/vibeunion/supacloud/issues/1243)) ([6da15d4](https://github.com/vibeunion/supacloud/commit/6da15d459e1883ab94e240834200a57e9a41676b))
* **compiler,app:** add module tags and boundary governance with Nx workspace configuration ([#1110](https://github.com/vibeunion/supacloud/issues/1110)) ([dda9635](https://github.com/vibeunion/supacloud/commit/dda96355ba25a53f1b550e8e95011b1c806a2003))
* **compiler:** add checkProject drift detection, capabilities governance, and CLI ([#1134](https://github.com/vibeunion/supacloud/issues/1134)) ([831225a](https://github.com/vibeunion/supacloud/commit/831225a6d8d5c79392c4e261ddbffb092125c97f))
* complete compiler runtime roadmap ([cb4618a](https://github.com/vibeunion/supacloud/commit/cb4618aef455853f7ad408f06d67004d49155ffb))
* **elysia:** add opt-in OpenAPI and GraphQL documentation ([#1297](https://github.com/vibeunion/supacloud/issues/1297)) ([d5b3f32](https://github.com/vibeunion/supacloud/commit/d5b3f32a075e813708b462a7b9d45458800b10e5))
* **elysia:** add read-only command preview ([#1302](https://github.com/vibeunion/supacloud/issues/1302)) ([995bcd4](https://github.com/vibeunion/supacloud/commit/995bcd43ac3639465eab476deefadd0f37867427))
* **elysia:** add validated native JSON responses ([#1210](https://github.com/vibeunion/supacloud/issues/1210)) ([28e73fe](https://github.com/vibeunion/supacloud/commit/28e73feff26d77010c23fd439c31b334a7705885))
* **framework:** add OpenAPI generation and typed worker execution ([#1286](https://github.com/vibeunion/supacloud/issues/1286)) ([25dcffb](https://github.com/vibeunion/supacloud/commit/25dcffb9a7a33ee7205868c860126d3d2ef50ff4))
* **framework:** complete schema-first route contracts ([#1304](https://github.com/vibeunion/supacloud/issues/1304)) ([4acc3ac](https://github.com/vibeunion/supacloud/commit/4acc3aced2b6e3202705dd87071131af631abad2))
* **framework:** runtime acceptance and versioned upgrade gates ([#1318](https://github.com/vibeunion/supacloud/issues/1318)) ([69dfba4](https://github.com/vibeunion/supacloud/commit/69dfba4f44ca3bd9a35b8a5f6fca91d61c9c2f0b))
* migrate compiler and strengthen type safety ([81ffb9d](https://github.com/vibeunion/supacloud/commit/81ffb9dae9a09b5561f90e655f1503514d3fe1d7))


### Bug Fixes

* **compiler:** align migration dependency pin with released elysia 0.15.0 ([#1324](https://github.com/vibeunion/supacloud/issues/1324)) ([459ee84](https://github.com/vibeunion/supacloud/commit/459ee840ade78b7f5891a678ef8ccbdd29631a30))
* **compiler:** close job scope review gaps ([#1161](https://github.com/vibeunion/supacloud/issues/1161)) ([2784942](https://github.com/vibeunion/supacloud/commit/278494285d6225d98619e3df76071418539894e6))
* **elysia:** distinguish response contract failures and scope error mapping ([#1200](https://github.com/vibeunion/supacloud/issues/1200)) ([a6fd97b](https://github.com/vibeunion/supacloud/commit/a6fd97b95ec394098eedffbf0626785fff18ce8c))
* **elysia:** recognize only Elysia status() responses ([#1307](https://github.com/vibeunion/supacloud/issues/1307)) ([b3fa60c](https://github.com/vibeunion/supacloud/commit/b3fa60c41ec71ef703c939f9d7bd5c38791750e1))


### Performance Improvements

* optimize compiler and upgrade Bun runtime ([#1283](https://github.com/vibeunion/supacloud/issues/1283)) ([381c1b9](https://github.com/vibeunion/supacloud/commit/381c1b98264a563d22fc2f4af85f7f7117563481))


### Miscellaneous Chores

* **deps:** upgrade Bun runtime baseline from 1.4.0 to 1.4.2 ([#1271](https://github.com/vibeunion/supacloud/issues/1271)) ([f53aee5](https://github.com/vibeunion/supacloud/commit/f53aee52e93c25e017e9c693a920de5752fe3ddc))
* release main ([3d041a4](https://github.com/vibeunion/supacloud/commit/3d041a4f2d7d6f29a9160f2c32bea959df72f5d4))
* release main ([f8262b9](https://github.com/vibeunion/supacloud/commit/f8262b9b9ad50d05433e400c88eac4ae94bc8711))
* release main ([#1086](https://github.com/vibeunion/supacloud/issues/1086)) ([1a1deea](https://github.com/vibeunion/supacloud/commit/1a1deea43217a0f831fca875e57f28b885e46511))
* release main ([#1098](https://github.com/vibeunion/supacloud/issues/1098)) ([c79ea95](https://github.com/vibeunion/supacloud/commit/c79ea95807bb09532de8b1e033c97c479b3572ba))
* release main ([#1133](https://github.com/vibeunion/supacloud/issues/1133)) ([34b54cf](https://github.com/vibeunion/supacloud/commit/34b54cf66636b3005b8a75de74e24533c9da7fe6))
* release main ([#1156](https://github.com/vibeunion/supacloud/issues/1156)) ([3827ba0](https://github.com/vibeunion/supacloud/commit/3827ba09bc1dd1c37e5075773900e2005aed3e0f))
* release main ([#1162](https://github.com/vibeunion/supacloud/issues/1162)) ([df72d07](https://github.com/vibeunion/supacloud/commit/df72d07f6fc025c759145d5fef8d0189e8a801f4))
* release main ([#1176](https://github.com/vibeunion/supacloud/issues/1176)) ([c04a50d](https://github.com/vibeunion/supacloud/commit/c04a50df7df76408208429587970fd1e66ffc789))
* release main ([#1183](https://github.com/vibeunion/supacloud/issues/1183)) ([07ca38e](https://github.com/vibeunion/supacloud/commit/07ca38e6db6c66a2b60f601a6561f65b2a99e65f))
* release main ([#1194](https://github.com/vibeunion/supacloud/issues/1194)) ([7d0eb27](https://github.com/vibeunion/supacloud/commit/7d0eb27ec8b118321e9085aff6cd9f77a2eec642))
* release main ([#1199](https://github.com/vibeunion/supacloud/issues/1199)) ([f374806](https://github.com/vibeunion/supacloud/commit/f3748068f6f0a838b668b81a7b23f9cffd74ca37))
* release main ([#1211](https://github.com/vibeunion/supacloud/issues/1211)) ([5b06eda](https://github.com/vibeunion/supacloud/commit/5b06eda20f637c121f177880291f6ee997cd01a1))
* release main ([#1221](https://github.com/vibeunion/supacloud/issues/1221)) ([254364e](https://github.com/vibeunion/supacloud/commit/254364e9b29bcf873773ef0e54017422e7889a0c))
* release main ([#1244](https://github.com/vibeunion/supacloud/issues/1244)) ([7abc6de](https://github.com/vibeunion/supacloud/commit/7abc6ded6e70fd45cd3da14960a8e4e72933e069))
* release main ([#1272](https://github.com/vibeunion/supacloud/issues/1272)) ([8b5c40d](https://github.com/vibeunion/supacloud/commit/8b5c40d442a3c2b7981b084d31da6c60f2d8db1c))
* release main ([#1284](https://github.com/vibeunion/supacloud/issues/1284)) ([b347a92](https://github.com/vibeunion/supacloud/commit/b347a92b0b4bcfd00b3ee23d22fa17d77225b689))
* release main ([#1287](https://github.com/vibeunion/supacloud/issues/1287)) ([99688d6](https://github.com/vibeunion/supacloud/commit/99688d69245cb881d14e98d0cb38037b45c3a343))
* release main ([#1298](https://github.com/vibeunion/supacloud/issues/1298)) ([2011f2d](https://github.com/vibeunion/supacloud/commit/2011f2dfddc277dee1d9f7b2a87fd8d96b7cfab6))
* release main ([#1303](https://github.com/vibeunion/supacloud/issues/1303)) ([7cf5889](https://github.com/vibeunion/supacloud/commit/7cf588922e5081926e34ae8b2438634e0ea16c2a))

## [0.15.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.14.1...elysia-v0.15.0) (2026-09-16)


### Features

* **framework:** runtime acceptance and versioned upgrade gates ([#1318](https://github.com/vibeunion/supacloud/issues/1318)) ([69dfba4](https://github.com/vibeunion/supacloud/commit/69dfba4f44ca3bd9a35b8a5f6fca91d61c9c2f0b))

## [0.14.1](https://github.com/vibeunion/supacloud/compare/elysia-v0.14.0...elysia-v0.14.1) (2026-09-15)


### Bug Fixes

* **elysia:** recognize only Elysia status() responses ([#1307](https://github.com/vibeunion/supacloud/issues/1307)) ([b3fa60c](https://github.com/vibeunion/supacloud/commit/b3fa60c41ec71ef703c939f9d7bd5c38791750e1))

## [0.14.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.13.0...elysia-v0.14.0) (2026-09-15)


### Features

* **architecture:** enforce compile-time application governance ([#1301](https://github.com/vibeunion/supacloud/issues/1301)) ([b2c1df2](https://github.com/vibeunion/supacloud/commit/b2c1df25294d0195ddf313623b965e599847d9f9))
* **elysia:** add read-only command preview ([#1302](https://github.com/vibeunion/supacloud/issues/1302)) ([995bcd4](https://github.com/vibeunion/supacloud/commit/995bcd43ac3639465eab476deefadd0f37867427))
* **framework:** complete schema-first route contracts ([#1304](https://github.com/vibeunion/supacloud/issues/1304)) ([4acc3ac](https://github.com/vibeunion/supacloud/commit/4acc3aced2b6e3202705dd87071131af631abad2))

## [0.13.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.12.0...elysia-v0.13.0) (2026-09-15)


### Features

* **elysia:** add opt-in OpenAPI and GraphQL documentation ([#1297](https://github.com/vibeunion/supacloud/issues/1297)) ([d5b3f32](https://github.com/vibeunion/supacloud/commit/d5b3f32a075e813708b462a7b9d45458800b10e5))

## [0.12.0](https://github.com/vibeunion/supacloud/compare/elysia-v0.11.2...elysia-v0.12.0) (2026-09-13)


### Features

* **framework:** add OpenAPI generation and typed worker execution ([#1286](https://github.com/vibeunion/supacloud/issues/1286)) ([25dcffb](https://github.com/vibeunion/supacloud/commit/25dcffb9a7a33ee7205868c860126d3d2ef50ff4))

## [0.11.2](https://github.com/vibeunion/supacloud/compare/elysia-v0.11.1...elysia-v0.11.2) (2026-09-13)


### Performance Improvements

* optimize compiler and upgrade Bun runtime ([#1283](https://github.com/vibeunion/supacloud/issues/1283)) ([381c1b9](https://github.com/vibeunion/supacloud/commit/381c1b98264a563d22fc2f4af85f7f7117563481))

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
