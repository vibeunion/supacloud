# Changelog

## [0.16.9](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.8...web-console-v0.16.9) (2026-06-29)


### Bug Fixes

* **management-api:** harden diagnostics health checks ([a69b21f](https://github.com/zuohuadong/supacloud/commit/a69b21fd4decaebe603d78eacec436226f5a5a40))

## [0.16.8](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.7...web-console-v0.16.8) (2026-06-29)


### Bug Fixes

* **web-console:** repair studio health surfaces ([0822a80](https://github.com/zuohuadong/supacloud/commit/0822a80678baf1053efedb400c73a2db9bcdf3d3))

## [0.16.7](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.6...web-console-v0.16.7) (2026-06-28)


### Miscellaneous Chores

* **deps-dev:** bump svelte from 5.56.3 to 5.56.4 in /packages/web-console ([501751d](https://github.com/zuohuadong/supacloud/commit/501751d3b27c9ed25545710b11786f78136d568d))
* **deps-dev:** bump vite from 8.0.16 to 8.1.0 in /packages/web-console ([02daea6](https://github.com/zuohuadong/supacloud/commit/02daea61743d78cd0e129b7f3cbd8c1b528e597d))
* **deps:** bump @svadmin/core from 0.30.0 to 0.31.0 in /packages/web-console ([9dbaa89](https://github.com/zuohuadong/supacloud/commit/9dbaa897196a6bacace4b568394fd8e7bf86f5bb))
* **deps:** bump @svadmin/ui from 0.37.0 to 0.38.1 in /packages/web-console ([5b946c8](https://github.com/zuohuadong/supacloud/commit/5b946c8f0ed0e1bb2adab308fb19f60b555911cb))
* **deps:** bump isomorphic-dompurify from 3.17.0 to 3.18.0 in /packages/web-console ([1a1a796](https://github.com/zuohuadong/supacloud/commit/1a1a796a7d350c8acc70582fd1540658d80f521e))

## [0.16.6](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.5...web-console-v0.16.6) (2026-06-25)


### Bug Fixes

* **management-api:** support generic postgres health ([51e23a1](https://github.com/zuohuadong/supacloud/commit/51e23a15c0e2291380cf5bbe19207787d3aa5092))

## [0.16.5](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.4...web-console-v0.16.5) (2026-06-24)


### Bug Fixes

* restore studio compatibility routes ([3aacf63](https://github.com/zuohuadong/supacloud/commit/3aacf63caf25da68e5ea791e3467943bdc7b343e))

## [0.16.4](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.3...web-console-v0.16.4) (2026-06-22)


### Bug Fixes

* **ci:** gate web console release build ([4b80c62](https://github.com/zuohuadong/supacloud/commit/4b80c62a64d8fae915162b717c906dfd6353961c))

## [0.16.3](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.2...web-console-v0.16.3) (2026-06-19)


### Bug Fixes

* **web-console:** call physical PITR restore endpoint ([#349](https://github.com/zuohuadong/supacloud/issues/349)) ([3db0075](https://github.com/zuohuadong/supacloud/commit/3db007552f467930e9d3fe7c723665a4ed952808))

## [0.16.2](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.1...web-console-v0.16.2) (2026-06-19)


### Bug Fixes

* **web-console:** prefer Bun function templates ([4725f61](https://github.com/zuohuadong/supacloud/commit/4725f61bf48173faea510df052bb870a52b9a3c6))

## [0.16.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.16.0...web-console-v0.16.1) (2026-06-19)


### Bug Fixes

* **web-console:** enforce SPA-only API access ([c2317a1](https://github.com/zuohuadong/supacloud/commit/c2317a18d5eb223637773a0d187c473f4184a3ed))

## [0.16.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.15.0...web-console-v0.16.0) (2026-06-19)


### Features

* **management-api:** configure auth email templates ([#335](https://github.com/zuohuadong/supacloud/issues/335)) ([10bee5f](https://github.com/zuohuadong/supacloud/commit/10bee5f9a88082f64090f0879838708a5a674628))

## [0.15.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.14.3...web-console-v0.15.0) (2026-06-15)


### Features

* **management-api:** close Supabase parity gaps ([df085a9](https://github.com/zuohuadong/supacloud/commit/df085a997bfa6e78f8ec92da467b6855fc22795e))

## [0.14.3](https://github.com/zuohuadong/supacloud/compare/web-console-v0.14.2...web-console-v0.14.3) (2026-06-06)


### Miscellaneous Chores

* **deps:** bump @svadmin/core in /packages/web-console ([#295](https://github.com/zuohuadong/supacloud/issues/295)) ([29f6385](https://github.com/zuohuadong/supacloud/commit/29f6385487693e5a719a11b7e2de06f46f37d9c0))

## [0.14.2](https://github.com/zuohuadong/supacloud/compare/web-console-v0.14.1...web-console-v0.14.2) (2026-06-04)


### Bug Fixes

* **gateway,storage:** inject Host/X-Forwarded-Proto headers and bootstrap storage RLS policies ([#275](https://github.com/zuohuadong/supacloud/issues/275)) ([b2c56a7](https://github.com/zuohuadong/supacloud/commit/b2c56a7160289845d654973dedc26ea625f96e96))

## [0.14.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.14.0...web-console-v0.14.1) (2026-06-03)


### Miscellaneous Chores

* upgrade all dependencies to latest minor ([e9719d9](https://github.com/zuohuadong/supacloud/commit/e9719d983c9303c783ddcd3d772c7e7c56e985b9))

## [0.14.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.13.3...web-console-v0.14.0) (2026-05-30)


### Features

* **web-console:** redesign login page style with Supabase aesthetics ([0822014](https://github.com/zuohuadong/supacloud/commit/0822014d56bbf80852ee06db8ee35362a413ffd0))

## [0.13.3](https://github.com/zuohuadong/supacloud/compare/web-console-v0.13.2...web-console-v0.13.3) (2026-05-29)


### Miscellaneous Chores

* **deps:** mark setup-buildx-action v4 PR merged ([e0cadc5](https://github.com/zuohuadong/supacloud/commit/e0cadc5fa00711c15b4d37a8ccf16ea7a7adbe24))

## [0.13.2](https://github.com/zuohuadong/supacloud/compare/web-console-v0.13.1...web-console-v0.13.2) (2026-05-28)


### Bug Fixes

* **auth:** use ES256 for GoTrue admin proxy ([728eed2](https://github.com/zuohuadong/supacloud/commit/728eed28f242e4861138921a11b4f2702890434b))

## [0.13.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.13.0...web-console-v0.13.1) (2026-05-27)


### Elegance & Refactoring

* remove Kong gateway provider, hardcode Caddy as sole gateway ([90ae018](https://github.com/zuohuadong/supacloud/commit/90ae018316bbb80d5fdb1d89ccf672c6e4b1c16c))

## [0.13.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.12.3...web-console-v0.13.0) (2026-05-26)


### Features

* add database scaling controls ([0ea03ae](https://github.com/zuohuadong/supacloud/commit/0ea03ae570461ddfb7f2c597ab94bb3db439895b))

## [0.12.3](https://github.com/zuohuadong/supacloud/compare/web-console-v0.12.2...web-console-v0.12.3) (2026-05-25)


### Performance Improvements

* raise background task concurrency cap ([dbbfb27](https://github.com/zuohuadong/supacloud/commit/dbbfb27cb6bb18b8b99ca4fca311dbe98289bc4e))

## [0.12.2](https://github.com/zuohuadong/supacloud/compare/web-console-v0.12.1...web-console-v0.12.2) (2026-05-23)


### Miscellaneous Chores

* **deps-dev:** bump vite in /packages/web-console ([#166](https://github.com/zuohuadong/supacloud/issues/166)) ([a2e1e02](https://github.com/zuohuadong/supacloud/commit/a2e1e02984fd208aeef43f6ee988ec50c1f60ffe))

## [0.12.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.12.0...web-console-v0.12.1) (2026-05-22)


### Bug Fixes

* **config:** raise background task concurrency default to 20 ([1c3cf09](https://github.com/zuohuadong/supacloud/commit/1c3cf099e20b07f96684409451bdcadbfebacfc9))

## [0.12.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.9...web-console-v0.12.0) (2026-05-20)


### Features

* add diagnostics and oauth jwks support ([96e619a](https://github.com/zuohuadong/supacloud/commit/96e619a532f5f16b4b0d08ed9662bc6c6053dbb2))

## [0.11.9](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.8...web-console-v0.11.9) (2026-05-19)


### Bug Fixes

* polish reports i18n and query performance errors ([#150](https://github.com/zuohuadong/supacloud/issues/150)) ([fa54130](https://github.com/zuohuadong/supacloud/commit/fa541307f963ed63584d836ba0d7e280f0a7f50e))

## [0.11.8](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.7...web-console-v0.11.8) (2026-05-18)


### Bug Fixes

* **web-console:** prevent i18n race after login ([#148](https://github.com/zuohuadong/supacloud/issues/148)) ([c38da4f](https://github.com/zuohuadong/supacloud/commit/c38da4fc639a3db2dbf8ac597e0176e1326cf8f0))

## [0.11.7](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.6...web-console-v0.11.7) (2026-05-18)


### Bug Fixes

* **web-console:** avoid invalid platform SQL calls ([#146](https://github.com/zuohuadong/supacloud/issues/146)) ([6e28949](https://github.com/zuohuadong/supacloud/commit/6e28949bdad2a916cddfd58341ca8d51242c5332))

## [0.11.6](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.5...web-console-v0.11.6) (2026-05-18)


### Bug Fixes

* **i18n:** add missing Dashboard.cache_hit_ratio translation ([#144](https://github.com/zuohuadong/supacloud/issues/144)) ([a3eceeb](https://github.com/zuohuadong/supacloud/commit/a3eceeb08808563ff8c19d487bb9b0b04eee0af0))

## [0.11.5](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.4...web-console-v0.11.5) (2026-05-18)


### Bug Fixes

* backup timeout and dashboard i18n hardcoded Chinese ([#142](https://github.com/zuohuadong/supacloud/issues/142)) ([05c4bc4](https://github.com/zuohuadong/supacloud/commit/05c4bc492eff9597f56ec60c288f33f460658efe))

## [0.11.4](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.3...web-console-v0.11.4) (2026-05-18)


### Bug Fixes

* resolve Studio Core infinite loop and multiple UI bugs ([#140](https://github.com/zuohuadong/supacloud/issues/140)) ([0bd82a1](https://github.com/zuohuadong/supacloud/commit/0bd82a1f45dca7503f5ba2a877aab750a5f70c76))

## [0.11.3](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.2...web-console-v0.11.3) (2026-05-18)


### Bug Fixes

* correct config routes and console init guard ([#138](https://github.com/zuohuadong/supacloud/issues/138)) ([1811293](https://github.com/zuohuadong/supacloud/commit/18112931562b3a5dba75b89ecf1e71c0f7262835))

## [0.11.2](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.1...web-console-v0.11.2) (2026-05-18)


### Bug Fixes

* harden web console API and stream handling ([#136](https://github.com/zuohuadong/supacloud/issues/136)) ([f208679](https://github.com/zuohuadong/supacloud/commit/f20867956d32866f2d8ee99272f697f42d0c3f58))

## [0.11.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.11.0...web-console-v0.11.1) (2026-05-16)


### Miscellaneous Chores

* **deps-dev:** bump vite in /packages/web-console ([#117](https://github.com/zuohuadong/supacloud/issues/117)) ([a257057](https://github.com/zuohuadong/supacloud/commit/a257057663345873c5f6ea9b498cf30a575d7e6e))

## [0.11.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.10.1...web-console-v0.11.0) (2026-05-16)


### Features

* **edge-functions:** implement per-function verify_jwt configuration ([7dcddf1](https://github.com/zuohuadong/supacloud/commit/7dcddf1a80c40f3023e38af9e7ed2d4ff5e14c22))
* **gateway:** manage certificates through Kong ([b76d519](https://github.com/zuohuadong/supacloud/commit/b76d519953732f1dc5a827abbffd8f2a3e95fe65))
* **management-api:** add web console tasks tracking & custom rate limits UI ([7891f83](https://github.com/zuohuadong/supacloud/commit/7891f83981ae2f476f8faf293bc60d1f89478285))
* **sdk/e2e:** finalize sdk proxy passthrough and structural snapshot tests ([1fe15b4](https://github.com/zuohuadong/supacloud/commit/1fe15b4e726602f7255ba2b64dbd0be8fc7252ee))
* **tasks:** deploy background task and message queue features to servers ([83d9062](https://github.com/zuohuadong/supacloud/commit/83d90626df765c99a96b5d93ed103e4452a5db4d))
* updates and fixes based on recent local changes ([79940f4](https://github.com/zuohuadong/supacloud/commit/79940f47578d4db4f4f133c08645d0c635c71a8d))
* **web-console:** integrate realtime health, custom domains and oauth panels ([1fe15b4](https://github.com/zuohuadong/supacloud/commit/1fe15b4e726602f7255ba2b64dbd0be8fc7252ee))


### Bug Fixes

* **auth,infra:** 401 pre-flight and all-in-one local docker ([e201d45](https://github.com/zuohuadong/supacloud/commit/e201d458280e084837c3d690c6296ed3f4545598))
* **ci:** normalize release changelog headings ([63f3f4d](https://github.com/zuohuadong/supacloud/commit/63f3f4d37c951f7493cada1cd09e37dfa7eb19ca))
* **ci:** use ascii release notes sections ([2fde822](https://github.com/zuohuadong/supacloud/commit/2fde8225e9a01077e09308c88dd982e81368c90e))
* **database:** consume sql rows response only ([98fede7](https://github.com/zuohuadong/supacloud/commit/98fede7ba3ed80a5d51f9bbb1f1e79eeab901eef))
* harden realtime tasks and data-plane boundaries ([c830dc5](https://github.com/zuohuadong/supacloud/commit/c830dc5f9b7b1f7721412864765e6ae1f1dd4a01))
* **web-console:** allow editing project routing domains ([1660361](https://github.com/zuohuadong/supacloud/commit/1660361efbfcc3fc9987d2a6cb62834a1c01dddd))
* **web-console:** correct Svelte 5 store syntax for svelte-query rune data access ([e55b2f7](https://github.com/zuohuadong/supacloud/commit/e55b2f74c02d49ec254df482071885d989a091a4))
* **web-console:** restore settings and task management UI ([f27519e](https://github.com/zuohuadong/supacloud/commit/f27519e0c2b7189caf19e842173c892ee8e8a790))


### Elegance & Refactoring

* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([7aa6894](https://github.com/zuohuadong/supacloud/commit/7aa68945bee02aa15447698e5990866e36af30d2))


### Performance Improvements

* reduce management hot path load ([954497f](https://github.com/zuohuadong/supacloud/commit/954497fe7b312ac3cdc4778ef4b21bb0e6097a4b))


### Documentation

* refresh hardening and runtime notes ([2c81d08](https://github.com/zuohuadong/supacloud/commit/2c81d0815bed50c06be3fb0ed311ce09bc8c4b01))
* **web-console:** add lucide dependency changelog entry ([12b0100](https://github.com/zuohuadong/supacloud/commit/12b0100f481cbe1234ff5a93a6eb32befb7d3da5))


### Miscellaneous Chores

* **deps-dev:** bump vite from 8.0.3 to 8.0.11 in /packages/web-console ([#87](https://github.com/zuohuadong/supacloud/issues/87)) ([b1d29a8](https://github.com/zuohuadong/supacloud/commit/b1d29a81f1db0d703cee9e9a6d9875174142ade5))
* **deps:** bump @svadmin/core in /packages/web-console ([#90](https://github.com/zuohuadong/supacloud/issues/90)) ([22663e4](https://github.com/zuohuadong/supacloud/commit/22663e44596778da2f3fec242fdc710ec89bd924))
* **deps:** bump @svadmin/ui in /packages/web-console ([#89](https://github.com/zuohuadong/supacloud/issues/89)) ([d43b235](https://github.com/zuohuadong/supacloud/commit/d43b2359afd4dc3dc9a994fcc210ff3d20ed0c9b))
* **deps:** bump lucide-svelte from 0.577.0 to 1.0.1 in /packages/web-console ([#88](https://github.com/zuohuadong/supacloud/issues/88)) ([e056f2b](https://github.com/zuohuadong/supacloud/commit/e056f2bfc6fefb860e2036ccc5d92385e0297ea6))
* **deps:** bump marked from 17.0.6 to 18.0.3 in /packages/web-console ([#85](https://github.com/zuohuadong/supacloud/issues/85)) ([247fb57](https://github.com/zuohuadong/supacloud/commit/247fb57ae16b519821adac2eccf36af0ff0d5346))
* flush remaining test suite fixes and project modifications ([e1b625c](https://github.com/zuohuadong/supacloud/commit/e1b625c707b304f753ebbbd466ddb0046cdfd740))
* release main ([02165d4](https://github.com/zuohuadong/supacloud/commit/02165d4da828b6af2d684c456040bf65341f8f1e))
* release main ([a939bbb](https://github.com/zuohuadong/supacloud/commit/a939bbb36a1c5ba6e59fe13ff1e1f5ec8b276edb))
* release main ([e0317fa](https://github.com/zuohuadong/supacloud/commit/e0317fa71adab2925153c8b7a8460ccf3c21d126))
* release main ([f75e8cd](https://github.com/zuohuadong/supacloud/commit/f75e8cd02814d439a583ee30a5c64005b00eb04a))
* release main ([42ac39f](https://github.com/zuohuadong/supacloud/commit/42ac39f6d77a49f88755a3b7fe70f4dd236d5312))
* release main ([fa8b990](https://github.com/zuohuadong/supacloud/commit/fa8b990a9fb44ce6784c07f7d5ef4bccff103952))
* release main ([9fddfb3](https://github.com/zuohuadong/supacloud/commit/9fddfb327fd5e62c20e620d0d9046a13722a94e2))
* release main ([1ecbc25](https://github.com/zuohuadong/supacloud/commit/1ecbc254d4f9cc95c56da279c50ac5e8186cba90))
* release main ([58b455a](https://github.com/zuohuadong/supacloud/commit/58b455a45ffa22c638ec2c1aa59292096b0014cb))
* release main ([7180516](https://github.com/zuohuadong/supacloud/commit/71805164f96869842f27919373521d88f5a4a341))
* release main ([80f9e49](https://github.com/zuohuadong/supacloud/commit/80f9e49271bf9a67d57f165baab37230a52c21dc))
* release main ([18b53e1](https://github.com/zuohuadong/supacloud/commit/18b53e191a034ed65ce0dda04e392a1906562818))
* release main ([77cbf82](https://github.com/zuohuadong/supacloud/commit/77cbf824d2120f59af592ce44300f587c2657913))
* release main ([03a4bfa](https://github.com/zuohuadong/supacloud/commit/03a4bfa21a066aa0ce52b1c14e4cf5daa7f3057d))
* release main ([d2757c8](https://github.com/zuohuadong/supacloud/commit/d2757c800d0f8116bd484e307adf8390e2aba9da))
* release main ([eb82b4d](https://github.com/zuohuadong/supacloud/commit/eb82b4dc38dc4e00401a259030b007ce3d986272))
* release main ([34e53e4](https://github.com/zuohuadong/supacloud/commit/34e53e408e15779759d33eaf8e91b9753eec5b1f))
* release main ([f533d2c](https://github.com/zuohuadong/supacloud/commit/f533d2cb3b93e5143c8066f671d7413ab97fedae))
* release main ([549c0fd](https://github.com/zuohuadong/supacloud/commit/549c0fd4df7bb2ed1d8aa4e25dfda17e3f093cf9))
* release main ([79c9288](https://github.com/zuohuadong/supacloud/commit/79c92889c99db9d8bcada29e8d521050a7dc4f93))
* release main ([11c5eb1](https://github.com/zuohuadong/supacloud/commit/11c5eb1f6f488c3a3ef02ca531e3556ba635ed17))
* release main ([d0c6b59](https://github.com/zuohuadong/supacloud/commit/d0c6b59815aa11ae90b15ec79af3b3e3bfadbdd4))
* release main ([#113](https://github.com/zuohuadong/supacloud/issues/113)) ([3c98a4c](https://github.com/zuohuadong/supacloud/commit/3c98a4c9353f5d53ad1517e4e56a779cece4aded))
* release main ([#114](https://github.com/zuohuadong/supacloud/issues/114)) ([02b89e6](https://github.com/zuohuadong/supacloud/commit/02b89e6d9d1ff7ac85148342415d3f6ae9277fd8))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([2e4376a](https://github.com/zuohuadong/supacloud/commit/2e4376a43affe224eb83c3d2c0f7761eb5fb204a))
* release main ([#93](https://github.com/zuohuadong/supacloud/issues/93)) ([ad30dda](https://github.com/zuohuadong/supacloud/commit/ad30dda44e9ade3ce786032cfba1969629fa83f4))
* remove obsolete debug artifacts ([b090cf9](https://github.com/zuohuadong/supacloud/commit/b090cf9c5ee74d37c4221e8a9a019b86a88d4447))
* setup release-please for automated versioning and update svadmin dependencies ([ff8b5b3](https://github.com/zuohuadong/supacloud/commit/ff8b5b337c7aa6aece97c1ed626d692df91a1494))
* **ts:** finish TypeScript 6 typecheck migration ([1226a03](https://github.com/zuohuadong/supacloud/commit/1226a03dc40909a2e5dc7e2fb90a3aee4daad855))
* upgrade svadmin to latest version and fix breaking changes in query/mutation hooks ([67b5bb8](https://github.com/zuohuadong/supacloud/commit/67b5bb87286c8f5ce97399f99db6d4fb174b44f0))

## [0.10.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.10.0...web-console-v0.10.1) (2026-05-15)


### Bug Fixes

* **ci:** normalize release changelog headings ([a446d69](https://github.com/zuohuadong/supacloud/commit/a446d692c12257753da8603617c3313982a56f87))
* **ci:** use ascii release notes sections ([fc1e24c](https://github.com/zuohuadong/supacloud/commit/fc1e24cc6e549da308a9d312b918eefbc1e9b418))

## [0.10.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.9.4...web-console-v0.10.0) (2026-05-15)


### Features

* **edge-functions:** implement per-function verify_jwt configuration ([adf6746](https://github.com/zuohuadong/supacloud/commit/adf67468b4ccb225aaf3dc50e0fd0bf2f10cb304))
* **gateway:** manage certificates through Kong ([49c1426](https://github.com/zuohuadong/supacloud/commit/49c1426c576ad2364c965f9d81d54d586b556905))
* **management-api:** add web console tasks tracking & custom rate limits UI ([366416c](https://github.com/zuohuadong/supacloud/commit/366416c9ed370812a26af7a9b4fc1ccac65c38d1))
* **sdk/e2e:** finalize sdk proxy passthrough and structural snapshot tests ([f7d0e13](https://github.com/zuohuadong/supacloud/commit/f7d0e13f4b5b8e6938cccc988c828dd06c316a91))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([f780e45](https://github.com/zuohuadong/supacloud/commit/f780e454c735fa81be08c9d122cd69d2907b8338))
* **tasks:** deploy background task and message queue features to servers ([dc85b34](https://github.com/zuohuadong/supacloud/commit/dc85b340db81f0866195b51d1aaeb81731b0824a))
* updates and fixes based on recent local changes ([fe495ba](https://github.com/zuohuadong/supacloud/commit/fe495baf4c7be6b469eb245a8c2bc62503f09a8e))
* **web-console:** integrate realtime health, custom domains and oauth panels ([f7d0e13](https://github.com/zuohuadong/supacloud/commit/f7d0e13f4b5b8e6938cccc988c828dd06c316a91))
* **web-console:** rewrite home page - real API data, solid icons, system status panel, quick actions ([1012eaf](https://github.com/zuohuadong/supacloud/commit/1012eafd4f62c514d06035d2083787f9621fa070))


### Bug Fixes

* **auth,infra:** 401 pre-flight and all-in-one local docker ([bc0a047](https://github.com/zuohuadong/supacloud/commit/bc0a0473cc7c580750a0af717502f15a01039a8f))
* **database:** consume sql rows response only ([3c829df](https://github.com/zuohuadong/supacloud/commit/3c829df24894cbbb184bfb4cb57da9d1506ff31c))
* harden realtime tasks and data-plane boundaries ([f396257](https://github.com/zuohuadong/supacloud/commit/f396257e4c442d7cfb581824b15080bf6dfe64bf))
* **web-console:** allow editing project routing domains ([13aa3d0](https://github.com/zuohuadong/supacloud/commit/13aa3d0e19f98289dad8e664a1d5605d6e725a57))
* **web-console:** correct Svelte 5 store syntax for svelte-query rune data access ([90b0a33](https://github.com/zuohuadong/supacloud/commit/90b0a33ea1bc465078e622a4a9de67902d072c28))
* **web-console:** restore settings and task management UI ([c7c1e7d](https://github.com/zuohuadong/supacloud/commit/c7c1e7dacb82b427ec59d84aa5574ab30a524128))


### Elegance & Refactoring

* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([29a71da](https://github.com/zuohuadong/supacloud/commit/29a71da7ddbc326f0b16b7eeb4bb159784e347c7))


### Performance Improvements

* reduce management hot path load ([2309d46](https://github.com/zuohuadong/supacloud/commit/2309d46b5f4ecfaad69742dcc7bfe80834615afe))


### Documentation

* refresh hardening and runtime notes ([5d4a995](https://github.com/zuohuadong/supacloud/commit/5d4a995fa196b706fbb7f09b154cd3026ee7357f))
* **web-console:** add lucide dependency changelog entry ([b1d4f95](https://github.com/zuohuadong/supacloud/commit/b1d4f95042bf3e9d82b705d3e83ae93ca5aa7e21))


### Miscellaneous Chores

* **deps-dev:** bump vite from 8.0.3 to 8.0.11 in /packages/web-console ([#87](https://github.com/zuohuadong/supacloud/issues/87)) ([3489923](https://github.com/zuohuadong/supacloud/commit/34899234e42dc5eaf53cc5311379f068ebe62ad5))
* **deps:** bump @svadmin/core in /packages/web-console ([#90](https://github.com/zuohuadong/supacloud/issues/90)) ([8590de8](https://github.com/zuohuadong/supacloud/commit/8590de859a08d59e6de1a2f6c484e99f93249138))
* **deps:** bump @svadmin/ui in /packages/web-console ([#89](https://github.com/zuohuadong/supacloud/issues/89)) ([364a176](https://github.com/zuohuadong/supacloud/commit/364a17692c14641db72286b6790a6804af6bf661))
* **deps:** bump lucide-svelte from 0.577.0 to 1.0.1 in /packages/web-console ([#88](https://github.com/zuohuadong/supacloud/issues/88)) ([dcfe926](https://github.com/zuohuadong/supacloud/commit/dcfe926aca7962debe7215bc7557f18cf7a25414))
* **deps:** bump marked from 17.0.6 to 18.0.3 in /packages/web-console ([#85](https://github.com/zuohuadong/supacloud/issues/85)) ([01edbed](https://github.com/zuohuadong/supacloud/commit/01edbeddfce9867f2d3be01153088b4381497677))
* flush remaining test suite fixes and project modifications ([686ad4b](https://github.com/zuohuadong/supacloud/commit/686ad4bb59b1e087c9bf621d9663b259f0f33d27))
* release main ([b5fb260](https://github.com/zuohuadong/supacloud/commit/b5fb2606814d00ea1f822a5f907dbd403d2a4185))
* release main ([9fbd756](https://github.com/zuohuadong/supacloud/commit/9fbd756acec93ead2fe6bddb274b3a1368f0a1a3))
* release main ([0355c8b](https://github.com/zuohuadong/supacloud/commit/0355c8befe2755b2a4e4d72c71a76123e1a7b6b8))
* release main ([14cc502](https://github.com/zuohuadong/supacloud/commit/14cc5024e876f5f7cb923d4306458acf3d004449))
* release main ([f0b4377](https://github.com/zuohuadong/supacloud/commit/f0b437729739e80d3acd7fb23c49624a2d96dcee))
* release main ([8b3d432](https://github.com/zuohuadong/supacloud/commit/8b3d4327ecf5e80ce091489a652108cbaa4b09b5))
* release main ([a922faf](https://github.com/zuohuadong/supacloud/commit/a922faf477bac633cb1852d780fedad772ad8161))
* release main ([c5d39ab](https://github.com/zuohuadong/supacloud/commit/c5d39abf5b1391210fbc39d90f15c2144ed979d3))
* release main ([83229a7](https://github.com/zuohuadong/supacloud/commit/83229a71488b1de5f33105ab53f3be31bdefb4d9))
* release main ([e9101e0](https://github.com/zuohuadong/supacloud/commit/e9101e0120f7ccb84ac7584051c7f556bbdf84a6))
* release main ([44d8344](https://github.com/zuohuadong/supacloud/commit/44d8344d36e813ac22c179ae5c4ed643b970bbb9))
* release main ([177be2a](https://github.com/zuohuadong/supacloud/commit/177be2a31983509e5262ca289136c4b078c8b8c3))
* release main ([519e551](https://github.com/zuohuadong/supacloud/commit/519e5518f0b23aca34ffc4488cf41c6bd320b08b))
* release main ([28dd468](https://github.com/zuohuadong/supacloud/commit/28dd46854718e4cc7ce0484098cea9051be75814))
* release main ([71845b0](https://github.com/zuohuadong/supacloud/commit/71845b0e1da740825cef3131ec89f4962bfeb268))
* release main ([7065db9](https://github.com/zuohuadong/supacloud/commit/7065db93a028d9b48ed093cc5f00f6c21547f2ee))
* release main ([97d3e7b](https://github.com/zuohuadong/supacloud/commit/97d3e7b673c61a6925743754887581e1fb53bdac))
* release main ([c1fb3b8](https://github.com/zuohuadong/supacloud/commit/c1fb3b8757cb80d86b8bde559458f0f5693b0f19))
* release main ([fb49e13](https://github.com/zuohuadong/supacloud/commit/fb49e13f6d7bfe38bf45345840a3a72eb7a17594))
* release main ([95faa91](https://github.com/zuohuadong/supacloud/commit/95faa91498b3f4c8a169bf1f9fdd2d32fad365a2))
* release main ([916dc05](https://github.com/zuohuadong/supacloud/commit/916dc052673f991dc508f8125020b94f86ebc3c2))
* release main ([adc35d5](https://github.com/zuohuadong/supacloud/commit/adc35d57af65a5d0ebc04b144909dc81c3084220))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([11ff3e7](https://github.com/zuohuadong/supacloud/commit/11ff3e76eeb4f752e51ea3b0b8d6024196f6e99a))
* release main ([#93](https://github.com/zuohuadong/supacloud/issues/93)) ([5e8bea4](https://github.com/zuohuadong/supacloud/commit/5e8bea459bc8c84ad4e1c86552b1f4b4fab14f5c))
* remove obsolete debug artifacts ([d5fcd34](https://github.com/zuohuadong/supacloud/commit/d5fcd3401eb7d4c71e29922a2ee523ba327d3870))
* setup release-please for automated versioning and update svadmin dependencies ([2f8cd9e](https://github.com/zuohuadong/supacloud/commit/2f8cd9e8c79fbdccc36bf6e37754af212c9d2589))
* **ts:** finish TypeScript 6 typecheck migration ([b34fa1a](https://github.com/zuohuadong/supacloud/commit/b34fa1aa93dff56a1a9347c33f9691098cb708f5))
* upgrade svadmin to latest version and fix breaking changes in query/mutation hooks ([3f4df1e](https://github.com/zuohuadong/supacloud/commit/3f4df1e413fb3ee713681701232b15860fec8e0d))
* **web-console:** delete orphaned mock projects/sql page ([21bcde2](https://github.com/zuohuadong/supacloud/commit/21bcde204a5030302164ef0a5415c312262af05d))
* **web-console:** remove orphaned mock pages (/dashboard, /monitoring, /system) that duplicated API-driven routes ([fd04b2e](https://github.com/zuohuadong/supacloud/commit/fd04b2ecd7ea63c794b4701e8e209e44ee21ddbf))

## [0.9.4](https://github.com/zuohuadong/supacloud/compare/web-console-v0.9.3...web-console-v0.9.4) (2026-05-11)


### Documentation

* refresh hardening and runtime notes ([d5eba46](https://github.com/zuohuadong/supacloud/commit/d5eba460190d41ec1c938441fa28e62aac19be03))

## [0.9.3](https://github.com/zuohuadong/supacloud/compare/web-console-v0.9.2...web-console-v0.9.3) (2026-05-10)


### Performance Improvements

* reduce management hot path load ([e5f4c82](https://github.com/zuohuadong/supacloud/commit/e5f4c82f58cb1d515c9c6f94d77fe8032ecdbe26))

## [0.9.2](https://github.com/zuohuadong/supacloud/compare/web-console-v0.9.1...web-console-v0.9.2) (2026-05-08)


### Documentation

* **web-console:** add lucide dependency changelog entry ([d048be4](https://github.com/zuohuadong/supacloud/commit/d048be4194978b2511da5ffbd4725ed6b249a041))

## [0.9.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.9.0...web-console-v0.9.1) (2026-05-08)


### Miscellaneous Chores

* **deps-dev:** bump vite from 8.0.3 to 8.0.11 in /packages/web-console ([#87](https://github.com/zuohuadong/supacloud/issues/87)) ([86a3c6c](https://github.com/zuohuadong/supacloud/commit/86a3c6ce6ff0015a1c844cdcd2e1a71286c0f36a))
* **deps:** bump @svadmin/core in /packages/web-console ([#90](https://github.com/zuohuadong/supacloud/issues/90)) ([b216a3c](https://github.com/zuohuadong/supacloud/commit/b216a3c2cf01f98fdfe3b8c3da43d4b164ae0929))
* **deps:** bump @svadmin/ui in /packages/web-console ([#89](https://github.com/zuohuadong/supacloud/issues/89)) ([8ca36cd](https://github.com/zuohuadong/supacloud/commit/8ca36cdddc51108d531b69cf67772a65cfee4384))
* **deps:** bump lucide-svelte from 0.577.0 to 1.0.1 in /packages/web-console ([#88](https://github.com/zuohuadong/supacloud/issues/88)) ([155cd3d](https://github.com/zuohuadong/supacloud/commit/155cd3dc9484caef3267d963961585971130359d))
* **deps:** bump marked from 17.0.6 to 18.0.3 in /packages/web-console ([#85](https://github.com/zuohuadong/supacloud/issues/85)) ([0419294](https://github.com/zuohuadong/supacloud/commit/04192949a6eaeb6671f296cf8d169e4e5f508f34))

## [0.9.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.5...web-console-v0.9.0) (2026-05-08)


### Features

* **gateway:** manage certificates through Kong ([3d5930f](https://github.com/zuohuadong/supacloud/commit/3d5930fb5eb78ed32fb96b06d0f824446504ae22))

## [0.8.5](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.4...web-console-v0.8.5) (2026-04-27)


### Bug Fixes

* **database:** consume sql rows response only ([75c3f68](https://github.com/zuohuadong/supacloud/commit/75c3f6818211cf326954cb75c530ef25e48b901b))

## [0.8.4](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.3...web-console-v0.8.4) (2026-04-24)


### Bug Fixes

* harden realtime tasks and data-plane boundaries ([f6bdfd1](https://github.com/zuohuadong/supacloud/commit/f6bdfd1b92d501507e27ad6ed73ecd3b46cc3e97))

## [0.8.3](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.2...web-console-v0.8.3) (2026-04-23)


### Bug Fixes

* **web-console:** allow editing project routing domains ([7ea7eb7](https://github.com/zuohuadong/supacloud/commit/7ea7eb7b28168a329fdc2a9a936d06654579aa48))
* **web-console:** restore settings and task management UI ([3f7ef75](https://github.com/zuohuadong/supacloud/commit/3f7ef756f3e151a9678f998d8e638f324ab7f77a))

## [0.8.2](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.1...web-console-v0.8.2) (2026-04-19)


### Miscellaneous Chores

* release main ([239aea7](https://github.com/zuohuadong/supacloud/commit/239aea7e22bae05cc3c7840bc6c0fd7b322a8862))
* release main ([8d020be](https://github.com/zuohuadong/supacloud/commit/8d020be4e8d374f0cf0498a97e4beb6a88e57fb0))

## [0.8.1](https://github.com/zuohuadong/supacloud/compare/web-console-v0.8.0...web-console-v0.8.1) (2026-04-19)


### Miscellaneous Chores

* **ts:** finish TypeScript 6 typecheck migration ([5e2ae90](https://github.com/zuohuadong/supacloud/commit/5e2ae9024cf356eb6892402a62bf4036b8ad00dc))

## [0.8.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.7.0...web-console-v0.8.0) (2026-04-17)


### Features

* **tasks:** deploy background task and message queue features to servers ([e66cdac](https://github.com/zuohuadong/supacloud/commit/e66cdac9c34f34990de5675ca75bfca9894cc3b4))
* updates and fixes based on recent local changes ([449c710](https://github.com/zuohuadong/supacloud/commit/449c71089721658d25737ac7df1c196b3bc9bb1d))

## [0.7.0](https://github.com/zuohuadong/supacloud/compare/web-console-v0.6.2...web-console-v0.7.0) (2026-04-14)


### Features

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
* **web-console:** rewrite home page - real API data, solid icons, system status panel, quick actions ([04fd67f](https://github.com/zuohuadong/supacloud/commit/04fd67fa7168afbc2ef258fa5cf9fa52405afc5a))


### Bug Fixes

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


### Elegance & Refactoring

* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([75c7dfd](https://github.com/zuohuadong/supacloud/commit/75c7dfd272ee2c9ca4f638a8493596c20a4ae4bf))
* eliminate technical debt - split projects.ts, centralize env vars, remove all any types ([13500d1](https://github.com/zuohuadong/supacloud/commit/13500d172805cfe3af14dac3f250de3550a8b7b0))
* simplify AutoTable with columns map definition ([a6a40f8](https://github.com/zuohuadong/supacloud/commit/a6a40f8a2b2f26384f27a225886fe8939b340c2f))
* **web-console:** complete svadmin migration with functions, secrets, and hosting lists ([4e5ef12](https://github.com/zuohuadong/supacloud/commit/4e5ef12c921bc6ad2fad275e92dcc53c2af125de))
* **web-console:** finalize AutoTable hybrid migration for auth and tables pages ([209608b](https://github.com/zuohuadong/supacloud/commit/209608b1f53e2cefb3f1b39dd33614c70b83ab34))
* **web-console:** finalize svadmin migration for all previously modified and untracked components ([d9ff5ba](https://github.com/zuohuadong/supacloud/commit/d9ff5ba8585ce08e8a614c43c2ee36a806a6453e))


### Documentation

* document SVAdmin Hybrid Mount architecture and useList patterns ([ca5435d](https://github.com/zuohuadong/supacloud/commit/ca5435d7df15aa014f8df927c2ea1b62c701afca))
* **web-console:** add pure SPA architecture annotations and adapter-static compatibility instructions ([1d2fc73](https://github.com/zuohuadong/supacloud/commit/1d2fc73d2c0ea822dbbbbe6d2b2a9abb9d09c76c))


### Miscellaneous Chores

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
