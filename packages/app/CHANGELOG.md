# Changelog

## [0.32.0](https://github.com/vibeunion/supacloud/compare/app-v0.31.1...app-v0.32.0) (2026-10-20)


### Features

* **route:** publish feature read permissions ([#2203](https://github.com/vibeunion/supacloud/issues/2203)) ([65ee9bf](https://github.com/vibeunion/supacloud/commit/65ee9bf6948a63700c4966ac71f48d47551eb30b))

## [0.31.1](https://github.com/vibeunion/supacloud/compare/app-v0.31.0...app-v0.31.1) (2026-10-19)


### Bug Fixes

* **compiler:** govern external feature cache invalidation ([#2184](https://github.com/vibeunion/supacloud/issues/2184)) ([905ca9c](https://github.com/vibeunion/supacloud/commit/905ca9c123b0ce3451839fbf09fd5c66501d8e06))

## [0.31.0](https://github.com/vibeunion/supacloud/compare/app-v0.30.0...app-v0.31.0) (2026-10-19)


### Features

* **cli:** require database provenance for feature generation ([#2167](https://github.com/vibeunion/supacloud/issues/2167)) ([8e1eb5d](https://github.com/vibeunion/supacloud/commit/8e1eb5d500898cf822b79884b4a3012b9f030d09))

## [0.30.0](https://github.com/vibeunion/supacloud/compare/app-v0.29.0...app-v0.30.0) (2026-10-19)


### Features

* **compiler:** support route-level idempotency contracts ([#2145](https://github.com/vibeunion/supacloud/issues/2145)) ([dc8ffe0](https://github.com/vibeunion/supacloud/commit/dc8ffe0c888dcaaf4f98d90b084cfeea7311d944))
* complete feature slice governance contracts ([#2151](https://github.com/vibeunion/supacloud/issues/2151)) ([025cb54](https://github.com/vibeunion/supacloud/commit/025cb54d8348931f59e74e1bf1157051218eae9d))


### Bug Fixes

* **compiler:** accept logical names in feature route bindings ([#2155](https://github.com/vibeunion/supacloud/issues/2155)) ([da4e369](https://github.com/vibeunion/supacloud/commit/da4e369b2094912fc72cb314be0633d362ee54ec))

## [0.29.0](https://github.com/vibeunion/supacloud/compare/app-v0.28.3...app-v0.29.0) (2026-10-18)


### Features

* **app:** enforce trusted feature request context ([#2056](https://github.com/vibeunion/supacloud/issues/2056)) ([214909b](https://github.com/vibeunion/supacloud/commit/214909bc1daefe8682cb7bd857396d95b13418a3))
* **compiler:** enforce feature persistence boundaries ([#2062](https://github.com/vibeunion/supacloud/issues/2062)) ([aeaa158](https://github.com/vibeunion/supacloud/commit/aeaa158bb452cf44d0122b321e3fc12777c11543))
* govern conditional command adapters ([#2120](https://github.com/vibeunion/supacloud/issues/2120)) ([bf3258f](https://github.com/vibeunion/supacloud/commit/bf3258f050c79a9148e8be3872055ee0f7999f46))


### Bug Fixes

* **compiler:** export FeaturePersistenceNode ([#2063](https://github.com/vibeunion/supacloud/issues/2063)) ([20937d4](https://github.com/vibeunion/supacloud/commit/20937d4fc17df43d8df7b8c3e66d37b1b271e511))

## [0.28.3](https://github.com/vibeunion/supacloud/compare/app-v0.28.2...app-v0.28.3) (2026-10-17)


### Bug Fixes

* **cli:** align verification target resolution ([#2052](https://github.com/vibeunion/supacloud/issues/2052)) ([3cfcc36](https://github.com/vibeunion/supacloud/commit/3cfcc362f87ecdaf82a4df303f5af436875fb36e))

## [0.28.2](https://github.com/vibeunion/supacloud/compare/app-v0.28.1...app-v0.28.2) (2026-10-17)


### Bug Fixes

* **cli:** sync published compiler dependency ([#2041](https://github.com/vibeunion/supacloud/issues/2041)) ([be44641](https://github.com/vibeunion/supacloud/commit/be446416b87bf009eec892bc20368e3595d7326a))

## [0.28.1](https://github.com/vibeunion/supacloud/compare/app-v0.28.0...app-v0.28.1) (2026-10-17)


### Bug Fixes

* **cli:** bound starter attachment task versions ([#2013](https://github.com/vibeunion/supacloud/issues/2013)) ([85313a0](https://github.com/vibeunion/supacloud/commit/85313a059dc2ebfdcd043422c47b84a2c5fcecf1))
* **cli:** derive feature writer inputs from request contracts ([#2015](https://github.com/vibeunion/supacloud/issues/2015)) ([befd7c9](https://github.com/vibeunion/supacloud/commit/befd7c99912c696955ec237403be7b185bbbd93a))
* **contracts:** preserve installed command errors and align Lite publication ([#2023](https://github.com/vibeunion/supacloud/issues/2023)) ([eb7b750](https://github.com/vibeunion/supacloud/commit/eb7b75043512bf2026a2e8e125f7c3c4f93a2700))
* **test:** accept canonical published package paths ([#2012](https://github.com/vibeunion/supacloud/issues/2012)) ([e5a356f](https://github.com/vibeunion/supacloud/commit/e5a356f4770dcd77e01a750db8a1bce4f198a9a6))

## [0.28.0](https://github.com/vibeunion/supacloud/compare/app-v0.27.2...app-v0.28.0) (2026-10-17)


### ⚠ BREAKING CHANGES

* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.
* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.

### Features

* **app:** add governed reactive event streams and lifecycle signals ([38a26e2](https://github.com/vibeunion/supacloud/commit/38a26e2d3b83226a7488df2ef4f1f5714573aeb2))
* **app:** add portable execution pipeline for Elysia 2 beta ([#1506](https://github.com/vibeunion/supacloud/issues/1506)) ([02486f4](https://github.com/vibeunion/supacloud/commit/02486f43a12d6260cbcabde305857fb92464529a))
* **cli:** make supacloud the one-command deploy entrypoint ([#1817](https://github.com/vibeunion/supacloud/issues/1817)) ([4be5da5](https://github.com/vibeunion/supacloud/commit/4be5da5a9284220610474ca290c708ce982d51bf))
* **compiler:** add validated application resource model ([#1512](https://github.com/vibeunion/supacloud/issues/1512)) ([c7ed93b](https://github.com/vibeunion/supacloud/commit/c7ed93b5cd50107ba0c61ac002e1c254907aa6a5))
* complete Angular framework defaults integration ([#1587](https://github.com/vibeunion/supacloud/issues/1587)) ([0dec8ea](https://github.com/vibeunion/supacloud/commit/0dec8ea48f288da27824579038136dd33f8ccb20))
* converge SDK-aware vibecoding defaults and local development ([#1607](https://github.com/vibeunion/supacloud/issues/1607)) ([cd66672](https://github.com/vibeunion/supacloud/commit/cd6667252a6a8fe0cc0539bc8610ebb8a818af51))
* default RxJS support with compatible SupaCloud JS calls ([#1556](https://github.com/vibeunion/supacloud/issues/1556)) ([b3015cb](https://github.com/vibeunion/supacloud/commit/b3015cb161c0d87e6611f6c4fc60c120a8c9fffe))
* **elysia:** Elysia 2 AOT evaluation and end-to-end typing architecture ([#1654](https://github.com/vibeunion/supacloud/issues/1654)) ([39ee49f](https://github.com/vibeunion/supacloud/commit/39ee49f760e85e789c43c1d18cf5729db592f6bc))
* enable strict Effect route governance by default ([#1742](https://github.com/vibeunion/supacloud/issues/1742)) ([4e18c90](https://github.com/vibeunion/supacloud/commit/4e18c908b9c08a8895be016b4e00a0158bf539c6))
* **governance:** enforce strict user and platform type contracts ([#1754](https://github.com/vibeunion/supacloud/issues/1754)) ([b22f889](https://github.com/vibeunion/supacloud/commit/b22f88919c349f088848028f13b15e44994e0d9c))
* **stability:** add FA delivery and acceptance governance ([#1915](https://github.com/vibeunion/supacloud/issues/1915)) ([f70b607](https://github.com/vibeunion/supacloud/commit/f70b6079234d849d5059dd5a879d22b895022987))


### Bug Fixes

* **app:** harden lifecycle ordering and preserve cleanup failures ([#1555](https://github.com/vibeunion/supacloud/issues/1555)) ([8c96e0d](https://github.com/vibeunion/supacloud/commit/8c96e0d516bd655178ee26f05777787f4e511dab))
* **app:** remove untyped form control writes ([#1758](https://github.com/vibeunion/supacloud/issues/1758)) ([ff8a277](https://github.com/vibeunion/supacloud/commit/ff8a277574d6271e85f87c33699ff19c0f827456))
* **elysia:** return 503 when pending work admission is full ([#1594](https://github.com/vibeunion/supacloud/issues/1594)) ([a1e5d2e](https://github.com/vibeunion/supacloud/commit/a1e5d2e9e023a45f852ae7b278509913f0c50e1e))


### Elegance & Refactoring

* use ESM-only owned packages and Lite launcher ([#1582](https://github.com/vibeunion/supacloud/issues/1582)) ([ed5ac78](https://github.com/vibeunion/supacloud/commit/ed5ac78ee3ab22567268fa276e5b016ad1e8b575))


### Miscellaneous Chores

* adopt AGPL-3.0-only licensing ([#1481](https://github.com/vibeunion/supacloud/issues/1481)) ([8787ad9](https://github.com/vibeunion/supacloud/commit/8787ad9466ebba8f487d28bf62d5f79a220b0ab8))
* **deps:** complete @sinclair/typebox to typebox 1.3.34 migration ([#1655](https://github.com/vibeunion/supacloud/issues/1655)) ([87d1133](https://github.com/vibeunion/supacloud/commit/87d1133c0fa0eadf145afc6c3747f693e3e36200))
* release main ([#1484](https://github.com/vibeunion/supacloud/issues/1484)) ([41b3e72](https://github.com/vibeunion/supacloud/commit/41b3e72d25dd8b1ea1d3dea5b75c90bdea9be797))
* release main ([#1507](https://github.com/vibeunion/supacloud/issues/1507)) ([b7f3a59](https://github.com/vibeunion/supacloud/commit/b7f3a59885596742a8b11fc808d898165a8989ec))
* release main ([#1561](https://github.com/vibeunion/supacloud/issues/1561)) ([3ee71e3](https://github.com/vibeunion/supacloud/commit/3ee71e301e7a5499780b45ec6c64e53698000029))
* release main ([#1586](https://github.com/vibeunion/supacloud/issues/1586)) ([21f22d8](https://github.com/vibeunion/supacloud/commit/21f22d8dba3a1e6e704865727ed5ff4095d28eac))
* release main ([#1592](https://github.com/vibeunion/supacloud/issues/1592)) ([224f76d](https://github.com/vibeunion/supacloud/commit/224f76dfff188cf943152c3ee23cff2269d4d2b9))
* release main ([#1609](https://github.com/vibeunion/supacloud/issues/1609)) ([b52c79c](https://github.com/vibeunion/supacloud/commit/b52c79ceda912786f1299ae2d618172f9252607a))
* release main ([#1657](https://github.com/vibeunion/supacloud/issues/1657)) ([1a3f7ff](https://github.com/vibeunion/supacloud/commit/1a3f7ff901f05dda38ed4827d70a91a4acccd8b3))
* release main ([#1743](https://github.com/vibeunion/supacloud/issues/1743)) ([dcbf82c](https://github.com/vibeunion/supacloud/commit/dcbf82c29fb6de94bd6be0c37df20662a6861b2e))
* release main ([#1757](https://github.com/vibeunion/supacloud/issues/1757)) ([e65dad9](https://github.com/vibeunion/supacloud/commit/e65dad945f8be7e84a7031b2ebf754cc48ad0f1c))
* release main ([#1767](https://github.com/vibeunion/supacloud/issues/1767)) ([d31bf06](https://github.com/vibeunion/supacloud/commit/d31bf06a2bfbdb353554a44576d0c54685f46193))
* release main ([#1815](https://github.com/vibeunion/supacloud/issues/1815)) ([d1acf62](https://github.com/vibeunion/supacloud/commit/d1acf62f306e2c77ac7bf681c675cb47537f28c3))
* release main ([#1825](https://github.com/vibeunion/supacloud/issues/1825)) ([4819f95](https://github.com/vibeunion/supacloud/commit/4819f95ae7ce722b58f4858261c100c448c9975e))
* release main ([#1916](https://github.com/vibeunion/supacloud/issues/1916)) ([64838ca](https://github.com/vibeunion/supacloud/commit/64838ca0d3a75e2e5bab11fbbb5f5cca3b5f830f))
* release main ([#1944](https://github.com/vibeunion/supacloud/issues/1944)) ([206d711](https://github.com/vibeunion/supacloud/commit/206d711a0012bad9465283f2f2bfc5f4eb80d269))
* release main ([#2030](https://github.com/vibeunion/supacloud/issues/2030)) ([2f7cf91](https://github.com/vibeunion/supacloud/commit/2f7cf91d941ab583ebe21d901069a16e55efc48a))
* upgrade dependencies and caddy ([#1821](https://github.com/vibeunion/supacloud/issues/1821)) ([91c9a4b](https://github.com/vibeunion/supacloud/commit/91c9a4bd0a14f757670822a1aa953643a00a83c9))
* upgrade workspace dependencies ([#1940](https://github.com/vibeunion/supacloud/issues/1940)) ([77ad418](https://github.com/vibeunion/supacloud/commit/77ad418e0568ceeeea0b59a10a3bbc451a68a95f))

## [0.27.2](https://github.com/vibeunion/supacloud/compare/app-v0.27.1...app-v0.27.2) (2026-10-17)


### Dependencies

* align the published @supacloud/contracts dependency to 0.11.2 for the shared command-error protocol.

## [0.27.1](https://github.com/vibeunion/supacloud/compare/app-v0.27.0...app-v0.27.1) (2026-10-15)


### Miscellaneous Chores

* upgrade workspace dependencies ([#1940](https://github.com/vibeunion/supacloud/issues/1940)) ([77ad418](https://github.com/vibeunion/supacloud/commit/77ad418e0568ceeeea0b59a10a3bbc451a68a95f))

## [0.27.0](https://github.com/vibeunion/supacloud/compare/app-v0.26.1...app-v0.27.0) (2026-10-14)


### Features

* **stability:** add FA delivery and acceptance governance ([#1915](https://github.com/vibeunion/supacloud/issues/1915)) ([f70b607](https://github.com/vibeunion/supacloud/commit/f70b6079234d849d5059dd5a879d22b895022987))

## [0.26.1](https://github.com/vibeunion/supacloud/compare/app-v0.26.0...app-v0.26.1) (2026-10-11)


### Miscellaneous Chores

* upgrade dependencies and caddy ([#1821](https://github.com/vibeunion/supacloud/issues/1821)) ([91c9a4b](https://github.com/vibeunion/supacloud/commit/91c9a4bd0a14f757670822a1aa953643a00a83c9))

## [0.26.0](https://github.com/vibeunion/supacloud/compare/app-v0.25.0...app-v0.26.0) (2026-10-11)


### Features

* **cli:** make supacloud the one-command deploy entrypoint ([#1817](https://github.com/vibeunion/supacloud/issues/1817)) ([4be5da5](https://github.com/vibeunion/supacloud/commit/4be5da5a9284220610474ca290c708ce982d51bf))

## [0.25.0](https://github.com/vibeunion/supacloud/compare/app-v0.24.1...app-v0.25.0) (2026-10-10)


### Features

* **governance:** enforce strict user and platform type contracts ([#1754](https://github.com/vibeunion/supacloud/issues/1754)) ([b22f889](https://github.com/vibeunion/supacloud/commit/b22f88919c349f088848028f13b15e44994e0d9c))

## [0.24.1](https://github.com/vibeunion/supacloud/compare/app-v0.24.0...app-v0.24.1) (2026-10-10)


### Bug Fixes

* **app:** remove untyped form control writes ([#1758](https://github.com/vibeunion/supacloud/issues/1758)) ([ff8a277](https://github.com/vibeunion/supacloud/commit/ff8a277574d6271e85f87c33699ff19c0f827456))

## [0.24.0](https://github.com/vibeunion/supacloud/compare/app-v0.23.0...app-v0.24.0) (2026-10-09)


### Features

* enable strict Effect route governance by default ([#1742](https://github.com/vibeunion/supacloud/issues/1742)) ([4e18c90](https://github.com/vibeunion/supacloud/commit/4e18c908b9c08a8895be016b4e00a0158bf539c6))

## [0.23.0](https://github.com/vibeunion/supacloud/compare/app-v0.22.0...app-v0.23.0) (2026-10-05)


### Features

* **elysia:** Elysia 2 AOT evaluation and end-to-end typing architecture ([#1654](https://github.com/vibeunion/supacloud/issues/1654)) ([39ee49f](https://github.com/vibeunion/supacloud/commit/39ee49f760e85e789c43c1d18cf5729db592f6bc))


### Miscellaneous Chores

* **deps:** complete @sinclair/typebox to typebox 1.3.34 migration ([#1655](https://github.com/vibeunion/supacloud/issues/1655)) ([87d1133](https://github.com/vibeunion/supacloud/commit/87d1133c0fa0eadf145afc6c3747f693e3e36200))

## [0.22.0](https://github.com/vibeunion/supacloud/compare/app-v0.21.1...app-v0.22.0) (2026-10-03)


### Features

* converge SDK-aware vibecoding defaults and local development ([#1607](https://github.com/vibeunion/supacloud/issues/1607)) ([cd66672](https://github.com/vibeunion/supacloud/commit/cd6667252a6a8fe0cc0539bc8610ebb8a818af51))

## [0.21.1](https://github.com/vibeunion/supacloud/compare/app-v0.21.0...app-v0.21.1) (2026-10-02)


### Bug Fixes

* **elysia:** return 503 when pending work admission is full ([#1594](https://github.com/vibeunion/supacloud/issues/1594)) ([a1e5d2e](https://github.com/vibeunion/supacloud/commit/a1e5d2e9e023a45f852ae7b278509913f0c50e1e))

## [0.21.0](https://github.com/vibeunion/supacloud/compare/app-v0.20.0...app-v0.21.0) (2026-10-02)


### Features

* complete Angular framework defaults integration ([#1587](https://github.com/vibeunion/supacloud/issues/1587)) ([0dec8ea](https://github.com/vibeunion/supacloud/commit/0dec8ea48f288da27824579038136dd33f8ccb20))

## [0.20.0](https://github.com/vibeunion/supacloud/compare/app-v0.19.0...app-v0.20.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.
* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.

### Features

* **app:** add governed reactive event streams and lifecycle signals ([38a26e2](https://github.com/vibeunion/supacloud/commit/38a26e2d3b83226a7488df2ef4f1f5714573aeb2))
* default RxJS support with compatible SupaCloud JS calls ([#1556](https://github.com/vibeunion/supacloud/issues/1556)) ([b3015cb](https://github.com/vibeunion/supacloud/commit/b3015cb161c0d87e6611f6c4fc60c120a8c9fffe))


### Bug Fixes

* **app:** harden lifecycle ordering and preserve cleanup failures ([#1555](https://github.com/vibeunion/supacloud/issues/1555)) ([8c96e0d](https://github.com/vibeunion/supacloud/commit/8c96e0d516bd655178ee26f05777787f4e511dab))


### Elegance & Refactoring

* use ESM-only owned packages and Lite launcher ([#1582](https://github.com/vibeunion/supacloud/issues/1582)) ([ed5ac78](https://github.com/vibeunion/supacloud/commit/ed5ac78ee3ab22567268fa276e5b016ad1e8b575))

## [0.19.0](https://github.com/vibeunion/supacloud/compare/app-v0.18.1...app-v0.19.0) (2026-09-30)


### Features

* **app:** add portable execution pipeline for Elysia 2 beta ([#1506](https://github.com/vibeunion/supacloud/issues/1506)) ([02486f4](https://github.com/vibeunion/supacloud/commit/02486f43a12d6260cbcabde305857fb92464529a))
* **compiler:** add validated application resource model ([#1512](https://github.com/vibeunion/supacloud/issues/1512)) ([c7ed93b](https://github.com/vibeunion/supacloud/commit/c7ed93b5cd50107ba0c61ac002e1c254907aa6a5))

## [0.18.1](https://github.com/vibeunion/supacloud/compare/app-v0.18.0...app-v0.18.1) (2026-09-28)


### Miscellaneous Chores

* adopt AGPL-3.0-only licensing ([#1481](https://github.com/vibeunion/supacloud/issues/1481)) ([8787ad9](https://github.com/vibeunion/supacloud/commit/8787ad9466ebba8f487d28bf62d5f79a220b0ab8))

## [0.18.0](https://github.com/vibeunion/supacloud/compare/app-v0.17.0...app-v0.18.0) (2026-09-28)


### Features

* integrate application delivery and platform runtime support ([#1453](https://github.com/vibeunion/supacloud/issues/1453)) ([68594fb](https://github.com/vibeunion/supacloud/commit/68594fb67937091bf274a02b33da0d51d31d7b3a))

## [0.17.0](https://github.com/vibeunion/supacloud/compare/app-v0.16.0...app-v0.17.0) (2026-09-26)


### Features

* **compiler:** preserve raw body and wildcard transport contracts ([#1442](https://github.com/vibeunion/supacloud/issues/1442)) ([436146d](https://github.com/vibeunion/supacloud/commit/436146d0f7f74be1c53969a2fc4854b59976d01d))

## [0.16.0](https://github.com/vibeunion/supacloud/compare/app-v0.15.0...app-v0.16.0) (2026-09-22)


### Features

* **app:** enforce typed reactive form writes ([#1372](https://github.com/vibeunion/supacloud/issues/1372)) ([5f76ea8](https://github.com/vibeunion/supacloud/commit/5f76ea818a94641c6cac7d55a3b46ce6a47dac7e))

## [0.15.0](https://github.com/vibeunion/supacloud/compare/app-v0.14.0...app-v0.15.0) (2026-09-19)


### Features

* **framework:** centralize command runtime governance contract ([#1341](https://github.com/vibeunion/supacloud/issues/1341)) ([2d7e795](https://github.com/vibeunion/supacloud/commit/2d7e79595af64c8fbe95a5e754dedcd0a825a282))

## [0.14.0](https://github.com/vibeunion/supacloud/compare/app-v0.13.0...app-v0.14.0) (2026-09-15)


### Features

* **architecture:** enforce compile-time application governance ([#1301](https://github.com/vibeunion/supacloud/issues/1301)) ([b2c1df2](https://github.com/vibeunion/supacloud/commit/b2c1df25294d0195ddf313623b965e599847d9f9))
* **framework:** complete schema-first route contracts ([#1304](https://github.com/vibeunion/supacloud/issues/1304)) ([4acc3ac](https://github.com/vibeunion/supacloud/commit/4acc3aced2b6e3202705dd87071131af631abad2))

## [0.13.0](https://github.com/vibeunion/supacloud/compare/app-v0.12.2...app-v0.13.0) (2026-09-15)


### Features

* **app:** add browser-safe HTTP entrypoint ([#1299](https://github.com/vibeunion/supacloud/issues/1299)) ([dc5c380](https://github.com/vibeunion/supacloud/commit/dc5c38027141d0c4888ce7860d04efda79f19043))


### Bug Fixes

* **app:** isolate initialization and guarantee shutdown cleanup ([#1300](https://github.com/vibeunion/supacloud/issues/1300)) ([d16c179](https://github.com/vibeunion/supacloud/commit/d16c17990161c016b0072380e8888a57b1663986))

## [0.12.2](https://github.com/vibeunion/supacloud/compare/app-v0.12.1...app-v0.12.2) (2026-09-13)


### Performance Improvements

* optimize compiler and upgrade Bun runtime ([#1283](https://github.com/vibeunion/supacloud/issues/1283)) ([381c1b9](https://github.com/vibeunion/supacloud/commit/381c1b98264a563d22fc2f4af85f7f7117563481))

## [0.12.1](https://github.com/vibeunion/supacloud/compare/app-v0.12.0...app-v0.12.1) (2026-09-11)


### Miscellaneous Chores

* **deps:** upgrade Bun runtime baseline from 1.4.0 to 1.4.2 ([#1271](https://github.com/vibeunion/supacloud/issues/1271)) ([f53aee5](https://github.com/vibeunion/supacloud/commit/f53aee52e93c25e017e9c693a920de5752fe3ddc))

## [0.12.0](https://github.com/vibeunion/supacloud/compare/app-v0.11.0...app-v0.12.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **commands:** HTTP JSON methods return unknown unless decoded through a contract; writes default to no replay. Durable adapters require explicit authorization and input codecs. See docs/command-migration.md for import, auth, schema, and deployment migration steps.

### Features

* **commands:** unify durable execution with existing workflows ([#1243](https://github.com/vibeunion/supacloud/issues/1243)) ([6da15d4](https://github.com/vibeunion/supacloud/commit/6da15d459e1883ab94e240834200a57e9a41676b))

## [0.11.0](https://github.com/vibeunion/supacloud/compare/app-v0.10.0...app-v0.11.0) (2026-09-08)


### Features

* add SupAuth identity and FA-driven command governance ([#1220](https://github.com/vibeunion/supacloud/issues/1220)) ([66a77ca](https://github.com/vibeunion/supacloud/commit/66a77caea086bb1282772dd9401bd2adb9c04342))

## [0.10.0](https://github.com/vibeunion/supacloud/compare/app-v0.9.0...app-v0.10.0) (2026-09-07)


### Features

* **app:** validate HTTP contracts and require route declarations ([#1201](https://github.com/vibeunion/supacloud/issues/1201)) ([6fc047b](https://github.com/vibeunion/supacloud/commit/6fc047b2349bc04fbbe0ff134558d6e45dc275eb))

## [0.9.0](https://github.com/vibeunion/supacloud/compare/app-v0.8.1...app-v0.9.0) (2026-09-07)


### Features

* **cli:** add governed application starter ([#1193](https://github.com/vibeunion/supacloud/issues/1193)) ([f33561b](https://github.com/vibeunion/supacloud/commit/f33561bfb05e0a63ce08de0153a4fa95f02ac2d6))

## [0.8.1](https://github.com/vibeunion/supacloud/compare/app-v0.8.0...app-v0.8.1) (2026-09-06)


### Documentation

* add bilingual Chinese and English documentation for MCP AI operations, observability, and backup recovery ([#1187](https://github.com/vibeunion/supacloud/issues/1187)) ([d98b061](https://github.com/vibeunion/supacloud/commit/d98b0612ea6c16753251f3c45dbc86cd0968c42c))

## [0.8.0](https://github.com/vibeunion/supacloud/compare/app-v0.7.0...app-v0.8.0) (2026-09-06)


### Features

* complete compiler runtime roadmap ([cb4618a](https://github.com/vibeunion/supacloud/commit/cb4618aef455853f7ad408f06d67004d49155ffb))

## [0.7.0](https://github.com/vibeunion/supacloud/compare/app-v0.6.1...app-v0.7.0) (2026-09-06)


### Features

* **app:** provide zero-config project defaults ([#1173](https://github.com/vibeunion/supacloud/issues/1173)) ([489824d](https://github.com/vibeunion/supacloud/commit/489824db5137e4675248cfc789d9d86e8139775e))

## [0.6.1](https://github.com/vibeunion/supacloud/compare/app-v0.6.0...app-v0.6.1) (2026-09-05)


### Bug Fixes

* **compiler:** close job scope review gaps ([#1161](https://github.com/vibeunion/supacloud/issues/1161)) ([2784942](https://github.com/vibeunion/supacloud/commit/278494285d6225d98619e3df76071418539894e6))

## [0.6.0](https://github.com/vibeunion/supacloud/compare/app-v0.5.0...app-v0.6.0) (2026-09-05)


### Features

* add statically compiled AOP boundaries and jobs ([#1160](https://github.com/vibeunion/supacloud/issues/1160)) ([66c962a](https://github.com/vibeunion/supacloud/commit/66c962a923ed6c4dbd3a354715346878793bb14c))
* migrate compiler and strengthen type safety ([81ffb9d](https://github.com/vibeunion/supacloud/commit/81ffb9dae9a09b5561f90e655f1503514d3fe1d7))

## [0.5.0](https://github.com/vibeunion/supacloud/compare/app-v0.4.0...app-v0.5.0) (2026-09-04)


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

## [0.4.0](https://github.com/vibeunion/supacloud/compare/app-v0.3.0...app-v0.4.0) (2026-09-04)


### Features

* **compiler:** add checkProject drift detection, capabilities governance, and CLI ([#1134](https://github.com/vibeunion/supacloud/issues/1134)) ([831225a](https://github.com/vibeunion/supacloud/commit/831225a6d8d5c79392c4e261ddbffb092125c97f))

## [0.3.0](https://github.com/vibeunion/supacloud/compare/app-v0.2.0...app-v0.3.0) (2026-09-03)


### Features

* **compiler,app:** add module tags and boundary governance with Nx workspace configuration ([#1110](https://github.com/vibeunion/supacloud/issues/1110)) ([dda9635](https://github.com/vibeunion/supacloud/commit/dda96355ba25a53f1b550e8e95011b1c806a2003))

## [0.2.0](https://github.com/vibeunion/supacloud/compare/app-v0.1.0...app-v0.2.0) (2026-09-02)


### Features

* **app:** add command governance boundaries ([#1104](https://github.com/vibeunion/supacloud/issues/1104)) ([48b6f4f](https://github.com/vibeunion/supacloud/commit/48b6f4f1dc9c8f474faa325172ee9f20b42d8332))
* **app:** add DB_CLIENT token and composeCommandExecutors pipeline ([#1103](https://github.com/vibeunion/supacloud/issues/1103)) ([cbba56f](https://github.com/vibeunion/supacloud/commit/cbba56f400ecb0b6948969c1ab16a75eed82c6f4))
* **app:** enforce command governance at runtime ([#1096](https://github.com/vibeunion/supacloud/issues/1096)) ([63f59e0](https://github.com/vibeunion/supacloud/commit/63f59e09bb98835ba3dc414e9fcc3806295850e4))

## 0.1.0 (2026-09-02)


### Features

* add application framework packages (app, compiler, elysia) ([#1082](https://github.com/vibeunion/supacloud/issues/1082)) ([7e6ccca](https://github.com/vibeunion/supacloud/commit/7e6cccaef340ea18b10040b32871cded1206fe91))
