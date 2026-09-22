# Changelog

## [0.5.0](https://github.com/vibeunion/supacloud/compare/contracts-v0.4.0...contracts-v0.5.0) (2026-09-22)


### Features

* **contracts:** add validated identity, app error and recovery contracts ([#1366](https://github.com/vibeunion/supacloud/issues/1366)) ([2811d97](https://github.com/vibeunion/supacloud/commit/2811d9711431fd5e9b495c67728441883908af4f))

## [0.4.0](https://github.com/vibeunion/supacloud/compare/contracts-v0.3.1...contracts-v0.4.0) (2026-09-15)


### Features

* **elysia:** add read-only command preview ([#1302](https://github.com/vibeunion/supacloud/issues/1302)) ([995bcd4](https://github.com/vibeunion/supacloud/commit/995bcd43ac3639465eab476deefadd0f37867427))

## [0.3.1](https://github.com/vibeunion/supacloud/compare/contracts-v0.3.0...contracts-v0.3.1) (2026-09-11)


### Miscellaneous Chores

* **deps:** upgrade Bun runtime baseline from 1.4.0 to 1.4.2 ([#1271](https://github.com/vibeunion/supacloud/issues/1271)) ([f53aee5](https://github.com/vibeunion/supacloud/commit/f53aee52e93c25e017e9c693a920de5752fe3ddc))

## [0.3.0](https://github.com/vibeunion/supacloud/compare/contracts-v0.2.0...contracts-v0.3.0) (2026-09-11)


### Features

* freeze authored type-safety merge gate ([25e07ea](https://github.com/vibeunion/supacloud/commit/25e07ea1de16cc01a24ed6f001b9bdc729b5ee5e))

## [0.2.0](https://github.com/vibeunion/supacloud/compare/contracts-v0.1.0...contracts-v0.2.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **commands:** HTTP JSON methods return unknown unless decoded through a contract; writes default to no replay. Durable adapters require explicit authorization and input codecs. See docs/command-migration.md for import, auth, schema, and deployment migration steps.

### Features

* **commands:** unify durable execution with existing workflows ([#1243](https://github.com/vibeunion/supacloud/issues/1243)) ([6da15d4](https://github.com/vibeunion/supacloud/commit/6da15d459e1883ab94e240834200a57e9a41676b))
