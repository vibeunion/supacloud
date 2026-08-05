# Changelog

## [0.5.7](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.6...supacloud-lite-v0.5.7) (2026-08-05)


### Bug Fixes

* **lite:** rename internal runtime identities ([a8183d6](https://github.com/zuohuadong/supacloud/commit/a8183d6c9dd9a726e416698f5039be86ef6a3b0c))

## [0.5.6](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.5...supacloud-lite-v0.5.6) (2026-08-04)


### Documentation

* **lite:** add bilingual Chinese/English README ([2b31e87](https://github.com/zuohuadong/supacloud/commit/2b31e8778389200b1077d77e7b1e9999db57d848))

## [0.5.5](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.4...supacloud-lite-v0.5.5) (2026-08-03)


### Bug Fixes

* **lite:** exit Windows CLI after cleanup ([579a714](https://github.com/zuohuadong/supacloud/commit/579a7147a2007885ddcaaabc0123ba10866187a5))
* **lite:** exit Windows CLI after cleanup ([17fe71e](https://github.com/zuohuadong/supacloud/commit/17fe71e23bdd2b1c79de3fbc7ec54fe3432981d1))
* **lite:** keep Windows CLI alive through cleanup ([2032834](https://github.com/zuohuadong/supacloud/commit/20328342240321c1f9267b307d9e546849fed85a))

## [0.5.4](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.3...supacloud-lite-v0.5.4) (2026-08-02)


### Bug Fixes

* **lite:** await realtime listener shutdown ([797699b](https://github.com/zuohuadong/supacloud/commit/797699bcc8b0fcaafccf076acec3c8a49a7ee447))
* **lite:** ignore stale background timer callbacks ([004ba74](https://github.com/zuohuadong/supacloud/commit/004ba74bf3f7970377fc743368d45cf4b6837da4))
* **lite:** skip runtime services for utility commands ([050576e](https://github.com/zuohuadong/supacloud/commit/050576ebcf0a25a0ddd28db020eca759c2521753))

## [0.5.3](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.2...supacloud-lite-v0.5.3) (2026-08-02)


### Bug Fixes

* **lite:** drain active background services before shutdown ([af0546d](https://github.com/zuohuadong/supacloud/commit/af0546d8b9cd15b21d61c8d953f9deed27dc9bff))

## [0.5.2](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.1...supacloud-lite-v0.5.2) (2026-07-30)


### Bug Fixes

* **lite:** release shadow backend after lock conflicts ([c44e7a3](https://github.com/zuohuadong/supacloud/commit/c44e7a3c17f3a2d1ae9f285f7f9ad5187ebd178b))

## [0.5.1](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.0...supacloud-lite-v0.5.1) (2026-07-30)


### Bug Fixes

* make Lite Windows shutdown verification reliable ([#650](https://github.com/zuohuadong/supacloud/issues/650)) ([c208006](https://github.com/zuohuadong/supacloud/commit/c208006aa49839562dda5b0fe1419f183ceb5b12))
* stabilize Lite shutdown and Studio interactions ([a4d6f19](https://github.com/zuohuadong/supacloud/commit/a4d6f19db6c4aa71702fccec83bfbdd2a0c8b2b1))

## [0.5.0](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.4.0...supacloud-lite-v0.5.0) (2026-07-29)


### Features

* **lite:** build standalone single-file binaries with embedded PGlite assets ([#644](https://github.com/zuohuadong/supacloud/issues/644)) ([50da574](https://github.com/zuohuadong/supacloud/commit/50da574a4643fba9d5027464b501e18afe79926b))

## [0.4.0](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.3.0...supacloud-lite-v0.4.0) (2026-07-29)


### Features

* **lite:** align auth queue and cache compatibility ([f6efcd3](https://github.com/zuohuadong/supacloud/commit/f6efcd3168392f96b36ad4a9b89fafd379f523a4))


### Bug Fixes

* resolve remaining reported runtime and console issues ([5fda9f0](https://github.com/zuohuadong/supacloud/commit/5fda9f0960fe7c1a03765f69cc59ebe847016a2c))
* resolve reported console and Lite issues ([781fba4](https://github.com/zuohuadong/supacloud/commit/781fba47412ed44272dc355d484c9d2c283151c9))

## [0.3.0](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.2.0...supacloud-lite-v0.3.0) (2026-07-28)


### Features

* extend Supabase-compatible platform capabilities ([adef019](https://github.com/zuohuadong/supacloud/commit/adef019261f82f123043ab4c7a047e6ad6956e56))
* harden Supabase Cloud compatibility ([ab64374](https://github.com/zuohuadong/supacloud/commit/ab643743b058ad08a0d32c124d26bed0863db397))


### Bug Fixes

* use installed TypeScript in Lite smoke ([8a64050](https://github.com/zuohuadong/supacloud/commit/8a64050833c47778e931067f8f30e541141256bf))


### Documentation

* **lite:** document snapshot archive dependency ([1c0a8cc](https://github.com/zuohuadong/supacloud/commit/1c0a8cccc4e6cbb0804c7badf6573d6d986c2528))

## [0.2.0](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.1.0...supacloud-lite-v0.2.0) (2026-07-28)


### Features

* **lite:** support image transforms and S3 storage ([7dbe7c7](https://github.com/zuohuadong/supacloud/commit/7dbe7c7d2972be5dac1e6c6597eafdcc6234a92a))


### Bug Fixes

* **lite:** preserve npm cli bin entry ([c208fee](https://github.com/zuohuadong/supacloud/commit/c208fee7b052377fd378bae99211dd55cdeea0f2))

## 0.1.0 (2026-07-27)


### Features

* **lite:** add SupaCloud Lite single-project PGlite runtime ([#602](https://github.com/zuohuadong/supacloud/issues/602)) ([a98ae0d](https://github.com/zuohuadong/supacloud/commit/a98ae0dfb31060348db4752b92ad39da13bc6793))


### Bug Fixes

* **management-api:** support Pigsty 4.4 production compatibility ([d8f6959](https://github.com/zuohuadong/supacloud/commit/d8f6959623e6f09e0e665e3353d56fd7fdbab6de))

## 0.1.0

- Initial Bun-native single-project SupaCloud Lite implementation using PGlite.
