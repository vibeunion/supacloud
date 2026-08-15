# Changelog

## [0.8.1](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.8.0...supacloud-lite-v0.8.1) (2026-08-15)


### Bug Fixes

* **lite:** complete extended auth compatibility ([#912](https://github.com/zuohuadong/supacloud/issues/912)) ([dd657f5](https://github.com/zuohuadong/supacloud/commit/dd657f5b52f2f3d65c0178f76fd78d027c153c5a))

## [0.8.0](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.7.3...supacloud-lite-v0.8.0) (2026-08-15)


### Features

* add project-scoped durable workflows ([#901](https://github.com/zuohuadong/supacloud/issues/901)) ([af4fbc2](https://github.com/zuohuadong/supacloud/commit/af4fbc257f18431f1ba68854ac8bdde03ec3af96))
* **lite:** add native engine and image transform caching ([#909](https://github.com/zuohuadong/supacloud/issues/909)) ([631f575](https://github.com/zuohuadong/supacloud/commit/631f5758c7bb6649678465a62d229f0a0e0528dd))


### Bug Fixes

* **lite:** keep inspection commands read-only ([#900](https://github.com/zuohuadong/supacloud/issues/900)) ([9437b80](https://github.com/zuohuadong/supacloud/commit/9437b808cd8a376f779d2391da25661f938047f2))

## [0.7.3](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.7.2...supacloud-lite-v0.7.3) (2026-08-14)


### Bug Fixes

* **lite:** load fetch-object edge functions ([#897](https://github.com/zuohuadong/supacloud/issues/897)) ([149e430](https://github.com/zuohuadong/supacloud/commit/149e4300ab17c0627e2f89990aabed9b7605b7cf))
* **lite:** skip request log for auth health probe ([#898](https://github.com/zuohuadong/supacloud/issues/898)) ([618d31c](https://github.com/zuohuadong/supacloud/commit/618d31c652ed1ec7b1ec6a9462e468ce1b7aa7b3))

## [0.7.2](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.7.1...supacloud-lite-v0.7.2) (2026-08-14)


### Bug Fixes

* **lite:** expose auth health probe ([#895](https://github.com/zuohuadong/supacloud/issues/895)) ([2a2930d](https://github.com/zuohuadong/supacloud/commit/2a2930d75acdcd44216bb60e89701b092e4fd352))

## [0.7.1](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.7.0...supacloud-lite-v0.7.1) (2026-08-11)


### Bug Fixes

* **lite:** bound standalone subprocess collection ([#827](https://github.com/zuohuadong/supacloud/issues/827)) ([4c37c33](https://github.com/zuohuadong/supacloud/commit/4c37c3325391de11ff6224b0297eb211a3627f5a))
* **lite:** guard db reset on uninitialized state ([#826](https://github.com/zuohuadong/supacloud/issues/826)) ([1e45f5f](https://github.com/zuohuadong/supacloud/commit/1e45f5fdd0cda0dbe238043526eb8d5ab8ebf1e1))
* **lite:** keep project API keys stable ([#817](https://github.com/zuohuadong/supacloud/issues/817)) ([80c5818](https://github.com/zuohuadong/supacloud/commit/80c581846a91654268af2b745f9a7d3d01ab8d5e))

## [0.7.0](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.6.0...supacloud-lite-v0.7.0) (2026-08-11)


### Features

* **lite:** support admin magic link verification ([#788](https://github.com/zuohuadong/supacloud/issues/788)) ([97defa0](https://github.com/zuohuadong/supacloud/commit/97defa0e3ba875d1bd0363f9f64df02a089238ff))

## [0.6.0](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.10...supacloud-lite-v0.6.0) (2026-08-11)


### Features

* **lite:** add secure phone OTP compatibility ([#790](https://github.com/zuohuadong/supacloud/issues/790)) ([b16b88d](https://github.com/zuohuadong/supacloud/commit/b16b88d36629fbb47e8afbfc25d2e75abf59b234))


### Bug Fixes

* **lite:** support storage owner_id compatibility ([#787](https://github.com/zuohuadong/supacloud/issues/787)) ([5fe92ea](https://github.com/zuohuadong/supacloud/commit/5fe92ea141a8fdc9328708ff8e2b565529fd8393))

## [0.5.10](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.9...supacloud-lite-v0.5.10) (2026-08-10)


### Bug Fixes

* **lite:** default PGlite timezone to UTC ([#793](https://github.com/zuohuadong/supacloud/issues/793)) ([e79cb42](https://github.com/zuohuadong/supacloud/commit/e79cb421e970f94a06df01d4e325f75960803c6d))
* **lite:** delegate function CORS preflights ([#792](https://github.com/zuohuadong/supacloud/issues/792)) ([5dd5f0f](https://github.com/zuohuadong/supacloud/commit/5dd5f0f290c6edf81c335bda8cdc27e857d4eabd))
* **lite:** respect project function execution grants ([#795](https://github.com/zuohuadong/supacloud/issues/795)) ([becd0ec](https://github.com/zuohuadong/supacloud/commit/becd0ecc5cc255777a225d9378b5cd3135136fce))

## [0.5.9](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.8...supacloud-lite-v0.5.9) (2026-08-09)


### Miscellaneous Chores

* **deps:** upgrade dependencies and remove svadmin patch ([6215cb7](https://github.com/zuohuadong/supacloud/commit/6215cb7091a4d0f3dbca754984931fb5aa0e2181))

## [0.5.8](https://github.com/zuohuadong/supacloud/compare/supacloud-lite-v0.5.7...supacloud-lite-v0.5.8) (2026-08-05)


### Bug Fixes

* **lite:** actionable hint when storage upload is denied by RLS ([2de9601](https://github.com/zuohuadong/supacloud/commit/2de96016c802f43a588e22e4dacc91d4efdaa1f3))

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
