# Changelog

## [0.3.0](https://github.com/zuohuadong/supacloud/compare/admin-v0.2.0...admin-v0.3.0) (2026-07-11)


### Features

* security hardening, idempotent install, and CI reliability fixes ([eb15db0](https://github.com/zuohuadong/supacloud/commit/eb15db0e58b8b2a2d19e4e99d92360a33da116a4))

## [0.2.0](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.12...admin-v0.2.0) (2026-06-23)


### Features

* **cli:** add gateway/caddy config tools to cli and admin ([4f5df4f](https://github.com/zuohuadong/supacloud/commit/4f5df4f2ea3f3aca94f95fe47ebc72bc9821e20f))

## [0.1.12](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.11...admin-v0.1.12) (2026-06-03)


### Miscellaneous Chores

* upgrade all dependencies to latest minor ([e9719d9](https://github.com/zuohuadong/supacloud/commit/e9719d983c9303c783ddcd3d772c7e7c56e985b9))

## [0.1.11](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.10...admin-v0.1.11) (2026-05-29)


### Miscellaneous Chores

* **deps:** mark setup-buildx-action v4 PR merged ([e0cadc5](https://github.com/zuohuadong/supacloud/commit/e0cadc5fa00711c15b4d37a8ccf16ea7a7adbe24))

## [0.1.10](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.9...admin-v0.1.10) (2026-05-16)


### Bug Fixes

* **ci:** normalize release changelog headings ([63f3f4d](https://github.com/zuohuadong/supacloud/commit/63f3f4d37c951f7493cada1cd09e37dfa7eb19ca))
* **ci:** use ascii release notes sections ([2fde822](https://github.com/zuohuadong/supacloud/commit/2fde8225e9a01077e09308c88dd982e81368c90e))
* **cli:** infer management URL from project API domains ([3ec0087](https://github.com/zuohuadong/supacloud/commit/3ec008799ecf259643141d8c24620b638d21be12))
* **installer:** derive studio domain from API host ([20acff7](https://github.com/zuohuadong/supacloud/commit/20acff72f543dd84a0082fe68640a605f5a5a1c0))
* **install:** skip legacy supabase compose stack ([4d9ab5b](https://github.com/zuohuadong/supacloud/commit/4d9ab5b3098e99f6829bc930cf71b16ec539bdae))
* make production upgrades binary-first ([6d8e401](https://github.com/zuohuadong/supacloud/commit/6d8e40131b88bd6f3a19f8b6c0f6f422dbc20875))
* support github proxies for binary upgrades ([254cb47](https://github.com/zuohuadong/supacloud/commit/254cb474bcd8ac98da7dccc67fce8829c0cca30e))


### Elegance & Refactoring

* remove legacy sql result alias ([3b14b89](https://github.com/zuohuadong/supacloud/commit/3b14b894dfb6cdd03304fbec0a5060439e52d3db))


### Miscellaneous Chores

* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/admin ([#83](https://github.com/zuohuadong/supacloud/issues/83)) ([a20d827](https://github.com/zuohuadong/supacloud/commit/a20d8271ebca6b6e7d0bf3b973b09c6616eb6619))
* release main ([c36b94e](https://github.com/zuohuadong/supacloud/commit/c36b94e213199b32cfb1d1ce0bb97ad579512b81))
* release main ([e7e6560](https://github.com/zuohuadong/supacloud/commit/e7e6560517e13baf3f72f5553bdb784c1b561d2e))
* release main ([b783711](https://github.com/zuohuadong/supacloud/commit/b783711ebf1aff4e3d244d5f67f126a461949db9))
* release main ([68c8362](https://github.com/zuohuadong/supacloud/commit/68c83624cba53efd1e2b1338304288336a86f98b))
* release main ([4c02b71](https://github.com/zuohuadong/supacloud/commit/4c02b7122fc26d4a43cb45576621b94e9073addc))
* release main ([cf795eb](https://github.com/zuohuadong/supacloud/commit/cf795eb4acc0de5e947c23cafe22ab93fe06ed0d))
* release main ([d79a138](https://github.com/zuohuadong/supacloud/commit/d79a1381e52e8231f8b0eeec9efc403e7ade68ce))
* release main ([939c0a4](https://github.com/zuohuadong/supacloud/commit/939c0a44d8d828831cc3b9da26f0d4a538536b72))
* release main ([77cbf82](https://github.com/zuohuadong/supacloud/commit/77cbf824d2120f59af592ce44300f587c2657913))
* release main ([03a4bfa](https://github.com/zuohuadong/supacloud/commit/03a4bfa21a066aa0ce52b1c14e4cf5daa7f3057d))
* release main ([d2757c8](https://github.com/zuohuadong/supacloud/commit/d2757c800d0f8116bd484e307adf8390e2aba9da))
* release main ([eb82b4d](https://github.com/zuohuadong/supacloud/commit/eb82b4dc38dc4e00401a259030b007ce3d986272))
* release main ([#113](https://github.com/zuohuadong/supacloud/issues/113)) ([3c98a4c](https://github.com/zuohuadong/supacloud/commit/3c98a4c9353f5d53ad1517e4e56a779cece4aded))
* release main ([#114](https://github.com/zuohuadong/supacloud/issues/114)) ([02b89e6](https://github.com/zuohuadong/supacloud/commit/02b89e6d9d1ff7ac85148342415d3f6ae9277fd8))
* release main ([#75](https://github.com/zuohuadong/supacloud/issues/75)) ([6e10ff2](https://github.com/zuohuadong/supacloud/commit/6e10ff2d2c15077b2cdf87c161f5285e4d1240c2))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([2e4376a](https://github.com/zuohuadong/supacloud/commit/2e4376a43affe224eb83c3d2c0f7761eb5fb204a))

## [0.1.9](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.8...admin-v0.1.9) (2026-05-15)


### Bug Fixes

* **ci:** normalize release changelog headings ([a446d69](https://github.com/zuohuadong/supacloud/commit/a446d692c12257753da8603617c3313982a56f87))
* **ci:** use ascii release notes sections ([fc1e24c](https://github.com/zuohuadong/supacloud/commit/fc1e24cc6e549da308a9d312b918eefbc1e9b418))

## [0.1.8](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.7...admin-v0.1.8) (2026-05-15)


### Bug Fixes

* **cli:** infer management URL from project API domains ([c5eb874](https://github.com/zuohuadong/supacloud/commit/c5eb874ec4d108f9bb0a8bb530b35269de8cca41))
* **installer:** derive studio domain from API host ([00a0008](https://github.com/zuohuadong/supacloud/commit/00a0008b4cd492afa27f92ec05dfb9977c92a57e))
* **install:** skip legacy supabase compose stack ([d09d0b0](https://github.com/zuohuadong/supacloud/commit/d09d0b0654e204c74418ae97a8f360aaedc912c6))
* make production upgrades binary-first ([7fd392b](https://github.com/zuohuadong/supacloud/commit/7fd392be1760b41ef7a103dd76c411032202e8d9))
* support github proxies for binary upgrades ([2a65cdf](https://github.com/zuohuadong/supacloud/commit/2a65cdf241c3e5389a13437fd280991f81e2ca39))


### Elegance & Refactoring

* remove legacy sql result alias ([d9c85e3](https://github.com/zuohuadong/supacloud/commit/d9c85e3916de88bb38b86e943a63a903789379bd))


### Miscellaneous Chores

* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/admin ([#83](https://github.com/zuohuadong/supacloud/issues/83)) ([ed0231e](https://github.com/zuohuadong/supacloud/commit/ed0231e9dc25b0b9fc61cfb627fd08741e8c8e42))
* release main ([7537614](https://github.com/zuohuadong/supacloud/commit/7537614cbe0428dc53c44d4e47129938f99d55a2))
* release main ([bbc5871](https://github.com/zuohuadong/supacloud/commit/bbc58717a7377d6200b272cba70a402ae4971e2e))
* release main ([9354c26](https://github.com/zuohuadong/supacloud/commit/9354c26bb259a9a1b89fdbdbf28a2b1b2c540af0))
* release main ([237cb3e](https://github.com/zuohuadong/supacloud/commit/237cb3ed1be202291f43653f533784a8c035e337))
* release main ([eedd89d](https://github.com/zuohuadong/supacloud/commit/eedd89d3cccda79b9a939dbb03e252f262b06fcf))
* release main ([b6756c9](https://github.com/zuohuadong/supacloud/commit/b6756c9c1ffee750f1750ae19630d7b15eff0961))
* release main ([854f4ac](https://github.com/zuohuadong/supacloud/commit/854f4ac060bc11343bb45c52ad5ea4e6d3b4a11b))
* release main ([31b095c](https://github.com/zuohuadong/supacloud/commit/31b095c43748f28bc1422a077df320d95e543175))
* release main ([519e551](https://github.com/zuohuadong/supacloud/commit/519e5518f0b23aca34ffc4488cf41c6bd320b08b))
* release main ([28dd468](https://github.com/zuohuadong/supacloud/commit/28dd46854718e4cc7ce0484098cea9051be75814))
* release main ([71845b0](https://github.com/zuohuadong/supacloud/commit/71845b0e1da740825cef3131ec89f4962bfeb268))
* release main ([7065db9](https://github.com/zuohuadong/supacloud/commit/7065db93a028d9b48ed093cc5f00f6c21547f2ee))
* release main ([#75](https://github.com/zuohuadong/supacloud/issues/75)) ([58492af](https://github.com/zuohuadong/supacloud/commit/58492afd48273e018bf0df202ab9d7e0a2ac4b79))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([11ff3e7](https://github.com/zuohuadong/supacloud/commit/11ff3e76eeb4f752e51ea3b0b8d6024196f6e99a))

## [0.1.7](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.6...admin-v0.1.7) (2026-05-08)


### Miscellaneous Chores

* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/admin ([#83](https://github.com/zuohuadong/supacloud/issues/83)) ([5838201](https://github.com/zuohuadong/supacloud/commit/583820146b57be2cc1165a118b94f329c8a5aed3))

## [0.1.6](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.5...admin-v0.1.6) (2026-05-08)


### Bug Fixes

* **cli:** infer management URL from project API domains ([41de422](https://github.com/zuohuadong/supacloud/commit/41de422003627bedaae2056916dedad7d012ee54))

## [0.1.5](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.4...admin-v0.1.5) (2026-05-08)


### Bug Fixes

* **installer:** derive studio domain from API host ([4d94d49](https://github.com/zuohuadong/supacloud/commit/4d94d49f0e3615e7dfe420dea7cc72ba91fc41d9))

## [0.1.4](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.3...admin-v0.1.4) (2026-05-06)


### Bug Fixes

* **install:** skip legacy supabase compose stack ([4bcf1fa](https://github.com/zuohuadong/supacloud/commit/4bcf1faacc036ddf55aa17c5124ca87e2d8083fa))

## [0.1.3](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.2...admin-v0.1.3) (2026-04-27)


### Elegance & Refactoring

* remove legacy sql result alias ([3565c00](https://github.com/zuohuadong/supacloud/commit/3565c00f197a35e129785cce299ee48b9f91f7b8))

## [0.1.2](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.1...admin-v0.1.2) (2026-04-27)


### Bug Fixes

* make production upgrades binary-first ([08e9046](https://github.com/zuohuadong/supacloud/commit/08e9046aa2f91def72b2a8796aa1aeb719240f66))
* support github proxies for binary upgrades ([598269c](https://github.com/zuohuadong/supacloud/commit/598269c26e9a04ea1c7c5dd543c13206c58e5f9d))

## [0.1.1](https://github.com/zuohuadong/supacloud/compare/admin-v0.1.0...admin-v0.1.1) (2026-04-19)


### Miscellaneous Chores

* release main ([239aea7](https://github.com/zuohuadong/supacloud/commit/239aea7e22bae05cc3c7840bc6c0fd7b322a8862))
* release main ([8d020be](https://github.com/zuohuadong/supacloud/commit/8d020be4e8d374f0cf0498a97e4beb6a88e57fb0))
