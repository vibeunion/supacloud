# Changelog

## [0.7.0](https://github.com/vibeunion/supacloud/compare/commands-v0.6.0...commands-v0.7.0) (2026-09-26)


### Features

* **framework:** add command composition and recovery observability ([#1432](https://github.com/vibeunion/supacloud/issues/1432)) ([456efcd](https://github.com/vibeunion/supacloud/commit/456efcd807deabeb3f3df6d718c47c427673b1f5))

## [0.6.0](https://github.com/vibeunion/supacloud/compare/commands-v0.5.0...commands-v0.6.0) (2026-09-22)


### Features

* **commands:** adopt validated command references ([#1367](https://github.com/vibeunion/supacloud/issues/1367)) ([929b3ff](https://github.com/vibeunion/supacloud/commit/929b3ff79066957a8c7a85e57367723360621441))

## [0.5.0](https://github.com/vibeunion/supacloud/compare/commands-v0.4.0...commands-v0.5.0) (2026-09-16)


### Features

* complete compile-time database architecture ([#1332](https://github.com/vibeunion/supacloud/issues/1332)) ([4a82b4b](https://github.com/vibeunion/supacloud/commit/4a82b4b89078ef371029c6d18b7c674086627a88))


### Documentation

* complete compile-time architecture usage guides ([#1333](https://github.com/vibeunion/supacloud/issues/1333)) ([3190178](https://github.com/vibeunion/supacloud/commit/319017810deb4d7c9911f1bd001ca898f9ea9982))

## [0.4.0](https://github.com/vibeunion/supacloud/compare/commands-v0.3.1...commands-v0.4.0) (2026-09-15)


### Features

* **framework:** complete schema-first route contracts ([#1304](https://github.com/vibeunion/supacloud/issues/1304)) ([4acc3ac](https://github.com/vibeunion/supacloud/commit/4acc3aced2b6e3202705dd87071131af631abad2))

## [0.3.1](https://github.com/vibeunion/supacloud/compare/commands-v0.3.0...commands-v0.3.1) (2026-09-11)


### Miscellaneous Chores

* **deps:** upgrade Bun runtime baseline from 1.4.0 to 1.4.2 ([#1271](https://github.com/vibeunion/supacloud/issues/1271)) ([f53aee5](https://github.com/vibeunion/supacloud/commit/f53aee52e93c25e017e9c693a920de5752fe3ddc))

## [0.3.0](https://github.com/vibeunion/supacloud/compare/commands-v0.2.0...commands-v0.3.0) (2026-09-11)


### Features

* freeze authored type-safety merge gate ([25e07ea](https://github.com/vibeunion/supacloud/commit/25e07ea1de16cc01a24ed6f001b9bdc729b5ee5e))

## [0.2.0](https://github.com/vibeunion/supacloud/compare/commands-v0.1.0...commands-v0.2.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **commands:** HTTP JSON methods return unknown unless decoded through a contract; writes default to no replay. Durable adapters require explicit authorization and input codecs. See docs/command-migration.md for import, auth, schema, and deployment migration steps.

### Features

* **commands:** unify durable execution with existing workflows ([#1243](https://github.com/vibeunion/supacloud/issues/1243)) ([6da15d4](https://github.com/vibeunion/supacloud/commit/6da15d459e1883ab94e240834200a57e9a41676b))
