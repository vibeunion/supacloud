# Changelog

## [0.20.1](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.20.0...edge-runtime-v0.20.1) (2026-09-02)


### Bug Fixes

* harden GoTrue upgrade runtime and CLI compatibility ([#1084](https://github.com/vibeunion/supacloud/issues/1084)) ([3ad2bac](https://github.com/vibeunion/supacloud/commit/3ad2bacad53cdff314d7120c77c9bffff067b2fe))

## [0.20.0](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.19.0...edge-runtime-v0.20.0) (2026-09-02)


### Features

* add first-class Function capability and limit profiles ([e7d19b3](https://github.com/vibeunion/supacloud/commit/e7d19b394f72136f16c1a4b68fa14b710ca46617))

## [0.19.0](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.18.7...edge-runtime-v0.19.0) (2026-09-01)


### Features

* add first-class edge function framework adapters ([#1072](https://github.com/vibeunion/supacloud/issues/1072)) ([d99f3ea](https://github.com/vibeunion/supacloud/commit/d99f3ea04b333913ad97d302cd722048ea091f44))

## [0.18.7](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.18.6...edge-runtime-v0.18.7) (2026-08-29)


### Miscellaneous Chores

* **deps:** upgrade workspace dependencies and svadmin ([#1067](https://github.com/vibeunion/supacloud/issues/1067)) ([9cd8ed6](https://github.com/vibeunion/supacloud/commit/9cd8ed6e81f11da1b26bf491ca745b5599115cc0))

## [0.18.6](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.18.5...edge-runtime-v0.18.6) (2026-08-25)


### Bug Fixes

* **edge-runtime:** make recycle budget configurable ([#1046](https://github.com/vibeunion/supacloud/issues/1046)) ([08e98d6](https://github.com/vibeunion/supacloud/commit/08e98d643ff380654c152208e94a329e299758ca))

## [0.18.5](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.18.4...edge-runtime-v0.18.5) (2026-08-23)


### Miscellaneous Chores

* **runtime:** upgrade Bun to 1.4.0 ([a1e4178](https://github.com/vibeunion/supacloud/commit/a1e4178c6a02127e4b71b0976d0f34a5a7940061))

## [0.18.4](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.18.3...edge-runtime-v0.18.4) (2026-08-19)


### Bug Fixes

* **edge-runtime:** pass canonical path to module loader to avoid descriptor collision ([ef636d3](https://github.com/vibeunion/supacloud/commit/ef636d39710187793b37c0dd21899c16dd979dda))

## [0.18.3](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.18.2...edge-runtime-v0.18.3) (2026-08-18)


### Bug Fixes

* resolve all GitHub Code Quality findings ([#952](https://github.com/vibeunion/supacloud/issues/952)) ([df0fb0c](https://github.com/vibeunion/supacloud/commit/df0fb0c53eb9a6424565bf39f1ce2f00ace429f1))

## [0.18.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.18.1...edge-runtime-v0.18.2) (2026-08-12)


### Bug Fixes

* **edge-runtime:** enforce activation artifact integrity ([#887](https://github.com/zuohuadong/supacloud/issues/887)) ([5a0375e](https://github.com/zuohuadong/supacloud/commit/5a0375ee348a954beb5100b05f6c5c89e43486ec))

## [0.18.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.18.0...edge-runtime-v0.18.1) (2026-08-12)


### Bug Fixes

* **edge:** isolate Bun plugins by project ([#873](https://github.com/zuohuadong/supacloud/issues/873)) ([93fa627](https://github.com/zuohuadong/supacloud/commit/93fa62768f2fed69ea42546564b3a9218e66feda))

## [0.18.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.17.1...edge-runtime-v0.18.0) (2026-08-12)


### Features

* **runtime:** attest canonical activations ([#868](https://github.com/zuohuadong/supacloud/issues/868)) ([636433e](https://github.com/zuohuadong/supacloud/commit/636433e1dbaaac04ae8d842d858b647a1667b0ce))

## [0.17.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.17.0...edge-runtime-v0.17.1) (2026-08-11)


### Bug Fixes

* **edge-runtime:** fail closed after artifact realpath ([#846](https://github.com/zuohuadong/supacloud/issues/846)) ([09ade5c](https://github.com/zuohuadong/supacloud/commit/09ade5c86b9c41098b44461d59fff7229c73ae04))

## [0.17.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.9...edge-runtime-v0.17.0) (2026-08-11)


### Features

* **edge-runtime:** return resolved function versions ([#844](https://github.com/zuohuadong/supacloud/issues/844)) ([b8b533f](https://github.com/zuohuadong/supacloud/commit/b8b533fca4ca727a7f7b51aee5168a61af3bc8fc))


### Bug Fixes

* **edge-runtime:** bind artifacts to activation roots ([#845](https://github.com/zuohuadong/supacloud/issues/845)) ([4f5835e](https://github.com/zuohuadong/supacloud/commit/4f5835ed261c998b17afbe96ed2dceb4cde3ddb5))

## [0.16.9](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.8...edge-runtime-v0.16.9) (2026-08-10)


### Bug Fixes

* **edge-runtime:** handle version CLI safely ([#784](https://github.com/zuohuadong/supacloud/issues/784)) ([9a84e8d](https://github.com/zuohuadong/supacloud/commit/9a84e8d0ec9a3496b5503fc23ea969fd4d2fb153))

## [0.16.8](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.7...edge-runtime-v0.16.8) (2026-08-10)


### Bug Fixes

* **upgrade:** add verified offline release bundles ([#773](https://github.com/zuohuadong/supacloud/issues/773)) ([e87331e](https://github.com/zuohuadong/supacloud/commit/e87331eab943f341edebc972c4d8c1f2b7294073))

## [0.16.7](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.6...edge-runtime-v0.16.7) (2026-08-10)


### Bug Fixes

* **edge-functions:** align CLI bundles with runtime policy ([#745](https://github.com/zuohuadong/supacloud/issues/745)) ([1ee2f94](https://github.com/zuohuadong/supacloud/commit/1ee2f94752efb0855a1528bd0049c733ae4cc6e5))

## [0.16.6](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.5...edge-runtime-v0.16.6) (2026-08-09)


### Bug Fixes

* **edge-runtime:** bound memory across function activations ([#741](https://github.com/zuohuadong/supacloud/issues/741)) ([7711f66](https://github.com/zuohuadong/supacloud/commit/7711f66aa11f50997449931145819f592c118ee3))


### Miscellaneous Chores

* **deps:** bump @supabase/supabase-js from 2.110.9 to 2.112.0 in /packages/edge-runtime ([1b351e2](https://github.com/zuohuadong/supacloud/commit/1b351e26e5ae401c1e1877324d2ca4ba9d97534c))
* **deps:** bump jose from 6.2.4 to 6.2.8 in /packages/edge-runtime ([f94b2c9](https://github.com/zuohuadong/supacloud/commit/f94b2c99a7b4430491ee0eef557936c2a485840f))
* **deps:** upgrade dependencies and remove svadmin patch ([6215cb7](https://github.com/zuohuadong/supacloud/commit/6215cb7091a4d0f3dbca754984931fb5aa0e2181))

## [0.16.5](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.4...edge-runtime-v0.16.5) (2026-08-04)


### Bug Fixes

* **edge-runtime:** fail closed function activation ([672a5f8](https://github.com/zuohuadong/supacloud/commit/672a5f82d31d26fb9d7dcb61d6f5d62a7dd9c821))
* **edge-runtime:** fail closed function activation ([699c81f](https://github.com/zuohuadong/supacloud/commit/699c81fd36503c82dd2b7dacc7fffac54cacf050))
* **functions:** activate code and jwt policy atomically ([447bbf5](https://github.com/zuohuadong/supacloud/commit/447bbf5e1f44651bfb790e54af502a7536b4a52c))
* **functions:** activate code and JWT policy atomically ([c6c5fa9](https://github.com/zuohuadong/supacloud/commit/c6c5fa95aeea7dd09a53de196a98a540622a6d59))

## [0.16.4](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.3...edge-runtime-v0.16.4) (2026-08-03)


### Bug Fixes

* **functions:** fail closed on activation readiness ([78af76b](https://github.com/zuohuadong/supacloud/commit/78af76bb07887bc54f6d3a0ac09407d7e95b3bce))
* **functions:** fail closed on activation readiness ([72424ee](https://github.com/zuohuadong/supacloud/commit/72424ee716549fd8f12c5b3c45b6f76ad41b175e))

## [0.16.3](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.2...edge-runtime-v0.16.3) (2026-08-03)


### Bug Fixes

* **edge-runtime:** allow guarded builtin CJS imports ([2a6c04d](https://github.com/zuohuadong/supacloud/commit/2a6c04d2a0bb0b56b04cb30dc041415ea2924f08))
* **edge-runtime:** allow guarded builtin CJS imports ([de3197d](https://github.com/zuohuadong/supacloud/commit/de3197d48adb7b85cef96bdcc9f4829d3e9ecf98))
* **edge-runtime:** allow guarded uv binding for net ([fc80f03](https://github.com/zuohuadong/supacloud/commit/fc80f032af1437c2926ae476650a0b82c60548bf))
* **edge-runtime:** allow guarded uv binding for net ([1abd4c5](https://github.com/zuohuadong/supacloud/commit/1abd4c5cc65f8dddd7a20d753d5796092d69dc79))

## [0.16.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.1...edge-runtime-v0.16.2) (2026-08-02)


### Bug Fixes

* address release-blocking review findings ([0154fdb](https://github.com/zuohuadong/supacloud/commit/0154fdbab758c9d9c6a80fb877b15848a5ace5df))
* **edge-runtime:** close dynamic import sandbox escapes ([#670](https://github.com/zuohuadong/supacloud/issues/670)) ([a935126](https://github.com/zuohuadong/supacloud/commit/a935126488eb021cd7f5d4fe58163160eb5f6686))


### Miscellaneous Chores

* **deps-dev:** bump @types/node from 26.1.1 to 26.1.2 in /packages/edge-runtime ([96c8900](https://github.com/zuohuadong/supacloud/commit/96c8900908839dd3532af924f584156da2faf7a6))

## [0.16.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.16.0...edge-runtime-v0.16.1) (2026-07-28)


### Bug Fixes

* **edge-runtime:** preserve listener ownership ([71ce079](https://github.com/zuohuadong/supacloud/commit/71ce079729fc9141bdb783d22c6b9ff5e39db0fd))

## [0.16.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.15.0...edge-runtime-v0.16.0) (2026-07-28)


### Features

* extend Supabase-compatible platform capabilities ([adef019](https://github.com/zuohuadong/supacloud/commit/adef019261f82f123043ab4c7a047e6ad6956e56))

## [0.15.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.14.3...edge-runtime-v0.15.0) (2026-07-27)


### Features

* add PostgreSQL cache data plane runtime ([f0c19f4](https://github.com/zuohuadong/supacloud/commit/f0c19f4f870bd0b26d453a67b8af76d609c53d64))

## [0.14.3](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.14.2...edge-runtime-v0.14.3) (2026-07-27)


### Bug Fixes

* **edge-runtime:** fairly schedule queued projects ([#580](https://github.com/zuohuadong/supacloud/issues/580)) ([e122747](https://github.com/zuohuadong/supacloud/commit/e12274770e67f7183a614960e5a173b0ca3481aa))

## [0.14.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.14.1...edge-runtime-v0.14.2) (2026-07-24)


### Miscellaneous Chores

* **deps:** bump @supabase/supabase-js in /packages/edge-runtime ([#566](https://github.com/zuohuadong/supacloud/issues/566)) ([332843f](https://github.com/zuohuadong/supacloud/commit/332843f6dc9647769672a78bbd3930ff3252db09))

## [0.14.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.14.0...edge-runtime-v0.14.1) (2026-07-23)


### Bug Fixes

* **edge-runtime:** execute multi-file bundles from source dir ([#543](https://github.com/zuohuadong/supacloud/issues/543)) ([bc7d427](https://github.com/zuohuadong/supacloud/commit/bc7d427885abf8ca867740828aa6e5f09e18259a))

## [0.14.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.13.2...edge-runtime-v0.14.0) (2026-07-20)


### Features

* **auth:** complete GoTrue platform controls ([5e5483e](https://github.com/zuohuadong/supacloud/commit/5e5483e91420ba240814cf7c85787c1cdebd7453))
* **auth:** complete GoTrue platform controls ([bc71998](https://github.com/zuohuadong/supacloud/commit/bc719989a5e28381f73a069df3d9fc03ca124bd3))

## [0.13.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.13.1...edge-runtime-v0.13.2) (2026-07-19)


### Bug Fixes

* **edge-runtime:** retire workers without unsafe termination ([#490](https://github.com/zuohuadong/supacloud/issues/490)) ([61706da](https://github.com/zuohuadong/supacloud/commit/61706da0d0a7782c2c7a2df263e7f9bc3b73bc74))

## [0.13.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.13.0...edge-runtime-v0.13.1) (2026-07-19)


### Bug Fixes

* **edge-runtime:** release workers after proxy disconnects ([#488](https://github.com/zuohuadong/supacloud/issues/488)) ([0188d07](https://github.com/zuohuadong/supacloud/commit/0188d07cb720c6ef48be224fac6133cfc8f75478))

## [0.13.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.12.2...edge-runtime-v0.13.0) (2026-07-19)


### Features

* complete safe database promotion workflow ([6763d10](https://github.com/zuohuadong/supacloud/commit/6763d10eb4e6b715259a1e445c5921dc276d6dfd))
* improve frontend hosting and console experience ([dc8422c](https://github.com/zuohuadong/supacloud/commit/dc8422c1c15be3c01b73ddb90d12b835c674880f))

## [0.12.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.12.1...edge-runtime-v0.12.2) (2026-07-18)


### Bug Fixes

* **edge:** fail closed shared JWT verification ([5b5df99](https://github.com/zuohuadong/supacloud/commit/5b5df991ecf5da446af9c9dae462d34c7cc285db))

## [0.12.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.12.0...edge-runtime-v0.12.1) (2026-07-17)


### Bug Fixes

* **auth:** close SupAuth shared runtime boundary gaps ([#477](https://github.com/zuohuadong/supacloud/issues/477)) ([14d1d64](https://github.com/zuohuadong/supacloud/commit/14d1d64b1ae05fd9c9c8390d318d9d3a97c6ced6))

## [0.12.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.11.1...edge-runtime-v0.12.0) (2026-07-17)


### Features

* **auth:** enforce SupAuth shared runtime boundaries ([aca9d67](https://github.com/zuohuadong/supacloud/commit/aca9d6756a550d43b06b9c1c0b3ec9a3e1cdd324))
* **auth:** enforce SupAuth shared runtime boundaries ([285a9f5](https://github.com/zuohuadong/supacloud/commit/285a9f5053125e8ad774c12824c829863b450dc4))

## [0.11.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.11.0...edge-runtime-v0.11.1) (2026-07-17)


### Bug Fixes

* **auth:** isolate third-party JWT verification ([#467](https://github.com/zuohuadong/supacloud/issues/467)) ([c7dae36](https://github.com/zuohuadong/supacloud/commit/c7dae365b64bb6dd258c6a14eba3c936a636e6c0))

## [0.11.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.10.3...edge-runtime-v0.11.0) (2026-07-17)


### Features

* **edge-runtime:** expose verified JWT subject ([0ba132b](https://github.com/zuohuadong/supacloud/commit/0ba132b99b057a1e682a3a551188cfc45dc25dcb))
* **edge-runtime:** expose verified JWT subject ([a8ed1ec](https://github.com/zuohuadong/supacloud/commit/a8ed1ecdb10def651f632f6d38a917e7b565fc61))

## [0.10.3](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.10.2...edge-runtime-v0.10.3) (2026-07-17)


### Miscellaneous Chores

* **deps:** bump @sinclair/typebox in /packages/edge-runtime ([97abb11](https://github.com/zuohuadong/supacloud/commit/97abb113ea083ec02c89afb71e2fb797577f36b9))
* **deps:** bump @supabase/supabase-js in /packages/edge-runtime ([fe46650](https://github.com/zuohuadong/supacloud/commit/fe46650b83f05a074abbf8f1c6ff395ac8715e0b))

## [0.10.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.10.1...edge-runtime-v0.10.2) (2026-07-15)


### Bug Fixes

* **management-api:** support Pigsty 4.4 production compatibility ([d8f6959](https://github.com/zuohuadong/supacloud/commit/d8f6959623e6f09e0e665e3353d56fd7fdbab6de))

## [0.10.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.10.0...edge-runtime-v0.10.1) (2026-07-11)


### Miscellaneous Chores

* **deps-dev:** bump typescript in /packages/edge-runtime ([#415](https://github.com/zuohuadong/supacloud/issues/415)) ([8865cd8](https://github.com/zuohuadong/supacloud/commit/8865cd8726f5d9c33fb50e233e4e914292013d64))
* **deps:** bump @sinclair/typebox in /packages/edge-runtime ([#426](https://github.com/zuohuadong/supacloud/issues/426)) ([5a92b48](https://github.com/zuohuadong/supacloud/commit/5a92b48dad07a31aa72d48ba2430c036d172325a))
* **deps:** bump @supabase/supabase-js to 2.110.2 and @tanstack/svelte-query to 6.1.36 ([71c4509](https://github.com/zuohuadong/supacloud/commit/71c4509aaee739bf8a395ab1a9d71d477245f9ec))

## [0.10.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.9.0...edge-runtime-v0.10.0) (2026-07-11)


### Features

* security hardening, idempotent install, and CI reliability fixes ([eb15db0](https://github.com/zuohuadong/supacloud/commit/eb15db0e58b8b2a2d19e4e99d92360a33da116a4))

## [0.9.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.8...edge-runtime-v0.9.0) (2026-07-02)


### Features

* **edge-runtime:** optimize function preheat and bundle metadata ([eb4f305](https://github.com/zuohuadong/supacloud/commit/eb4f305ce77041e21f4e71c1166b4ddd33f6d81b))

## [0.8.8](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.7...edge-runtime-v0.8.8) (2026-06-30)


### Bug Fixes

* **edge-runtime:** inject tenant-local PostgREST REST URL ([#397](https://github.com/zuohuadong/supacloud/issues/397)) ([e1ad57e](https://github.com/zuohuadong/supacloud/commit/e1ad57e78038a028c268f0a79d9784daac574b08))

## [0.8.7](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.6...edge-runtime-v0.8.7) (2026-06-19)


### Bug Fixes

* **edge-runtime:** embed worker executor in compiled binary ([#337](https://github.com/zuohuadong/supacloud/issues/337)) ([cfe9e86](https://github.com/zuohuadong/supacloud/commit/cfe9e8628bdf0d5981eb2f33b119dce130b18872))

## [0.8.6](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.5...edge-runtime-v0.8.6) (2026-06-19)


### Miscellaneous Chores

* **deps-dev:** bump @types/node in /packages/edge-runtime ([#331](https://github.com/zuohuadong/supacloud/issues/331)) ([72e3193](https://github.com/zuohuadong/supacloud/commit/72e3193ce6aea452e504a7d26f8b40ddd260c981))

## [0.8.5](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.4...edge-runtime-v0.8.5) (2026-06-08)


### Bug Fixes

* **edge-runtime:** make request body limit configurable ([3d08370](https://github.com/zuohuadong/supacloud/commit/3d08370ada5188d9c11b639b973ed3736ea04a02))

## [0.8.4](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.3...edge-runtime-v0.8.4) (2026-06-05)


### Bug Fixes

* **ci:** pin Bun runtime to 1.3.14 ([03304e8](https://github.com/zuohuadong/supacloud/commit/03304e821eeab32849004c623af34b3c96bee0ce))

## [0.8.3](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.2...edge-runtime-v0.8.3) (2026-06-03)


### Bug Fixes

* **edge-runtime:** pass TLS policy into smol workers ([b9ce395](https://github.com/zuohuadong/supacloud/commit/b9ce39556e9f881537274bd39a14de7df644706a))

## [0.8.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.1...edge-runtime-v0.8.2) (2026-06-03)


### Bug Fixes

* **edge-runtime:** support custom TLS trust for function fetch ([#262](https://github.com/zuohuadong/supacloud/issues/262)) ([8488688](https://github.com/zuohuadong/supacloud/commit/8488688c73dd475792a8c8e7409d8b8ed2653d57))


### Miscellaneous Chores

* upgrade all dependencies to latest minor ([e9719d9](https://github.com/zuohuadong/supacloud/commit/e9719d983c9303c783ddcd3d772c7e7c56e985b9))

## [0.8.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.8.0...edge-runtime-v0.8.1) (2026-05-29)


### Miscellaneous Chores

* **deps:** mark setup-buildx-action v4 PR merged ([e0cadc5](https://github.com/zuohuadong/supacloud/commit/e0cadc5fa00711c15b4d37a8ccf16ea7a7adbe24))

## [0.8.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.7.2...edge-runtime-v0.8.0) (2026-05-26)


### Features

* add caddy frontend optimization pipeline ([71c5f2f](https://github.com/zuohuadong/supacloud/commit/71c5f2f933acbbfa6347bfd815d6da280a57c5eb))

## [0.7.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.7.1...edge-runtime-v0.7.2) (2026-05-26)


### Bug Fixes

* **edge-runtime:** tolerate missing functions directory ([ec3cbad](https://github.com/zuohuadong/supacloud/commit/ec3cbadf7080903d26c4e843f6d4f2da90ff3cd2))

## [0.7.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.7.0...edge-runtime-v0.7.1) (2026-05-26)


### Bug Fixes

* cap background queue control-plane pressure ([ac1c62f](https://github.com/zuohuadong/supacloud/commit/ac1c62f3784af66bb8a1a69c4f7ddbb3c83a0097))

## [0.7.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.6.4...edge-runtime-v0.7.0) (2026-05-25)


### Features

* add LISTEN/NOTIFY wakeups to background worker and fix storage mimetype ([72f91c9](https://github.com/zuohuadong/supacloud/commit/72f91c9e778b0ea6c9d9161d282f6b71a018e45e))

## [0.6.4](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.6.3...edge-runtime-v0.6.4) (2026-05-24)


### Bug Fixes

* add management-api.env to frontend systemd unit template ([93299eb](https://github.com/zuohuadong/supacloud/commit/93299eba1dbecd4c706054c29e2aa93015b5fba9))

## [0.6.3](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.6.2...edge-runtime-v0.6.3) (2026-05-24)


### Bug Fixes

* separate platform mirror table, invoker circuit breaker, WorkerPool NaN metrics ([#177](https://github.com/zuohuadong/supacloud/issues/177)) ([2b31821](https://github.com/zuohuadong/supacloud/commit/2b31821d83276f73af9b6267e32fcdef2c098784))

## [0.6.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.6.1...edge-runtime-v0.6.2) (2026-05-23)


### Bug Fixes

* **edge-runtime:** preserve background invocation auth ([#174](https://github.com/zuohuadong/supacloud/issues/174)) ([da8f2b2](https://github.com/zuohuadong/supacloud/commit/da8f2b23c2d9b5cd6c5fae07d1117d44e193f89b))

## [0.6.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.6.0...edge-runtime-v0.6.1) (2026-05-23)


### Bug Fixes

* pass background auth token to edge functions ([eee1e9a](https://github.com/zuohuadong/supacloud/commit/eee1e9a9d42e7ef91c51e7a88db40c2480eaf9cb))

## [0.6.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.5.2...edge-runtime-v0.6.0) (2026-05-20)


### Features

* add diagnostics and oauth jwks support ([96e619a](https://github.com/zuohuadong/supacloud/commit/96e619a532f5f16b4b0d08ed9662bc6c6053dbb2))

## [0.5.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.5.1...edge-runtime-v0.5.2) (2026-05-20)


### Bug Fixes

* **edge-runtime:** load worker entry from deploy directory ([a3fa1e7](https://github.com/zuohuadong/supacloud/commit/a3fa1e74a41b73edb17eacb66080c020446158c1))

## [0.5.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.5.0...edge-runtime-v0.5.1) (2026-05-19)


### Bug Fixes

* **edge-runtime:** tolerate runtime env version skew ([6e19758](https://github.com/zuohuadong/supacloud/commit/6e19758f3370c683ed5d1e8a71f696c42555f150))

## [0.5.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.4.1...edge-runtime-v0.5.0) (2026-05-16)


### Features

* **core:** Native Supabase compatibility fixes for Realtime, Storage RLS, and Edge Functions ([8a76cf8](https://github.com/zuohuadong/supacloud/commit/8a76cf87e05a01db81c1e037eefb9d6a3419c6dc))
* **edge-functions:** implement per-function verify_jwt configuration ([7dcddf1](https://github.com/zuohuadong/supacloud/commit/7dcddf1a80c40f3023e38af9e7ed2d4ff5e14c22))
* **edge-runtime:** add jsr/npm import matching and expand Deno std lib shims ([e4be6ae](https://github.com/zuohuadong/supacloud/commit/e4be6ae629032476e7485ce81b3f0fa26a93c55d))
* **platform:** massive stabilization update across edge-runtime, mcp, routing, and sdk-proxy compatibility ([a94d84f](https://github.com/zuohuadong/supacloud/commit/a94d84f056714eff210739ef0cef3da7f0b5f0be))
* **tasks:** deploy background task and message queue features to servers ([83d9062](https://github.com/zuohuadong/supacloud/commit/83d90626df765c99a96b5d93ed103e4452a5db4d))
* updates and fixes based on recent local changes ([79940f4](https://github.com/zuohuadong/supacloud/commit/79940f47578d4db4f4f133c08645d0c635c71a8d))


### Bug Fixes

* add function invoke route, repair stale projects, web-console deployment ([7cf073b](https://github.com/zuohuadong/supacloud/commit/7cf073b2b31cf2cf814fd2e5dcffbf55cc9fc224))
* **auth,infra:** 401 pre-flight and all-in-one local docker ([e201d45](https://github.com/zuohuadong/supacloud/commit/e201d458280e084837c3d690c6296ed3f4545598))
* **ci:** normalize release changelog headings ([63f3f4d](https://github.com/zuohuadong/supacloud/commit/63f3f4d37c951f7493cada1cd09e37dfa7eb19ca))
* **ci:** use ascii release notes sections ([2fde822](https://github.com/zuohuadong/supacloud/commit/2fde8225e9a01077e09308c88dd982e81368c90e))
* **edge-runtime:** add missing jose dependency ([f611c8a](https://github.com/zuohuadong/supacloud/commit/f611c8aeede400dee11616efbc843893dd01343e))
* **edge-runtime:** add stripped path routing fallbacks to support Kong strip_path: true ([4885310](https://github.com/zuohuadong/supacloud/commit/48853108fdf1db3f57418531045999ff783602d4))
* **edge-runtime:** avoid double-managed runtime restarts ([ff3c82c](https://github.com/zuohuadong/supacloud/commit/ff3c82c4f9f96f51eeec6411b8351d61743445b1))
* **edge-runtime:** bust Bun import() cache on function redeploy ([323e0b7](https://github.com/zuohuadong/supacloud/commit/323e0b7c1f3b0717409282078cc99d09c17f97b3))
* **edge-runtime:** bypass verifyJwt for CORS preflight OPTIONS requests to prevent 401 errors ([c1f2164](https://github.com/zuohuadong/supacloud/commit/c1f21643b9337919699d605c5f4e0dfc8e99f934))
* **edge-runtime:** cache project secrets to prevent DOMException TimeoutError under load and accept apikey header ([0b1a74b](https://github.com/zuohuadong/supacloud/commit/0b1a74bc767a08375993e0c66c50c27a730f7dac))
* **edge-runtime:** exact ipv4 binding for localhost healthchecks ([0fcd47a](https://github.com/zuohuadong/supacloud/commit/0fcd47a4e4bdfb6ee145d9ef07550eeca8eb20aa))
* **edge-runtime:** inject Bun function env ([63656e1](https://github.com/zuohuadong/supacloud/commit/63656e107850628d5fa03cde5f1d3432974755d3))
* **edge-runtime:** normalize fallback tenant env ([00757b2](https://github.com/zuohuadong/supacloud/commit/00757b2086bc12a18de6ab9c54e736f572a1bed2))
* **edge-runtime:** normalize fallback tenant env ([1ac8e95](https://github.com/zuohuadong/supacloud/commit/1ac8e954ad11f1e2340271986bb523058e991d28))
* **edge-runtime:** preserve env for waitUntil tasks ([d72cacc](https://github.com/zuohuadong/supacloud/commit/d72cacc3cffb59cc89af97ce6412f21c2cd82a98))
* **edge-runtime:** preserve env for waitUntil tasks ([2a0f33e](https://github.com/zuohuadong/supacloud/commit/2a0f33ecd17874047c25400aafd7f4d4c9788a6f))
* **edge-runtime:** reject masked runtime secrets ([ef05aa0](https://github.com/zuohuadong/supacloud/commit/ef05aa07750c467fb4b437104ff42e3d60205d39))
* **edge-runtime:** remove suicidal killStaleListeners to break restart loop ([7cb53ca](https://github.com/zuohuadong/supacloud/commit/7cb53cacce75732df67e30b0c92d022710aad272))
* **edge-runtime:** use EDGE_RUNTIME_PORT to avoid port conflict with management API ([73d6a24](https://github.com/zuohuadong/supacloud/commit/73d6a2495377467f1e80c70ee896b43cebe0120a))
* explicit @sinclair/typebox dependency to prevent elysia/edge-runtime crash during CI e2e tests proxy boot ([1d38a09](https://github.com/zuohuadong/supacloud/commit/1d38a095904ac29d0cc120b945cd1366a41b3c0d))
* harden realtime tasks and data-plane boundaries ([c830dc5](https://github.com/zuohuadong/supacloud/commit/c830dc5f9b7b1f7721412864765e6ae1f1dd4a01))
* improve one-click install robustness and compile edge-runtime as standalone binary ([7fcc5c1](https://github.com/zuohuadong/supacloud/commit/7fcc5c15ffd076387d712d9a347a6f59e6640d4f))
* improve one-click install robustness and compile edge-runtime binary ([9686a2f](https://github.com/zuohuadong/supacloud/commit/9686a2fd25a600385c90adde6630950bb773aa61))
* improve one-click install robustness, add function invoke route, repair stale projects ([acf3365](https://github.com/zuohuadong/supacloud/commit/acf3365c6ee6b4c1fc490ab0eac216e861ff2101))
* **runtime:** respect ssl config for tenant urls ([bbfa23e](https://github.com/zuohuadong/supacloud/commit/bbfa23e4c004f86f5cf75d7d248a274c95a54e3f))
* **runtime:** respect ssl config for tenant urls ([ce976fe](https://github.com/zuohuadong/supacloud/commit/ce976fe825bc775501d65b8a7bc6291466ec840d))


### Elegance & Refactoring

* **edge-functions:** migrate version artifacts into internal revisions ([0eae21c](https://github.com/zuohuadong/supacloud/commit/0eae21c3b7577fe01c403bf5a54d458099fe362d))
* **edge-runtime:** replace query-param hack with Worker replacement for module invalidation ([e279883](https://github.com/zuohuadong/supacloud/commit/e279883e5fbb32c70c0a68864522024137e32bb6))


### Miscellaneous Chores

* better jwt error logging ([ce49953](https://github.com/zuohuadong/supacloud/commit/ce499535f585e402eee979343a801698025caa3c))
* flush remaining test suite fixes and project modifications ([e1b625c](https://github.com/zuohuadong/supacloud/commit/e1b625c707b304f753ebbbd466ddb0046cdfd740))
* push all accumulated compliance and runtime integrations ([4cb93dd](https://github.com/zuohuadong/supacloud/commit/4cb93dd0a1d21bd0ecdd32a2751fe57fd4374355))
* release main ([0ad39c2](https://github.com/zuohuadong/supacloud/commit/0ad39c25703950b1fbafe492d148dc10fd95cd8c))
* release main ([2a4e9fa](https://github.com/zuohuadong/supacloud/commit/2a4e9fa0c8dd368baf844420e5b216ebbdb87828))
* release main ([a74e431](https://github.com/zuohuadong/supacloud/commit/a74e431e8782208d969b51b4db797fe4f1ba158a))
* release main ([5592191](https://github.com/zuohuadong/supacloud/commit/55921916298238fda51026ba66ff10469c012da3))
* release main ([a0c1c3e](https://github.com/zuohuadong/supacloud/commit/a0c1c3e6d098ac1e789b5495faa1b91faae238c0))
* release main ([44cace4](https://github.com/zuohuadong/supacloud/commit/44cace4ff79f412dab23780e0d155a8ff46d2b3d))
* release main ([9c4b4ab](https://github.com/zuohuadong/supacloud/commit/9c4b4ab4e0776bc6f0929d2a2b1d008c7b3a4701))
* release main ([94f669a](https://github.com/zuohuadong/supacloud/commit/94f669a68c88b2ef6c09e53e5812a36e82ffdf20))
* release main ([510d73c](https://github.com/zuohuadong/supacloud/commit/510d73c6b77e815e1210a7a2bdcd999f5f80226e))
* release main ([5876a87](https://github.com/zuohuadong/supacloud/commit/5876a87aa04c79d8a23d73e39b9cec108963cae1))
* release main ([010fefe](https://github.com/zuohuadong/supacloud/commit/010fefe044a1165c16591e10e74613898c5a96de))
* release main ([cc6432a](https://github.com/zuohuadong/supacloud/commit/cc6432aa987f17b011e357584816945cf80ec533))
* release main ([58b455a](https://github.com/zuohuadong/supacloud/commit/58b455a45ffa22c638ec2c1aa59292096b0014cb))
* release main ([7180516](https://github.com/zuohuadong/supacloud/commit/71805164f96869842f27919373521d88f5a4a341))
* release main ([77cbf82](https://github.com/zuohuadong/supacloud/commit/77cbf824d2120f59af592ce44300f587c2657913))
* release main ([03a4bfa](https://github.com/zuohuadong/supacloud/commit/03a4bfa21a066aa0ce52b1c14e4cf5daa7f3057d))
* release main ([d2757c8](https://github.com/zuohuadong/supacloud/commit/d2757c800d0f8116bd484e307adf8390e2aba9da))
* release main ([eb82b4d](https://github.com/zuohuadong/supacloud/commit/eb82b4dc38dc4e00401a259030b007ce3d986272))
* release main ([647e652](https://github.com/zuohuadong/supacloud/commit/647e6524e435d72c08f64723783da224498507b8))
* release main ([f5d59fe](https://github.com/zuohuadong/supacloud/commit/f5d59fe86049a71a7010627756ec41037ebeaca6))
* release main ([549c0fd](https://github.com/zuohuadong/supacloud/commit/549c0fd4df7bb2ed1d8aa4e25dfda17e3f093cf9))
* release main ([79c9288](https://github.com/zuohuadong/supacloud/commit/79c92889c99db9d8bcada29e8d521050a7dc4f93))
* release main ([59ea7a6](https://github.com/zuohuadong/supacloud/commit/59ea7a61481821d2265a679dd2785eafe204ae95))
* release main ([fbd5548](https://github.com/zuohuadong/supacloud/commit/fbd554816e5e519b3a3c3310e6096a71c92ba2fa))
* release main ([11c5eb1](https://github.com/zuohuadong/supacloud/commit/11c5eb1f6f488c3a3ef02ca531e3556ba635ed17))
* release main ([d0c6b59](https://github.com/zuohuadong/supacloud/commit/d0c6b59815aa11ae90b15ec79af3b3e3bfadbdd4))
* release main ([#113](https://github.com/zuohuadong/supacloud/issues/113)) ([3c98a4c](https://github.com/zuohuadong/supacloud/commit/3c98a4c9353f5d53ad1517e4e56a779cece4aded))
* release main ([#114](https://github.com/zuohuadong/supacloud/issues/114)) ([02b89e6](https://github.com/zuohuadong/supacloud/commit/02b89e6d9d1ff7ac85148342415d3f6ae9277fd8))
* **systemd:** add canonical service templates ([2c3e629](https://github.com/zuohuadong/supacloud/commit/2c3e6299d6b22a36f7eb826d53d36567c47be1e5))

## [0.4.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.4.0...edge-runtime-v0.4.1) (2026-05-15)


### Bug Fixes

* **ci:** normalize release changelog headings ([a446d69](https://github.com/zuohuadong/supacloud/commit/a446d692c12257753da8603617c3313982a56f87))
* **ci:** use ascii release notes sections ([fc1e24c](https://github.com/zuohuadong/supacloud/commit/fc1e24cc6e549da308a9d312b918eefbc1e9b418))

## [0.4.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.9...edge-runtime-v0.4.0) (2026-05-15)


### Features

* **core:** Native Supabase compatibility fixes for Realtime, Storage RLS, and Edge Functions ([fd83e88](https://github.com/zuohuadong/supacloud/commit/fd83e88a67ec1736c1066707a7a2d3b9692a0f4b))
* **edge-functions:** implement per-function verify_jwt configuration ([adf6746](https://github.com/zuohuadong/supacloud/commit/adf67468b4ccb225aaf3dc50e0fd0bf2f10cb304))
* **edge-runtime:** add jsr/npm import matching and expand Deno std lib shims ([94e3b78](https://github.com/zuohuadong/supacloud/commit/94e3b786511b52dffbe9dcfe9c5e67f60fa012fe))
* **platform:** massive stabilization update across edge-runtime, mcp, routing, and sdk-proxy compatibility ([bcb15e1](https://github.com/zuohuadong/supacloud/commit/bcb15e17cb0da13e1ba930999d777b2457e56d5d))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([f780e45](https://github.com/zuohuadong/supacloud/commit/f780e454c735fa81be08c9d122cd69d2907b8338))
* **tasks:** deploy background task and message queue features to servers ([dc85b34](https://github.com/zuohuadong/supacloud/commit/dc85b340db81f0866195b51d1aaeb81731b0824a))
* updates and fixes based on recent local changes ([fe495ba](https://github.com/zuohuadong/supacloud/commit/fe495baf4c7be6b469eb245a8c2bc62503f09a8e))


### Bug Fixes

* add function invoke route, repair stale projects, web-console deployment ([3ed37ee](https://github.com/zuohuadong/supacloud/commit/3ed37ee7825fa060ca9ac11dab9ada16b923ddb8))
* **auth,infra:** 401 pre-flight and all-in-one local docker ([bc0a047](https://github.com/zuohuadong/supacloud/commit/bc0a0473cc7c580750a0af717502f15a01039a8f))
* **edge-runtime:** add missing jose dependency ([484da2f](https://github.com/zuohuadong/supacloud/commit/484da2fc842d5a94d8d2e2526b90c87b91abf8b7))
* **edge-runtime:** add stripped path routing fallbacks to support Kong strip_path: true ([330f96e](https://github.com/zuohuadong/supacloud/commit/330f96e1af59d1e09926c2af68721b047f997263))
* **edge-runtime:** avoid double-managed runtime restarts ([bc6b664](https://github.com/zuohuadong/supacloud/commit/bc6b6646903ef2bd48038b7a8a1a968ec4c3b503))
* **edge-runtime:** bust Bun import() cache on function redeploy ([0300772](https://github.com/zuohuadong/supacloud/commit/0300772657d6e8cc75b53ebbc4bf0e01c34e7996))
* **edge-runtime:** bypass verifyJwt for CORS preflight OPTIONS requests to prevent 401 errors ([ea26fe0](https://github.com/zuohuadong/supacloud/commit/ea26fe0344e083cac90b8c9c9354178537053552))
* **edge-runtime:** cache project secrets to prevent DOMException TimeoutError under load and accept apikey header ([c76a60e](https://github.com/zuohuadong/supacloud/commit/c76a60e957ef3a06a1247ba768f5ea1ddd874279))
* **edge-runtime:** exact ipv4 binding for localhost healthchecks ([fa80572](https://github.com/zuohuadong/supacloud/commit/fa80572d0ab7eb16e5c9c87d57ab8f08d3b6ea91))
* **edge-runtime:** inject Bun function env ([66b7266](https://github.com/zuohuadong/supacloud/commit/66b7266344177b96abcd7452fe5fa31195a922d6))
* **edge-runtime:** normalize fallback tenant env ([827a658](https://github.com/zuohuadong/supacloud/commit/827a65868e9030c79c3de7bdf8af03228027642a))
* **edge-runtime:** normalize fallback tenant env ([fc5c2d5](https://github.com/zuohuadong/supacloud/commit/fc5c2d53969ad7c47a50c5134b2001bea15a2c7b))
* **edge-runtime:** preserve env for waitUntil tasks ([f5ab3a4](https://github.com/zuohuadong/supacloud/commit/f5ab3a42a382ee77460fca569df9527b68da2b3e))
* **edge-runtime:** preserve env for waitUntil tasks ([cba4f62](https://github.com/zuohuadong/supacloud/commit/cba4f62a50cdda1b33e8a3cdc2bbab09889f7549))
* **edge-runtime:** reject masked runtime secrets ([eabe0e8](https://github.com/zuohuadong/supacloud/commit/eabe0e8658d156c18f1f835901b5e2114a2814af))
* **edge-runtime:** remove suicidal killStaleListeners to break restart loop ([e3576ae](https://github.com/zuohuadong/supacloud/commit/e3576aefbcb5d9be69372e43de0b97e9774a41ed))
* **edge-runtime:** use EDGE_RUNTIME_PORT to avoid port conflict with management API ([fee5c80](https://github.com/zuohuadong/supacloud/commit/fee5c80cd000daa59247a8389d3a686f0d74ed2a))
* explicit @sinclair/typebox dependency to prevent elysia/edge-runtime crash during CI e2e tests proxy boot ([a4e4833](https://github.com/zuohuadong/supacloud/commit/a4e48334eff5692af16e51b4554c4753dbd550ee))
* harden realtime tasks and data-plane boundaries ([f396257](https://github.com/zuohuadong/supacloud/commit/f396257e4c442d7cfb581824b15080bf6dfe64bf))
* improve one-click install robustness and compile edge-runtime as standalone binary ([de2a135](https://github.com/zuohuadong/supacloud/commit/de2a135bb661cb66f78f356d24d671a2023b6fc9))
* improve one-click install robustness and compile edge-runtime binary ([d14d4d7](https://github.com/zuohuadong/supacloud/commit/d14d4d72547c9d6d37d7fabbe3aad844a2c479fb))
* improve one-click install robustness, add function invoke route, repair stale projects ([cabc22f](https://github.com/zuohuadong/supacloud/commit/cabc22fe416ccd2e7555cc7ef67aa25fd1248f87))
* **runtime:** respect ssl config for tenant urls ([25a4f97](https://github.com/zuohuadong/supacloud/commit/25a4f97761813db374c93aed1c398413b0c6dce7))
* **runtime:** respect ssl config for tenant urls ([8520e5d](https://github.com/zuohuadong/supacloud/commit/8520e5d2661b043efcdd681a2f699c4c72bf5dfd))


### Elegance & Refactoring

* **edge-functions:** migrate version artifacts into internal revisions ([bd475aa](https://github.com/zuohuadong/supacloud/commit/bd475aa89989eea6a94668362b41b7fbee050765))
* **edge-runtime:** replace query-param hack with Worker replacement for module invalidation ([7f9246f](https://github.com/zuohuadong/supacloud/commit/7f9246f1dcbd5500de5666c2a94defdfe466e25f))


### Miscellaneous Chores

* better jwt error logging ([94c05a4](https://github.com/zuohuadong/supacloud/commit/94c05a47080bb65996a4a78dc033ca3ca655bab7))
* flush remaining test suite fixes and project modifications ([686ad4b](https://github.com/zuohuadong/supacloud/commit/686ad4bb59b1e087c9bf621d9663b259f0f33d27))
* push all accumulated compliance and runtime integrations ([8a6fec0](https://github.com/zuohuadong/supacloud/commit/8a6fec02a010bc035670181c3394333325e891a3))
* release main ([d6bd16a](https://github.com/zuohuadong/supacloud/commit/d6bd16a00f934b0c0c84110e7239abf942ab791e))
* release main ([dd7c341](https://github.com/zuohuadong/supacloud/commit/dd7c341b6b67b0b5c08140d67214a201cdc183d4))
* release main ([80c8170](https://github.com/zuohuadong/supacloud/commit/80c8170714b9dc572e177b68da04529bd901f25a))
* release main ([09e497c](https://github.com/zuohuadong/supacloud/commit/09e497cde2ab00f019e6bb671063142fb57b8d4b))
* release main ([51e6d88](https://github.com/zuohuadong/supacloud/commit/51e6d882f5aaf4a20ddba2597df748647d898c6e))
* release main ([19b57d6](https://github.com/zuohuadong/supacloud/commit/19b57d655005f78d914f1b8ee61632067e87f8e7))
* release main ([7924b79](https://github.com/zuohuadong/supacloud/commit/7924b79abf2d1cab65026dbff344b7b6a20a8bfe))
* release main ([e229440](https://github.com/zuohuadong/supacloud/commit/e2294400adc88ad4ceebf5f5fdc67a57ed38334a))
* release main ([86f2d95](https://github.com/zuohuadong/supacloud/commit/86f2d95fe4dae6528eb1e4945846db413e0696c3))
* release main ([1bca726](https://github.com/zuohuadong/supacloud/commit/1bca72644a7d79dc91335c2146196fc109814877))
* release main ([87a7fc5](https://github.com/zuohuadong/supacloud/commit/87a7fc5fd94492fee00dc8639025548f3f51bef4))
* release main ([67cc94b](https://github.com/zuohuadong/supacloud/commit/67cc94b2722f4949577c9b6791c81df25632ecf5))
* release main ([83229a7](https://github.com/zuohuadong/supacloud/commit/83229a71488b1de5f33105ab53f3be31bdefb4d9))
* release main ([e9101e0](https://github.com/zuohuadong/supacloud/commit/e9101e0120f7ccb84ac7584051c7f556bbdf84a6))
* release main ([519e551](https://github.com/zuohuadong/supacloud/commit/519e5518f0b23aca34ffc4488cf41c6bd320b08b))
* release main ([28dd468](https://github.com/zuohuadong/supacloud/commit/28dd46854718e4cc7ce0484098cea9051be75814))
* release main ([71845b0](https://github.com/zuohuadong/supacloud/commit/71845b0e1da740825cef3131ec89f4962bfeb268))
* release main ([7065db9](https://github.com/zuohuadong/supacloud/commit/7065db93a028d9b48ed093cc5f00f6c21547f2ee))
* release main ([1659cf1](https://github.com/zuohuadong/supacloud/commit/1659cf1de67ecb6cef082717df1769fc204b0942))
* release main ([a23a693](https://github.com/zuohuadong/supacloud/commit/a23a6939233998aa24449826bb001c1402d9ba37))
* release main ([fb49e13](https://github.com/zuohuadong/supacloud/commit/fb49e13f6d7bfe38bf45345840a3a72eb7a17594))
* release main ([95faa91](https://github.com/zuohuadong/supacloud/commit/95faa91498b3f4c8a169bf1f9fdd2d32fad365a2))
* release main ([cffe8d6](https://github.com/zuohuadong/supacloud/commit/cffe8d6838d7d5aabd332c873512415fb62fd91a))
* release main ([3632df1](https://github.com/zuohuadong/supacloud/commit/3632df11bb3047eff34446a13658b956904942a2))
* release main ([916dc05](https://github.com/zuohuadong/supacloud/commit/916dc052673f991dc508f8125020b94f86ebc3c2))
* release main ([adc35d5](https://github.com/zuohuadong/supacloud/commit/adc35d57af65a5d0ebc04b144909dc81c3084220))
* **systemd:** add canonical service templates ([c7fc3dd](https://github.com/zuohuadong/supacloud/commit/c7fc3dd225b46d71eaa55419ccdba2899189e99f))

## [0.3.9](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.8...edge-runtime-v0.3.9) (2026-05-12)


### Bug Fixes

* add function invoke route, repair stale projects, web-console deployment ([dedab66](https://github.com/zuohuadong/supacloud/commit/dedab667e4a200470a1d6c5d4dfada8df17e32ea))
* improve one-click install robustness, add function invoke route, repair stale projects ([5cdbe8a](https://github.com/zuohuadong/supacloud/commit/5cdbe8a0f7800e3b1b1e903976bcc8c33e61d1b1))

## [0.3.8](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.7...edge-runtime-v0.3.8) (2026-05-12)


### Bug Fixes

* **edge-runtime:** normalize fallback tenant env ([c72379f](https://github.com/zuohuadong/supacloud/commit/c72379fc12576132edcd19fe59cc69da6d1ad4fa))
* **edge-runtime:** normalize fallback tenant env ([e55a526](https://github.com/zuohuadong/supacloud/commit/e55a5260b61070cf33d99033c8ed9bbf7afa250b))
* improve one-click install robustness and compile edge-runtime as standalone binary ([aeccd2f](https://github.com/zuohuadong/supacloud/commit/aeccd2f4a57540cdd801bb0206dade92a67bbd6f))
* improve one-click install robustness and compile edge-runtime binary ([0328040](https://github.com/zuohuadong/supacloud/commit/03280408e260ed8e86cdb103e25d347713b4cbcb))

## [0.3.7](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.6...edge-runtime-v0.3.7) (2026-05-07)


### Bug Fixes

* **runtime:** respect ssl config for tenant urls ([d8ace81](https://github.com/zuohuadong/supacloud/commit/d8ace81412b4caa87fe00982539310452faeaaa1))
* **runtime:** respect ssl config for tenant urls ([d0852b2](https://github.com/zuohuadong/supacloud/commit/d0852b2e3d95a1c4ab33a30916df68aa15a41a64))

## [0.3.6](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.5...edge-runtime-v0.3.6) (2026-05-07)


### Bug Fixes

* **edge-runtime:** preserve env for waitUntil tasks ([1e43fbf](https://github.com/zuohuadong/supacloud/commit/1e43fbf6eb22a8fff3218326dae4c6e0b8fb4176))
* **edge-runtime:** preserve env for waitUntil tasks ([424152c](https://github.com/zuohuadong/supacloud/commit/424152c21265e67ec5812453d3cfc2a5ed064b87))

## [0.3.5](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.4...edge-runtime-v0.3.5) (2026-04-29)


### Bug Fixes

* **edge-runtime:** inject Bun function env ([54aefe5](https://github.com/zuohuadong/supacloud/commit/54aefe576cb351fe2dd37c4a9b8e74ed4c34f517))

## [0.3.4](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.3...edge-runtime-v0.3.4) (2026-04-29)


### Bug Fixes

* **edge-runtime:** reject masked runtime secrets ([9ecc6f1](https://github.com/zuohuadong/supacloud/commit/9ecc6f1de03fc7e49f5569e6fd52427c56c1ed4c))

## [0.3.3](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.2...edge-runtime-v0.3.3) (2026-04-24)


### Bug Fixes

* harden realtime tasks and data-plane boundaries ([f6bdfd1](https://github.com/zuohuadong/supacloud/commit/f6bdfd1b92d501507e27ad6ed73ecd3b46cc3e97))

## [0.3.2](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.1...edge-runtime-v0.3.2) (2026-04-19)


### Miscellaneous Chores

* release main ([239aea7](https://github.com/zuohuadong/supacloud/commit/239aea7e22bae05cc3c7840bc6c0fd7b322a8862))
* release main ([8d020be](https://github.com/zuohuadong/supacloud/commit/8d020be4e8d374f0cf0498a97e4beb6a88e57fb0))

## [0.3.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.3.0...edge-runtime-v0.3.1) (2026-04-18)


### Bug Fixes

* **edge-runtime:** avoid double-managed runtime restarts ([5a27175](https://github.com/zuohuadong/supacloud/commit/5a271758fff9bbe008f8d8aade559e4d8dffab3e))


### Elegance & Refactoring

* **edge-functions:** migrate version artifacts into internal revisions ([e9c0890](https://github.com/zuohuadong/supacloud/commit/e9c0890013bb23b0189dd089c3e7d79507ee37b2))


### Miscellaneous Chores

* **systemd:** add canonical service templates ([9f1c42c](https://github.com/zuohuadong/supacloud/commit/9f1c42c4fabd1da1d24a35c9f699f92f22e0bcad))

## [0.3.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.2.1...edge-runtime-v0.3.0) (2026-04-17)


### Features

* **tasks:** deploy background task and message queue features to servers ([e66cdac](https://github.com/zuohuadong/supacloud/commit/e66cdac9c34f34990de5675ca75bfca9894cc3b4))
* updates and fixes based on recent local changes ([449c710](https://github.com/zuohuadong/supacloud/commit/449c71089721658d25737ac7df1c196b3bc9bb1d))

## [0.2.1](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.2.0...edge-runtime-v0.2.1) (2026-04-16)


### Bug Fixes

* **edge-runtime:** bust Bun import() cache on function redeploy ([fae6e90](https://github.com/zuohuadong/supacloud/commit/fae6e90ea414b38326c553d0751970e0e7386576))
* **edge-runtime:** use EDGE_RUNTIME_PORT to avoid port conflict with management API ([69b6f44](https://github.com/zuohuadong/supacloud/commit/69b6f448c25e8e57ec68e462ed31ee0b623e5d7b))


### Elegance & Refactoring

* **edge-runtime:** replace query-param hack with Worker replacement for module invalidation ([777c7d2](https://github.com/zuohuadong/supacloud/commit/777c7d242d9ffb8d78082afbd75f3fcaf0553a16))

## [0.2.0](https://github.com/zuohuadong/supacloud/compare/edge-runtime-v0.1.1...edge-runtime-v0.2.0) (2026-04-14)


### Features

* add Signed URLs, TUS resumable upload, and Edge Functions SDK compatibility ([cdaeca1](https://github.com/zuohuadong/supacloud/commit/cdaeca12094796ac92f38114cf23b6728e63a057))
* **api:** complete architecture hardening and Elysia schema validation implementation ([5d93b9a](https://github.com/zuohuadong/supacloud/commit/5d93b9ad1303efda36a3069e208096c5187f70ed))
* **core:** Native Supabase compatibility fixes for Realtime, Storage RLS, and Edge Functions ([44ba883](https://github.com/zuohuadong/supacloud/commit/44ba8836347e8c2d04911330cd4bb8546eed71e5))
* custom domain support, edge-runtime auto-deps, test fixes ([3fb55a9](https://github.com/zuohuadong/supacloud/commit/3fb55a950d262da432e5eaa29fd455135709491a))
* **edge-functions:** implement per-function verify_jwt configuration ([d9e060b](https://github.com/zuohuadong/supacloud/commit/d9e060b68f89ddca5e87e59bfb4c34f9f4e49c4f))
* **edge-runtime:** add jsr/npm import matching and expand Deno std lib shims ([8d1758a](https://github.com/zuohuadong/supacloud/commit/8d1758ad074ef0bd2d6d8bb4562c91a9351e03e4))
* **edge-runtime:** merge Deno.serve() compatibility into WorkerPool sandbox ([25feca2](https://github.com/zuohuadong/supacloud/commit/25feca24a09287bcb34866b5923cc676a67ba60a))
* **edge:** module cache invalidation on deploy + Angie CORS template ([456df57](https://github.com/zuohuadong/supacloud/commit/456df57c65876aa80adea84d545a9ae4a6d2d274))
* **edge:** server-side Bun.build() bundling pipeline + multi-file bundle deploy ([4010992](https://github.com/zuohuadong/supacloud/commit/401099230b49a9ba08f5ef4cee6beab143d02b37))
* **platform:** massive stabilization update across edge-runtime, mcp, routing, and sdk-proxy compatibility ([38f010a](https://github.com/zuohuadong/supacloud/commit/38f010ac111ef2cd098f63c328d2d6e2cebafbe3))
* **secrets:** DB-backed project secrets with dynamic runtime injection ([0b06bc6](https://github.com/zuohuadong/supacloud/commit/0b06bc6775adae14060fae7cffe8f2b7c5b14dea))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([def0c30](https://github.com/zuohuadong/supacloud/commit/def0c30fe63502a6717a760f19d98c0962ba76ab))


### Bug Fixes

* **auth,infra:** 401 pre-flight and all-in-one local docker ([b7fb005](https://github.com/zuohuadong/supacloud/commit/b7fb00575e04cfec3a46df4209e214c6016f0bea))
* **edge-runtime:** add missing jose dependency ([67e75fb](https://github.com/zuohuadong/supacloud/commit/67e75fb40be325ec93f72c9fa8b5c4aa302946e8))
* **edge-runtime:** add stripped path routing fallbacks to support Kong strip_path: true ([02bde5c](https://github.com/zuohuadong/supacloud/commit/02bde5c63fc99af0f80a2a877773aa99fb3baf26))
* **edge-runtime:** bypass verifyJwt for CORS preflight OPTIONS requests to prevent 401 errors ([62c3918](https://github.com/zuohuadong/supacloud/commit/62c3918186beb78aac4d496ffee24f7d1c7c0798))
* **edge-runtime:** cache project secrets to prevent DOMException TimeoutError under load and accept apikey header ([37bb41c](https://github.com/zuohuadong/supacloud/commit/37bb41c93f938bc70135d06d36b76e3dd4a3b829))
* **edge-runtime:** exact ipv4 binding for localhost healthchecks ([cfa16d2](https://github.com/zuohuadong/supacloud/commit/cfa16d22696429eecdf19d72d760dcfdc88d1072))
* **edge-runtime:** remove suicidal killStaleListeners to break restart loop ([4c06386](https://github.com/zuohuadong/supacloud/commit/4c06386b8f9c214d6ffc137439d57109cbfe7614))
* **edge:** increase pool timeout to 5min (300s) ([69185d1](https://github.com/zuohuadong/supacloud/commit/69185d1f33f30a13a6711200de24c15a19e1e384))
* **edge:** increase timeouts for AI streaming (20s→120s pool, 300s proxy) ([66a146f](https://github.com/zuohuadong/supacloud/commit/66a146f9188fb7ce0ec31a02f86b3687a28faf73))
* explicit @sinclair/typebox dependency to prevent elysia/edge-runtime crash during CI e2e tests proxy boot ([3a288e0](https://github.com/zuohuadong/supacloud/commit/3a288e0317bceba940145f9e2aa8e306ab17b10d))
* **gw:** route mcp over native gateway internally, bump dep ([19084ea](https://github.com/zuohuadong/supacloud/commit/19084ea79c9e2a18f0548c2d9d45ffa7fcaa6af7))


### Elegance & Refactoring

* remove legacy supabase-vector/auth container deps, fix ASSETS null guard ([4bb0323](https://github.com/zuohuadong/supacloud/commit/4bb032334fea13bc09eb99042100c14d6bab1ba9))


### Miscellaneous Chores

* better jwt error logging ([7d9e862](https://github.com/zuohuadong/supacloud/commit/7d9e862f435e93281c4ae35ca4b21241c52eb5e4))
* flush remaining test suite fixes and project modifications ([b678a77](https://github.com/zuohuadong/supacloud/commit/b678a77bf72e4bcaf75f9963153f8802ec0d869e))
* push all accumulated compliance and runtime integrations ([adba09c](https://github.com/zuohuadong/supacloud/commit/adba09ca0752da3ad240f728873f460076246ab2))
