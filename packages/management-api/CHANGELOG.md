# Changelog

## [0.42.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.42.0...management-api-v0.42.1) (2026-07-17)


### Bug Fixes

* **auth:** close SupAuth shared runtime boundary gaps ([#477](https://github.com/zuohuadong/supacloud/issues/477)) ([14d1d64](https://github.com/zuohuadong/supacloud/commit/14d1d64b1ae05fd9c9c8390d318d9d3a97c6ced6))

## [0.42.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.41.5...management-api-v0.42.0) (2026-07-17)


### Features

* **auth:** enforce SupAuth shared runtime boundaries ([aca9d67](https://github.com/zuohuadong/supacloud/commit/aca9d6756a550d43b06b9c1c0b3ec9a3e1cdd324))
* **auth:** enforce SupAuth shared runtime boundaries ([285a9f5](https://github.com/zuohuadong/supacloud/commit/285a9f5053125e8ad774c12824c829863b450dc4))


### Bug Fixes

* **auth:** bind shared bearer keys to tenant ([79671dd](https://github.com/zuohuadong/supacloud/commit/79671dd8c95d247e656c890018d7598eb840c843))
* **auth:** bind shared bearer keys to tenant ([0387f9c](https://github.com/zuohuadong/supacloud/commit/0387f9c3fc8a1849e1bc17655b12cb4dc27e8082))
* **auth:** support shared GoTrue runtime owner ([93dd1be](https://github.com/zuohuadong/supacloud/commit/93dd1be9306d3e86ebdea024ab3ee5aa08a7c95f))

## [0.41.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.41.4...management-api-v0.41.5) (2026-07-17)


### Bug Fixes

* **auth:** isolate third-party JWT verification ([#467](https://github.com/zuohuadong/supacloud/issues/467)) ([c7dae36](https://github.com/zuohuadong/supacloud/commit/c7dae365b64bb6dd258c6a14eba3c936a636e6c0))

## [0.41.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.41.3...management-api-v0.41.4) (2026-07-17)


### Bug Fixes

* **gateway:** reconcile managed route drift ([ddaf522](https://github.com/zuohuadong/supacloud/commit/ddaf5229f3a65bbf0127eb344539b1347f617f8c))

## [0.41.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.41.2...management-api-v0.41.3) (2026-07-17)


### Miscellaneous Chores

* **deps-dev:** bump @supabase/supabase-js in /packages/management-api ([d1693bf](https://github.com/zuohuadong/supacloud/commit/d1693bf96eba309eb8aba718163ec745e2bfcd5c))
* **deps:** bump @sinclair/typebox in /packages/management-api ([a97b9d4](https://github.com/zuohuadong/supacloud/commit/a97b9d4e57912148e313e5d71f291c3ab590d0f8))
* **deps:** bump nanoid from 5.1.16 to 6.0.0 in /packages/management-api ([9a03ac7](https://github.com/zuohuadong/supacloud/commit/9a03ac780cf6a1b8d7a042d0bcfc9c6275ecbdd3))
* **deps:** bump nanoid in /packages/management-api ([78f88aa](https://github.com/zuohuadong/supacloud/commit/78f88aaf182e8c4ddf18a75aa0856d13cb35d04c))

## [0.41.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.41.1...management-api-v0.41.2) (2026-07-17)


### Bug Fixes

* **gateway:** allow tus preflight headers ([fbeac27](https://github.com/zuohuadong/supacloud/commit/fbeac27094e1f965eef2a72cfd0a9f7b59a0ffce))
* **gateway:** preserve TUS CORS and capabilities ([60e48c4](https://github.com/zuohuadong/supacloud/commit/60e48c4da58d878103a0fce1b7cbccc2d0343e0a))
* **storage:** expose TUS capability headers ([bbffc44](https://github.com/zuohuadong/supacloud/commit/bbffc44c85effaa7006ed12d708e0a5379fc6a81))
* **storage:** preserve TUS capability responses ([0339ed6](https://github.com/zuohuadong/supacloud/commit/0339ed63091a7ca19f2f8f51a38f9301ea13d002))

## [0.41.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.41.0...management-api-v0.41.1) (2026-07-17)


### Bug Fixes

* **gateway:** bound rate-limit memory ([7fc8b26](https://github.com/zuohuadong/supacloud/commit/7fc8b265cd1a5f2a9b414ed3569c99cfd4f3c262))
* **gateway:** raise default API rate limits ([e01c5c1](https://github.com/zuohuadong/supacloud/commit/e01c5c18f2bcd6a09bf55efe8de51575650f39fc))

## [0.41.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.40.6...management-api-v0.41.0) (2026-07-17)


### Features

* **gateway:** support protocol-scoped redirects ([62d02b7](https://github.com/zuohuadong/supacloud/commit/62d02b7eea7eb182462db7a36a3424f379923d87))


### Bug Fixes

* **gateway:** harden redirect route updates ([278c177](https://github.com/zuohuadong/supacloud/commit/278c1776742ed4530bdab0c8c234b2e59cea34b6))

## [0.40.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.40.5...management-api-v0.40.6) (2026-07-17)


### Bug Fixes

* **rbac:** isolate user permissions by application ([31521a3](https://github.com/zuohuadong/supacloud/commit/31521a3a501075623baf3b61f894ae2d0f65ee75))
* **rbac:** preserve scoped permission boundaries ([04e0216](https://github.com/zuohuadong/supacloud/commit/04e0216eb41f659c7162f56683cbca311ef321e4))

## [0.40.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.40.4...management-api-v0.40.5) (2026-07-17)


### Bug Fixes

* **management-api:** redact sensitive Caddy request headers ([#440](https://github.com/zuohuadong/supacloud/issues/440)) ([e83e25d](https://github.com/zuohuadong/supacloud/commit/e83e25d8bc24135da9a33a66008591284c322c47))

## [0.40.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.40.3...management-api-v0.40.4) (2026-07-16)


### Bug Fixes

* **management-api:** harden runtime compatibility ([42c936c](https://github.com/zuohuadong/supacloud/commit/42c936cdebeff3e42260b44eea105d302159de7e))

## [0.40.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.40.2...management-api-v0.40.3) (2026-07-16)


### Bug Fixes

* make generated WeChat functions self-contained ([#436](https://github.com/zuohuadong/supacloud/issues/436)) ([219a1df](https://github.com/zuohuadong/supacloud/commit/219a1df9aea1ae5238517f56e76e5d853a07221e))
* **management-api:** allow standard idempotency header in CORS ([#435](https://github.com/zuohuadong/supacloud/issues/435)) ([a13614b](https://github.com/zuohuadong/supacloud/commit/a13614be173f1911a9e792eae4fa16c6fd3a9869))

## [0.40.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.40.1...management-api-v0.40.2) (2026-07-15)


### Bug Fixes

* **postgres:** add Docker Pigsty 4.4 compatibility ([1a65158](https://github.com/zuohuadong/supacloud/commit/1a65158e0199c1a52aeed4614094d034a3d3341c))

## [0.40.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.40.0...management-api-v0.40.1) (2026-07-15)


### Bug Fixes

* **management-api:** support Pigsty 4.4 production compatibility ([d8f6959](https://github.com/zuohuadong/supacloud/commit/d8f6959623e6f09e0e665e3353d56fd7fdbab6de))

## [0.40.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.39.1...management-api-v0.40.0) (2026-07-14)


### Features

* add Pigsty 4.4 compatibility ([809ef2e](https://github.com/zuohuadong/supacloud/commit/809ef2e50446d07793814b1e20eca012198fc4fd))


### Bug Fixes

* **ci:** isolate process-global Bun module mocks ([76eadac](https://github.com/zuohuadong/supacloud/commit/76eadac4a2f8b881930ddbda5d78cae9fd274e87))
* **management-api:** isolate API test database mocks ([4efc282](https://github.com/zuohuadong/supacloud/commit/4efc2827edfff63d558d6274ae199f91f68f60ca))
* **management-api:** isolate storage auth tests ([a913cef](https://github.com/zuohuadong/supacloud/commit/a913ceffe42de2cc0871fb5b409b830feac8e1e6))

## [0.39.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.39.0...management-api-v0.39.1) (2026-07-11)


### Miscellaneous Chores

* **deps-dev:** bump @supabase/supabase-js in /packages/management-api ([#422](https://github.com/zuohuadong/supacloud/issues/422)) ([d0f81d7](https://github.com/zuohuadong/supacloud/commit/d0f81d759b50564dda428408d8526ef7d627d9c7))
* **deps-dev:** bump typescript in /packages/management-api ([#413](https://github.com/zuohuadong/supacloud/issues/413)) ([834df74](https://github.com/zuohuadong/supacloud/commit/834df7462c5c3b2f03ada9cd43772b8c591f19c2))
* **deps:** bump @clack/prompts in /packages/management-api ([#425](https://github.com/zuohuadong/supacloud/issues/425)) ([a946a30](https://github.com/zuohuadong/supacloud/commit/a946a308e53218c65f6097ea836bd916a1ea0382))
* **deps:** bump @sinclair/typebox in /packages/management-api ([#424](https://github.com/zuohuadong/supacloud/issues/424)) ([4c585d9](https://github.com/zuohuadong/supacloud/commit/4c585d93d2dba825e6941abe3b5573e9832ed80f))
* **deps:** bump nanoid in /packages/management-api ([#418](https://github.com/zuohuadong/supacloud/issues/418)) ([13b5890](https://github.com/zuohuadong/supacloud/commit/13b5890d5b49588aa2ae278c67cb613a88813d1e))

## [0.39.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.38.0...management-api-v0.39.0) (2026-07-11)


### Features

* security hardening, idempotent install, and CI reliability fixes ([eb15db0](https://github.com/zuohuadong/supacloud/commit/eb15db0e58b8b2a2d19e4e99d92360a33da116a4))


### Bug Fixes

* **management-api:** replace process-global mock.module with spyOn in auth-users test ([e7b5d61](https://github.com/zuohuadong/supacloud/commit/e7b5d61e675ea78fec67263bd75cc13d2dd1eb39))
* **management-api:** return 404 for unmatched gateway hosts ([#411](https://github.com/zuohuadong/supacloud/issues/411)) ([efb2590](https://github.com/zuohuadong/supacloud/commit/efb2590dfa973a0cc41f5d977801309884286f12))
* **management-api:** serialize caddy config publishes ([#399](https://github.com/zuohuadong/supacloud/issues/399)) ([20eb4c9](https://github.com/zuohuadong/supacloud/commit/20eb4c990e59299e9dde04d5850482e7a220884e))
* **management-api:** stabilize auth user update proxy ([#410](https://github.com/zuohuadong/supacloud/issues/410)) ([b954e71](https://github.com/zuohuadong/supacloud/commit/b954e7165d146f57436cb7b371f34e0c2ebbd9e1))

## [0.38.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.11...management-api-v0.38.0) (2026-07-02)


### Features

* **edge-runtime:** optimize function preheat and bundle metadata ([eb4f305](https://github.com/zuohuadong/supacloud/commit/eb4f305ce77041e21f4e71c1166b4ddd33f6d81b))

## [0.37.11](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.10...management-api-v0.37.11) (2026-06-30)


### Bug Fixes

* **edge-runtime:** inject tenant-local PostgREST REST URL ([#397](https://github.com/zuohuadong/supacloud/issues/397)) ([e1ad57e](https://github.com/zuohuadong/supacloud/commit/e1ad57e78038a028c268f0a79d9784daac574b08))

## [0.37.10](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.9...management-api-v0.37.10) (2026-06-29)


### Bug Fixes

* **management-api:** harden diagnostics health checks ([a69b21f](https://github.com/zuohuadong/supacloud/commit/a69b21fd4decaebe603d78eacec436226f5a5a40))

## [0.37.9](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.8...management-api-v0.37.9) (2026-06-29)


### Bug Fixes

* **web-console:** repair studio health surfaces ([0822a80](https://github.com/zuohuadong/supacloud/commit/0822a80678baf1053efedb400c73a2db9bcdf3d3))

## [0.37.8](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.7...management-api-v0.37.8) (2026-06-29)


### Bug Fixes

* **runtime:** update companion binary download versions ([d88232f](https://github.com/zuohuadong/supacloud/commit/d88232f2fd244d510b20006f0094e5367d4c79b2))

## [0.37.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.6...management-api-v0.37.7) (2026-06-28)


### Miscellaneous Chores

* **deps:** bump @svadmin/core from 0.30.0 to 0.31.0 in /packages/management-api ([ce0fb94](https://github.com/zuohuadong/supacloud/commit/ce0fb94ada57fda8b99b7baa131e0d3ac5d05227))

## [0.37.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.5...management-api-v0.37.6) (2026-06-28)


### Bug Fixes

* **auth:** repair tenant auth schema ownership ([e4e18c0](https://github.com/zuohuadong/supacloud/commit/e4e18c0fd4eb30b2a14e6a4a2c6b9bd86b5ec119))

## [0.37.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.4...management-api-v0.37.5) (2026-06-28)


### Bug Fixes

* **storage:** let S3 SigV4 bypass API bearer guard ([f2a5c7c](https://github.com/zuohuadong/supacloud/commit/f2a5c7c1979d6c9ba668842cd0d7fbe2f555e59f))

## [0.37.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.3...management-api-v0.37.4) (2026-06-28)


### Bug Fixes

* **storage:** prioritize S3 compatibility routes ([e3b57d3](https://github.com/zuohuadong/supacloud/commit/e3b57d3d6a8576477e733ad979595d1feccac5d3))

## [0.37.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.2...management-api-v0.37.3) (2026-06-28)


### Bug Fixes

* **storage:** allow provisioning projects to bootstrap objects ([6275415](https://github.com/zuohuadong/supacloud/commit/62754158d6612e7ccd53f97faa253e88fcba7afb))

## [0.37.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.1...management-api-v0.37.2) (2026-06-25)


### Bug Fixes

* **management-api:** support generic postgres health ([51e23a1](https://github.com/zuohuadong/supacloud/commit/51e23a15c0e2291380cf5bbe19207787d3aa5092))

## [0.37.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.37.0...management-api-v0.37.1) (2026-06-24)


### Bug Fixes

* restore studio compatibility routes ([3aacf63](https://github.com/zuohuadong/supacloud/commit/3aacf63caf25da68e5ea791e3467943bdc7b343e))

## [0.37.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.36.7...management-api-v0.37.0) (2026-06-23)


### Features

* **auth:** support Supabase June auth updates ([7caa595](https://github.com/zuohuadong/supacloud/commit/7caa595b3b6c9920cf97eca98eeacf8c362fc959))

## [0.36.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.36.6...management-api-v0.36.7) (2026-06-23)


### Bug Fixes

* **gateway:** preserve external auth upstream on rebuild ([2a178d3](https://github.com/zuohuadong/supacloud/commit/2a178d34b68efeb06429a0c0f8bf0c70df11e7c9))

## [0.36.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.36.5...management-api-v0.36.6) (2026-06-23)


### Bug Fixes

* **gateway:** support clean caddy reconcile ([a848dc6](https://github.com/zuohuadong/supacloud/commit/a848dc695e738e213cc6ecebe0b697c6f2bf9f7a))

## [0.36.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.36.4...management-api-v0.36.5) (2026-06-23)


### Bug Fixes

* **gateway:** support mounted static custom routes ([#356](https://github.com/zuohuadong/supacloud/issues/356)) ([f6ced08](https://github.com/zuohuadong/supacloud/commit/f6ced083f2f94b041fc8168a4ac4eb14d21080dd))

## [0.36.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.36.3...management-api-v0.36.4) (2026-06-22)


### Bug Fixes

* **management-api:** expose content disposition in gateway cors ([#351](https://github.com/zuohuadong/supacloud/issues/351)) ([638d2de](https://github.com/zuohuadong/supacloud/commit/638d2de455103d46da6358ce019d29493d96bf5a))

## [0.36.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.36.2...management-api-v0.36.3) (2026-06-19)


### Bug Fixes

* **installer:** gate legacy supabase compose cleanup ([#347](https://github.com/zuohuadong/supacloud/issues/347)) ([d721e4d](https://github.com/zuohuadong/supacloud/commit/d721e4da9163c9e9d683f04ddf0087e9fc57789f))

## [0.36.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.36.1...management-api-v0.36.2) (2026-06-19)


### Bug Fixes

* **management-api:** mark storage enterprise capabilities unavailable ([#345](https://github.com/zuohuadong/supacloud/issues/345)) ([7b273b5](https://github.com/zuohuadong/supacloud/commit/7b273b5ad5f57badab204f10e3463145c0287d8b))

## [0.36.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.36.0...management-api-v0.36.1) (2026-06-19)


### Bug Fixes

* **management-api:** prefer bun auth provider templates ([#343](https://github.com/zuohuadong/supacloud/issues/343)) ([6f7d858](https://github.com/zuohuadong/supacloud/commit/6f7d858291051f5205f9e2781ea004844d4ba23f))

## [0.36.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.35.1...management-api-v0.36.0) (2026-06-19)


### Features

* **management-api:** configure auth email templates ([#335](https://github.com/zuohuadong/supacloud/issues/335)) ([10bee5f](https://github.com/zuohuadong/supacloud/commit/10bee5f9a88082f64090f0879838708a5a674628))

## [0.35.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.35.0...management-api-v0.35.1) (2026-06-19)


### Bug Fixes

* **management-api:** expose platform capability status ([#332](https://github.com/zuohuadong/supacloud/issues/332)) ([28cb6fb](https://github.com/zuohuadong/supacloud/commit/28cb6fb222b17f9f662d16ebaa3c2c762b18f7e8))

## [0.35.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.34.1...management-api-v0.35.0) (2026-06-19)


### Features

* **management-api:** implement organization member management ([#328](https://github.com/zuohuadong/supacloud/issues/328)) ([76578d7](https://github.com/zuohuadong/supacloud/commit/76578d750f9d3d175cec32db7b12dc4e2caa1eb2))

## [0.34.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.34.0...management-api-v0.34.1) (2026-06-19)


### Bug Fixes

* **management-api:** route project branches to real handlers ([#326](https://github.com/zuohuadong/supacloud/issues/326)) ([da14c88](https://github.com/zuohuadong/supacloud/commit/da14c88ed263b995b11af953430d9a630d2daf3e))

## [0.34.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.33.1...management-api-v0.34.0) (2026-06-19)


### Features

* **gotrue:** enable tenant config hot reload ([#325](https://github.com/zuohuadong/supacloud/issues/325)) ([5c68823](https://github.com/zuohuadong/supacloud/commit/5c6882359b86937d78c9eb57e9baf9dc0b4507ba))
* **management-api:** add SupAuth webhook audit facade ([#321](https://github.com/zuohuadong/supacloud/issues/321)) ([3526370](https://github.com/zuohuadong/supacloud/commit/35263708e5a6d0c4cf623f36c668fcae2b57688d))


### Bug Fixes

* **realtime:** configure v2.109 internal credentials ([26a900f](https://github.com/zuohuadong/supacloud/commit/26a900fb6ab2d5a9af6b1279137f2bc60ff7f831))
* **realtime:** retry tenant registration while container is starting ([d6b320a](https://github.com/zuohuadong/supacloud/commit/d6b320a6c72167fc4d6060f728ba07f770bb2386))
* **realtime:** support v2.109 service startup ([900ccf8](https://github.com/zuohuadong/supacloud/commit/900ccf83978d5c0a996aa009785a9ce5e2b1e5cf))


### Miscellaneous Chores

* **realtime:** bump image to v2.109.1 ([2764a13](https://github.com/zuohuadong/supacloud/commit/2764a130c76ccd0a40c6bf3fb0a9c6d5e906b801))

## [0.33.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.33.0...management-api-v0.33.1) (2026-06-18)


### Bug Fixes

* **gateway:** ensure Caddy JSON config self-heals on cold start and restart ([#319](https://github.com/zuohuadong/supacloud/issues/319)) ([8d30be3](https://github.com/zuohuadong/supacloud/commit/8d30be3f4899f0a9e1db466559571940cadc5371))
* **management-api:** sync project rbac metadata with gotrue put ([#318](https://github.com/zuohuadong/supacloud/issues/318)) ([771d172](https://github.com/zuohuadong/supacloud/commit/771d1722f06565b55be2de380b14a34adc00ab9b))

## [0.33.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.32.0...management-api-v0.33.0) (2026-06-17)


### Features

* **management-api:** add project rbac facade ([#316](https://github.com/zuohuadong/supacloud/issues/316)) ([787ba9d](https://github.com/zuohuadong/supacloud/commit/787ba9d0a0bf020837c26c7bdef2329cc208b7db))

## [0.32.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.31.2...management-api-v0.32.0) (2026-06-15)


### Features

* **management-api:** close Supabase parity gaps ([df085a9](https://github.com/zuohuadong/supacloud/commit/df085a997bfa6e78f8ec92da467b6855fc22795e))


### Miscellaneous Chores

* **deps:** bump @svadmin/core in /packages/management-api ([#310](https://github.com/zuohuadong/supacloud/issues/310)) ([68b6273](https://github.com/zuohuadong/supacloud/commit/68b6273f56b34815eaf3a3ed2fb01cddb5dc203b))

## [0.31.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.31.1...management-api-v0.31.2) (2026-06-13)


### Bug Fixes

* **auth-wechat:** align login response with supabase-mp-js ([d957a52](https://github.com/zuohuadong/supacloud/commit/d957a5287fa25425934e4e2d82fd77803c8542b2))

## [0.31.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.31.0...management-api-v0.31.1) (2026-06-11)


### Bug Fixes

* **auth:** sign GoTrue admin tokens with project JWKS ([1b4f7a4](https://github.com/zuohuadong/supacloud/commit/1b4f7a47907e3ff8740c629fd5f3616ae548618e))

## [0.31.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.30.4...management-api-v0.31.0) (2026-06-10)


### Features

* support rewrite custom gateway routes ([4e257ed](https://github.com/zuohuadong/supacloud/commit/4e257ed7d19eb9a824f37c89c4cd716944ec75b3))

## [0.30.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.30.3...management-api-v0.30.4) (2026-06-08)


### Bug Fixes

* **gateway:** stop static frontend fallback leaks ([48aaaa3](https://github.com/zuohuadong/supacloud/commit/48aaaa3c35d7cb4538d3f20a613579b480e23eba))

## [0.30.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.30.2...management-api-v0.30.3) (2026-06-06)


### Bug Fixes

* **management-api:** prevent empty_stream connection reset during frontend zip upload ([#298](https://github.com/zuohuadong/supacloud/issues/298)) ([3687228](https://github.com/zuohuadong/supacloud/commit/36872281590f66fd92ff6cd76891c2e1bfa085a9))

## [0.30.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.30.1...management-api-v0.30.2) (2026-06-06)


### Miscellaneous Chores

* **deps:** bump @svadmin/core in /packages/management-api ([#296](https://github.com/zuohuadong/supacloud/issues/296)) ([345aeb5](https://github.com/zuohuadong/supacloud/commit/345aeb508e206a8052bc6ec15c2eb602dce3b238))

## [0.30.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.30.0...management-api-v0.30.1) (2026-06-05)


### Bug Fixes

* **ci:** pin Bun runtime to 1.3.14 ([03304e8](https://github.com/zuohuadong/supacloud/commit/03304e821eeab32849004c623af34b3c96bee0ce))

## [0.30.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.9...management-api-v0.30.0) (2026-06-04)


### Features

* **gateway:** add controlled custom routes ([6732f0f](https://github.com/zuohuadong/supacloud/commit/6732f0f3069568b8eab0262ab122c64805448cda))


### Bug Fixes

* **gateway:** support 500MiB TUS uploads ([579b967](https://github.com/zuohuadong/supacloud/commit/579b967703e0bd06044ec25d7eee7150388d50fc))
* **routing:** prefer HTTPS for public custom domains ([ea37d35](https://github.com/zuohuadong/supacloud/commit/ea37d359b79d10c0a3787ac2b93933680eb2ca00))
* **runtime:** propagate signup flags to gotrue env ([c79a15a](https://github.com/zuohuadong/supacloud/commit/c79a15aafba6f14263f281a43a28b99f987677b3))

## [0.29.9](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.8...management-api-v0.29.9) (2026-06-04)


### Bug Fixes

* **gateway:** support additional api domains ([#286](https://github.com/zuohuadong/supacloud/issues/286)) ([5555e19](https://github.com/zuohuadong/supacloud/commit/5555e199ddc04aaa58ae6c3e4858a9d81931bb0a))

## [0.29.8](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.7...management-api-v0.29.8) (2026-06-04)


### Bug Fixes

* **gateway:** omit empty Caddy response headers ([aa58937](https://github.com/zuohuadong/supacloud/commit/aa58937c09fa2dece951df712dd63c06700eae4a))

## [0.29.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.6...management-api-v0.29.7) (2026-06-04)


### Bug Fixes

* **cli:** avoid gateway init for one-shot commands ([#281](https://github.com/zuohuadong/supacloud/issues/281)) ([69be7a8](https://github.com/zuohuadong/supacloud/commit/69be7a8d3bbcb046a7394a6110b0a10fe1775ef6))
* **gateway:** migrate hydrated storage routes ([#283](https://github.com/zuohuadong/supacloud/issues/283)) ([8d4a7f1](https://github.com/zuohuadong/supacloud/commit/8d4a7f1cb478ecbe718ad91408bf9f529b0b593e))

## [0.29.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.5...management-api-v0.29.6) (2026-06-04)


### Bug Fixes

* **gateway:** preserve storage SDK route prefix ([fb80b09](https://github.com/zuohuadong/supacloud/commit/fb80b09c05a7885d3e53391c74dcb09de99d1b65))

## [0.29.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.4...management-api-v0.29.5) (2026-06-04)


### Bug Fixes

* **storage:** accept configured api domains for sdk requests ([#277](https://github.com/zuohuadong/supacloud/issues/277)) ([3d23d1a](https://github.com/zuohuadong/supacloud/commit/3d23d1add7e8adb326f9691ecc12acebf77671e3))

## [0.29.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.3...management-api-v0.29.4) (2026-06-04)


### Bug Fixes

* **gateway,storage:** inject Host/X-Forwarded-Proto headers and bootstrap storage RLS policies ([#275](https://github.com/zuohuadong/supacloud/issues/275)) ([b2c56a7](https://github.com/zuohuadong/supacloud/commit/b2c56a7160289845d654973dedc26ea625f96e96))

## [0.29.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.2...management-api-v0.29.3) (2026-06-03)


### Bug Fixes

* harden PostGREST tenant schema defaults and watchdog alerts ([9637aad](https://github.com/zuohuadong/supacloud/commit/9637aad2a168cb9043d2afdece050a912637e9e7))

## [0.29.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.1...management-api-v0.29.2) (2026-06-03)


### Bug Fixes

* **gateway:** block configured Caddy TLS domains ([2ad13da](https://github.com/zuohuadong/supacloud/commit/2ad13daedd3aef4675fe5ea4ba0030db57655de7))
* **management-api:** inject key_ops sign for legacy ES256 signing keys ([74dcc11](https://github.com/zuohuadong/supacloud/commit/74dcc112f9a210a7b50cf555c9f95f1f81fb9cce))

## [0.29.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.29.0...management-api-v0.29.1) (2026-06-03)


### Bug Fixes

* **management-api:** quote JSON values correctly for systemd EnvironmentFile ([522240e](https://github.com/zuohuadong/supacloud/commit/522240ea766cc52a358f3098a11d12ab39bbf5af))


### Elegance & Refactoring

* **gateway:** generalize SupAuth hosted login to hosted auth page routes ([14a2b07](https://github.com/zuohuadong/supacloud/commit/14a2b07bf392f1af22fb435921ac817ea1f402f0))

## [0.29.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.28.2...management-api-v0.29.0) (2026-06-03)


### Features

* **gateway:** add SupAuth hosted login page routes ([bcc1d9a](https://github.com/zuohuadong/supacloud/commit/bcc1d9a3d2d062039d0654440d367b8e3f383e49))

## [0.28.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.28.1...management-api-v0.28.2) (2026-06-03)


### Bug Fixes

* **gateway:** disable streaming on Caddy proxy for storage compat routes ([#264](https://github.com/zuohuadong/supacloud/issues/264)) ([ed67e4f](https://github.com/zuohuadong/supacloud/commit/ed67e4f73af7f607045021b99deb69a6ffb862bd))

## [0.28.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.28.0...management-api-v0.28.1) (2026-06-03)


### Bug Fixes

* **management-api:** derive studio host from api domain ([e6935d7](https://github.com/zuohuadong/supacloud/commit/e6935d7e2cbf2991a652ec04cd0f350beafce242))


### Miscellaneous Chores

* upgrade all dependencies to latest minor ([e9719d9](https://github.com/zuohuadong/supacloud/commit/e9719d983c9303c783ddcd3d772c7e7c56e985b9))

## [0.28.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.8...management-api-v0.28.0) (2026-06-02)


### Features

* **gateway:** add Caddy config notice log and DO-NOT-EDIT marker ([9613d43](https://github.com/zuohuadong/supacloud/commit/9613d43d386cdead400508b2442b19c305a13750))

## [0.27.8](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.7...management-api-v0.27.8) (2026-06-02)


### Bug Fixes

* **gateway:** allow forwarded CORS headers ([e86239b](https://github.com/zuohuadong/supacloud/commit/e86239b35e4721848504ec416ecf6683ae5daa69))
* **gateway:** allow forwarded CORS headers ([2912d50](https://github.com/zuohuadong/supacloud/commit/2912d50b68400d9b877a5d8402f0424986ca6284))
* **management-api:** verify project secret upserts ([87c9260](https://github.com/zuohuadong/supacloud/commit/87c9260682f3031b85cb97a47fdc62c53f35a003))

## [0.27.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.6...management-api-v0.27.7) (2026-06-02)


### Bug Fixes

* **gateway:** authorize Caddy route domains for TLS ask ([19439d0](https://github.com/zuohuadong/supacloud/commit/19439d0d835e86ad22e59bc75213709ec1b17a84))

## [0.27.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.5...management-api-v0.27.6) (2026-06-02)


### Bug Fixes

* **gateway:** strip storage prefix in Caddy routes ([29987fc](https://github.com/zuohuadong/supacloud/commit/29987fc8af61de250337b921ac9ea03f9f308c24))

## [0.27.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.4...management-api-v0.27.5) (2026-06-01)


### Bug Fixes

* **auth:** normalize public oauth client secrets ([#252](https://github.com/zuohuadong/supacloud/issues/252)) ([1f65f1f](https://github.com/zuohuadong/supacloud/commit/1f65f1f4d4ecf3f486f8367057bd5e3b14f3296e))

## [0.27.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.3...management-api-v0.27.4) (2026-05-30)


### Bug Fixes

* **storage:** add CORS headers to Storage API responses ([ca7b50b](https://github.com/zuohuadong/supacloud/commit/ca7b50b8e652892659e507957446825e911d3c68))

## [0.27.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.2...management-api-v0.27.3) (2026-05-29)


### Miscellaneous Chores

* **deps:** mark setup-buildx-action v4 PR merged ([e0cadc5](https://github.com/zuohuadong/supacloud/commit/e0cadc5fa00711c15b4d37a8ccf16ea7a7adbe24))

## [0.27.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.1...management-api-v0.27.2) (2026-05-28)


### Bug Fixes

* **auth:** use ES256 for GoTrue admin proxy ([728eed2](https://github.com/zuohuadong/supacloud/commit/728eed28f242e4861138921a11b4f2702890434b))

## [0.27.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.27.0...management-api-v0.27.1) (2026-05-28)


### Bug Fixes

* **auth:** remove legacy HS256 from jwt_keys to fix GoTrue signing key selection ([eb6675d](https://github.com/zuohuadong/supacloud/commit/eb6675dba15c32bcc31ab0df4f6677b7c7930a2b))

## [0.27.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.26.4...management-api-v0.27.0) (2026-05-28)


### Features

* **auth:** orchestrate dedicated auth domains with Caddy ([d5357ff](https://github.com/zuohuadong/supacloud/commit/d5357ffbbfd4aa3d98d815e8ca1efcf3d87c6544))
* **auth:** orchestrate dedicated auth domains with Caddy ([8b38b29](https://github.com/zuohuadong/supacloud/commit/8b38b29ff76dbd5fecbe0a4e75d619919437e142))
* **tenant-runtime:** persist allocated ports to DB and reuse on restart ([e612962](https://github.com/zuohuadong/supacloud/commit/e6129620ec3bd906a2fc7f15daef0858e420f7f9))


### Bug Fixes

* **auth:** address auth domain review feedback ([0b71e4a](https://github.com/zuohuadong/supacloud/commit/0b71e4afa7ef6dec853d354cb8bb170f6b636294))
* **auth:** address auth domain review feedback ([3dab280](https://github.com/zuohuadong/supacloud/commit/3dab280a62cbbc5ac05e9096d0adf1f17e2eaaa3))

## [0.26.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.26.3...management-api-v0.26.4) (2026-05-27)


### Elegance & Refactoring

* remove Kong gateway provider, hardcode Caddy as sole gateway ([90ae018](https://github.com/zuohuadong/supacloud/commit/90ae018316bbb80d5fdb1d89ccf672c6e4b1c16c))

## [0.26.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.26.2...management-api-v0.26.3) (2026-05-27)


### Bug Fixes

* **gateway:** strip upstream CORS headers in Caddy routes ([#232](https://github.com/zuohuadong/supacloud/issues/232)) ([4670aca](https://github.com/zuohuadong/supacloud/commit/4670acaf08a0c843e9066242542eebf061a9fc6d))

## [0.26.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.26.1...management-api-v0.26.2) (2026-05-27)


### Bug Fixes

* **gateway:** preserve frontend origins in Caddy CORS ([#225](https://github.com/zuohuadong/supacloud/issues/225)) ([5fe9905](https://github.com/zuohuadong/supacloud/commit/5fe9905f2f978399b4cdc2a1985b72935051fc0f))
* stop bootstrapping pgsodium in self-host postgres ([#226](https://github.com/zuohuadong/supacloud/issues/226)) ([3092e1e](https://github.com/zuohuadong/supacloud/commit/3092e1efec0897e1eb32c2a20a8fc9e4bcc00588))

## [0.26.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.26.0...management-api-v0.26.1) (2026-05-27)


### Bug Fixes

* **gateway:** authorize on-demand TLS for frontend custom domains ([6c3a954](https://github.com/zuohuadong/supacloud/commit/6c3a954708e7a18f60c1126f13379295436871ec))
* **gateway:** authorize on-demand TLS for frontend custom domains ([#222](https://github.com/zuohuadong/supacloud/issues/222)) ([7bb18ae](https://github.com/zuohuadong/supacloud/commit/7bb18ae0b120f7e28fcd682924bc85c4d053692c))
* restore frontend caddy routes during reconcile ([#223](https://github.com/zuohuadong/supacloud/issues/223)) ([42e5aa1](https://github.com/zuohuadong/supacloud/commit/42e5aa1f42ab1cdb37a7f621dcc854efa2e28509))


### Elegance & Refactoring

* **gateway:** move CORS enforcement from application layer to Caddy ([8cd4c7a](https://github.com/zuohuadong/supacloud/commit/8cd4c7a2dad217e5e4530d44afb0627dd565f2cf))

## [0.26.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.25.1...management-api-v0.26.0) (2026-05-26)


### Features

* add caddy frontend optimization pipeline ([608c164](https://github.com/zuohuadong/supacloud/commit/608c164658f78a95f77defc5a58ccb40016afddd))
* add caddy frontend optimization pipeline ([71c5f2f](https://github.com/zuohuadong/supacloud/commit/71c5f2f933acbbfa6347bfd815d6da280a57c5eb))

## [0.25.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.25.0...management-api-v0.25.1) (2026-05-26)


### Bug Fixes

* **edge-runtime:** tolerate missing functions directory ([ec3cbad](https://github.com/zuohuadong/supacloud/commit/ec3cbadf7080903d26c4e843f6d4f2da90ff3cd2))

## [0.25.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.24.0...management-api-v0.25.0) (2026-05-26)


### Features

* **gateway:** replace kong default edge with caddy ([6bdcfaf](https://github.com/zuohuadong/supacloud/commit/6bdcfafc1d2784616be476c0d47d7030cc809ee7))

## [0.24.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.23.0...management-api-v0.24.0) (2026-05-26)


### Features

* PGMQ queue compatibility and postgres CI trigger ([#213](https://github.com/zuohuadong/supacloud/issues/213)) ([08ddac4](https://github.com/zuohuadong/supacloud/commit/08ddac4e0af75460734706ab4047874321d24f00))
* PGMQ queue compatibility, postgres CI path trigger, and SDK migration ([#214](https://github.com/zuohuadong/supacloud/issues/214)) ([418ef8d](https://github.com/zuohuadong/supacloud/commit/418ef8dcd40a1aa11b312796fdc32f3219d916a8))

## [0.23.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.22.3...management-api-v0.23.0) (2026-05-26)


### Features

* add database scaling controls ([0ea03ae](https://github.com/zuohuadong/supacloud/commit/0ea03ae570461ddfb7f2c597ab94bb3db439895b))

## [0.22.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.22.2...management-api-v0.22.3) (2026-05-26)


### Bug Fixes

* **realtime:** keep systemd unit upgrade-safe ([d63fa82](https://github.com/zuohuadong/supacloud/commit/d63fa829afdd473565dbf66e7b3391b69758ec28))

## [0.22.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.22.1...management-api-v0.22.2) (2026-05-26)


### Bug Fixes

* align storage health checks with tenant runtime ([#201](https://github.com/zuohuadong/supacloud/issues/201)) ([457c90a](https://github.com/zuohuadong/supacloud/commit/457c90a4f354703f21c55156aba7f0da20234930))
* cap background queue control-plane pressure ([ac1c62f](https://github.com/zuohuadong/supacloud/commit/ac1c62f3784af66bb8a1a69c4f7ddbb3c83a0097))
* **realtime:** harden global service startup ([9795274](https://github.com/zuohuadong/supacloud/commit/9795274550328645dd365977dea81c0623ba85e2))

## [0.22.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.22.0...management-api-v0.22.1) (2026-05-25)


### Bug Fixes

* **upgrade:** tune edge runtime systemd capacity with daemon-reload ([a4fedf5](https://github.com/zuohuadong/supacloud/commit/a4fedf5d526314d5a94ed8feefa698d8bbea5fab))

## [0.22.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.21.6...management-api-v0.22.0) (2026-05-25)


### Features

* add LISTEN/NOTIFY wakeups to background worker and fix storage mimetype ([72f91c9](https://github.com/zuohuadong/supacloud/commit/72f91c9e778b0ea6c9d9161d282f6b71a018e45e))


### Performance Improvements

* raise background task concurrency cap ([dbbfb27](https://github.com/zuohuadong/supacloud/commit/dbbfb27cb6bb18b8b99ca4fca311dbe98289bc4e))

## [0.21.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.21.5...management-api-v0.21.6) (2026-05-25)


### Bug Fixes

* **storage:** preserve object mimetype on downloads ([e7142da](https://github.com/zuohuadong/supacloud/commit/e7142da0636bd0689c9dbb7d6dd6ad355679f969))

## [0.21.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.21.4...management-api-v0.21.5) (2026-05-25)


### Bug Fixes

* spawn static workers from release binary path ([#191](https://github.com/zuohuadong/supacloud/issues/191)) ([88a79fc](https://github.com/zuohuadong/supacloud/commit/88a79fc4675f413af22d7d3aa37b3fd7ccddd3df))

## [0.21.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.21.3...management-api-v0.21.4) (2026-05-24)


### Bug Fixes

* **management-api:** isolate static serve entrypoint ([#189](https://github.com/zuohuadong/supacloud/issues/189)) ([2e2cf3a](https://github.com/zuohuadong/supacloud/commit/2e2cf3a5f460d5f674bd995cb97e70da130043de))

## [0.21.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.21.2...management-api-v0.21.3) (2026-05-24)


### Bug Fixes

* **management-api:** use release binary for frontend static units ([#187](https://github.com/zuohuadong/supacloud/issues/187)) ([ce51480](https://github.com/zuohuadong/supacloud/commit/ce51480fedaf0a86ef62b0a55e4468ac1b1e165e))

## [0.21.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.21.1...management-api-v0.21.2) (2026-05-24)


### Bug Fixes

* add management-api.env to frontend systemd unit template ([93299eb](https://github.com/zuohuadong/supacloud/commit/93299eba1dbecd4c706054c29e2aa93015b5fba9))
* **management-api:** allow new supacloud task headers ([c31eb75](https://github.com/zuohuadong/supacloud/commit/c31eb75d15a3ffcd2942e536ea1938c056b20ac8))

## [0.21.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.21.0...management-api-v0.21.1) (2026-05-24)


### Bug Fixes

* add management-api.env to frontend systemd unit template ([#184](https://github.com/zuohuadong/supacloud/issues/184)) ([12b9fd8](https://github.com/zuohuadong/supacloud/commit/12b9fd872afb8edfbd2fd319f1fcfa98d22537e9))
## [0.21.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.20.4...management-api-v0.21.0) (2026-05-24)


### Features

* wrap queue APIs in supacloud js ([5b29872](https://github.com/zuohuadong/supacloud/commit/5b298726e9d4950b9a97fe76ddba77705bea5039))

## [0.20.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.20.3...management-api-v0.20.4) (2026-05-24)


### Bug Fixes

* separate platform mirror table, invoker circuit breaker, WorkerPool NaN metrics ([#177](https://github.com/zuohuadong/supacloud/issues/177)) ([2b31821](https://github.com/zuohuadong/supacloud/commit/2b31821d83276f73af9b6267e32fcdef2c098784))

## [0.20.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.20.2...management-api-v0.20.3) (2026-05-24)


### Bug Fixes

* **management-api:** validate background invoker users ([63bb67f](https://github.com/zuohuadong/supacloud/commit/63bb67f11c85e6862cb76e909a9315815be9cd26))

## [0.20.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.20.1...management-api-v0.20.2) (2026-05-23)


### Bug Fixes

* harden static serve edge cases ([121a2f5](https://github.com/zuohuadong/supacloud/commit/121a2f5558d721e0653d7acf9317d8befeea5fc7))

## [0.20.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.20.0...management-api-v0.20.1) (2026-05-23)


### Bug Fixes

* resolve storage project refs from routing config ([#170](https://github.com/zuohuadong/supacloud/issues/170)) ([b15ff95](https://github.com/zuohuadong/supacloud/commit/b15ff9580825665fba3e68a13827d9fffcdfceaa))

## [0.20.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.19.5...management-api-v0.20.0) (2026-05-23)


### Features

* **management-api:** add static-serve subcommand for binary-versioned frontend hosting ([da162e8](https://github.com/zuohuadong/supacloud/commit/da162e8245e1ded15a566fdec8461b63e6bf294a))

## [0.19.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.19.4...management-api-v0.19.5) (2026-05-22)


### Bug Fixes

* **config:** raise background task concurrency default to 20 ([1c3cf09](https://github.com/zuohuadong/supacloud/commit/1c3cf099e20b07f96684409451bdcadbfebacfc9))

## [0.19.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.19.3...management-api-v0.19.4) (2026-05-22)


### Bug Fixes

* **db:** add migration for legacy deployment_history schema ([#163](https://github.com/zuohuadong/supacloud/issues/163)) ([dfdf811](https://github.com/zuohuadong/supacloud/commit/dfdf811a554c1713f95e74c3154b30244d310d25))
* **management-api:** run background function tasks concurrently ([fad97e5](https://github.com/zuohuadong/supacloud/commit/fad97e50ed043f3119defbd2b0f8b253274e70d0))

## [0.19.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.19.2...management-api-v0.19.3) (2026-05-22)


### Bug Fixes

* propagate background idempotency keys ([1365f13](https://github.com/zuohuadong/supacloud/commit/1365f13b7e6f6811bb3fec5ded1aaf2a63c161b1))

## [0.19.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.19.1...management-api-v0.19.2) (2026-05-21)


### Bug Fixes

* **schema:** fold task queue patch into baseline ([2fd702b](https://github.com/zuohuadong/supacloud/commit/2fd702bbdf7357b81cca000213386e3453995e25))

## [0.19.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.19.0...management-api-v0.19.1) (2026-05-20)


### Bug Fixes

* add body schema to /auth/login and /auth/verify routes ([#159](https://github.com/zuohuadong/supacloud/issues/159)) ([5ff346d](https://github.com/zuohuadong/supacloud/commit/5ff346d7167eb338d2531c672b4fa9b7b14b5de5))

## [0.19.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.11...management-api-v0.19.0) (2026-05-20)


### Features

* add diagnostics and oauth jwks support ([96e619a](https://github.com/zuohuadong/supacloud/commit/96e619a532f5f16b4b0d08ed9662bc6c6053dbb2))

## [0.18.11](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.10...management-api-v0.18.11) (2026-05-20)


### Bug Fixes

* harden backup timeout with system command and add WebSocket idle timeout ([#157](https://github.com/zuohuadong/supacloud/issues/157)) ([12543c2](https://github.com/zuohuadong/supacloud/commit/12543c2afb9ee0af4b4547a934f9f7502dd737a1))

## [0.18.10](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.9...management-api-v0.18.10) (2026-05-19)


### Bug Fixes

* **edge-runtime:** tolerate runtime env version skew ([6e19758](https://github.com/zuohuadong/supacloud/commit/6e19758f3370c683ed5d1e8a71f696c42555f150))
* harden backup timeout, shell abort, realtime trigger, and service health checks ([#154](https://github.com/zuohuadong/supacloud/issues/154)) ([e0e2d1e](https://github.com/zuohuadong/supacloud/commit/e0e2d1e947ca639213123faef012281ad7ee4600))

## [0.18.9](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.8...management-api-v0.18.9) (2026-05-18)


### Bug Fixes

* backup timeout and dashboard i18n hardcoded Chinese ([#142](https://github.com/zuohuadong/supacloud/issues/142)) ([05c4bc4](https://github.com/zuohuadong/supacloud/commit/05c4bc492eff9597f56ec60c288f33f460658efe))

## [0.18.8](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.7...management-api-v0.18.8) (2026-05-18)


### Bug Fixes

* resolve Studio Core infinite loop and multiple UI bugs ([#140](https://github.com/zuohuadong/supacloud/issues/140)) ([0bd82a1](https://github.com/zuohuadong/supacloud/commit/0bd82a1f45dca7503f5ba2a877aab750a5f70c76))

## [0.18.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.6...management-api-v0.18.7) (2026-05-18)


### Bug Fixes

* correct config routes and console init guard ([#138](https://github.com/zuohuadong/supacloud/issues/138)) ([1811293](https://github.com/zuohuadong/supacloud/commit/18112931562b3a5dba75b89ecf1e71c0f7262835))

## [0.18.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.5...management-api-v0.18.6) (2026-05-18)


### Bug Fixes

* harden web console API and stream handling ([#136](https://github.com/zuohuadong/supacloud/issues/136)) ([f208679](https://github.com/zuohuadong/supacloud/commit/f20867956d32866f2d8ee99272f697f42d0c3f58))

## [0.18.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.4...management-api-v0.18.5) (2026-05-18)


### Bug Fixes

* improve error handling, extension parsing, and static assets fallback ([#134](https://github.com/zuohuadong/supacloud/issues/134)) ([8d9289e](https://github.com/zuohuadong/supacloud/commit/8d9289e0e70e74d8855fe75617350abea5d0f1d7))

## [0.18.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.3...management-api-v0.18.4) (2026-05-18)


### Bug Fixes

* API error handling - prevent connection reset on DB errors ([#132](https://github.com/zuohuadong/supacloud/issues/132)) ([5a63da1](https://github.com/zuohuadong/supacloud/commit/5a63da1e168e91b1d8bd995c41094da1e51d04af))

## [0.18.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.2...management-api-v0.18.3) (2026-05-17)


### Bug Fixes

* guard one_time_tokens user fk migration ([#130](https://github.com/zuohuadong/supacloud/issues/130)) ([4d3019f](https://github.com/zuohuadong/supacloud/commit/4d3019f7cff9ef768b4e277b43fb4fb295ecd719))
* make ALTER_TENANT_SQL idempotent for existing tables with missing columns ([#125](https://github.com/zuohuadong/supacloud/issues/125)) ([d6d4f73](https://github.com/zuohuadong/supacloud/commit/d6d4f734287124239d6f73d82df6715fe45ffeda))
* resolve PR [#126](https://github.com/zuohuadong/supacloud/issues/126) blocking issues (user_id backfill + GraphQL stub) ([#129](https://github.com/zuohuadong/supacloud/issues/129)) ([e9f2a07](https://github.com/zuohuadong/supacloud/commit/e9f2a07d594e92543839f5c55e40cd61e0d740cd))

## [0.18.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.1...management-api-v0.18.2) (2026-05-17)


### Bug Fixes

* add Studio root route and management API route to setupMasterRoutes ([#123](https://github.com/zuohuadong/supacloud/issues/123)) ([1a3fb40](https://github.com/zuohuadong/supacloud/commit/1a3fb40a93077ca55ea41166a5a7f451b9ca2ede))
* auto-run tenant schema migrations during startRuntime ([#121](https://github.com/zuohuadong/supacloud/issues/121)) ([ba4f8cb](https://github.com/zuohuadong/supacloud/commit/ba4f8cb96fbf98b927e556868f39d7cf73530571))

## [0.18.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.18.0...management-api-v0.18.1) (2026-05-16)


### Bug Fixes

* runtime bootstrap fixes for v0.18.0 ([#118](https://github.com/zuohuadong/supacloud/issues/118)) ([848e17c](https://github.com/zuohuadong/supacloud/commit/848e17c6296e96e2fd03cb7c5961a55d544e2af5))

## [0.18.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.17.0...management-api-v0.18.0) (2026-05-16)


### Features

* add project OAuth/OIDC migration ([c89a890](https://github.com/zuohuadong/supacloud/commit/c89a890ec9d18bb64be7160f63ee5d6b432eb6c2))
* add queue client api ([0de46f7](https://github.com/zuohuadong/supacloud/commit/0de46f7d416999fad55c8f7a2e20d2e612678d35))
* **auth:** add Webhooks, SSO/SAML, and MFA management APIs for Studio parity ([751daa1](https://github.com/zuohuadong/supacloud/commit/751daa13922121911ba79b88bc8fba585e92eff9))
* **background:** make async routing server-driven ([3c748fd](https://github.com/zuohuadong/supacloud/commit/3c748fde19d8643ae7b81c2f5064d3371cae06c6))
* **cli:** add postgres config, pooler, network-restrictions, and storage policies endpoints ([831287b](https://github.com/zuohuadong/supacloud/commit/831287b8bc3bf0c78c763f65fa9640592ee3704f))
* **core:** harden realtime scale limits, dynamic PK resolution, and log retrieval ([716e908](https://github.com/zuohuadong/supacloud/commit/716e908d9cc64a5dd4b4cd3e8cd9e880a3e4e492))
* **core:** integrate official walrus architecture to realtime schema ([8f33ecf](https://github.com/zuohuadong/supacloud/commit/8f33ecf57f55afd3bd78604e9f84cf5c674e2eeb))
* **core:** Native Supabase compatibility fixes for Realtime, Storage RLS, and Edge Functions ([8a76cf8](https://github.com/zuohuadong/supacloud/commit/8a76cf87e05a01db81c1e037eefb9d6a3419c6dc))
* **edge-functions:** implement per-function verify_jwt configuration ([7dcddf1](https://github.com/zuohuadong/supacloud/commit/7dcddf1a80c40f3023e38af9e7ed2d4ff5e14c22))
* **edge-runtime:** natively expose core SUPABASE_* variables to Deno function sandbox ([1d718c1](https://github.com/zuohuadong/supacloud/commit/1d718c17545606e4575d18c04f8ab89fa5b0a823))
* **extensions:** expand auto-install whitelist with pg_cron, pgvector, postgis, pgaudit ([a7f06c7](https://github.com/zuohuadong/supacloud/commit/a7f06c72523f6a7fb630397cc91fc9ee2dd53123))
* **gateway:** manage certificates through Kong ([b76d519](https://github.com/zuohuadong/supacloud/commit/b76d519953732f1dc5a827abbffd8f2a3e95fe65))
* improve database sql cli workflows ([cd405b7](https://github.com/zuohuadong/supacloud/commit/cd405b7a667b62a9e98c2216fc772b0f64dc59cc))
* **management-api:** abstract realtime tenant routing and config fallbacks for sdk parity ([d24132f](https://github.com/zuohuadong/supacloud/commit/d24132fac362320ac27c2c4433151001d15c7826))
* **management-api:** add Swagger detail annotations to all 121 route handlers ([fe0e63f](https://github.com/zuohuadong/supacloud/commit/fe0e63f308d1a54dd97ee178569eb5f2b3a2db17))
* **management-api:** add tenant-scoped custom path rate limiting via Kong ([5df0362](https://github.com/zuohuadong/supacloud/commit/5df0362e8959ba9f9d3537dd29b8e5c78f7d7602))
* **management-api:** add web console tasks tracking & custom rate limits UI ([7891f83](https://github.com/zuohuadong/supacloud/commit/7891f83981ae2f476f8faf293bc60d1f89478285))
* **management-api:** implement S3 fetch adapter and improve shared CI database routing ([78ceecd](https://github.com/zuohuadong/supacloud/commit/78ceecd35e0b606f387c15803c4ff58b5c12fcdc))
* **management-api:** use async getProjectRef and update edge runtime config to use external config.ts bindings ([c5bfac5](https://github.com/zuohuadong/supacloud/commit/c5bfac5236186b0282b04835288612828724620e))
* **mcp:** expose edge function logs and update tools documentation ([6ac5db3](https://github.com/zuohuadong/supacloud/commit/6ac5db34b56c22f5c99887a29deb4408b10862ab))
* optimize tenant runtime lifecycle ([c180807](https://github.com/zuohuadong/supacloud/commit/c18080793693e8a65fcba59f2289628065ab0239))
* **platform:** massive stabilization update across edge-runtime, mcp, routing, and sdk-proxy compatibility ([a94d84f](https://github.com/zuohuadong/supacloud/commit/a94d84f056714eff210739ef0cef3da7f0b5f0be))
* **proxy:** align management API and realtime service with official Supabase parity ([a13797d](https://github.com/zuohuadong/supacloud/commit/a13797de104f0aeb89517611282bd018eb66468c))
* **realtime:** enrich LISTEN/NOTIFY triggers with full OLD/NEW records and auto-attach DDL event trigger ([142d946](https://github.com/zuohuadong/supacloud/commit/142d94624fc6367d6f51c2ce95fb9aa27f37bb9c))
* **realtime:** replace docker realtime dependency with native SupaCloud Elysia implementation ([9a16130](https://github.com/zuohuadong/supacloud/commit/9a16130ca7a2ea0923a2bc2eae4c3b16abf78903))
* **runtime:** manage PostgREST lifecycle state ([69e3e5a](https://github.com/zuohuadong/supacloud/commit/69e3e5a60cce78a2c122af23ae06dba9f0dd54a1))
* **schema:** add PostgREST pre-request context + supabase_migrations schema for CLI compatibility ([7d578c6](https://github.com/zuohuadong/supacloud/commit/7d578c633f8406ad366723520823df778f3e9633))
* **sdk/e2e:** finalize sdk proxy passthrough and structural snapshot tests ([1fe15b4](https://github.com/zuohuadong/supacloud/commit/1fe15b4e726602f7255ba2b64dbd0be8fc7252ee))
* **self-host:** add PG18 compose stack and refresh tenant env ([d248bbf](https://github.com/zuohuadong/supacloud/commit/d248bbf3f6353429cd9567b4cfb70badb4df5a73))
* **studio:** real TypeScript type generation and pg_stat usage metrics ([2d32b9c](https://github.com/zuohuadong/supacloud/commit/2d32b9c175232d9db559ac045172916a5c916c96))
* **system:** add realtime CDC prerequisites setup and imaginary proxy enhancements ([6ef3491](https://github.com/zuohuadong/supacloud/commit/6ef3491109cbe299a0accaf4c0774ad75c788d53))
* **tasks:** deploy background task and message queue features to servers ([83d9062](https://github.com/zuohuadong/supacloud/commit/83d90626df765c99a96b5d93ed103e4452a5db4d))
* updates and fixes based on recent local changes ([79940f4](https://github.com/zuohuadong/supacloud/commit/79940f47578d4db4f4f133c08645d0c635c71a8d))
* **web-console:** integrate realtime health, custom domains and oauth panels ([1fe15b4](https://github.com/zuohuadong/supacloud/commit/1fe15b4e726602f7255ba2b64dbd0be8fc7252ee))


### Bug Fixes

* add function invoke route, repair stale projects, web-console deployment ([7cf073b](https://github.com/zuohuadong/supacloud/commit/7cf073b2b31cf2cf814fd2e5dcffbf55cc9fc224))
* add global error handlers to prevent silent crashes and log fatal errors ([48c4ec9](https://github.com/zuohuadong/supacloud/commit/48c4ec9baea7656f1efadbeaa70f709b2cb2b581))
* add JWT_SECRET fallback and Kong env vars to installer ([69edf44](https://github.com/zuohuadong/supacloud/commit/69edf449092c1ff6117dc5057a0839adf8e68c76))
* add JWT_SECRET fallback and Kong env vars to installer ([96390c1](https://github.com/zuohuadong/supacloud/commit/96390c193cc0c40d21dd2f69d7d791fe1b908de2))
* align vanity-subdomains endpoint to OpenAPI spec and drop @aws-sdk/client-s3 ([c23b85b](https://github.com/zuohuadong/supacloud/commit/c23b85bdd7ad9444d3f22aef69bba2eb3e097344))
* allow supacloud async cors headers ([a807129](https://github.com/zuohuadong/supacloud/commit/a807129003fa39752c454034adedd4b090bf8179))
* auth middleware response format mismatch with route schemas ([#107](https://github.com/zuohuadong/supacloud/issues/107)) ([6d5be0f](https://github.com/zuohuadong/supacloud/commit/6d5be0fee54fc1879dbab6552bd785d5c7acb04e))
* **auth,infra:** 401 pre-flight and all-in-one local docker ([e201d45](https://github.com/zuohuadong/supacloud/commit/e201d458280e084837c3d690c6296ed3f4545598))
* **auth:** accept project service role on management routes ([e458c85](https://github.com/zuohuadong/supacloud/commit/e458c85f168e007565f25e4a3edfd6e4da42ea2d))
* **auth:** forward pagination and search params to GoTrue for admin list users route ([035b47a](https://github.com/zuohuadong/supacloud/commit/035b47a6256e20e803aa0804fea422a4322699c7))
* **auth:** respect mailer_autoconfirm setting when global SMTP is configured ([463ca44](https://github.com/zuohuadong/supacloud/commit/463ca448912ebc539ee8f2d63925dc1aee27fdbe))
* **auth:** restore empty string fallback for OpenAPI enum compliance ([51e5f5e](https://github.com/zuohuadong/supacloud/commit/51e5f5e1eb5a8c2253b3a596a0966007423180db))
* call checkKongConnectivity inside setupMasterRoutes ([58d5a87](https://github.com/zuohuadong/supacloud/commit/58d5a876f82abd5bb3bb3dc3a3337a266afe49d1))
* **ci:** align test schema with official supabase-js migrations for 100% SDK compatibility ([0bd382e](https://github.com/zuohuadong/supacloud/commit/0bd382e571c5fa16432b579db32cf719259fc39d))
* **ci:** fix E2E tests db insertion returning undefined and fix missing jwtSecret in CI tests ([4a9626c](https://github.com/zuohuadong/supacloud/commit/4a9626cc71993ccaab5b48d2c8151597648aa2b3))
* **ci:** fix EdgeRuntime 9000 port collision with Minio and prevent Project creation edge crashes ([6d50913](https://github.com/zuohuadong/supacloud/commit/6d509136d72c88727a642c3aad2cc51cd2f7df99))
* **ci:** make official SDK compliance non-blocking tracking metric ([b7ac8ec](https://github.com/zuohuadong/supacloud/commit/b7ac8ecda21cd5d9ba530213bafd59fd4e1f115c))
* **ci:** normalize release changelog headings ([63f3f4d](https://github.com/zuohuadong/supacloud/commit/63f3f4d37c951f7493cada1cd09e37dfa7eb19ca))
* **ci:** provide websocket for sdk compliance ([3991e17](https://github.com/zuohuadong/supacloud/commit/3991e17009128349ba67cdaff01c4333a5060566))
* **ci:** remove sql.end() from mid-pipeline compliance scripts to prevent connection poisoning ([86e94c1](https://github.com/zuohuadong/supacloud/commit/86e94c15451c1cea9c5c8223cc9ccc24c983ec67))
* **ci:** repair release asset upload ([2f616a4](https://github.com/zuohuadong/supacloud/commit/2f616a4f602ef1f56ed21ad3edd880e63dfe9f41))
* **ci:** repair unit test syntax and SDK parity monorepo compatibility ([ec73e4e](https://github.com/zuohuadong/supacloud/commit/ec73e4ea354e439ec2473f8cd8741b8817715fd3))
* **ci:** resolve EdgeRuntime port collision and API schema validation errors in integration tests ([3b834f7](https://github.com/zuohuadong/supacloud/commit/3b834f708fc4591954aa3f417af5186a2e1a712c))
* **ci:** resolve FK constraint violation in CLI compliance and make all compliance scripts non-blocking ([1248ae6](https://github.com/zuohuadong/supacloud/commit/1248ae6f8d0bcb1b9ee75e87efeedd7a8f3f3871))
* **ci:** retry official cli bootstrap downloads ([dfef728](https://github.com/zuohuadong/supacloud/commit/dfef7289193a6ffa79d9946fb83f100b69551859))
* **ci:** rewrite CLI compliance tests to use --db-url for self-hosted mode ([21c6c3f](https://github.com/zuohuadong/supacloud/commit/21c6c3f36852758500991fa825bf194f11a21985))
* **ci:** robust environment flag checks and S3 array buffer type coercions ([ab7ed12](https://github.com/zuohuadong/supacloud/commit/ab7ed127cdee071e54b52165ebe4a5d67f2da502))
* **ci:** use ascii release notes sections ([2fde822](https://github.com/zuohuadong/supacloud/commit/2fde8225e9a01077e09308c88dd982e81368c90e))
* **cli:** push migrations through management API ([2d5827e](https://github.com/zuohuadong/supacloud/commit/2d5827e1adb3cc5617f2a994c6280013b5e85a1a))
* **cli:** push migrations via management api ([8d45c6e](https://github.com/zuohuadong/supacloud/commit/8d45c6e2b0525396b699094b3b2c737cb169eac1))
* **compat:** complete Supabase parity hardening for DB extensions, Signed URLs and API tests ([c2aff1e](https://github.com/zuohuadong/supacloud/commit/c2aff1e2da7804ec5c4eeade09414ced0e40c159))
* **compatibility:** address P0, P1, and P2 compatibility issues ([26bc5ab](https://github.com/zuohuadong/supacloud/commit/26bc5ab4e063b0f321576e5c4c7c03eb8991cbe2))
* **compatibility:** address realtime array ids, ws cleanup, and schema dependencies ([4821b09](https://github.com/zuohuadong/supacloud/commit/4821b092ea1e06205cc6f912cf4de3a8b872a191))
* **compat:** make database schema loading idempotent, sync runtime roles, and move upload state to postgres ([6d09ad3](https://github.com/zuohuadong/supacloud/commit/6d09ad31fe4ed1287d5c4ef21e5e22177d517417))
* **compat:** make full supabase schema idempotent, enforce RLS on signed uploads, scope db_user grants, and fix health probe ([4c8d616](https://github.com/zuohuadong/supacloud/commit/4c8d616fc1ae952f8f8c08701d649fd5ebcfbde3))
* **compat:** replace Deno.env.get with bun-native Bun.env[] in edge function templates ([55d7509](https://github.com/zuohuadong/supacloud/commit/55d750902835ec5fd964683b8791ddaa6098c5c4))
* **compat:** replace postgres driver with native bun:sql for edge auth closures ([e1000f7](https://github.com/zuohuadong/supacloud/commit/e1000f7d95fde0e37ed2f23a4b0752d9e4b87dac))
* **compat:** resolve deep semantic deviations spanning Realtime, Auth, and Storage ([89c5046](https://github.com/zuohuadong/supacloud/commit/89c5046f705edb8a8c4e663a6f526cf674768a4e))
* **compat:** resolve Remaining P0 SDK mismatches for Storage response formats ([c65f835](https://github.com/zuohuadong/supacloud/commit/c65f83519b3f5e24371bcb84db498821d3d9dabe))
* **compat:** resolve Remaining P1/P2 Storage and auth issues from Phase 19 audit ([f1acca5](https://github.com/zuohuadong/supacloud/commit/f1acca56e92826b8f2b8919756b08f7b156b0a87))
* **compat:** resolve storage runtime metadata fidelity and explicitly link custom provider physical identities using postgres bindings ([43fe3a2](https://github.com/zuohuadong/supacloud/commit/43fe3a2109217f8936ce6ed1d4c3c367376ac0c7))
* **compat:** StorageRLS return truthiness, phantom dry-run objects, schema grants order, and Edge JWT_SECRET injection ([a88c8bf](https://github.com/zuohuadong/supacloud/commit/a88c8bfdda1cc3a13532ce0a3146ea6dd3aece38))
* **compat:** use bunjs native postgres import for edge functions instead of deno url ([bc140d6](https://github.com/zuohuadong/supacloud/commit/bc140d6d35a999573b74cfdf493e76318f9c513f))
* **core:** apply full supabase.sql schema during project bootstrap ([eb66181](https://github.com/zuohuadong/supacloud/commit/eb66181e5dca90034d4aca9b0eb1f3bda5a16640))
* **core:** harden infrastructure, sys roles, and pipeline cleanups ([73edddd](https://github.com/zuohuadong/supacloud/commit/73edddde76216deff2733fda051daa6120242bbb))
* **db:** add migration to enforce ON DELETE CASCADE on project_tasks FK ([b754936](https://github.com/zuohuadong/supacloud/commit/b754936587edfad1661a705829ff1b9017fd2de3))
* **db:** remove index creation from ddlQuery to avoid execution failure on partial schema ([8c048c3](https://github.com/zuohuadong/supacloud/commit/8c048c3ce1f4f9439fda73bb207557b51c1c6052))
* **db:** use sql.unsafe for sequential DDL execution to prevent prepared statement errors ([92844c0](https://github.com/zuohuadong/supacloud/commit/92844c09fe51d40ea1ae6a075492fb0b1f954e3b))
* **deps:** remove dredd, upgrade MCP SDK, override hono/path-to-regexp to eliminate 26 audit vulnerabilities ([123b12a](https://github.com/zuohuadong/supacloud/commit/123b12a6c09c354e318eb8e3544752d7c4646e5a))
* **e2e:** fix storage routing, postgrest schema reload, and CI gotrue boot crashes ([335c701](https://github.com/zuohuadong/supacloud/commit/335c701fc208ea0a8e08911c6656a82105141ea8))
* **e2e:** force storage to use postgres global database in proxy mode and debug gotrue boot ([d96d4f1](https://github.com/zuohuadong/supacloud/commit/d96d4f12aa498e3468a3687a7e08e1d3c41c3615))
* **e2e:** mock task workers and dynamically provision minio bucket in CI via AWS SDK ([1694cb5](https://github.com/zuohuadong/supacloud/commit/1694cb5ba8cacdf4e585b872b0b456306a9d1bf6))
* **e2e:** resolve 6 CI test failures ([4f14000](https://github.com/zuohuadong/supacloud/commit/4f140006faf8dde9ffca1e18ffba5dabff439cf3))
* **e2e:** resolve multiple syntax errors, s3 provisioning mock and bucket snapshot error mapping ([14f80ee](https://github.com/zuohuadong/supacloud/commit/14f80eed39cba679123b416332670870b5342937))
* **e2e:** stabilize CI pipeline by bypassing realtime provision and natively bootstrapping storage tables ([bfced76](https://github.com/zuohuadong/supacloud/commit/bfced7669a0e95261479674fa2a938bc0a85fbf9))
* **e2e:** switch ci postgres connection to supabase_admin to bypass auth namespace permission denied ([229ac88](https://github.com/zuohuadong/supacloud/commit/229ac8860f0379b945750af44e80bac6c6810a1f))
* **edge-runtime:** avoid double-managed runtime restarts ([ff3c82c](https://github.com/zuohuadong/supacloud/commit/ff3c82c4f9f96f51eeec6411b8351d61743445b1))
* **edge-runtime:** bypass verifyJwt for CORS preflight OPTIONS requests to prevent 401 errors ([c1f2164](https://github.com/zuohuadong/supacloud/commit/c1f21643b9337919699d605c5f4e0dfc8e99f934))
* **edge-runtime:** inject Bun function env ([63656e1](https://github.com/zuohuadong/supacloud/commit/63656e107850628d5fa03cde5f1d3432974755d3))
* **edge-runtime:** keep embedded child restarting ([2e1c3f4](https://github.com/zuohuadong/supacloud/commit/2e1c3f4d4deb954f09f7b50b6576755bc577fcfe))
* **edge-runtime:** preserve env for waitUntil tasks ([d72cacc](https://github.com/zuohuadong/supacloud/commit/d72cacc3cffb59cc89af97ce6412f21c2cd82a98))
* **edge-runtime:** preserve env for waitUntil tasks ([2a0f33e](https://github.com/zuohuadong/supacloud/commit/2a0f33ecd17874047c25400aafd7f4d4c9788a6f))
* **edge-runtime:** sync manager port to 9000 to match Kong gateway routes ([00f9a9c](https://github.com/zuohuadong/supacloud/commit/00f9a9cbf6857fcf17d0b7bab7fae9a1e04df3a5))
* explicit @sinclair/typebox dependency to prevent elysia/edge-runtime crash during CI e2e tests proxy boot ([1d38a09](https://github.com/zuohuadong/supacloud/commit/1d38a095904ac29d0cc120b945cd1366a41b3c0d))
* extend rest proxy timeout ([0a00187](https://github.com/zuohuadong/supacloud/commit/0a00187f68b3ef43061d2dae97522cce931b8e2d))
* **functions:** harden runtime routing and diagnostics ([39bb502](https://github.com/zuohuadong/supacloud/commit/39bb502e40cae1d9d256eca37156770c701dd09e))
* **gateway:** allow x-upsert and Cache-Control headers in CORS to support native Supabase SDK storage uploads ([5605f28](https://github.com/zuohuadong/supacloud/commit/5605f28a97f90000603d6bbdec97405bfb4aef16))
* **gateway:** include hosted frontend origins in cors ([03776dd](https://github.com/zuohuadong/supacloud/commit/03776dde46457c6d90747cbe0eb7b4e1c76aed8b))
* **gateway:** increase default Kong timeouts to 500s for AI/OCR inference ([aef2bdf](https://github.com/zuohuadong/supacloud/commit/aef2bdf1e090aabe3160ba44699900e60ea0815d))
* **gateway:** preserve functions proxy path prefix ([35d4ed0](https://github.com/zuohuadong/supacloud/commit/35d4ed0c445b19b510340e655281f741725fbe5d))
* **gateway:** resolve edge runtime startup loops and enhance auth proxy routing stability ([03fa0fe](https://github.com/zuohuadong/supacloud/commit/03fa0fe6171c71226909d17c5134510f54521f94))
* harden management API edge cases ([e8d914d](https://github.com/zuohuadong/supacloud/commit/e8d914d95c6ed6dee06b8eb78bdcfe05b73506d6))
* harden realtime tasks and data-plane boundaries ([c830dc5](https://github.com/zuohuadong/supacloud/commit/c830dc5f9b7b1f7721412864765e6ae1f1dd4a01))
* improve one-click install robustness, add function invoke route, repair stale projects ([acf3365](https://github.com/zuohuadong/supacloud/commit/acf3365c6ee6b4c1fc490ab0eac216e861ff2101))
* **installer:** align pigsty supabase install path ([b4ec59d](https://github.com/zuohuadong/supacloud/commit/b4ec59de669ed5033558d177b4d2c415f699b466))
* **installer:** derive studio domain from API host ([20acff7](https://github.com/zuohuadong/supacloud/commit/20acff72f543dd84a0082fe68640a605f5a5a1c0))
* **install:** skip legacy supabase compose stack ([4d9ab5b](https://github.com/zuohuadong/supacloud/commit/4d9ab5b3098e99f6829bc930cf71b16ec539bdae))
* make production upgrades binary-first ([6d8e401](https://github.com/zuohuadong/supacloud/commit/6d8e40131b88bd6f3a19f8b6c0f6f422dbc20875))
* **management-api:** accept serialized routing config ([a13c2e6](https://github.com/zuohuadong/supacloud/commit/a13c2e6815bce20475e04ca08092543e0d7cab4d))
* **management-api:** add anon rls policies and realtime schema db grants for sdk tests ([f67f86f](https://github.com/zuohuadong/supacloud/commit/f67f86faecfa52bcc365d2ff23587a104c637f3e))
* **management-api:** add missing realtime rls policies to official sdk test suite setup ([25ba911](https://github.com/zuohuadong/supacloud/commit/25ba9111633f528ede90247ac695cc8fe3e9a2f7))
* **management-api:** allow public storage reads on custom domains ([5305431](https://github.com/zuohuadong/supacloud/commit/5305431c6eb61fa22e7b3e7d90d9a6d389824acd))
* **management-api:** comply with rfc 1123 hostname rules and aws s3 specs ([061056f](https://github.com/zuohuadong/supacloud/commit/061056f9f3d646ff332fdba099e848b9f8c3f73b))
* **management-api:** correct proxy ws route to match phoenix websocket mount point exactly ([6020050](https://github.com/zuohuadong/supacloud/commit/602005028d0352ec5180279f0349932f856288ee))
* **management-api:** default to port 9090 ([19b4537](https://github.com/zuohuadong/supacloud/commit/19b45374b71d8e9175d4f8e4dd20fd11162e6019))
* **management-api:** encrypt background task credentials ([4434730](https://github.com/zuohuadong/supacloud/commit/4434730fd584c63d80543c84be19910d630d07ae))
* **management-api:** enforce Swagger route coverage ([3319984](https://github.com/zuohuadong/supacloud/commit/33199848235a3391b9cc832de0271ab5defee74d))
* **management-api:** expose unmasked runtime env internally ([aa30ef7](https://github.com/zuohuadong/supacloud/commit/aa30ef77cb2f12301c0026b79ad96ef706c1b229))
* **management-api:** grant auth roles tenant database access ([cff8ad2](https://github.com/zuohuadong/supacloud/commit/cff8ad23823e81d14925fb49cd046a10ef950924))
* **management-api:** grant postgrest authenticator database access ([0bce5ef](https://github.com/zuohuadong/supacloud/commit/0bce5ef3d3916d067956c4e9f24a3509903cc8d0))
* **management-api:** harden project queue reliability ([4444b8b](https://github.com/zuohuadong/supacloud/commit/4444b8b688c28f31ec9785437de4c028d4598643))
* **management-api:** harden sdk proxy unit test isolation ([b276b3c](https://github.com/zuohuadong/supacloud/commit/b276b3c544d8be06448a236bccd04b2ab1959404))
* **management-api:** harden storage and background contracts ([0970bf9](https://github.com/zuohuadong/supacloud/commit/0970bf9aa9dfc62b4904a58c72c71ffa56cd5e49))
* **management-api:** harden storage list metadata parsing ([44a3139](https://github.com/zuohuadong/supacloud/commit/44a31392d566093f0d74bd141dc7a1117ec95c8e))
* **management-api:** inject internal supabase runtime secrets ([e6358eb](https://github.com/zuohuadong/supacloud/commit/e6358ebf57632b2982365045f4a7c700a351c44c))
* **management-api:** isolate background auth encryption regression ([0ff4be2](https://github.com/zuohuadong/supacloud/commit/0ff4be2edc7aeebe205b97a8f674fc8f11f6e4f2))
* **management-api:** make edge runtime port dynamically configurable from environment ([6adf0f2](https://github.com/zuohuadong/supacloud/commit/6adf0f2c0ecb5f64ad44a65b29ee575a71514002))
* **management-api:** normalize project response timestamps and update functions secrets schema formatting ([a38affb](https://github.com/zuohuadong/supacloud/commit/a38affb26766106461d2fb80127d2f9a05618ff8))
* **management-api:** pin Supabase JS compliance ref ([63c66b0](https://github.com/zuohuadong/supacloud/commit/63c66b0e891efe51ef87bae8d613089ce181d92a))
* **management-api:** reconcile custom domain runtime routes ([4d5509f](https://github.com/zuohuadong/supacloud/commit/4d5509f57a92470b13b27e2472fb94c75fecd076))
* **management-api:** refine s3 ports and storage adapter error handling ([d251fb9](https://github.com/zuohuadong/supacloud/commit/d251fb9d856b7aa5f55a9f3bb5f8c6269a79931e))
* **management-api:** remove malicious sdk parity minio port rewrite and resolve edge-runtime container port collision ([b090a1c](https://github.com/zuohuadong/supacloud/commit/b090a1c320ba57f505bc96f49c15416fb7fec537))
* **management-api:** resolve functions tenants from custom domains ([f45e0ae](https://github.com/zuohuadong/supacloud/commit/f45e0aeea0670ce40c36ddb82abe46668ed5f7c5))
* **management-api:** revert realtime proxy path to use /socket/websocket to fix HTTP 404 dropping connections ([0cc19ec](https://github.com/zuohuadong/supacloud/commit/0cc19ec65ef5b7fb6146a4b8e00eaf2a10fdbf72))
* **management-api:** set duplex on sdk-proxy test requests ([7e24b18](https://github.com/zuohuadong/supacloud/commit/7e24b18f406b7ef5823ad5c8b1745712c3aaf1b2))
* **management-api:** spoof realtime host header and dump api logs on ci failure ([692abe7](https://github.com/zuohuadong/supacloud/commit/692abe73c93266c2c8a4ee5956de5730799dcf85))
* **management-api:** stabilize encrypted background task regression ([b336b8a](https://github.com/zuohuadong/supacloud/commit/b336b8a0d3a8477dbda42b406fac2faa58ad8064))
* **management-api:** strictly align P0/P1 OpenAPI endpoints and refactor Vanity Subdomain schemas ([b5ed7fb](https://github.com/zuohuadong/supacloud/commit/b5ed7fb2426895a166b9b205175fc1afc5e306cd))
* **management-api:** use aws4fetch for robust s3 operations and fix realtime CDC prereqs timeouts ([4e8b5be](https://github.com/zuohuadong/supacloud/commit/4e8b5be10c83a302cee959a9c1ae5e50d81442e7))
* **management-api:** use native S3 fetch adapter for CI uploads and standardize WS proxy headers ([9c949b3](https://github.com/zuohuadong/supacloud/commit/9c949b3c168bc9a6f255b410946589e63ca1494b))
* **management-api:** use node random uuid in sdk proxy ([e720c4c](https://github.com/zuohuadong/supacloud/commit/e720c4cd6df5e714a9d1fb5a88c1143ca1935976))
* materialize juicefs upload streams ([7cfea79](https://github.com/zuohuadong/supacloud/commit/7cfea79acebcce5fca41587abdd99421738e6561))
* materialize storage upload streams ([60c43c9](https://github.com/zuohuadong/supacloud/commit/60c43c9570eb0b0a9f78a9690f7698eb015a600d))
* **openapi:** align ref generation, service health, config responses with official Supabase OpenAPI spec ([905bc26](https://github.com/zuohuadong/supacloud/commit/905bc267b3aaeae50f1cc70acffbd66893684beb))
* **openapi:** resolve TS error for custom hostname data property ([d354901](https://github.com/zuohuadong/supacloud/commit/d35490161c80b9100fb5d7accb0f28d84db62ddb))
* **openapi:** satisfy strict schema enums and ref length requirements ([50086ea](https://github.com/zuohuadong/supacloud/commit/50086ea98b9494d8f9234b1c79a4ed91d2bfc5c5))
* **openapi:** use predefined enums for missing auth config providers instead of empty strings ([ccc1849](https://github.com/zuohuadong/supacloud/commit/ccc1849f833b885e8b2303bf44dc77e00d63944f))
* **pigsty:** align 4.3 upgrade with supacloud storage defaults ([fa95736](https://github.com/zuohuadong/supacloud/commit/fa95736040119d1bbecc8f081a0df364b211ae9c))
* **postgrest:** enable OpenAPI mode, db-pre-request, and single-source config ([84e96a7](https://github.com/zuohuadong/supacloud/commit/84e96a74f2051b1be526a8bd4bcc2a2f487d4ca6))
* provision_runtime fails on Ubuntu due to Group=nobody and missing auth schema ([#110](https://github.com/zuohuadong/supacloud/issues/110)) ([c36f6fb](https://github.com/zuohuadong/supacloud/commit/c36f6fb69447ec066a8d52ccc157ff8b406e392f))
* **proxy:** forward function POST bodies with duplex ([781ed51](https://github.com/zuohuadong/supacloud/commit/781ed51ae2fa70bfec7da1f7db956934fb6c05c3))
* **proxy:** resolve Elysia routing precedence and e2e testing bugs ([81c9d65](https://github.com/zuohuadong/supacloud/commit/81c9d6515aa7bb971f7123baa51853e1d06df2f6))
* **proxy:** update Elysia wildcard routing for correct SDK REST and Auth passthrough ([988acb7](https://github.com/zuohuadong/supacloud/commit/988acb73eb88b1aad486f631f8434012c9e689ee))
* publish background tasks for realtime ([bfe6948](https://github.com/zuohuadong/supacloud/commit/bfe6948c4e189a8240da0baf55c0982f1a5ddf9d))
* **queue:** keep edge functions on dedicated worker ([abe4d7c](https://github.com/zuohuadong/supacloud/commit/abe4d7c0399f896ca147631db04d5ce482f242b7))
* **queue:** migrate foundation worker to stable pg-listen ([97beb1e](https://github.com/zuohuadong/supacloud/commit/97beb1ec469474a2a624d85191c2eec9947a8497))
* **realtime:** connect tenants with admin database credentials ([87f1f33](https://github.com/zuohuadong/supacloud/commit/87f1f33e1aae8c794933319366d04dccd2ba466f))
* **realtime:** correct subscribeTenant arity (TS2554) ([cdaf01f](https://github.com/zuohuadong/supacloud/commit/cdaf01fe920cd9a63a0a7aad764dd2d0f033bd94))
* **realtime:** proxy websocket traffic via management ws ([87edac6](https://github.com/zuohuadong/supacloud/commit/87edac6182f31ed76b36ea74233ec2ee3c961639))
* **realtime:** reconcile missing tenants and use valid enc key ([ef7c3d5](https://github.com/zuohuadong/supacloud/commit/ef7c3d58fbe0e9d6926407b8a53d272ff581ce6f))
* **realtime:** reconcile tenant schema privileges ([31f6435](https://github.com/zuohuadong/supacloud/commit/31f64359b358a76a1038ed86adff27f09cfe2268))
* **realtime:** resolve websocket protocol encoding, path matching, and presence syncs ([e891973](https://github.com/zuohuadong/supacloud/commit/e891973b8556752955760fb3eea78ad642efe16c))
* **realtime:** route websocket through root proxy ([e9e5d5d](https://github.com/zuohuadong/supacloud/commit/e9e5d5da9d287ae5a284179b04f4731845334d6e))
* **realtime:** route WebSocket to self-seeded tenant realtime-dev via host header ([2bc2f77](https://github.com/zuohuadong/supacloud/commit/2bc2f77e9766c582e005284c131e123a701d14e0))
* **realtime:** sign tenant reconcile admin tokens correctly ([79e26f5](https://github.com/zuohuadong/supacloud/commit/79e26f5e94471f8004ee249ce302a10018460bee))
* **realtime:** use node crypto for admin JWT signing ([d6b3ac6](https://github.com/zuohuadong/supacloud/commit/d6b3ac6dee08967efee63850f4cd75868f8e774c))
* resolve unit test and automation suite failures due to ci overriding jwt and absent db configurations ([21e09a4](https://github.com/zuohuadong/supacloud/commit/21e09a4ce2a27cd45839cbad5d4f8223940cd95c))
* restore project reprovisions missing resources ([e1a8f3b](https://github.com/zuohuadong/supacloud/commit/e1a8f3b8e9a95cff315837f5c44ca81b67d4b96f))
* **routing:** unify tenant domain and port resolution ([45f2afe](https://github.com/zuohuadong/supacloud/commit/45f2afee474f40be192b6f319cf6aa67c8613fe4))
* **runtime:** respect ssl config for tenant urls ([bbfa23e](https://github.com/zuohuadong/supacloud/commit/bbfa23e4c004f86f5cf75d7d248a274c95a54e3f))
* **runtime:** respect ssl config for tenant urls ([ce976fe](https://github.com/zuohuadong/supacloud/commit/ce976fe825bc775501d65b8a7bc6291466ec840d))
* **security:** harden storage and proxy surfaces ([f17825b](https://github.com/zuohuadong/supacloud/commit/f17825b410269d8b20947412b8c422a1ce6fff25))
* **services:** mock S3 provision and cleanup in CI mode to prevent destructive saga rollbacks ([988acb7](https://github.com/zuohuadong/supacloud/commit/988acb73eb88b1aad486f631f8434012c9e689ee))
* ship web console with binary upgrades ([56bf95a](https://github.com/zuohuadong/supacloud/commit/56bf95ab7c99ef6866595adef0d3afa2620a50a7))
* skip missing tenant dbs during realtime reconcile ([477300d](https://github.com/zuohuadong/supacloud/commit/477300da3ed24bba579338d826a4c98876c60fa2))
* stabilize edge runtime under binary upgrades ([8a60992](https://github.com/zuohuadong/supacloud/commit/8a609925339e6384cc5322cb567fcdae7f3887ba))
* standardize HTTP status codes in API error responses and improve CI health checks ([1df0b73](https://github.com/zuohuadong/supacloud/commit/1df0b73f6a5c8b9b87e40858759064af377bd300))
* **storage:** add s3 compensatory rollbacks on db materialization drops, and align move/copy verifications ([4a0e82d](https://github.com/zuohuadong/supacloud/commit/4a0e82d28d4f0f7d9c303c0b35233f400e5a5b13))
* **storage:** align listV2 payload schema with supersonic sdk cursor logic, delimit switches, and correct folder signatures ([f294d2f](https://github.com/zuohuadong/supacloud/commit/f294d2f7b16cca88a30b00c23b4d6121ea0ba7d6))
* **storage:** align sdk outputs, append cache-controls, rewrite native id mappings, format schema json boundaries, handle download dispositions and purge social scale traps ([c57e1d4](https://github.com/zuohuadong/supacloud/commit/c57e1d44d6be207642b506ea165e6e907a29fbe7))
* **storage:** align upload Id with official API and fix bucket-not-found status ([f773015](https://github.com/zuohuadong/supacloud/commit/f773015181a09e218efcebb0e5a4bb18b120076c))
* **storage:** bypass Elysia multipart parser to correctly support supabase-js SDK uploads missing body field names ([10eaf8f](https://github.com/zuohuadong/supacloud/commit/10eaf8f3e470e68cb728c3cbdada28a39f4fbff0))
* **storage:** correct wechat compilation, enforce move atomicity, validate upload persistence, and align bucket delete constraints ([9efaa18](https://github.com/zuohuadong/supacloud/commit/9efaa187f85550bd2fd18d4714dc916df38a7c63))
* **storage:** enforce bucket transaction atomicity, query limits, and 23505 constraints ([7ce4164](https://github.com/zuohuadong/supacloud/commit/7ce4164c7cc303f0adb957b33baadaa157586518))
* **storage:** enforce move & tus assertions, isolate admin overriden buckets, format cdn restrictions and insert database defaults ([fd63f85](https://github.com/zuohuadong/supacloud/commit/fd63f8531086819a74502a0c6543b0628c0000cb))
* **storage:** enforce move transactional rollbacks, v1 list search binding, v2 delimiter defaults, and 404 project trace handling ([d2b2c6c](https://github.com/zuohuadong/supacloud/commit/d2b2c6c08efead1864317ccb5d444cb630aa338b))
* **storage:** enforce RLS on existence checks and defer POST/PUT materialization ([d993be7](https://github.com/zuohuadong/supacloud/commit/d993be7cab851993f8a1be64fe03e8ce4cfe87e8))
* **storage:** fix list observability, empty bucket status matching, signed upload checks and delete isolation ([8242cb6](https://github.com/zuohuadong/supacloud/commit/8242cb6fe27f149d37280d41908905e5ad41cef5))
* **storage:** implement list-v2 folder collapsing, apply db mimetypes, and track rollback logging ([b76d932](https://github.com/zuohuadong/supacloud/commit/b76d932ebeff55db9179d7cef8ae86ea46cd1f38))
* **storage:** implement missing endpoints and payload compatibility ([a47e483](https://github.com/zuohuadong/supacloud/commit/a47e48348d4b7b273159d097e29dbcea97502d20))
* **storage:** map list timestamps, enforce tus limits, and resolve public bucket overrides ([7441ea4](https://github.com/zuohuadong/supacloud/commit/7441ea4fbe0836f4e55a6094948a1c7670d49e40))
* **storage:** migrate PUT to use custom multipart buffer boundary extractor ([22d3b9f](https://github.com/zuohuadong/supacloud/commit/22d3b9fd200e7ad9b1f38a1b53663d6d9d31b440))
* **storage:** resolve 100% JS SDK functional compatibility issues ([f583643](https://github.com/zuohuadong/supacloud/commit/f583643445377a15977f519b65000b88fe14696a))
* **storage:** resolve bucket rls coupling, move transactional loops, and list sorting capabilities ([609b764](https://github.com/zuohuadong/supacloud/commit/609b76444f25bf9e1ce24703e4500908f76e2920))
* **storage:** resolve upload TOCTOU concurrency and align official RLS error semantics ([a132ac3](https://github.com/zuohuadong/supacloud/commit/a132ac3386afd71f88eabc3fa159268a39fb91d0))
* **storage:** sniff raw payload to force multipart parsing even when gateway overrides content-type to image/png ([6d80fb3](https://github.com/zuohuadong/supacloud/commit/6d80fb34813f772fc184a032ad6778b3b56a0618))
* **storage:** store raw seconds in cacheControl metadata (official Supabase format) ([b0b6323](https://github.com/zuohuadong/supacloud/commit/b0b6323dcd51130b04c873984f95a33672fc16c2))
* **storage:** stream large uploads through kong ([62614e4](https://github.com/zuohuadong/supacloud/commit/62614e4837969b09af925ed56946fa8c926e961f))
* support github proxies for binary upgrades ([254cb47](https://github.com/zuohuadong/supacloud/commit/254cb474bcd8ac98da7dccc67fce8829c0cca30e))
* **tasks:** allow invoker jwt to read task detail ([73b43a8](https://github.com/zuohuadong/supacloud/commit/73b43a859b78d3d2b393ba0acf01a72616bf3aa5))
* **tasks:** avoid malformed array literal issue in unsafe sql binding for ANY() ([a0edca1](https://github.com/zuohuadong/supacloud/commit/a0edca1eef046fec29955e211c932cfcffa07b42))
* **tasks:** patch tenant queue schema compatibility ([5bf720a](https://github.com/zuohuadong/supacloud/commit/5bf720a5ca57c643a2fe359637f7d8797874c714))
* tolerate sdk proxy background auth introspection failures ([97f7ff5](https://github.com/zuohuadong/supacloud/commit/97f7ff5cc58f1a1bf2a001e787b842c2c38dd748))
* use direct GoTrue port instead of HTTPS API URL to avoid self-signed cert errors ([575db53](https://github.com/zuohuadong/supacloud/commit/575db538903a0d64faf2bab39e135b2fabeab2ac))
* **web-console:** restore settings and task management UI ([f27519e](https://github.com/zuohuadong/supacloud/commit/f27519e0c2b7189caf19e842173c892ee8e8a790))


### Elegance & Refactoring

* **api:** standardize error payload schemas across all routes for Stripe parity ([0459964](https://github.com/zuohuadong/supacloud/commit/0459964d450fe12cfd710b5966b109a0f2f1228c))
* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([7aa6894](https://github.com/zuohuadong/supacloud/commit/7aa68945bee02aa15447698e5990866e36af30d2))
* **core:** use resolveDbName and parameterized queries for schema routing and postgres reflection ([a688ccb](https://github.com/zuohuadong/supacloud/commit/a688ccba98d8e9244e3c217f5b90c6b249fba02a))
* **edge-functions:** migrate version artifacts into internal revisions ([0eae21c](https://github.com/zuohuadong/supacloud/commit/0eae21c3b7577fe01c403bf5a54d458099fe362d))
* **queue:** remove legacy pg-listen implementation ([3316eef](https://github.com/zuohuadong/supacloud/commit/3316eef196f2710ed934eb4c20753562d24e4c6b))
* **realtime:** revert native realtime and restore official docker integration ([0ba5dba](https://github.com/zuohuadong/supacloud/commit/0ba5dbaa457fc726789f441f7f6562eaf650c2cb))
* remove legacy sql result alias ([3b14b89](https://github.com/zuohuadong/supacloud/commit/3b14b894dfb6cdd03304fbec0a5060439e52d3db))
* **runtime:** centralize PostgREST lifecycle control ([6bec0da](https://github.com/zuohuadong/supacloud/commit/6bec0da7ad968b272f4fee83cdbd797bfe7ccc85))


### Performance Improvements

* reduce management hot path load ([954497f](https://github.com/zuohuadong/supacloud/commit/954497fe7b312ac3cdc4778ef4b21bb0e6097a4b))


### Miscellaneous Chores

* align error codes and resolve DB roles in management API ([f59f63b](https://github.com/zuohuadong/supacloud/commit/f59f63bc3a086c90ca260e096afa7c4856d53769))
* bump version (+0.0.1) for management-api and mcp-server ([21ca1c1](https://github.com/zuohuadong/supacloud/commit/21ca1c15b32e99274832189812b311182c8b655d))
* cleanup scratch files and commit modified files ([87c7b52](https://github.com/zuohuadong/supacloud/commit/87c7b5271ed26fa93af2f282df3a40a645cd8c6f))
* **deps:** bump @svadmin/core in /packages/management-api ([#81](https://github.com/zuohuadong/supacloud/issues/81)) ([6b224b4](https://github.com/zuohuadong/supacloud/commit/6b224b44ef8a3664d1a965c29a1657a024f9bd05))
* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/management-api ([#86](https://github.com/zuohuadong/supacloud/issues/86)) ([73bd4f3](https://github.com/zuohuadong/supacloud/commit/73bd4f3fced096d8a25891c39542fc2da7979e86))
* flush remaining test suite fixes and project modifications ([e1b625c](https://github.com/zuohuadong/supacloud/commit/e1b625c707b304f753ebbbd466ddb0046cdfd740))
* **management-api:** translate all remaining Chinese comments to English ([3e6b522](https://github.com/zuohuadong/supacloud/commit/3e6b522b1fc1ff0dc838411ff43a256ab70fd2a3))
* push all accumulated compliance and runtime integrations ([4cb93dd](https://github.com/zuohuadong/supacloud/commit/4cb93dd0a1d21bd0ecdd32a2751fe57fd4374355))
* release main ([06f311e](https://github.com/zuohuadong/supacloud/commit/06f311e419da1693c40b65356609f36a63112901))
* release main ([3c470d4](https://github.com/zuohuadong/supacloud/commit/3c470d49ebaecb19f6e84f521b293f9f23a4f295))
* release main ([0ad39c2](https://github.com/zuohuadong/supacloud/commit/0ad39c25703950b1fbafe492d148dc10fd95cd8c))
* release main ([2a4e9fa](https://github.com/zuohuadong/supacloud/commit/2a4e9fa0c8dd368baf844420e5b216ebbdb87828))
* release main ([7abf76d](https://github.com/zuohuadong/supacloud/commit/7abf76db1f7d0214b96ecc486ab272dd37540f64))
* release main ([6f4c17f](https://github.com/zuohuadong/supacloud/commit/6f4c17ffaa68f5ddee7b2bc31513819c2e0770e8))
* release main ([fd3c559](https://github.com/zuohuadong/supacloud/commit/fd3c559ae272d672e8b3dca2835d76604307620e))
* release main ([6e07685](https://github.com/zuohuadong/supacloud/commit/6e076851178b577aea3651a1b0c78c19f1238a4b))
* release main ([e0317fa](https://github.com/zuohuadong/supacloud/commit/e0317fa71adab2925153c8b7a8460ccf3c21d126))
* release main ([f75e8cd](https://github.com/zuohuadong/supacloud/commit/f75e8cd02814d439a583ee30a5c64005b00eb04a))
* release main ([c36b94e](https://github.com/zuohuadong/supacloud/commit/c36b94e213199b32cfb1d1ce0bb97ad579512b81))
* release main ([e7e6560](https://github.com/zuohuadong/supacloud/commit/e7e6560517e13baf3f72f5553bdb784c1b561d2e))
* release main ([42ac39f](https://github.com/zuohuadong/supacloud/commit/42ac39f6d77a49f88755a3b7fe70f4dd236d5312))
* release main ([fa8b990](https://github.com/zuohuadong/supacloud/commit/fa8b990a9fb44ce6784c07f7d5ef4bccff103952))
* release main ([a0c1c3e](https://github.com/zuohuadong/supacloud/commit/a0c1c3e6d098ac1e789b5495faa1b91faae238c0))
* release main ([44cace4](https://github.com/zuohuadong/supacloud/commit/44cace4ff79f412dab23780e0d155a8ff46d2b3d))
* release main ([9c4b4ab](https://github.com/zuohuadong/supacloud/commit/9c4b4ab4e0776bc6f0929d2a2b1d008c7b3a4701))
* release main ([94f669a](https://github.com/zuohuadong/supacloud/commit/94f669a68c88b2ef6c09e53e5812a36e82ffdf20))
* release main ([414f002](https://github.com/zuohuadong/supacloud/commit/414f002e22078d49e1592f9fb44647de46ab089b))
* release main ([4e741f1](https://github.com/zuohuadong/supacloud/commit/4e741f121110071caa876b0c3e205315b423b590))
* release main ([b783711](https://github.com/zuohuadong/supacloud/commit/b783711ebf1aff4e3d244d5f67f126a461949db9))
* release main ([68c8362](https://github.com/zuohuadong/supacloud/commit/68c83624cba53efd1e2b1338304288336a86f98b))
* release main ([02bad3c](https://github.com/zuohuadong/supacloud/commit/02bad3cf78b8e763fff61e5ca9345c48d7d746ea))
* release main ([bd2f9f2](https://github.com/zuohuadong/supacloud/commit/bd2f9f23ad48ee91201f7224cab79c1a7d36e6ec))
* release main ([14a6849](https://github.com/zuohuadong/supacloud/commit/14a68493a489d60e9cab28c6e4210926ba6e8943))
* release main ([aa0230b](https://github.com/zuohuadong/supacloud/commit/aa0230b870da4e65e26a854e8be1afe4c17575d8))
* release main ([1fd53b8](https://github.com/zuohuadong/supacloud/commit/1fd53b807849285d80b0467ba7a1f9df14ad2c81))
* release main ([9c6863e](https://github.com/zuohuadong/supacloud/commit/9c6863ed9cd1ec9b09c959da28083808e200ddfa))
* release main ([d6657ff](https://github.com/zuohuadong/supacloud/commit/d6657ff2d0f34f7d80fc27a076b203b9d4a4e2bb))
* release main ([ccee104](https://github.com/zuohuadong/supacloud/commit/ccee1046abe95587000d3fb3d8a955acb143ee6d))
* release main ([510d73c](https://github.com/zuohuadong/supacloud/commit/510d73c6b77e815e1210a7a2bdcd999f5f80226e))
* release main ([5876a87](https://github.com/zuohuadong/supacloud/commit/5876a87aa04c79d8a23d73e39b9cec108963cae1))
* release main ([010fefe](https://github.com/zuohuadong/supacloud/commit/010fefe044a1165c16591e10e74613898c5a96de))
* release main ([cc6432a](https://github.com/zuohuadong/supacloud/commit/cc6432aa987f17b011e357584816945cf80ec533))
* release main ([fef7214](https://github.com/zuohuadong/supacloud/commit/fef7214018950c6294e9ede6bc03e9c1cb4494b1))
* release main ([d1cfc6f](https://github.com/zuohuadong/supacloud/commit/d1cfc6f16d702e9e906ccdc839566da2433fa0e6))
* release main ([0848af3](https://github.com/zuohuadong/supacloud/commit/0848af33b2bbc432058e4fc5711824c31bdb6de6))
* release main ([d179e78](https://github.com/zuohuadong/supacloud/commit/d179e786a33f011b3412191b6daadc33a1dc977f))
* release main ([b9cd6f1](https://github.com/zuohuadong/supacloud/commit/b9cd6f102248cd2f19887729f3008f9047b1e07a))
* release main ([dabed32](https://github.com/zuohuadong/supacloud/commit/dabed32838d354cc3f7372d3e09680f5eb21c4fa))
* release main ([e17f4ba](https://github.com/zuohuadong/supacloud/commit/e17f4bafbbe36ccfee36a1674b4cb604979753d9))
* release main ([79c3047](https://github.com/zuohuadong/supacloud/commit/79c304776239076e9506bd4212bdca0a14eaf023))
* release main ([92a9181](https://github.com/zuohuadong/supacloud/commit/92a9181ff9fdd1f8ba59d2712dac70843a6b04ef))
* release main ([b804fb4](https://github.com/zuohuadong/supacloud/commit/b804fb455a06c41f226134e00478cf4f476a35cf))
* release main ([dd285e7](https://github.com/zuohuadong/supacloud/commit/dd285e7de03ba5463c0a44d46435e17c2b47a47c))
* release main ([ba4aeb4](https://github.com/zuohuadong/supacloud/commit/ba4aeb4180cbcb14fd17fff46ff23f563f133c22))
* release main ([e6d169c](https://github.com/zuohuadong/supacloud/commit/e6d169c794c4332371fcf13b52af8cdeedb89d32))
* release main ([5143971](https://github.com/zuohuadong/supacloud/commit/5143971cdebf58c70a196d6f8a0ebb6d188a6b76))
* release main ([f1e303c](https://github.com/zuohuadong/supacloud/commit/f1e303ca003424f1e08fd96c7a5f498bb43d8b01))
* release main ([bebe2c4](https://github.com/zuohuadong/supacloud/commit/bebe2c436ea9935302b5f4fe5ddffc98b51c04d6))
* release main ([3d2dc9e](https://github.com/zuohuadong/supacloud/commit/3d2dc9e68388fc6255ecfa90af363f1a4feaa4d1))
* release main ([c597a22](https://github.com/zuohuadong/supacloud/commit/c597a22d2b36a0e0b327ab77456bde81dbb29525))
* release main ([4c02b71](https://github.com/zuohuadong/supacloud/commit/4c02b7122fc26d4a43cb45576621b94e9073addc))
* release main ([cf795eb](https://github.com/zuohuadong/supacloud/commit/cf795eb4acc0de5e947c23cafe22ab93fe06ed0d))
* release main ([bb8f23a](https://github.com/zuohuadong/supacloud/commit/bb8f23ac5782372a25b48be0c7fa2b7ca92f5f09))
* release main ([4cf3521](https://github.com/zuohuadong/supacloud/commit/4cf35216f83343ce03a46433e5c9894f685f7b53))
* release main ([52434f1](https://github.com/zuohuadong/supacloud/commit/52434f17867c510aed91e0d2e8dbada57a7243b7))
* release main ([368c5d4](https://github.com/zuohuadong/supacloud/commit/368c5d4475f0e3d333b453fead2f350effb10e34))
* release main ([d79a138](https://github.com/zuohuadong/supacloud/commit/d79a1381e52e8231f8b0eeec9efc403e7ade68ce))
* release main ([939c0a4](https://github.com/zuohuadong/supacloud/commit/939c0a44d8d828831cc3b9da26f0d4a538536b72))
* release main ([1433283](https://github.com/zuohuadong/supacloud/commit/143328300650aa4eb7036db536cffb6a8cdea675))
* release main ([e761103](https://github.com/zuohuadong/supacloud/commit/e761103b02817ba0f741bede271777b0a067bb2f))
* release main ([58b455a](https://github.com/zuohuadong/supacloud/commit/58b455a45ffa22c638ec2c1aa59292096b0014cb))
* release main ([7180516](https://github.com/zuohuadong/supacloud/commit/71805164f96869842f27919373521d88f5a4a341))
* release main ([e199522](https://github.com/zuohuadong/supacloud/commit/e1995227f2d8d1ce9c57cd708661f4001d303a4a))
* release main ([ef1acf8](https://github.com/zuohuadong/supacloud/commit/ef1acf81f8b7ad9f6d2119466f2a20c8d23683b9))
* release main ([6ffcc26](https://github.com/zuohuadong/supacloud/commit/6ffcc263227e7c4cb4ff6a7ce0d1812d0b45f053))
* release main ([4fc66bc](https://github.com/zuohuadong/supacloud/commit/4fc66bc3f66873411eb8f0cdea6d8e8fc3caccc3))
* release main ([80f9e49](https://github.com/zuohuadong/supacloud/commit/80f9e49271bf9a67d57f165baab37230a52c21dc))
* release main ([18b53e1](https://github.com/zuohuadong/supacloud/commit/18b53e191a034ed65ce0dda04e392a1906562818))
* release main ([4f6cbf8](https://github.com/zuohuadong/supacloud/commit/4f6cbf8fd0566ac4fb26e1b0c399985b629f8349))
* release main ([4f20220](https://github.com/zuohuadong/supacloud/commit/4f202208b8a85fea42d64da4e54ee52ae61d4aa3))
* release main ([77cbf82](https://github.com/zuohuadong/supacloud/commit/77cbf824d2120f59af592ce44300f587c2657913))
* release main ([03a4bfa](https://github.com/zuohuadong/supacloud/commit/03a4bfa21a066aa0ce52b1c14e4cf5daa7f3057d))
* release main ([d2757c8](https://github.com/zuohuadong/supacloud/commit/d2757c800d0f8116bd484e307adf8390e2aba9da))
* release main ([eb82b4d](https://github.com/zuohuadong/supacloud/commit/eb82b4dc38dc4e00401a259030b007ce3d986272))
* release main ([1fd1134](https://github.com/zuohuadong/supacloud/commit/1fd113415fee2641a5eb40a3474fede22fd4d950))
* release main ([d8f8a46](https://github.com/zuohuadong/supacloud/commit/d8f8a46f5b0dd90eeea7a6d593d1b106a71ed4a6))
* release main ([34e53e4](https://github.com/zuohuadong/supacloud/commit/34e53e408e15779759d33eaf8e91b9753eec5b1f))
* release main ([f533d2c](https://github.com/zuohuadong/supacloud/commit/f533d2cb3b93e5143c8066f671d7413ab97fedae))
* release main ([647e652](https://github.com/zuohuadong/supacloud/commit/647e6524e435d72c08f64723783da224498507b8))
* release main ([f5d59fe](https://github.com/zuohuadong/supacloud/commit/f5d59fe86049a71a7010627756ec41037ebeaca6))
* release main ([549c0fd](https://github.com/zuohuadong/supacloud/commit/549c0fd4df7bb2ed1d8aa4e25dfda17e3f093cf9))
* release main ([79c9288](https://github.com/zuohuadong/supacloud/commit/79c92889c99db9d8bcada29e8d521050a7dc4f93))
* release main ([2162160](https://github.com/zuohuadong/supacloud/commit/2162160dc41f8e1a4961ec44e1528ce52626dc74))
* release main ([09c74f1](https://github.com/zuohuadong/supacloud/commit/09c74f1f76e977664c3668d65b513a3d0088d15d))
* release main ([11c5eb1](https://github.com/zuohuadong/supacloud/commit/11c5eb1f6f488c3a3ef02ca531e3556ba635ed17))
* release main ([d0c6b59](https://github.com/zuohuadong/supacloud/commit/d0c6b59815aa11ae90b15ec79af3b3e3bfadbdd4))
* release main ([#106](https://github.com/zuohuadong/supacloud/issues/106)) ([3d3945a](https://github.com/zuohuadong/supacloud/commit/3d3945a651707663000bf743a06d214bc9547321))
* release main ([#109](https://github.com/zuohuadong/supacloud/issues/109)) ([07f65c2](https://github.com/zuohuadong/supacloud/commit/07f65c228db7d7fd755f190bbd514e7fb8db8498))
* release main ([#111](https://github.com/zuohuadong/supacloud/issues/111)) ([1d4e010](https://github.com/zuohuadong/supacloud/commit/1d4e010dc83a4fba32b07e9f4541f441f97e2df6))
* release main ([#113](https://github.com/zuohuadong/supacloud/issues/113)) ([3c98a4c](https://github.com/zuohuadong/supacloud/commit/3c98a4c9353f5d53ad1517e4e56a779cece4aded))
* release main ([#114](https://github.com/zuohuadong/supacloud/issues/114)) ([02b89e6](https://github.com/zuohuadong/supacloud/commit/02b89e6d9d1ff7ac85148342415d3f6ae9277fd8))
* release main ([#75](https://github.com/zuohuadong/supacloud/issues/75)) ([6e10ff2](https://github.com/zuohuadong/supacloud/commit/6e10ff2d2c15077b2cdf87c161f5285e4d1240c2))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([2e4376a](https://github.com/zuohuadong/supacloud/commit/2e4376a43affe224eb83c3d2c0f7761eb5fb204a))
* **release:** bump management-api to 0.8.0 ([2376ddf](https://github.com/zuohuadong/supacloud/commit/2376ddf04572719528d74bd9205679706ce25b5c))
* **release:** bump unified versions by 0.0.1 ([c3311e7](https://github.com/zuohuadong/supacloud/commit/c3311e7815127514b37da9006651580296f8b6b2))
* **release:** bump version to 0.7.5 ([e065e8e](https://github.com/zuohuadong/supacloud/commit/e065e8e1d7c25cf8e1ed2c55e38acf8d3eef9a9b))
* **release:** bump version to 0.7.6 ([ab32dc5](https://github.com/zuohuadong/supacloud/commit/ab32dc535d036d96a731a1c40211e95a5544f93d))
* **release:** bump version to 0.7.7 ([005911c](https://github.com/zuohuadong/supacloud/commit/005911c198f3c89f405ce608e30e7401510c74d5))
* **release:** bump version to 0.7.8 ([274bc43](https://github.com/zuohuadong/supacloud/commit/274bc438121d41125ee9f8a5679f041195830233))
* remove obsolete debug artifacts ([b090cf9](https://github.com/zuohuadong/supacloud/commit/b090cf9c5ee74d37c4221e8a9a019b86a88d4447))
* setup release-please for automated versioning and update svadmin dependencies ([ff8b5b3](https://github.com/zuohuadong/supacloud/commit/ff8b5b337c7aa6aece97c1ed626d692df91a1494))
* **ts:** finish TypeScript 6 typecheck migration ([1226a03](https://github.com/zuohuadong/supacloud/commit/1226a03dc40909a2e5dc7e2fb90a3aee4daad855))
* upgrade svadmin to latest version and fix breaking changes in query/mutation hooks ([67b5bb8](https://github.com/zuohuadong/supacloud/commit/67b5bb87286c8f5ce97399f99db6d4fb174b44f0))

## [0.17.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.16.0...management-api-v0.17.0) (2026-05-15)


### Features

* add project OAuth/OIDC migration ([0315760](https://github.com/zuohuadong/supacloud/commit/0315760c7864b17dd0433a0f9b918be8a64931cd))
* add queue client api ([b07be9c](https://github.com/zuohuadong/supacloud/commit/b07be9cf0b8f74d8fa3291ee7b563da88a6f46f7))
* **auth:** add Webhooks, SSO/SAML, and MFA management APIs for Studio parity ([ab2f877](https://github.com/zuohuadong/supacloud/commit/ab2f8778800a93a4fef14dc00caace2370a09787))
* **background:** make async routing server-driven ([11851ad](https://github.com/zuohuadong/supacloud/commit/11851adb6682a2f86cbca7e6d506e059184c9b7b))
* **cli:** add postgres config, pooler, network-restrictions, and storage policies endpoints ([af93af2](https://github.com/zuohuadong/supacloud/commit/af93af226f204dfc30ac1aba2aba4cb755f07b1c))
* **core:** harden realtime scale limits, dynamic PK resolution, and log retrieval ([f3c17f5](https://github.com/zuohuadong/supacloud/commit/f3c17f5990d408f0ac90b91f401492e72e4f3ad8))
* **core:** integrate official walrus architecture to realtime schema ([8547f36](https://github.com/zuohuadong/supacloud/commit/8547f364fb565417d771c95cd980da28637282b2))
* **core:** Native Supabase compatibility fixes for Realtime, Storage RLS, and Edge Functions ([fd83e88](https://github.com/zuohuadong/supacloud/commit/fd83e88a67ec1736c1066707a7a2d3b9692a0f4b))
* **edge-functions:** implement per-function verify_jwt configuration ([adf6746](https://github.com/zuohuadong/supacloud/commit/adf67468b4ccb225aaf3dc50e0fd0bf2f10cb304))
* **edge-runtime:** natively expose core SUPABASE_* variables to Deno function sandbox ([d5fb3ee](https://github.com/zuohuadong/supacloud/commit/d5fb3eefcd3ca247bac00fa345432b5b4fa676b3))
* **extensions:** expand auto-install whitelist with pg_cron, pgvector, postgis, pgaudit ([6733932](https://github.com/zuohuadong/supacloud/commit/6733932985499d4b5b84edf6665e143ea18b1f21))
* **gateway:** manage certificates through Kong ([49c1426](https://github.com/zuohuadong/supacloud/commit/49c1426c576ad2364c965f9d81d54d586b556905))
* improve database sql cli workflows ([d2faf45](https://github.com/zuohuadong/supacloud/commit/d2faf45cf2f962169a28798fb8b626f0e68f6835))
* **management-api:** abstract realtime tenant routing and config fallbacks for sdk parity ([408ad4c](https://github.com/zuohuadong/supacloud/commit/408ad4cd5e5757e7d72c86e2a6bbc2fc2c2ac9d6))
* **management-api:** add Swagger detail annotations to all 121 route handlers ([5cb9d8f](https://github.com/zuohuadong/supacloud/commit/5cb9d8ff44992c1cc49be9df8cc4ac118556e7e5))
* **management-api:** add tenant-scoped custom path rate limiting via Kong ([1747c46](https://github.com/zuohuadong/supacloud/commit/1747c46bbb3b9efc949b6550ea67733a6b88acea))
* **management-api:** add web console tasks tracking & custom rate limits UI ([366416c](https://github.com/zuohuadong/supacloud/commit/366416c9ed370812a26af7a9b4fc1ccac65c38d1))
* **management-api:** implement Postgres LISTEN/NOTIFY queue worker for AI & MQTT events ([fbaca0e](https://github.com/zuohuadong/supacloud/commit/fbaca0e83d071ba6e5f08e4d063e295513a90531))
* **management-api:** implement S3 fetch adapter and improve shared CI database routing ([95bf226](https://github.com/zuohuadong/supacloud/commit/95bf2262e6324099cb8de2ebb0c0c9bb338b9de5))
* **management-api:** use async getProjectRef and update edge runtime config to use external config.ts bindings ([c563e4b](https://github.com/zuohuadong/supacloud/commit/c563e4bbe4aa18bd0ba4572ba2000df388b14f24))
* **mcp:** expose edge function logs and update tools documentation ([a2b6b0f](https://github.com/zuohuadong/supacloud/commit/a2b6b0fb9bb2703eefca94607cbf8e8e32ab34dd))
* optimize tenant runtime lifecycle ([76c26ef](https://github.com/zuohuadong/supacloud/commit/76c26efab0bc47a9509b46bc592b7f7be2b81c88))
* **platform:** massive stabilization update across edge-runtime, mcp, routing, and sdk-proxy compatibility ([bcb15e1](https://github.com/zuohuadong/supacloud/commit/bcb15e17cb0da13e1ba930999d777b2457e56d5d))
* **proxy:** align management API and realtime service with official Supabase parity ([17a2138](https://github.com/zuohuadong/supacloud/commit/17a213891aae4f8126fedbdff78549dbcbf473b0))
* **realtime:** enrich LISTEN/NOTIFY triggers with full OLD/NEW records and auto-attach DDL event trigger ([5286266](https://github.com/zuohuadong/supacloud/commit/52862667d20b77b4c2377c16e43a0247b373bc8f))
* **realtime:** replace docker realtime dependency with native SupaCloud Elysia implementation ([2e172e3](https://github.com/zuohuadong/supacloud/commit/2e172e33b77228f3a04da9d8d121fd66a37dc5ad))
* **schema:** add PostgREST pre-request context + supabase_migrations schema for CLI compatibility ([87db63f](https://github.com/zuohuadong/supacloud/commit/87db63f346702cf50c1bf852fce897d6ac618c14))
* **sdk/e2e:** finalize sdk proxy passthrough and structural snapshot tests ([f7d0e13](https://github.com/zuohuadong/supacloud/commit/f7d0e13f4b5b8e6938cccc988c828dd06c316a91))
* **self-host:** add PG18 compose stack and refresh tenant env ([bfe84bd](https://github.com/zuohuadong/supacloud/commit/bfe84bd12f689150f3978001c7cc8aafd24b51b1))
* **static:** add multi-core cluster mode via SO_REUSEPORT ([581e443](https://github.com/zuohuadong/supacloud/commit/581e443b30b9be69296b93fdd9cd78b45c328d56))
* **static:** implement HTTP 206 Range requests and graceful shutdown ([8febf67](https://github.com/zuohuadong/supacloud/commit/8febf67ebb60351af17ee2921661de7d1b5e3180))
* **studio:** real TypeScript type generation and pg_stat usage metrics ([01f3ab8](https://github.com/zuohuadong/supacloud/commit/01f3ab8e00a2164636f651e62dfea1e62c80dc97))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([f780e45](https://github.com/zuohuadong/supacloud/commit/f780e454c735fa81be08c9d122cd69d2907b8338))
* **system:** add realtime CDC prerequisites setup and imaginary proxy enhancements ([0ba08ba](https://github.com/zuohuadong/supacloud/commit/0ba08ba5c0381bef0151871eabe6e2822e117909))
* **tasks:** deploy background task and message queue features to servers ([dc85b34](https://github.com/zuohuadong/supacloud/commit/dc85b340db81f0866195b51d1aaeb81731b0824a))
* updates and fixes based on recent local changes ([fe495ba](https://github.com/zuohuadong/supacloud/commit/fe495baf4c7be6b469eb245a8c2bc62503f09a8e))
* **web-console:** integrate realtime health, custom domains and oauth panels ([f7d0e13](https://github.com/zuohuadong/supacloud/commit/f7d0e13f4b5b8e6938cccc988c828dd06c316a91))


### Bug Fixes

* add function invoke route, repair stale projects, web-console deployment ([3ed37ee](https://github.com/zuohuadong/supacloud/commit/3ed37ee7825fa060ca9ac11dab9ada16b923ddb8))
* add global error handlers to prevent silent crashes and log fatal errors ([b008860](https://github.com/zuohuadong/supacloud/commit/b008860f1b4a52806edc85634ce7b0e113a4e207))
* align vanity-subdomains endpoint to OpenAPI spec and drop @aws-sdk/client-s3 ([cd80ff7](https://github.com/zuohuadong/supacloud/commit/cd80ff744b39b799c115e7b6ba4fb94a1efecc9f))
* allow supacloud async cors headers ([332c605](https://github.com/zuohuadong/supacloud/commit/332c605c41e77e4ca942a6f4ed63d428c6866a02))
* auth middleware response format mismatch with route schemas ([#107](https://github.com/zuohuadong/supacloud/issues/107)) ([a93ee54](https://github.com/zuohuadong/supacloud/commit/a93ee5419f82f29fbe33c30aa459aa90d11290f4))
* **auth,infra:** 401 pre-flight and all-in-one local docker ([bc0a047](https://github.com/zuohuadong/supacloud/commit/bc0a0473cc7c580750a0af717502f15a01039a8f))
* **auth:** accept project service role on management routes ([ea0af53](https://github.com/zuohuadong/supacloud/commit/ea0af53996947ca9656b215550899036f69f25ac))
* **auth:** forward pagination and search params to GoTrue for admin list users route ([fb9347f](https://github.com/zuohuadong/supacloud/commit/fb9347f831c408bcb4ad5a1fb805629e2c64a9fc))
* **auth:** respect mailer_autoconfirm setting when global SMTP is configured ([41e3746](https://github.com/zuohuadong/supacloud/commit/41e3746bf4458db28236143c850f935af993e4fe))
* **auth:** restore empty string fallback for OpenAPI enum compliance ([1186f17](https://github.com/zuohuadong/supacloud/commit/1186f176e815296148c51e341c5e0feffee0b0ee))
* **ci:** align test schema with official supabase-js migrations for 100% SDK compatibility ([d6e1307](https://github.com/zuohuadong/supacloud/commit/d6e1307dfa16056a51b768ea087adc3aa207e99e))
* **ci:** fix E2E tests db insertion returning undefined and fix missing jwtSecret in CI tests ([f4c3cc1](https://github.com/zuohuadong/supacloud/commit/f4c3cc1912946749da3b4f38a9107854f98d79d0))
* **ci:** fix EdgeRuntime 9000 port collision with Minio and prevent Project creation edge crashes ([51194e1](https://github.com/zuohuadong/supacloud/commit/51194e1a2f4aecda4b352bc34c1814ad60421a91))
* **ci:** make official SDK compliance non-blocking tracking metric ([0320660](https://github.com/zuohuadong/supacloud/commit/03206603cbbfb5127cf7fafb4604998e46976ee6))
* **ci:** normalize release changelog headings ([a446d69](https://github.com/zuohuadong/supacloud/commit/a446d692c12257753da8603617c3313982a56f87))
* **ci:** provide websocket for sdk compliance ([776686a](https://github.com/zuohuadong/supacloud/commit/776686ace6de9bcb86c874428010cefcc5811e58))
* **ci:** remove sql.end() from mid-pipeline compliance scripts to prevent connection poisoning ([966372d](https://github.com/zuohuadong/supacloud/commit/966372de5358c1e8ed3df1e3d91c11fa0eb07d25))
* **ci:** repair release asset upload ([b0e0025](https://github.com/zuohuadong/supacloud/commit/b0e00255b0936a44beede10e6f0defb972f5610d))
* **ci:** repair unit test syntax and SDK parity monorepo compatibility ([fa85911](https://github.com/zuohuadong/supacloud/commit/fa85911a018443eb9ed37678836147cc9737d90b))
* **ci:** resolve EdgeRuntime port collision and API schema validation errors in integration tests ([76e0844](https://github.com/zuohuadong/supacloud/commit/76e084432a2db3991baa27a67c042f87cfebcf86))
* **ci:** resolve FK constraint violation in CLI compliance and make all compliance scripts non-blocking ([c31a5bd](https://github.com/zuohuadong/supacloud/commit/c31a5bdafc6c403ed315b0f8f4f413de3ce820e7))
* **ci:** retry official cli bootstrap downloads ([245aa71](https://github.com/zuohuadong/supacloud/commit/245aa71bb58bd2669965373d06fd3a965eae4c27))
* **ci:** rewrite CLI compliance tests to use --db-url for self-hosted mode ([82ce0ff](https://github.com/zuohuadong/supacloud/commit/82ce0ff525c33893318f80a7efd50b509f5835db))
* **ci:** robust environment flag checks and S3 array buffer type coercions ([ba58e07](https://github.com/zuohuadong/supacloud/commit/ba58e077e598e2b3a570bf7c9774cca486afdbe5))
* **ci:** use ascii release notes sections ([fc1e24c](https://github.com/zuohuadong/supacloud/commit/fc1e24cc6e549da308a9d312b918eefbc1e9b418))
* **cli:** push migrations through management API ([300afb4](https://github.com/zuohuadong/supacloud/commit/300afb4a9e56eb15f68da6b1c3b85a0af321689a))
* **cli:** push migrations via management api ([46f6fbc](https://github.com/zuohuadong/supacloud/commit/46f6fbccea1e7188b0faa2dc6d1cb9c8af1f49d0))
* **compat:** complete Supabase parity hardening for DB extensions, Signed URLs and API tests ([6a75497](https://github.com/zuohuadong/supacloud/commit/6a7549705d1e187113edae1ec274666dac41df04))
* **compatibility:** address P0, P1, and P2 compatibility issues ([fd7133b](https://github.com/zuohuadong/supacloud/commit/fd7133bb1dae7e9edf156ddc8880e982bc2890c8))
* **compatibility:** address realtime array ids, ws cleanup, and schema dependencies ([8b31d1b](https://github.com/zuohuadong/supacloud/commit/8b31d1b596abdd910bb81853754ddd80f96e54d6))
* **compat:** make database schema loading idempotent, sync runtime roles, and move upload state to postgres ([08c792b](https://github.com/zuohuadong/supacloud/commit/08c792bd626d4468760419ce8734fabdc100a887))
* **compat:** make full supabase schema idempotent, enforce RLS on signed uploads, scope db_user grants, and fix health probe ([78309ba](https://github.com/zuohuadong/supacloud/commit/78309ba02cf8f6a59365e689745f1de82b73f24b))
* **compat:** replace Deno.env.get with bun-native Bun.env[] in edge function templates ([acc3f7f](https://github.com/zuohuadong/supacloud/commit/acc3f7f90dce5f475d6fb573d288c3f78abfbd8c))
* **compat:** replace postgres driver with native bun:sql for edge auth closures ([77c863d](https://github.com/zuohuadong/supacloud/commit/77c863df59e2824574addb25f6ac49470bcb5d2e))
* **compat:** resolve deep semantic deviations spanning Realtime, Auth, and Storage ([d4af677](https://github.com/zuohuadong/supacloud/commit/d4af677eae723cc56f68ed61523143113397993b))
* **compat:** resolve Remaining P0 SDK mismatches for Storage response formats ([37710c2](https://github.com/zuohuadong/supacloud/commit/37710c29b2c92ce1350cae679a576b8db195a079))
* **compat:** resolve Remaining P1/P2 Storage and auth issues from Phase 19 audit ([a27dc96](https://github.com/zuohuadong/supacloud/commit/a27dc963f7aa45c4dd835563880ca8b941f15c69))
* **compat:** resolve storage runtime metadata fidelity and explicitly link custom provider physical identities using postgres bindings ([e498ae3](https://github.com/zuohuadong/supacloud/commit/e498ae3746389475533caa7f247a24bcad1020f2))
* **compat:** StorageRLS return truthiness, phantom dry-run objects, schema grants order, and Edge JWT_SECRET injection ([1a0cac8](https://github.com/zuohuadong/supacloud/commit/1a0cac80aee8b8aa67c5b41b00bafadbbdccdfdf))
* **compat:** use bunjs native postgres import for edge functions instead of deno url ([6fc679b](https://github.com/zuohuadong/supacloud/commit/6fc679b75d7924bca9ad6e9bf6f6e61896d188cb))
* **core:** apply full supabase.sql schema during project bootstrap ([130f2f8](https://github.com/zuohuadong/supacloud/commit/130f2f8ce4a3ec020cdc0c09346aff6650675a09))
* **core:** harden infrastructure, sys roles, and pipeline cleanups ([833993e](https://github.com/zuohuadong/supacloud/commit/833993e02573a880e7224cda9a8ab2a6ce2e9754))
* **db:** add migration to enforce ON DELETE CASCADE on project_tasks FK ([6f10f2f](https://github.com/zuohuadong/supacloud/commit/6f10f2fe8cc99435905bd2abdbe8785729705e2d))
* **db:** remove index creation from ddlQuery to avoid execution failure on partial schema ([600b671](https://github.com/zuohuadong/supacloud/commit/600b6718fe4446f708748c1a5f99dff4a9d9694e))
* **db:** use sql.unsafe for sequential DDL execution to prevent prepared statement errors ([05d9304](https://github.com/zuohuadong/supacloud/commit/05d93045b032711f810b8d647ab12daf1d9919db))
* **deps:** remove dredd, upgrade MCP SDK, override hono/path-to-regexp to eliminate 26 audit vulnerabilities ([4ca828b](https://github.com/zuohuadong/supacloud/commit/4ca828b1450ae8d5326c90a1839d73c0b8a4e072))
* **e2e:** fix storage routing, postgrest schema reload, and CI gotrue boot crashes ([a2f64b3](https://github.com/zuohuadong/supacloud/commit/a2f64b36ddcd5ce4d99dc4d92d8883f0fbee6b9b))
* **e2e:** force storage to use postgres global database in proxy mode and debug gotrue boot ([35996c6](https://github.com/zuohuadong/supacloud/commit/35996c603c01949fe7bb2890025931adc8b3523c))
* **e2e:** mock task workers and dynamically provision minio bucket in CI via AWS SDK ([97564de](https://github.com/zuohuadong/supacloud/commit/97564def72a65c9b900f43cae7bbff63d289099a))
* **e2e:** resolve 6 CI test failures ([3f42413](https://github.com/zuohuadong/supacloud/commit/3f424134dc3ad0255716501a0886b658c57f5b1e))
* **e2e:** resolve multiple syntax errors, s3 provisioning mock and bucket snapshot error mapping ([8530d3a](https://github.com/zuohuadong/supacloud/commit/8530d3a4c63b93481c95d2efa2cb5b5930a3cb21))
* **e2e:** stabilize CI pipeline by bypassing realtime provision and natively bootstrapping storage tables ([530cf98](https://github.com/zuohuadong/supacloud/commit/530cf9880ba8b2c9e1245924a8424eb19865c86f))
* **e2e:** switch ci postgres connection to supabase_admin to bypass auth namespace permission denied ([09d6049](https://github.com/zuohuadong/supacloud/commit/09d6049b638f48d2c336e0e6db9ebf74ae02250a))
* **edge-runtime:** avoid double-managed runtime restarts ([bc6b664](https://github.com/zuohuadong/supacloud/commit/bc6b6646903ef2bd48038b7a8a1a968ec4c3b503))
* **edge-runtime:** bypass verifyJwt for CORS preflight OPTIONS requests to prevent 401 errors ([ea26fe0](https://github.com/zuohuadong/supacloud/commit/ea26fe0344e083cac90b8c9c9354178537053552))
* **edge-runtime:** inject Bun function env ([66b7266](https://github.com/zuohuadong/supacloud/commit/66b7266344177b96abcd7452fe5fa31195a922d6))
* **edge-runtime:** keep embedded child restarting ([3fd8e72](https://github.com/zuohuadong/supacloud/commit/3fd8e7216b61a5dbbaf4ee61d537990d93e9ed94))
* **edge-runtime:** preserve env for waitUntil tasks ([f5ab3a4](https://github.com/zuohuadong/supacloud/commit/f5ab3a42a382ee77460fca569df9527b68da2b3e))
* **edge-runtime:** preserve env for waitUntil tasks ([cba4f62](https://github.com/zuohuadong/supacloud/commit/cba4f62a50cdda1b33e8a3cdc2bbab09889f7549))
* **edge-runtime:** sync manager port to 9000 to match Kong gateway routes ([ef1771f](https://github.com/zuohuadong/supacloud/commit/ef1771f275cf308503b5804c3a4c150a25413e89))
* explicit @sinclair/typebox dependency to prevent elysia/edge-runtime crash during CI e2e tests proxy boot ([a4e4833](https://github.com/zuohuadong/supacloud/commit/a4e48334eff5692af16e51b4554c4753dbd550ee))
* extend rest proxy timeout ([e723950](https://github.com/zuohuadong/supacloud/commit/e723950689579f4397729dc0f129d87798f7b69b))
* **functions:** harden runtime routing and diagnostics ([7184c84](https://github.com/zuohuadong/supacloud/commit/7184c84d3c1ada76184cec0873398cbff2d30344))
* **gateway:** allow x-upsert and Cache-Control headers in CORS to support native Supabase SDK storage uploads ([ee5d92d](https://github.com/zuohuadong/supacloud/commit/ee5d92db1aff6aeed65e7c43bcf5edb53b54d9d0))
* **gateway:** include hosted frontend origins in cors ([0e5febb](https://github.com/zuohuadong/supacloud/commit/0e5febb71a471e89a01eba5c2e9ead92f20ce034))
* **gateway:** increase default Kong timeouts to 500s for AI/OCR inference ([421bcb5](https://github.com/zuohuadong/supacloud/commit/421bcb5e238b8313d782b0cc6a84d5af7f241292))
* **gateway:** preserve functions proxy path prefix ([ea21232](https://github.com/zuohuadong/supacloud/commit/ea212329290c99678900c1ffcec05d856f92e4ac))
* **gateway:** resolve edge runtime startup loops and enhance auth proxy routing stability ([51e516d](https://github.com/zuohuadong/supacloud/commit/51e516d422dcf3c467630b99ef178f105398cd8c))
* harden management API edge cases ([416e210](https://github.com/zuohuadong/supacloud/commit/416e21083e39accd30c94f6c6a6ffdb743305cff))
* harden realtime tasks and data-plane boundaries ([f396257](https://github.com/zuohuadong/supacloud/commit/f396257e4c442d7cfb581824b15080bf6dfe64bf))
* improve one-click install robustness, add function invoke route, repair stale projects ([cabc22f](https://github.com/zuohuadong/supacloud/commit/cabc22fe416ccd2e7555cc7ef67aa25fd1248f87))
* **installer:** align pigsty supabase install path ([aa34fe3](https://github.com/zuohuadong/supacloud/commit/aa34fe364290383e77d0f62cf24a448514a7fc29))
* **installer:** derive studio domain from API host ([00a0008](https://github.com/zuohuadong/supacloud/commit/00a0008b4cd492afa27f92ec05dfb9977c92a57e))
* **install:** skip legacy supabase compose stack ([d09d0b0](https://github.com/zuohuadong/supacloud/commit/d09d0b0654e204c74418ae97a8f360aaedc912c6))
* make production upgrades binary-first ([7fd392b](https://github.com/zuohuadong/supacloud/commit/7fd392be1760b41ef7a103dd76c411032202e8d9))
* **management-api:** accept serialized routing config ([f891925](https://github.com/zuohuadong/supacloud/commit/f891925dbf1f42581d8e6e13bae6fc3bf936a467))
* **management-api:** add anon rls policies and realtime schema db grants for sdk tests ([4a872bb](https://github.com/zuohuadong/supacloud/commit/4a872bb8a3f306bd0b4d86c63ac1b80601eb7e1b))
* **management-api:** add missing realtime rls policies to official sdk test suite setup ([8f80aaa](https://github.com/zuohuadong/supacloud/commit/8f80aaa83db79b52759d539d138cfd9abd04efd1))
* **management-api:** allow public storage reads on custom domains ([2dba2db](https://github.com/zuohuadong/supacloud/commit/2dba2db3f7cbcffdf7e1b554fd598d702ae09dce))
* **management-api:** comply with rfc 1123 hostname rules and aws s3 specs ([6000406](https://github.com/zuohuadong/supacloud/commit/6000406a2094b0c3361e60999ee5aaa249a98c43))
* **management-api:** correct proxy ws route to match phoenix websocket mount point exactly ([4c64f27](https://github.com/zuohuadong/supacloud/commit/4c64f276ea3256cf5042679aa77450568286921e))
* **management-api:** default to port 9090 ([b0f5db7](https://github.com/zuohuadong/supacloud/commit/b0f5db7a508ae48f3231b69b93ac13b055ea1cc7))
* **management-api:** encrypt background task credentials ([478fc0e](https://github.com/zuohuadong/supacloud/commit/478fc0e79a19173b14c5f62c0497508f171ccc52))
* **management-api:** enforce Swagger route coverage ([44e7d4b](https://github.com/zuohuadong/supacloud/commit/44e7d4b369c78b82d65fdccc7e5e34c0deaa14a2))
* **management-api:** expose unmasked runtime env internally ([11f58e6](https://github.com/zuohuadong/supacloud/commit/11f58e6727b093d40bc36a000472fe3fb83439c0))
* **management-api:** grant auth roles tenant database access ([f748812](https://github.com/zuohuadong/supacloud/commit/f7488120403e2e33b48048cb00dd2c6b25453ce5))
* **management-api:** grant postgrest authenticator database access ([23beb27](https://github.com/zuohuadong/supacloud/commit/23beb278832b298cae3872298f40d6f1a44b2d0d))
* **management-api:** harden project queue reliability ([d0816c9](https://github.com/zuohuadong/supacloud/commit/d0816c9ea5f9f5be6fa1db0154808548b802a3d9))
* **management-api:** harden sdk proxy unit test isolation ([688fb20](https://github.com/zuohuadong/supacloud/commit/688fb201767e2f1b540f99ad3855a525b9d77d16))
* **management-api:** harden storage and background contracts ([fe246b6](https://github.com/zuohuadong/supacloud/commit/fe246b6a1897166ac756275c164cf59f7474f5f5))
* **management-api:** harden storage list metadata parsing ([69ed6f2](https://github.com/zuohuadong/supacloud/commit/69ed6f2e42c37952615ebc8095e51871720888ee))
* **management-api:** inject internal supabase runtime secrets ([8b8b797](https://github.com/zuohuadong/supacloud/commit/8b8b79728977204bf8ee06e8967cfbf2057ff78c))
* **management-api:** isolate background auth encryption regression ([ca3371e](https://github.com/zuohuadong/supacloud/commit/ca3371e61e1295b4d5887229b3bef1c6a123770f))
* **management-api:** make edge runtime port dynamically configurable from environment ([aabb108](https://github.com/zuohuadong/supacloud/commit/aabb1087b1a27c5b4d863208287d130df5129a45))
* **management-api:** normalize project response timestamps and update functions secrets schema formatting ([fa0ec55](https://github.com/zuohuadong/supacloud/commit/fa0ec553430c684ec00af70b01e785527edbd5c5))
* **management-api:** pin Supabase JS compliance ref ([2c0fd2e](https://github.com/zuohuadong/supacloud/commit/2c0fd2efb8e96aed7cb41ea342f8d887ce7e7ba2))
* **management-api:** reconcile custom domain runtime routes ([2f2d9da](https://github.com/zuohuadong/supacloud/commit/2f2d9dad97479723c392e3b99f854c910e0ac722))
* **management-api:** refine s3 ports and storage adapter error handling ([516d0c8](https://github.com/zuohuadong/supacloud/commit/516d0c805892e5e14d22068093e81006ade95e5e))
* **management-api:** remove malicious sdk parity minio port rewrite and resolve edge-runtime container port collision ([e7b66f1](https://github.com/zuohuadong/supacloud/commit/e7b66f1e2f17d9ef8d88ea7ba76c9ed7e6e2772f))
* **management-api:** resolve functions tenants from custom domains ([9171fbd](https://github.com/zuohuadong/supacloud/commit/9171fbd201234f74c6c15d3547043ad8c5dcbb56))
* **management-api:** revert realtime proxy path to use /socket/websocket to fix HTTP 404 dropping connections ([131c2f2](https://github.com/zuohuadong/supacloud/commit/131c2f26e29733edfdef8904df5f07e117a888ca))
* **management-api:** set duplex on sdk-proxy test requests ([5a3fab4](https://github.com/zuohuadong/supacloud/commit/5a3fab47ec93a35bdf0ef5fcbe3fbb8c843a5dce))
* **management-api:** spoof realtime host header and dump api logs on ci failure ([ce696fc](https://github.com/zuohuadong/supacloud/commit/ce696fc697724d04c55928ebab6bfec3495bc83e))
* **management-api:** stabilize encrypted background task regression ([16be349](https://github.com/zuohuadong/supacloud/commit/16be34947c233b35a395db11bd991d541161f9be))
* **management-api:** strictly align P0/P1 OpenAPI endpoints and refactor Vanity Subdomain schemas ([512ee52](https://github.com/zuohuadong/supacloud/commit/512ee52b79f1c2503d788f787f21d43313e38ab0))
* **management-api:** use aws4fetch for robust s3 operations and fix realtime CDC prereqs timeouts ([9f893f2](https://github.com/zuohuadong/supacloud/commit/9f893f2296a7c69e73ab066ae8079a38c4fb3ed4))
* **management-api:** use native S3 fetch adapter for CI uploads and standardize WS proxy headers ([39a0bdb](https://github.com/zuohuadong/supacloud/commit/39a0bdb3995c8659dca09413f4b27a2a9b1e5a2f))
* **management-api:** use node random uuid in sdk proxy ([77aceea](https://github.com/zuohuadong/supacloud/commit/77aceea8f6fa109818093afe1693b14d3a1b417d))
* materialize juicefs upload streams ([2d3a253](https://github.com/zuohuadong/supacloud/commit/2d3a2538205d8daafeaa4818730e4c2142c9ccde))
* materialize storage upload streams ([49d6819](https://github.com/zuohuadong/supacloud/commit/49d681945882f441a7b65fdf5914ff23a55e003a))
* **openapi:** align ref generation, service health, config responses with official Supabase OpenAPI spec ([6d94ded](https://github.com/zuohuadong/supacloud/commit/6d94dedd37a5f1996983f6d6c60c2129104c3824))
* **openapi:** resolve TS error for custom hostname data property ([b7430fa](https://github.com/zuohuadong/supacloud/commit/b7430fa1a3da4f89b06ec4a76e45d0b2429967fb))
* **openapi:** satisfy strict schema enums and ref length requirements ([ddd6a54](https://github.com/zuohuadong/supacloud/commit/ddd6a54e1b53d33c9d9895b5e008d673639c706d))
* **openapi:** use predefined enums for missing auth config providers instead of empty strings ([eca51ff](https://github.com/zuohuadong/supacloud/commit/eca51ffd0a7dcb705d3a644fb37f24b624cfe688))
* **pigsty:** align 4.3 upgrade with supacloud storage defaults ([7f2a857](https://github.com/zuohuadong/supacloud/commit/7f2a85711292859c5bb1b1d709effbeaea1d781d))
* **postgrest:** enable OpenAPI mode, db-pre-request, and single-source config ([9c172b5](https://github.com/zuohuadong/supacloud/commit/9c172b5efdcb6adc288bf7ab4095f1a06d16e482))
* provision_runtime fails on Ubuntu due to Group=nobody and missing auth schema ([#110](https://github.com/zuohuadong/supacloud/issues/110)) ([29faf4f](https://github.com/zuohuadong/supacloud/commit/29faf4fb42c1562ed30897ac9a935fccdb9844cd))
* **proxy:** forward function POST bodies with duplex ([d39d801](https://github.com/zuohuadong/supacloud/commit/d39d8018b6fc4024481d6facc28fdb55866c1166))
* **proxy:** resolve Elysia routing precedence and e2e testing bugs ([f39fdee](https://github.com/zuohuadong/supacloud/commit/f39fdee9cababa10ecc0a4e5375588d5aeed34ca))
* **proxy:** update Elysia wildcard routing for correct SDK REST and Auth passthrough ([0364f5f](https://github.com/zuohuadong/supacloud/commit/0364f5f3b9b628d533589e65f3d20a98ea3306ab))
* publish background tasks for realtime ([ef0a19e](https://github.com/zuohuadong/supacloud/commit/ef0a19e118a0202b598ac170f6e54971d6381519))
* **queue:** keep edge functions on dedicated worker ([63213c3](https://github.com/zuohuadong/supacloud/commit/63213c34a0b5c57761a99d865edf4f20783697d5))
* **queue:** migrate foundation worker to stable pg-listen ([20f5f07](https://github.com/zuohuadong/supacloud/commit/20f5f0703a0da4810248db97b62852f16ae087c2))
* **realtime:** connect tenants with admin database credentials ([2d46d30](https://github.com/zuohuadong/supacloud/commit/2d46d30d33a4ed864cbe6a3d0232447a46e58978))
* **realtime:** correct subscribeTenant arity (TS2554) ([df49c12](https://github.com/zuohuadong/supacloud/commit/df49c12009c10e0c5dbff75eee5d9c01b5332dac))
* **realtime:** proxy websocket traffic via management ws ([599041f](https://github.com/zuohuadong/supacloud/commit/599041fd028c33ba2fabb9734b18c7df887868df))
* **realtime:** reconcile missing tenants and use valid enc key ([7d133f9](https://github.com/zuohuadong/supacloud/commit/7d133f980a45cda46889a3a299248aab1fc1a06e))
* **realtime:** reconcile tenant schema privileges ([11984f4](https://github.com/zuohuadong/supacloud/commit/11984f4911ae95c76290944f1fd34feb900ab1e6))
* **realtime:** resolve websocket protocol encoding, path matching, and presence syncs ([5d3d86b](https://github.com/zuohuadong/supacloud/commit/5d3d86b560e2ca7f3e7ca36b6f8a63fd8d831b14))
* **realtime:** route websocket through root proxy ([9947074](https://github.com/zuohuadong/supacloud/commit/9947074ce2386721821721b221247cc435c370a3))
* **realtime:** route WebSocket to self-seeded tenant realtime-dev via host header ([3b94834](https://github.com/zuohuadong/supacloud/commit/3b94834277365ec8189b9d726e270849033c3b83))
* **realtime:** sign tenant reconcile admin tokens correctly ([9724f1c](https://github.com/zuohuadong/supacloud/commit/9724f1cc0d364984df6ca9ae2b9cdb5a9cc7a040))
* **realtime:** use node crypto for admin JWT signing ([a3da533](https://github.com/zuohuadong/supacloud/commit/a3da53369c4862c5be7b73864ef28a66bbcb9063))
* resolve unit test and automation suite failures due to ci overriding jwt and absent db configurations ([aa0cc9d](https://github.com/zuohuadong/supacloud/commit/aa0cc9d40ac1a78ab98a537dbc18007f7af58c47))
* restore project reprovisions missing resources ([e757d3a](https://github.com/zuohuadong/supacloud/commit/e757d3a18ab31fdb7dc3edaf8eb5ee63585db512))
* **routing:** unify tenant domain and port resolution ([f9da764](https://github.com/zuohuadong/supacloud/commit/f9da764cd348045d8a91df0ff932a34e7d289bdb))
* **runtime:** respect ssl config for tenant urls ([25a4f97](https://github.com/zuohuadong/supacloud/commit/25a4f97761813db374c93aed1c398413b0c6dce7))
* **runtime:** respect ssl config for tenant urls ([8520e5d](https://github.com/zuohuadong/supacloud/commit/8520e5d2661b043efcdd681a2f699c4c72bf5dfd))
* **security:** harden storage and proxy surfaces ([10044a5](https://github.com/zuohuadong/supacloud/commit/10044a5e5cadf023a8893ac07781ea926a97b56f))
* **services:** mock S3 provision and cleanup in CI mode to prevent destructive saga rollbacks ([0364f5f](https://github.com/zuohuadong/supacloud/commit/0364f5f3b9b628d533589e65f3d20a98ea3306ab))
* ship web console with binary upgrades ([373b712](https://github.com/zuohuadong/supacloud/commit/373b7122f3059faacc6fb7d0a93b4788fe83ab54))
* skip missing tenant dbs during realtime reconcile ([c7d9842](https://github.com/zuohuadong/supacloud/commit/c7d9842ab3ebf4e8cb7b37f848099e45f7fa4028))
* stabilize edge runtime under binary upgrades ([613a123](https://github.com/zuohuadong/supacloud/commit/613a1238ca8781871ab272d44eea361532e80175))
* standardize HTTP status codes in API error responses and improve CI health checks ([ffab9d4](https://github.com/zuohuadong/supacloud/commit/ffab9d4c99d58647eeb6366b07ea2fd032d20d3f))
* **static:** replace sirv-cli with Bun-native disk-read static server ([cb70cd8](https://github.com/zuohuadong/supacloud/commit/cb70cd8d1ad47193736b76e0aa931b23b3c4718f))
* **storage:** add s3 compensatory rollbacks on db materialization drops, and align move/copy verifications ([c31f571](https://github.com/zuohuadong/supacloud/commit/c31f571131adf2979611f72079d4f5c3a1c33345))
* **storage:** align listV2 payload schema with supersonic sdk cursor logic, delimit switches, and correct folder signatures ([e165dbd](https://github.com/zuohuadong/supacloud/commit/e165dbdacd83bf259e5c47f7498e859b3aedfdc0))
* **storage:** align sdk outputs, append cache-controls, rewrite native id mappings, format schema json boundaries, handle download dispositions and purge social scale traps ([47718f0](https://github.com/zuohuadong/supacloud/commit/47718f0d88f8c6b19793f90c59c72474b03f6fc4))
* **storage:** align upload Id with official API and fix bucket-not-found status ([9360ca7](https://github.com/zuohuadong/supacloud/commit/9360ca7fddc1a4c7e0883b37ba3656b98c1715e8))
* **storage:** bypass Elysia multipart parser to correctly support supabase-js SDK uploads missing body field names ([8fd351b](https://github.com/zuohuadong/supacloud/commit/8fd351b17dbbdcc64c5d9932975f1454cdae6f32))
* **storage:** correct wechat compilation, enforce move atomicity, validate upload persistence, and align bucket delete constraints ([5258a10](https://github.com/zuohuadong/supacloud/commit/5258a10532cd76abe3d4f6f07691835177ab9b05))
* **storage:** enforce bucket transaction atomicity, query limits, and 23505 constraints ([2a031d8](https://github.com/zuohuadong/supacloud/commit/2a031d868f01bbc6c0452b6a770d775a63d85192))
* **storage:** enforce move & tus assertions, isolate admin overriden buckets, format cdn restrictions and insert database defaults ([6e23522](https://github.com/zuohuadong/supacloud/commit/6e2352226748cf655fbc385228fec7e38c009b08))
* **storage:** enforce move transactional rollbacks, v1 list search binding, v2 delimiter defaults, and 404 project trace handling ([c54063c](https://github.com/zuohuadong/supacloud/commit/c54063c7b1a472e296d18271af5a7544d40a3342))
* **storage:** enforce RLS on existence checks and defer POST/PUT materialization ([0f62fc3](https://github.com/zuohuadong/supacloud/commit/0f62fc3cb57f7d4155856b050e5c43d9aa23b31e))
* **storage:** fix list observability, empty bucket status matching, signed upload checks and delete isolation ([b9f20e1](https://github.com/zuohuadong/supacloud/commit/b9f20e1cc632467286305ac8897ba09c597da873))
* **storage:** implement list-v2 folder collapsing, apply db mimetypes, and track rollback logging ([610c2a1](https://github.com/zuohuadong/supacloud/commit/610c2a1b5b61baacef831c373601215079780d63))
* **storage:** implement missing endpoints and payload compatibility ([2ceb0af](https://github.com/zuohuadong/supacloud/commit/2ceb0af52543cf3f7f9aebe59bb8b08e8a624c9e))
* **storage:** map list timestamps, enforce tus limits, and resolve public bucket overrides ([a74406a](https://github.com/zuohuadong/supacloud/commit/a74406a346db20f5299a7fbb15685e6596fd3be9))
* **storage:** migrate PUT to use custom multipart buffer boundary extractor ([3f2bf22](https://github.com/zuohuadong/supacloud/commit/3f2bf22d493a76b3b8cdf9077ff2fd416dc58421))
* **storage:** resolve 100% JS SDK functional compatibility issues ([c736c87](https://github.com/zuohuadong/supacloud/commit/c736c87736fe3f6ccbff565ccebc700a2b0ea780))
* **storage:** resolve bucket rls coupling, move transactional loops, and list sorting capabilities ([1296bd3](https://github.com/zuohuadong/supacloud/commit/1296bd30e4ba5498d0b9f8946d20265a4a706a44))
* **storage:** resolve upload TOCTOU concurrency and align official RLS error semantics ([a3c774c](https://github.com/zuohuadong/supacloud/commit/a3c774c4638b7acc3f057e760c12593b41e844ca))
* **storage:** sniff raw payload to force multipart parsing even when gateway overrides content-type to image/png ([2f5348e](https://github.com/zuohuadong/supacloud/commit/2f5348e540c04c343bcea54513fd090f15812c03))
* **storage:** store raw seconds in cacheControl metadata (official Supabase format) ([b5a55ee](https://github.com/zuohuadong/supacloud/commit/b5a55ee1c60a893e912d1bf65e73ec8231cc0b21))
* **storage:** stream large uploads through kong ([b06f669](https://github.com/zuohuadong/supacloud/commit/b06f669ed127b95bba7e8b20be27b2886b4f69f9))
* support github proxies for binary upgrades ([2a65cdf](https://github.com/zuohuadong/supacloud/commit/2a65cdf241c3e5389a13437fd280991f81e2ca39))
* **tasks:** allow invoker jwt to read task detail ([67c0cb2](https://github.com/zuohuadong/supacloud/commit/67c0cb29a4fd5688f6a22f447607cb6291f4ac1b))
* **tasks:** avoid malformed array literal issue in unsafe sql binding for ANY() ([a631807](https://github.com/zuohuadong/supacloud/commit/a631807e19b9bd17c3985e2552f0e78e569c9bba))
* **tasks:** patch tenant queue schema compatibility ([7d76a88](https://github.com/zuohuadong/supacloud/commit/7d76a883c278feef1184e6e8a8dc683aac68db56))
* tolerate sdk proxy background auth introspection failures ([b28564c](https://github.com/zuohuadong/supacloud/commit/b28564c92d9d0fca24eecfd920a198d9baa2776b))
* use direct GoTrue port instead of HTTPS API URL to avoid self-signed cert errors ([e531b7c](https://github.com/zuohuadong/supacloud/commit/e531b7ca510537b87b50da2fbcdf43247f44d06d))
* **web-console:** restore settings and task management UI ([c7c1e7d](https://github.com/zuohuadong/supacloud/commit/c7c1e7dacb82b427ec59d84aa5574ab30a524128))


### Elegance & Refactoring

* **api:** standardize error payload schemas across all routes for Stripe parity ([17a8164](https://github.com/zuohuadong/supacloud/commit/17a8164c0f39eaf318b4e8961ec67f0b26f9e32d))
* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([29a71da](https://github.com/zuohuadong/supacloud/commit/29a71da7ddbc326f0b16b7eeb4bb159784e347c7))
* **core:** use resolveDbName and parameterized queries for schema routing and postgres reflection ([177ef72](https://github.com/zuohuadong/supacloud/commit/177ef72275778d091a616f69a836efd87895053e))
* **edge-functions:** migrate version artifacts into internal revisions ([bd475aa](https://github.com/zuohuadong/supacloud/commit/bd475aa89989eea6a94668362b41b7fbee050765))
* **queue:** remove legacy pg-listen implementation ([ca186df](https://github.com/zuohuadong/supacloud/commit/ca186df82178acf6611226645b7d27d038ba6071))
* **realtime:** revert native realtime and restore official docker integration ([861377f](https://github.com/zuohuadong/supacloud/commit/861377f33569c28e637629d59234db22b2936560))
* remove legacy sql result alias ([d9c85e3](https://github.com/zuohuadong/supacloud/commit/d9c85e3916de88bb38b86e943a63a903789379bd))


### Performance Improvements

* reduce management hot path load ([2309d46](https://github.com/zuohuadong/supacloud/commit/2309d46b5f4ecfaad69742dcc7bfe80834615afe))


### Miscellaneous Chores

* align error codes and resolve DB roles in management API ([90cffb5](https://github.com/zuohuadong/supacloud/commit/90cffb50fbec47665c284b91407844322fe4f336))
* bump version (+0.0.1) for management-api and mcp-server ([c94f4af](https://github.com/zuohuadong/supacloud/commit/c94f4af59caf2423d422a99a99aa8fbc6dff7709))
* cleanup scratch files and commit modified files ([0598301](https://github.com/zuohuadong/supacloud/commit/0598301d11d550f677667bf14c470284cecd7b5d))
* **deps:** bump @svadmin/core in /packages/management-api ([#81](https://github.com/zuohuadong/supacloud/issues/81)) ([31a67a9](https://github.com/zuohuadong/supacloud/commit/31a67a91d39662a4bbe07d2413ec38c347e2f357))
* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/management-api ([#86](https://github.com/zuohuadong/supacloud/issues/86)) ([f3b2e58](https://github.com/zuohuadong/supacloud/commit/f3b2e58119e817e2a859d54aaf1c51cd41d7946e))
* flush remaining test suite fixes and project modifications ([686ad4b](https://github.com/zuohuadong/supacloud/commit/686ad4bb59b1e087c9bf621d9663b259f0f33d27))
* **management-api:** translate all queue worker comments to English ([406e693](https://github.com/zuohuadong/supacloud/commit/406e6937e014d751f99f67fa435000441a87f863))
* **management-api:** translate all remaining Chinese comments to English ([c1d5670](https://github.com/zuohuadong/supacloud/commit/c1d567063e99a47eefb38f8d00e89a6915e4a057))
* push all accumulated compliance and runtime integrations ([8a6fec0](https://github.com/zuohuadong/supacloud/commit/8a6fec02a010bc035670181c3394333325e891a3))
* release main ([4e7f2a6](https://github.com/zuohuadong/supacloud/commit/4e7f2a620baed1671e5d7005fc1d8b587982f208))
* release main ([3b1237f](https://github.com/zuohuadong/supacloud/commit/3b1237f22412a4485de2c4af21e6fd62babde48c))
* release main ([d6bd16a](https://github.com/zuohuadong/supacloud/commit/d6bd16a00f934b0c0c84110e7239abf942ab791e))
* release main ([dd7c341](https://github.com/zuohuadong/supacloud/commit/dd7c341b6b67b0b5c08140d67214a201cdc183d4))
* release main ([6688e2a](https://github.com/zuohuadong/supacloud/commit/6688e2ae64e6a80164a87f43cf0cdf85d862657f))
* release main ([f6bcb28](https://github.com/zuohuadong/supacloud/commit/f6bcb289706b6f06dbd914e3c9e0e34ea1b5cdbc))
* release main ([2133e72](https://github.com/zuohuadong/supacloud/commit/2133e7297156f2a16f155aaecaa04061acd8dbba))
* release main ([425f7da](https://github.com/zuohuadong/supacloud/commit/425f7da9d8816edab8a7a71d9ac95f1d6cf06e44))
* release main ([0355c8b](https://github.com/zuohuadong/supacloud/commit/0355c8befe2755b2a4e4d72c71a76123e1a7b6b8))
* release main ([14cc502](https://github.com/zuohuadong/supacloud/commit/14cc5024e876f5f7cb923d4306458acf3d004449))
* release main ([7537614](https://github.com/zuohuadong/supacloud/commit/7537614cbe0428dc53c44d4e47129938f99d55a2))
* release main ([bbc5871](https://github.com/zuohuadong/supacloud/commit/bbc58717a7377d6200b272cba70a402ae4971e2e))
* release main ([f0b4377](https://github.com/zuohuadong/supacloud/commit/f0b437729739e80d3acd7fb23c49624a2d96dcee))
* release main ([8b3d432](https://github.com/zuohuadong/supacloud/commit/8b3d4327ecf5e80ce091489a652108cbaa4b09b5))
* release main ([51e6d88](https://github.com/zuohuadong/supacloud/commit/51e6d882f5aaf4a20ddba2597df748647d898c6e))
* release main ([19b57d6](https://github.com/zuohuadong/supacloud/commit/19b57d655005f78d914f1b8ee61632067e87f8e7))
* release main ([7924b79](https://github.com/zuohuadong/supacloud/commit/7924b79abf2d1cab65026dbff344b7b6a20a8bfe))
* release main ([e229440](https://github.com/zuohuadong/supacloud/commit/e2294400adc88ad4ceebf5f5fdc67a57ed38334a))
* release main ([f86eac7](https://github.com/zuohuadong/supacloud/commit/f86eac758cc98a0a3fe8688f31ec34139be015a6))
* release main ([b6e4a0d](https://github.com/zuohuadong/supacloud/commit/b6e4a0d3f71b76248cfac5e9780984dd91ac39c6))
* release main ([9354c26](https://github.com/zuohuadong/supacloud/commit/9354c26bb259a9a1b89fdbdbf28a2b1b2c540af0))
* release main ([237cb3e](https://github.com/zuohuadong/supacloud/commit/237cb3ed1be202291f43653f533784a8c035e337))
* release main ([62a5a31](https://github.com/zuohuadong/supacloud/commit/62a5a315685c1bb3c308b45975f899cccd12b844))
* release main ([17f4b3a](https://github.com/zuohuadong/supacloud/commit/17f4b3a8883e241dd874836a004f2258efa490af))
* release main ([c572c9e](https://github.com/zuohuadong/supacloud/commit/c572c9ed5c2cab7b86a7f222f7b72912dc9f6e7e))
* release main ([bd45ae9](https://github.com/zuohuadong/supacloud/commit/bd45ae9daa1815d9c4b7a9c0888865d8e1bdb4b7))
* release main ([afb147c](https://github.com/zuohuadong/supacloud/commit/afb147c118cbe967ea8d60c826ae3553e0ea96e0))
* release main ([b6882d4](https://github.com/zuohuadong/supacloud/commit/b6882d4bce2b7add34022481a8ce09d02194ae42))
* release main ([ea97458](https://github.com/zuohuadong/supacloud/commit/ea97458072ef45486dd34948f61a03a404238e63))
* release main ([847e8f3](https://github.com/zuohuadong/supacloud/commit/847e8f3d26d570cdd36e2a87f25a63cf34fb5398))
* release main ([86f2d95](https://github.com/zuohuadong/supacloud/commit/86f2d95fe4dae6528eb1e4945846db413e0696c3))
* release main ([1bca726](https://github.com/zuohuadong/supacloud/commit/1bca72644a7d79dc91335c2146196fc109814877))
* release main ([87a7fc5](https://github.com/zuohuadong/supacloud/commit/87a7fc5fd94492fee00dc8639025548f3f51bef4))
* release main ([67cc94b](https://github.com/zuohuadong/supacloud/commit/67cc94b2722f4949577c9b6791c81df25632ecf5))
* release main ([cff457b](https://github.com/zuohuadong/supacloud/commit/cff457bdf2bc8584b154952162d0e5c621d13a87))
* release main ([608b396](https://github.com/zuohuadong/supacloud/commit/608b3963c1010c8cde63d42cd0f2a24d06a1e15e))
* release main ([65e28b5](https://github.com/zuohuadong/supacloud/commit/65e28b57270c313813cf5aea7f6385a7795623cf))
* release main ([a7d687f](https://github.com/zuohuadong/supacloud/commit/a7d687f39cea00f70dae78e10457d8708819e823))
* release main ([b4f8a93](https://github.com/zuohuadong/supacloud/commit/b4f8a935f2ea3353ca600667f3f429f003ffa208))
* release main ([3209d62](https://github.com/zuohuadong/supacloud/commit/3209d627dee3c616410c7d344a0214d1b1a8e628))
* release main ([5d65e29](https://github.com/zuohuadong/supacloud/commit/5d65e296f0ff5db2df3e72147ab67ad8df7554de))
* release main ([5482646](https://github.com/zuohuadong/supacloud/commit/5482646ff7e300d620811fdc0186a9821ebbdb28))
* release main ([c651ce5](https://github.com/zuohuadong/supacloud/commit/c651ce5093164409134d67ca264d71219c8c1f30))
* release main ([97e23fc](https://github.com/zuohuadong/supacloud/commit/97e23fcf4f87521e54e0ef84bb8d1466ce44c7ea))
* release main ([e8f9dc3](https://github.com/zuohuadong/supacloud/commit/e8f9dc37135e8e32da71d9ea51926f9ac9641c8a))
* release main ([6de326e](https://github.com/zuohuadong/supacloud/commit/6de326e3fa82d41b997f7004c46db1d5923381e4))
* release main ([02a4a21](https://github.com/zuohuadong/supacloud/commit/02a4a21936c2b536c57b207edd85f9c76c3cd7a7))
* release main ([e3ca779](https://github.com/zuohuadong/supacloud/commit/e3ca779c5b77188c009c92e619543e36b27d559b))
* release main ([fb5e6f7](https://github.com/zuohuadong/supacloud/commit/fb5e6f7ae0dc1f74802bbdbd97d66b6aa04d52ff))
* release main ([bbcd637](https://github.com/zuohuadong/supacloud/commit/bbcd6370f559448e5e8cfc4679b949e8e4a2fdeb))
* release main ([34a2d74](https://github.com/zuohuadong/supacloud/commit/34a2d74737f627dac011eb88872d9754fa5b6a1e))
* release main ([a8dd5ae](https://github.com/zuohuadong/supacloud/commit/a8dd5ae146b736029568ed47a82c16932304f47b))
* release main ([eedd89d](https://github.com/zuohuadong/supacloud/commit/eedd89d3cccda79b9a939dbb03e252f262b06fcf))
* release main ([b6756c9](https://github.com/zuohuadong/supacloud/commit/b6756c9c1ffee750f1750ae19630d7b15eff0961))
* release main ([86f5978](https://github.com/zuohuadong/supacloud/commit/86f5978cf56826143493442305c49e1eeb4e4105))
* release main ([27ea761](https://github.com/zuohuadong/supacloud/commit/27ea761d62381ecf32fa0563b17c83b9e6943561))
* release main ([6575ad3](https://github.com/zuohuadong/supacloud/commit/6575ad378405d2435784556c113eff8583a9317f))
* release main ([18b513f](https://github.com/zuohuadong/supacloud/commit/18b513f47ccbfd3ed5c3279d751924b617f7e127))
* release main ([854f4ac](https://github.com/zuohuadong/supacloud/commit/854f4ac060bc11343bb45c52ad5ea4e6d3b4a11b))
* release main ([31b095c](https://github.com/zuohuadong/supacloud/commit/31b095c43748f28bc1422a077df320d95e543175))
* release main ([870112e](https://github.com/zuohuadong/supacloud/commit/870112e8b4314f334b5007a7d148f4fd965a242d))
* release main ([cb5a91c](https://github.com/zuohuadong/supacloud/commit/cb5a91c2fbb230e42a204d060bd5b3158654eb93))
* release main ([83229a7](https://github.com/zuohuadong/supacloud/commit/83229a71488b1de5f33105ab53f3be31bdefb4d9))
* release main ([e9101e0](https://github.com/zuohuadong/supacloud/commit/e9101e0120f7ccb84ac7584051c7f556bbdf84a6))
* release main ([3aad1b2](https://github.com/zuohuadong/supacloud/commit/3aad1b20a67ec2cb0c782f63fa7a95e01e6b8eaa))
* release main ([9d84e39](https://github.com/zuohuadong/supacloud/commit/9d84e39ea4fb5ffa9cfb90b9d5c917a65eca774d))
* release main ([ec63fb2](https://github.com/zuohuadong/supacloud/commit/ec63fb24cc1e5589d7a3db04340956b26feabe04))
* release main ([e014f72](https://github.com/zuohuadong/supacloud/commit/e014f7292b04f5b7490f0e13b2591009b9201d97))
* release main ([44d8344](https://github.com/zuohuadong/supacloud/commit/44d8344d36e813ac22c179ae5c4ed643b970bbb9))
* release main ([177be2a](https://github.com/zuohuadong/supacloud/commit/177be2a31983509e5262ca289136c4b078c8b8c3))
* release main ([5bffa54](https://github.com/zuohuadong/supacloud/commit/5bffa5453d2d9d8eeccd0f5a861ffc08ab0aa724))
* release main ([1175844](https://github.com/zuohuadong/supacloud/commit/1175844cbcbca91e9a5fbde14433ae016d756e41))
* release main ([519e551](https://github.com/zuohuadong/supacloud/commit/519e5518f0b23aca34ffc4488cf41c6bd320b08b))
* release main ([28dd468](https://github.com/zuohuadong/supacloud/commit/28dd46854718e4cc7ce0484098cea9051be75814))
* release main ([71845b0](https://github.com/zuohuadong/supacloud/commit/71845b0e1da740825cef3131ec89f4962bfeb268))
* release main ([7065db9](https://github.com/zuohuadong/supacloud/commit/7065db93a028d9b48ed093cc5f00f6c21547f2ee))
* release main ([91ab682](https://github.com/zuohuadong/supacloud/commit/91ab6821ccd527283000ad9d85c59ba4db6061a0))
* release main ([7bcb4fb](https://github.com/zuohuadong/supacloud/commit/7bcb4fb720707213d057ef743ba1b4fcf29f49a1))
* release main ([97d3e7b](https://github.com/zuohuadong/supacloud/commit/97d3e7b673c61a6925743754887581e1fb53bdac))
* release main ([c1fb3b8](https://github.com/zuohuadong/supacloud/commit/c1fb3b8757cb80d86b8bde559458f0f5693b0f19))
* release main ([1659cf1](https://github.com/zuohuadong/supacloud/commit/1659cf1de67ecb6cef082717df1769fc204b0942))
* release main ([a23a693](https://github.com/zuohuadong/supacloud/commit/a23a6939233998aa24449826bb001c1402d9ba37))
* release main ([fb49e13](https://github.com/zuohuadong/supacloud/commit/fb49e13f6d7bfe38bf45345840a3a72eb7a17594))
* release main ([95faa91](https://github.com/zuohuadong/supacloud/commit/95faa91498b3f4c8a169bf1f9fdd2d32fad365a2))
* release main ([3333fe8](https://github.com/zuohuadong/supacloud/commit/3333fe8485536a5eb89ff56ea2cea8d1d63024be))
* release main ([0ae1d8f](https://github.com/zuohuadong/supacloud/commit/0ae1d8fd69b730c04bbc5eca67cf3eb993c13285))
* release main ([916dc05](https://github.com/zuohuadong/supacloud/commit/916dc052673f991dc508f8125020b94f86ebc3c2))
* release main ([adc35d5](https://github.com/zuohuadong/supacloud/commit/adc35d57af65a5d0ebc04b144909dc81c3084220))
* release main ([#106](https://github.com/zuohuadong/supacloud/issues/106)) ([c057d26](https://github.com/zuohuadong/supacloud/commit/c057d269c1abb56c5c0df6b1209d8a16c9b5881f))
* release main ([#109](https://github.com/zuohuadong/supacloud/issues/109)) ([87897d6](https://github.com/zuohuadong/supacloud/commit/87897d61a305d4fe1350b74a60507a222492aab3))
* release main ([#111](https://github.com/zuohuadong/supacloud/issues/111)) ([e136d89](https://github.com/zuohuadong/supacloud/commit/e136d896020555aee7472f1d27b2d0215c98cd2e))
* release main ([#113](https://github.com/zuohuadong/supacloud/issues/113)) ([157ecf4](https://github.com/zuohuadong/supacloud/commit/157ecf4c1475c23e46166ccd46b6df6b5b013e73))
* release main ([#75](https://github.com/zuohuadong/supacloud/issues/75)) ([58492af](https://github.com/zuohuadong/supacloud/commit/58492afd48273e018bf0df202ab9d7e0a2ac4b79))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([11ff3e7](https://github.com/zuohuadong/supacloud/commit/11ff3e76eeb4f752e51ea3b0b8d6024196f6e99a))
* **release:** bump management-api to 0.8.0 ([4fac643](https://github.com/zuohuadong/supacloud/commit/4fac6430d1f9d395ed0530d784876a3bdf6da8d0))
* **release:** bump unified versions by 0.0.1 ([98dd8ee](https://github.com/zuohuadong/supacloud/commit/98dd8eeaed49ec51fe638a8a8fa72c5bad8c217f))
* **release:** bump version to 0.7.5 ([18c3b41](https://github.com/zuohuadong/supacloud/commit/18c3b4141233fdb47ebd33d78926b7db6cad75ca))
* **release:** bump version to 0.7.6 ([cad136f](https://github.com/zuohuadong/supacloud/commit/cad136f9b95ffe6da7a4b98b1b43bff749adcfc5))
* **release:** bump version to 0.7.7 ([ff94ae8](https://github.com/zuohuadong/supacloud/commit/ff94ae87e6af76b64b03ffb4aefdba0e71af5f6e))
* **release:** bump version to 0.7.8 ([7e15b76](https://github.com/zuohuadong/supacloud/commit/7e15b7671db74a1964e2f845612fc8eb84d06396))
* remove obsolete debug artifacts ([d5fcd34](https://github.com/zuohuadong/supacloud/commit/d5fcd3401eb7d4c71e29922a2ee523ba327d3870))
* setup release-please for automated versioning and update svadmin dependencies ([2f8cd9e](https://github.com/zuohuadong/supacloud/commit/2f8cd9e8c79fbdccc36bf6e37754af212c9d2589))
* **ts:** finish TypeScript 6 typecheck migration ([b34fa1a](https://github.com/zuohuadong/supacloud/commit/b34fa1aa93dff56a1a9347c33f9691098cb708f5))
* upgrade svadmin to latest version and fix breaking changes in query/mutation hooks ([3f4df1e](https://github.com/zuohuadong/supacloud/commit/3f4df1e413fb3ee713681701232b15860fec8e0d))

## [0.16.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.15.0...management-api-v0.16.0) (2026-05-15)


### Features

* add project OAuth/OIDC migration ([0315760](https://github.com/zuohuadong/supacloud/commit/0315760c7864b17dd0433a0f9b918be8a64931cd))
* add queue client api ([b07be9c](https://github.com/zuohuadong/supacloud/commit/b07be9cf0b8f74d8fa3291ee7b563da88a6f46f7))
* **auth:** add Webhooks, SSO/SAML, and MFA management APIs for Studio parity ([ab2f877](https://github.com/zuohuadong/supacloud/commit/ab2f8778800a93a4fef14dc00caace2370a09787))
* **background:** make async routing server-driven ([11851ad](https://github.com/zuohuadong/supacloud/commit/11851adb6682a2f86cbca7e6d506e059184c9b7b))
* **cli:** add postgres config, pooler, network-restrictions, and storage policies endpoints ([af93af2](https://github.com/zuohuadong/supacloud/commit/af93af226f204dfc30ac1aba2aba4cb755f07b1c))
* **core:** harden realtime scale limits, dynamic PK resolution, and log retrieval ([f3c17f5](https://github.com/zuohuadong/supacloud/commit/f3c17f5990d408f0ac90b91f401492e72e4f3ad8))
* **core:** integrate official walrus architecture to realtime schema ([8547f36](https://github.com/zuohuadong/supacloud/commit/8547f364fb565417d771c95cd980da28637282b2))
* **core:** Native Supabase compatibility fixes for Realtime, Storage RLS, and Edge Functions ([fd83e88](https://github.com/zuohuadong/supacloud/commit/fd83e88a67ec1736c1066707a7a2d3b9692a0f4b))
* **edge-functions:** implement per-function verify_jwt configuration ([adf6746](https://github.com/zuohuadong/supacloud/commit/adf67468b4ccb225aaf3dc50e0fd0bf2f10cb304))
* **edge-runtime:** natively expose core SUPABASE_* variables to Deno function sandbox ([d5fb3ee](https://github.com/zuohuadong/supacloud/commit/d5fb3eefcd3ca247bac00fa345432b5b4fa676b3))
* **extensions:** expand auto-install whitelist with pg_cron, pgvector, postgis, pgaudit ([6733932](https://github.com/zuohuadong/supacloud/commit/6733932985499d4b5b84edf6665e143ea18b1f21))
* **gateway:** manage certificates through Kong ([49c1426](https://github.com/zuohuadong/supacloud/commit/49c1426c576ad2364c965f9d81d54d586b556905))
* improve database sql cli workflows ([d2faf45](https://github.com/zuohuadong/supacloud/commit/d2faf45cf2f962169a28798fb8b626f0e68f6835))
* **management-api:** abstract realtime tenant routing and config fallbacks for sdk parity ([408ad4c](https://github.com/zuohuadong/supacloud/commit/408ad4cd5e5757e7d72c86e2a6bbc2fc2c2ac9d6))
* **management-api:** add Swagger detail annotations to all 121 route handlers ([5cb9d8f](https://github.com/zuohuadong/supacloud/commit/5cb9d8ff44992c1cc49be9df8cc4ac118556e7e5))
* **management-api:** add tenant-scoped custom path rate limiting via Kong ([1747c46](https://github.com/zuohuadong/supacloud/commit/1747c46bbb3b9efc949b6550ea67733a6b88acea))
* **management-api:** add web console tasks tracking & custom rate limits UI ([366416c](https://github.com/zuohuadong/supacloud/commit/366416c9ed370812a26af7a9b4fc1ccac65c38d1))
* **management-api:** implement Postgres LISTEN/NOTIFY queue worker for AI & MQTT events ([fbaca0e](https://github.com/zuohuadong/supacloud/commit/fbaca0e83d071ba6e5f08e4d063e295513a90531))
* **management-api:** implement S3 fetch adapter and improve shared CI database routing ([95bf226](https://github.com/zuohuadong/supacloud/commit/95bf2262e6324099cb8de2ebb0c0c9bb338b9de5))
* **management-api:** use async getProjectRef and update edge runtime config to use external config.ts bindings ([c563e4b](https://github.com/zuohuadong/supacloud/commit/c563e4bbe4aa18bd0ba4572ba2000df388b14f24))
* **mcp:** expose edge function logs and update tools documentation ([a2b6b0f](https://github.com/zuohuadong/supacloud/commit/a2b6b0fb9bb2703eefca94607cbf8e8e32ab34dd))
* optimize tenant runtime lifecycle ([76c26ef](https://github.com/zuohuadong/supacloud/commit/76c26efab0bc47a9509b46bc592b7f7be2b81c88))
* **platform:** massive stabilization update across edge-runtime, mcp, routing, and sdk-proxy compatibility ([bcb15e1](https://github.com/zuohuadong/supacloud/commit/bcb15e17cb0da13e1ba930999d777b2457e56d5d))
* **proxy:** align management API and realtime service with official Supabase parity ([17a2138](https://github.com/zuohuadong/supacloud/commit/17a213891aae4f8126fedbdff78549dbcbf473b0))
* **realtime:** enrich LISTEN/NOTIFY triggers with full OLD/NEW records and auto-attach DDL event trigger ([5286266](https://github.com/zuohuadong/supacloud/commit/52862667d20b77b4c2377c16e43a0247b373bc8f))
* **realtime:** replace docker realtime dependency with native SupaCloud Elysia implementation ([2e172e3](https://github.com/zuohuadong/supacloud/commit/2e172e33b77228f3a04da9d8d121fd66a37dc5ad))
* **schema:** add PostgREST pre-request context + supabase_migrations schema for CLI compatibility ([87db63f](https://github.com/zuohuadong/supacloud/commit/87db63f346702cf50c1bf852fce897d6ac618c14))
* **sdk/e2e:** finalize sdk proxy passthrough and structural snapshot tests ([f7d0e13](https://github.com/zuohuadong/supacloud/commit/f7d0e13f4b5b8e6938cccc988c828dd06c316a91))
* **self-host:** add PG18 compose stack and refresh tenant env ([bfe84bd](https://github.com/zuohuadong/supacloud/commit/bfe84bd12f689150f3978001c7cc8aafd24b51b1))
* **static:** add multi-core cluster mode via SO_REUSEPORT ([581e443](https://github.com/zuohuadong/supacloud/commit/581e443b30b9be69296b93fdd9cd78b45c328d56))
* **static:** implement HTTP 206 Range requests and graceful shutdown ([8febf67](https://github.com/zuohuadong/supacloud/commit/8febf67ebb60351af17ee2921661de7d1b5e3180))
* **studio:** real TypeScript type generation and pg_stat usage metrics ([01f3ab8](https://github.com/zuohuadong/supacloud/commit/01f3ab8e00a2164636f651e62dfea1e62c80dc97))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([f780e45](https://github.com/zuohuadong/supacloud/commit/f780e454c735fa81be08c9d122cd69d2907b8338))
* **system:** add realtime CDC prerequisites setup and imaginary proxy enhancements ([0ba08ba](https://github.com/zuohuadong/supacloud/commit/0ba08ba5c0381bef0151871eabe6e2822e117909))
* **tasks:** deploy background task and message queue features to servers ([dc85b34](https://github.com/zuohuadong/supacloud/commit/dc85b340db81f0866195b51d1aaeb81731b0824a))
* updates and fixes based on recent local changes ([fe495ba](https://github.com/zuohuadong/supacloud/commit/fe495baf4c7be6b469eb245a8c2bc62503f09a8e))
* **web-console:** integrate realtime health, custom domains and oauth panels ([f7d0e13](https://github.com/zuohuadong/supacloud/commit/f7d0e13f4b5b8e6938cccc988c828dd06c316a91))


### Bug Fixes

* add function invoke route, repair stale projects, web-console deployment ([3ed37ee](https://github.com/zuohuadong/supacloud/commit/3ed37ee7825fa060ca9ac11dab9ada16b923ddb8))
* add global error handlers to prevent silent crashes and log fatal errors ([b008860](https://github.com/zuohuadong/supacloud/commit/b008860f1b4a52806edc85634ce7b0e113a4e207))
* align vanity-subdomains endpoint to OpenAPI spec and drop @aws-sdk/client-s3 ([cd80ff7](https://github.com/zuohuadong/supacloud/commit/cd80ff744b39b799c115e7b6ba4fb94a1efecc9f))
* allow supacloud async cors headers ([332c605](https://github.com/zuohuadong/supacloud/commit/332c605c41e77e4ca942a6f4ed63d428c6866a02))
* auth middleware response format mismatch with route schemas ([#107](https://github.com/zuohuadong/supacloud/issues/107)) ([a93ee54](https://github.com/zuohuadong/supacloud/commit/a93ee5419f82f29fbe33c30aa459aa90d11290f4))
* **auth,infra:** 401 pre-flight and all-in-one local docker ([bc0a047](https://github.com/zuohuadong/supacloud/commit/bc0a0473cc7c580750a0af717502f15a01039a8f))
* **auth:** accept project service role on management routes ([ea0af53](https://github.com/zuohuadong/supacloud/commit/ea0af53996947ca9656b215550899036f69f25ac))
* **auth:** forward pagination and search params to GoTrue for admin list users route ([fb9347f](https://github.com/zuohuadong/supacloud/commit/fb9347f831c408bcb4ad5a1fb805629e2c64a9fc))
* **auth:** respect mailer_autoconfirm setting when global SMTP is configured ([41e3746](https://github.com/zuohuadong/supacloud/commit/41e3746bf4458db28236143c850f935af993e4fe))
* **auth:** restore empty string fallback for OpenAPI enum compliance ([1186f17](https://github.com/zuohuadong/supacloud/commit/1186f176e815296148c51e341c5e0feffee0b0ee))
* **ci:** align test schema with official supabase-js migrations for 100% SDK compatibility ([d6e1307](https://github.com/zuohuadong/supacloud/commit/d6e1307dfa16056a51b768ea087adc3aa207e99e))
* **ci:** fix E2E tests db insertion returning undefined and fix missing jwtSecret in CI tests ([f4c3cc1](https://github.com/zuohuadong/supacloud/commit/f4c3cc1912946749da3b4f38a9107854f98d79d0))
* **ci:** fix EdgeRuntime 9000 port collision with Minio and prevent Project creation edge crashes ([51194e1](https://github.com/zuohuadong/supacloud/commit/51194e1a2f4aecda4b352bc34c1814ad60421a91))
* **ci:** make official SDK compliance non-blocking tracking metric ([0320660](https://github.com/zuohuadong/supacloud/commit/03206603cbbfb5127cf7fafb4604998e46976ee6))
* **ci:** provide websocket for sdk compliance ([776686a](https://github.com/zuohuadong/supacloud/commit/776686ace6de9bcb86c874428010cefcc5811e58))
* **ci:** remove sql.end() from mid-pipeline compliance scripts to prevent connection poisoning ([966372d](https://github.com/zuohuadong/supacloud/commit/966372de5358c1e8ed3df1e3d91c11fa0eb07d25))
* **ci:** repair release asset upload ([b0e0025](https://github.com/zuohuadong/supacloud/commit/b0e00255b0936a44beede10e6f0defb972f5610d))
* **ci:** repair unit test syntax and SDK parity monorepo compatibility ([fa85911](https://github.com/zuohuadong/supacloud/commit/fa85911a018443eb9ed37678836147cc9737d90b))
* **ci:** resolve EdgeRuntime port collision and API schema validation errors in integration tests ([76e0844](https://github.com/zuohuadong/supacloud/commit/76e084432a2db3991baa27a67c042f87cfebcf86))
* **ci:** resolve FK constraint violation in CLI compliance and make all compliance scripts non-blocking ([c31a5bd](https://github.com/zuohuadong/supacloud/commit/c31a5bdafc6c403ed315b0f8f4f413de3ce820e7))
* **ci:** retry official cli bootstrap downloads ([245aa71](https://github.com/zuohuadong/supacloud/commit/245aa71bb58bd2669965373d06fd3a965eae4c27))
* **ci:** rewrite CLI compliance tests to use --db-url for self-hosted mode ([82ce0ff](https://github.com/zuohuadong/supacloud/commit/82ce0ff525c33893318f80a7efd50b509f5835db))
* **ci:** robust environment flag checks and S3 array buffer type coercions ([ba58e07](https://github.com/zuohuadong/supacloud/commit/ba58e077e598e2b3a570bf7c9774cca486afdbe5))
* **cli:** push migrations through management API ([300afb4](https://github.com/zuohuadong/supacloud/commit/300afb4a9e56eb15f68da6b1c3b85a0af321689a))
* **cli:** push migrations via management api ([46f6fbc](https://github.com/zuohuadong/supacloud/commit/46f6fbccea1e7188b0faa2dc6d1cb9c8af1f49d0))
* **compat:** complete Supabase parity hardening for DB extensions, Signed URLs and API tests ([6a75497](https://github.com/zuohuadong/supacloud/commit/6a7549705d1e187113edae1ec274666dac41df04))
* **compatibility:** address P0, P1, and P2 compatibility issues ([fd7133b](https://github.com/zuohuadong/supacloud/commit/fd7133bb1dae7e9edf156ddc8880e982bc2890c8))
* **compatibility:** address realtime array ids, ws cleanup, and schema dependencies ([8b31d1b](https://github.com/zuohuadong/supacloud/commit/8b31d1b596abdd910bb81853754ddd80f96e54d6))
* **compat:** make database schema loading idempotent, sync runtime roles, and move upload state to postgres ([08c792b](https://github.com/zuohuadong/supacloud/commit/08c792bd626d4468760419ce8734fabdc100a887))
* **compat:** make full supabase schema idempotent, enforce RLS on signed uploads, scope db_user grants, and fix health probe ([78309ba](https://github.com/zuohuadong/supacloud/commit/78309ba02cf8f6a59365e689745f1de82b73f24b))
* **compat:** replace Deno.env.get with bun-native Bun.env[] in edge function templates ([acc3f7f](https://github.com/zuohuadong/supacloud/commit/acc3f7f90dce5f475d6fb573d288c3f78abfbd8c))
* **compat:** replace postgres driver with native bun:sql for edge auth closures ([77c863d](https://github.com/zuohuadong/supacloud/commit/77c863df59e2824574addb25f6ac49470bcb5d2e))
* **compat:** resolve deep semantic deviations spanning Realtime, Auth, and Storage ([d4af677](https://github.com/zuohuadong/supacloud/commit/d4af677eae723cc56f68ed61523143113397993b))
* **compat:** resolve Remaining P0 SDK mismatches for Storage response formats ([37710c2](https://github.com/zuohuadong/supacloud/commit/37710c29b2c92ce1350cae679a576b8db195a079))
* **compat:** resolve Remaining P1/P2 Storage and auth issues from Phase 19 audit ([a27dc96](https://github.com/zuohuadong/supacloud/commit/a27dc963f7aa45c4dd835563880ca8b941f15c69))
* **compat:** resolve storage runtime metadata fidelity and explicitly link custom provider physical identities using postgres bindings ([e498ae3](https://github.com/zuohuadong/supacloud/commit/e498ae3746389475533caa7f247a24bcad1020f2))
* **compat:** StorageRLS return truthiness, phantom dry-run objects, schema grants order, and Edge JWT_SECRET injection ([1a0cac8](https://github.com/zuohuadong/supacloud/commit/1a0cac80aee8b8aa67c5b41b00bafadbbdccdfdf))
* **compat:** use bunjs native postgres import for edge functions instead of deno url ([6fc679b](https://github.com/zuohuadong/supacloud/commit/6fc679b75d7924bca9ad6e9bf6f6e61896d188cb))
* **core:** apply full supabase.sql schema during project bootstrap ([130f2f8](https://github.com/zuohuadong/supacloud/commit/130f2f8ce4a3ec020cdc0c09346aff6650675a09))
* **core:** harden infrastructure, sys roles, and pipeline cleanups ([833993e](https://github.com/zuohuadong/supacloud/commit/833993e02573a880e7224cda9a8ab2a6ce2e9754))
* **db:** add migration to enforce ON DELETE CASCADE on project_tasks FK ([6f10f2f](https://github.com/zuohuadong/supacloud/commit/6f10f2fe8cc99435905bd2abdbe8785729705e2d))
* **db:** remove index creation from ddlQuery to avoid execution failure on partial schema ([600b671](https://github.com/zuohuadong/supacloud/commit/600b6718fe4446f708748c1a5f99dff4a9d9694e))
* **db:** use sql.unsafe for sequential DDL execution to prevent prepared statement errors ([05d9304](https://github.com/zuohuadong/supacloud/commit/05d93045b032711f810b8d647ab12daf1d9919db))
* **deps:** remove dredd, upgrade MCP SDK, override hono/path-to-regexp to eliminate 26 audit vulnerabilities ([4ca828b](https://github.com/zuohuadong/supacloud/commit/4ca828b1450ae8d5326c90a1839d73c0b8a4e072))
* **e2e:** fix storage routing, postgrest schema reload, and CI gotrue boot crashes ([a2f64b3](https://github.com/zuohuadong/supacloud/commit/a2f64b36ddcd5ce4d99dc4d92d8883f0fbee6b9b))
* **e2e:** force storage to use postgres global database in proxy mode and debug gotrue boot ([35996c6](https://github.com/zuohuadong/supacloud/commit/35996c603c01949fe7bb2890025931adc8b3523c))
* **e2e:** mock task workers and dynamically provision minio bucket in CI via AWS SDK ([97564de](https://github.com/zuohuadong/supacloud/commit/97564def72a65c9b900f43cae7bbff63d289099a))
* **e2e:** resolve 6 CI test failures ([3f42413](https://github.com/zuohuadong/supacloud/commit/3f424134dc3ad0255716501a0886b658c57f5b1e))
* **e2e:** resolve multiple syntax errors, s3 provisioning mock and bucket snapshot error mapping ([8530d3a](https://github.com/zuohuadong/supacloud/commit/8530d3a4c63b93481c95d2efa2cb5b5930a3cb21))
* **e2e:** stabilize CI pipeline by bypassing realtime provision and natively bootstrapping storage tables ([530cf98](https://github.com/zuohuadong/supacloud/commit/530cf9880ba8b2c9e1245924a8424eb19865c86f))
* **e2e:** switch ci postgres connection to supabase_admin to bypass auth namespace permission denied ([09d6049](https://github.com/zuohuadong/supacloud/commit/09d6049b638f48d2c336e0e6db9ebf74ae02250a))
* **edge-runtime:** avoid double-managed runtime restarts ([bc6b664](https://github.com/zuohuadong/supacloud/commit/bc6b6646903ef2bd48038b7a8a1a968ec4c3b503))
* **edge-runtime:** bypass verifyJwt for CORS preflight OPTIONS requests to prevent 401 errors ([ea26fe0](https://github.com/zuohuadong/supacloud/commit/ea26fe0344e083cac90b8c9c9354178537053552))
* **edge-runtime:** inject Bun function env ([66b7266](https://github.com/zuohuadong/supacloud/commit/66b7266344177b96abcd7452fe5fa31195a922d6))
* **edge-runtime:** keep embedded child restarting ([3fd8e72](https://github.com/zuohuadong/supacloud/commit/3fd8e7216b61a5dbbaf4ee61d537990d93e9ed94))
* **edge-runtime:** preserve env for waitUntil tasks ([f5ab3a4](https://github.com/zuohuadong/supacloud/commit/f5ab3a42a382ee77460fca569df9527b68da2b3e))
* **edge-runtime:** preserve env for waitUntil tasks ([cba4f62](https://github.com/zuohuadong/supacloud/commit/cba4f62a50cdda1b33e8a3cdc2bbab09889f7549))
* **edge-runtime:** sync manager port to 9000 to match Kong gateway routes ([ef1771f](https://github.com/zuohuadong/supacloud/commit/ef1771f275cf308503b5804c3a4c150a25413e89))
* explicit @sinclair/typebox dependency to prevent elysia/edge-runtime crash during CI e2e tests proxy boot ([a4e4833](https://github.com/zuohuadong/supacloud/commit/a4e48334eff5692af16e51b4554c4753dbd550ee))
* extend rest proxy timeout ([e723950](https://github.com/zuohuadong/supacloud/commit/e723950689579f4397729dc0f129d87798f7b69b))
* **functions:** harden runtime routing and diagnostics ([7184c84](https://github.com/zuohuadong/supacloud/commit/7184c84d3c1ada76184cec0873398cbff2d30344))
* **gateway:** allow x-upsert and Cache-Control headers in CORS to support native Supabase SDK storage uploads ([ee5d92d](https://github.com/zuohuadong/supacloud/commit/ee5d92db1aff6aeed65e7c43bcf5edb53b54d9d0))
* **gateway:** include hosted frontend origins in cors ([0e5febb](https://github.com/zuohuadong/supacloud/commit/0e5febb71a471e89a01eba5c2e9ead92f20ce034))
* **gateway:** increase default Kong timeouts to 500s for AI/OCR inference ([421bcb5](https://github.com/zuohuadong/supacloud/commit/421bcb5e238b8313d782b0cc6a84d5af7f241292))
* **gateway:** preserve functions proxy path prefix ([ea21232](https://github.com/zuohuadong/supacloud/commit/ea212329290c99678900c1ffcec05d856f92e4ac))
* **gateway:** resolve edge runtime startup loops and enhance auth proxy routing stability ([51e516d](https://github.com/zuohuadong/supacloud/commit/51e516d422dcf3c467630b99ef178f105398cd8c))
* harden management API edge cases ([416e210](https://github.com/zuohuadong/supacloud/commit/416e21083e39accd30c94f6c6a6ffdb743305cff))
* harden realtime tasks and data-plane boundaries ([f396257](https://github.com/zuohuadong/supacloud/commit/f396257e4c442d7cfb581824b15080bf6dfe64bf))
* improve one-click install robustness, add function invoke route, repair stale projects ([cabc22f](https://github.com/zuohuadong/supacloud/commit/cabc22fe416ccd2e7555cc7ef67aa25fd1248f87))
* **installer:** align pigsty supabase install path ([aa34fe3](https://github.com/zuohuadong/supacloud/commit/aa34fe364290383e77d0f62cf24a448514a7fc29))
* **installer:** derive studio domain from API host ([00a0008](https://github.com/zuohuadong/supacloud/commit/00a0008b4cd492afa27f92ec05dfb9977c92a57e))
* **install:** skip legacy supabase compose stack ([d09d0b0](https://github.com/zuohuadong/supacloud/commit/d09d0b0654e204c74418ae97a8f360aaedc912c6))
* make production upgrades binary-first ([7fd392b](https://github.com/zuohuadong/supacloud/commit/7fd392be1760b41ef7a103dd76c411032202e8d9))
* **management-api:** accept serialized routing config ([f891925](https://github.com/zuohuadong/supacloud/commit/f891925dbf1f42581d8e6e13bae6fc3bf936a467))
* **management-api:** add anon rls policies and realtime schema db grants for sdk tests ([4a872bb](https://github.com/zuohuadong/supacloud/commit/4a872bb8a3f306bd0b4d86c63ac1b80601eb7e1b))
* **management-api:** add missing realtime rls policies to official sdk test suite setup ([8f80aaa](https://github.com/zuohuadong/supacloud/commit/8f80aaa83db79b52759d539d138cfd9abd04efd1))
* **management-api:** allow public storage reads on custom domains ([2dba2db](https://github.com/zuohuadong/supacloud/commit/2dba2db3f7cbcffdf7e1b554fd598d702ae09dce))
* **management-api:** comply with rfc 1123 hostname rules and aws s3 specs ([6000406](https://github.com/zuohuadong/supacloud/commit/6000406a2094b0c3361e60999ee5aaa249a98c43))
* **management-api:** correct proxy ws route to match phoenix websocket mount point exactly ([4c64f27](https://github.com/zuohuadong/supacloud/commit/4c64f276ea3256cf5042679aa77450568286921e))
* **management-api:** default to port 9090 ([b0f5db7](https://github.com/zuohuadong/supacloud/commit/b0f5db7a508ae48f3231b69b93ac13b055ea1cc7))
* **management-api:** encrypt background task credentials ([478fc0e](https://github.com/zuohuadong/supacloud/commit/478fc0e79a19173b14c5f62c0497508f171ccc52))
* **management-api:** enforce Swagger route coverage ([44e7d4b](https://github.com/zuohuadong/supacloud/commit/44e7d4b369c78b82d65fdccc7e5e34c0deaa14a2))
* **management-api:** expose unmasked runtime env internally ([11f58e6](https://github.com/zuohuadong/supacloud/commit/11f58e6727b093d40bc36a000472fe3fb83439c0))
* **management-api:** grant auth roles tenant database access ([f748812](https://github.com/zuohuadong/supacloud/commit/f7488120403e2e33b48048cb00dd2c6b25453ce5))
* **management-api:** grant postgrest authenticator database access ([23beb27](https://github.com/zuohuadong/supacloud/commit/23beb278832b298cae3872298f40d6f1a44b2d0d))
* **management-api:** harden project queue reliability ([d0816c9](https://github.com/zuohuadong/supacloud/commit/d0816c9ea5f9f5be6fa1db0154808548b802a3d9))
* **management-api:** harden sdk proxy unit test isolation ([688fb20](https://github.com/zuohuadong/supacloud/commit/688fb201767e2f1b540f99ad3855a525b9d77d16))
* **management-api:** harden storage and background contracts ([fe246b6](https://github.com/zuohuadong/supacloud/commit/fe246b6a1897166ac756275c164cf59f7474f5f5))
* **management-api:** harden storage list metadata parsing ([69ed6f2](https://github.com/zuohuadong/supacloud/commit/69ed6f2e42c37952615ebc8095e51871720888ee))
* **management-api:** inject internal supabase runtime secrets ([8b8b797](https://github.com/zuohuadong/supacloud/commit/8b8b79728977204bf8ee06e8967cfbf2057ff78c))
* **management-api:** isolate background auth encryption regression ([ca3371e](https://github.com/zuohuadong/supacloud/commit/ca3371e61e1295b4d5887229b3bef1c6a123770f))
* **management-api:** make edge runtime port dynamically configurable from environment ([aabb108](https://github.com/zuohuadong/supacloud/commit/aabb1087b1a27c5b4d863208287d130df5129a45))
* **management-api:** normalize project response timestamps and update functions secrets schema formatting ([fa0ec55](https://github.com/zuohuadong/supacloud/commit/fa0ec553430c684ec00af70b01e785527edbd5c5))
* **management-api:** pin Supabase JS compliance ref ([2c0fd2e](https://github.com/zuohuadong/supacloud/commit/2c0fd2efb8e96aed7cb41ea342f8d887ce7e7ba2))
* **management-api:** reconcile custom domain runtime routes ([2f2d9da](https://github.com/zuohuadong/supacloud/commit/2f2d9dad97479723c392e3b99f854c910e0ac722))
* **management-api:** refine s3 ports and storage adapter error handling ([516d0c8](https://github.com/zuohuadong/supacloud/commit/516d0c805892e5e14d22068093e81006ade95e5e))
* **management-api:** remove malicious sdk parity minio port rewrite and resolve edge-runtime container port collision ([e7b66f1](https://github.com/zuohuadong/supacloud/commit/e7b66f1e2f17d9ef8d88ea7ba76c9ed7e6e2772f))
* **management-api:** resolve functions tenants from custom domains ([9171fbd](https://github.com/zuohuadong/supacloud/commit/9171fbd201234f74c6c15d3547043ad8c5dcbb56))
* **management-api:** revert realtime proxy path to use /socket/websocket to fix HTTP 404 dropping connections ([131c2f2](https://github.com/zuohuadong/supacloud/commit/131c2f26e29733edfdef8904df5f07e117a888ca))
* **management-api:** set duplex on sdk-proxy test requests ([5a3fab4](https://github.com/zuohuadong/supacloud/commit/5a3fab47ec93a35bdf0ef5fcbe3fbb8c843a5dce))
* **management-api:** spoof realtime host header and dump api logs on ci failure ([ce696fc](https://github.com/zuohuadong/supacloud/commit/ce696fc697724d04c55928ebab6bfec3495bc83e))
* **management-api:** stabilize encrypted background task regression ([16be349](https://github.com/zuohuadong/supacloud/commit/16be34947c233b35a395db11bd991d541161f9be))
* **management-api:** strictly align P0/P1 OpenAPI endpoints and refactor Vanity Subdomain schemas ([512ee52](https://github.com/zuohuadong/supacloud/commit/512ee52b79f1c2503d788f787f21d43313e38ab0))
* **management-api:** use aws4fetch for robust s3 operations and fix realtime CDC prereqs timeouts ([9f893f2](https://github.com/zuohuadong/supacloud/commit/9f893f2296a7c69e73ab066ae8079a38c4fb3ed4))
* **management-api:** use native S3 fetch adapter for CI uploads and standardize WS proxy headers ([39a0bdb](https://github.com/zuohuadong/supacloud/commit/39a0bdb3995c8659dca09413f4b27a2a9b1e5a2f))
* **management-api:** use node random uuid in sdk proxy ([77aceea](https://github.com/zuohuadong/supacloud/commit/77aceea8f6fa109818093afe1693b14d3a1b417d))
* materialize juicefs upload streams ([2d3a253](https://github.com/zuohuadong/supacloud/commit/2d3a2538205d8daafeaa4818730e4c2142c9ccde))
* materialize storage upload streams ([49d6819](https://github.com/zuohuadong/supacloud/commit/49d681945882f441a7b65fdf5914ff23a55e003a))
* **openapi:** align ref generation, service health, config responses with official Supabase OpenAPI spec ([6d94ded](https://github.com/zuohuadong/supacloud/commit/6d94dedd37a5f1996983f6d6c60c2129104c3824))
* **openapi:** resolve TS error for custom hostname data property ([b7430fa](https://github.com/zuohuadong/supacloud/commit/b7430fa1a3da4f89b06ec4a76e45d0b2429967fb))
* **openapi:** satisfy strict schema enums and ref length requirements ([ddd6a54](https://github.com/zuohuadong/supacloud/commit/ddd6a54e1b53d33c9d9895b5e008d673639c706d))
* **openapi:** use predefined enums for missing auth config providers instead of empty strings ([eca51ff](https://github.com/zuohuadong/supacloud/commit/eca51ffd0a7dcb705d3a644fb37f24b624cfe688))
* **pigsty:** align 4.3 upgrade with supacloud storage defaults ([7f2a857](https://github.com/zuohuadong/supacloud/commit/7f2a85711292859c5bb1b1d709effbeaea1d781d))
* **postgrest:** enable OpenAPI mode, db-pre-request, and single-source config ([9c172b5](https://github.com/zuohuadong/supacloud/commit/9c172b5efdcb6adc288bf7ab4095f1a06d16e482))
* provision_runtime fails on Ubuntu due to Group=nobody and missing auth schema ([#110](https://github.com/zuohuadong/supacloud/issues/110)) ([29faf4f](https://github.com/zuohuadong/supacloud/commit/29faf4fb42c1562ed30897ac9a935fccdb9844cd))
* **proxy:** forward function POST bodies with duplex ([d39d801](https://github.com/zuohuadong/supacloud/commit/d39d8018b6fc4024481d6facc28fdb55866c1166))
* **proxy:** resolve Elysia routing precedence and e2e testing bugs ([f39fdee](https://github.com/zuohuadong/supacloud/commit/f39fdee9cababa10ecc0a4e5375588d5aeed34ca))
* **proxy:** update Elysia wildcard routing for correct SDK REST and Auth passthrough ([0364f5f](https://github.com/zuohuadong/supacloud/commit/0364f5f3b9b628d533589e65f3d20a98ea3306ab))
* publish background tasks for realtime ([ef0a19e](https://github.com/zuohuadong/supacloud/commit/ef0a19e118a0202b598ac170f6e54971d6381519))
* **queue:** keep edge functions on dedicated worker ([63213c3](https://github.com/zuohuadong/supacloud/commit/63213c34a0b5c57761a99d865edf4f20783697d5))
* **queue:** migrate foundation worker to stable pg-listen ([20f5f07](https://github.com/zuohuadong/supacloud/commit/20f5f0703a0da4810248db97b62852f16ae087c2))
* **realtime:** connect tenants with admin database credentials ([2d46d30](https://github.com/zuohuadong/supacloud/commit/2d46d30d33a4ed864cbe6a3d0232447a46e58978))
* **realtime:** correct subscribeTenant arity (TS2554) ([df49c12](https://github.com/zuohuadong/supacloud/commit/df49c12009c10e0c5dbff75eee5d9c01b5332dac))
* **realtime:** proxy websocket traffic via management ws ([599041f](https://github.com/zuohuadong/supacloud/commit/599041fd028c33ba2fabb9734b18c7df887868df))
* **realtime:** reconcile missing tenants and use valid enc key ([7d133f9](https://github.com/zuohuadong/supacloud/commit/7d133f980a45cda46889a3a299248aab1fc1a06e))
* **realtime:** reconcile tenant schema privileges ([11984f4](https://github.com/zuohuadong/supacloud/commit/11984f4911ae95c76290944f1fd34feb900ab1e6))
* **realtime:** resolve websocket protocol encoding, path matching, and presence syncs ([5d3d86b](https://github.com/zuohuadong/supacloud/commit/5d3d86b560e2ca7f3e7ca36b6f8a63fd8d831b14))
* **realtime:** route websocket through root proxy ([9947074](https://github.com/zuohuadong/supacloud/commit/9947074ce2386721821721b221247cc435c370a3))
* **realtime:** route WebSocket to self-seeded tenant realtime-dev via host header ([3b94834](https://github.com/zuohuadong/supacloud/commit/3b94834277365ec8189b9d726e270849033c3b83))
* **realtime:** sign tenant reconcile admin tokens correctly ([9724f1c](https://github.com/zuohuadong/supacloud/commit/9724f1cc0d364984df6ca9ae2b9cdb5a9cc7a040))
* **realtime:** use node crypto for admin JWT signing ([a3da533](https://github.com/zuohuadong/supacloud/commit/a3da53369c4862c5be7b73864ef28a66bbcb9063))
* resolve unit test and automation suite failures due to ci overriding jwt and absent db configurations ([aa0cc9d](https://github.com/zuohuadong/supacloud/commit/aa0cc9d40ac1a78ab98a537dbc18007f7af58c47))
* restore project reprovisions missing resources ([e757d3a](https://github.com/zuohuadong/supacloud/commit/e757d3a18ab31fdb7dc3edaf8eb5ee63585db512))
* **routing:** unify tenant domain and port resolution ([f9da764](https://github.com/zuohuadong/supacloud/commit/f9da764cd348045d8a91df0ff932a34e7d289bdb))
* **runtime:** respect ssl config for tenant urls ([25a4f97](https://github.com/zuohuadong/supacloud/commit/25a4f97761813db374c93aed1c398413b0c6dce7))
* **runtime:** respect ssl config for tenant urls ([8520e5d](https://github.com/zuohuadong/supacloud/commit/8520e5d2661b043efcdd681a2f699c4c72bf5dfd))
* **security:** harden storage and proxy surfaces ([10044a5](https://github.com/zuohuadong/supacloud/commit/10044a5e5cadf023a8893ac07781ea926a97b56f))
* **services:** mock S3 provision and cleanup in CI mode to prevent destructive saga rollbacks ([0364f5f](https://github.com/zuohuadong/supacloud/commit/0364f5f3b9b628d533589e65f3d20a98ea3306ab))
* ship web console with binary upgrades ([373b712](https://github.com/zuohuadong/supacloud/commit/373b7122f3059faacc6fb7d0a93b4788fe83ab54))
* skip missing tenant dbs during realtime reconcile ([c7d9842](https://github.com/zuohuadong/supacloud/commit/c7d9842ab3ebf4e8cb7b37f848099e45f7fa4028))
* stabilize edge runtime under binary upgrades ([613a123](https://github.com/zuohuadong/supacloud/commit/613a1238ca8781871ab272d44eea361532e80175))
* standardize HTTP status codes in API error responses and improve CI health checks ([ffab9d4](https://github.com/zuohuadong/supacloud/commit/ffab9d4c99d58647eeb6366b07ea2fd032d20d3f))
* **static:** replace sirv-cli with Bun-native disk-read static server ([cb70cd8](https://github.com/zuohuadong/supacloud/commit/cb70cd8d1ad47193736b76e0aa931b23b3c4718f))
* **storage:** add s3 compensatory rollbacks on db materialization drops, and align move/copy verifications ([c31f571](https://github.com/zuohuadong/supacloud/commit/c31f571131adf2979611f72079d4f5c3a1c33345))
* **storage:** align listV2 payload schema with supersonic sdk cursor logic, delimit switches, and correct folder signatures ([e165dbd](https://github.com/zuohuadong/supacloud/commit/e165dbdacd83bf259e5c47f7498e859b3aedfdc0))
* **storage:** align sdk outputs, append cache-controls, rewrite native id mappings, format schema json boundaries, handle download dispositions and purge social scale traps ([47718f0](https://github.com/zuohuadong/supacloud/commit/47718f0d88f8c6b19793f90c59c72474b03f6fc4))
* **storage:** align upload Id with official API and fix bucket-not-found status ([9360ca7](https://github.com/zuohuadong/supacloud/commit/9360ca7fddc1a4c7e0883b37ba3656b98c1715e8))
* **storage:** bypass Elysia multipart parser to correctly support supabase-js SDK uploads missing body field names ([8fd351b](https://github.com/zuohuadong/supacloud/commit/8fd351b17dbbdcc64c5d9932975f1454cdae6f32))
* **storage:** correct wechat compilation, enforce move atomicity, validate upload persistence, and align bucket delete constraints ([5258a10](https://github.com/zuohuadong/supacloud/commit/5258a10532cd76abe3d4f6f07691835177ab9b05))
* **storage:** enforce bucket transaction atomicity, query limits, and 23505 constraints ([2a031d8](https://github.com/zuohuadong/supacloud/commit/2a031d868f01bbc6c0452b6a770d775a63d85192))
* **storage:** enforce move & tus assertions, isolate admin overriden buckets, format cdn restrictions and insert database defaults ([6e23522](https://github.com/zuohuadong/supacloud/commit/6e2352226748cf655fbc385228fec7e38c009b08))
* **storage:** enforce move transactional rollbacks, v1 list search binding, v2 delimiter defaults, and 404 project trace handling ([c54063c](https://github.com/zuohuadong/supacloud/commit/c54063c7b1a472e296d18271af5a7544d40a3342))
* **storage:** enforce RLS on existence checks and defer POST/PUT materialization ([0f62fc3](https://github.com/zuohuadong/supacloud/commit/0f62fc3cb57f7d4155856b050e5c43d9aa23b31e))
* **storage:** fix list observability, empty bucket status matching, signed upload checks and delete isolation ([b9f20e1](https://github.com/zuohuadong/supacloud/commit/b9f20e1cc632467286305ac8897ba09c597da873))
* **storage:** implement list-v2 folder collapsing, apply db mimetypes, and track rollback logging ([610c2a1](https://github.com/zuohuadong/supacloud/commit/610c2a1b5b61baacef831c373601215079780d63))
* **storage:** implement missing endpoints and payload compatibility ([2ceb0af](https://github.com/zuohuadong/supacloud/commit/2ceb0af52543cf3f7f9aebe59bb8b08e8a624c9e))
* **storage:** map list timestamps, enforce tus limits, and resolve public bucket overrides ([a74406a](https://github.com/zuohuadong/supacloud/commit/a74406a346db20f5299a7fbb15685e6596fd3be9))
* **storage:** migrate PUT to use custom multipart buffer boundary extractor ([3f2bf22](https://github.com/zuohuadong/supacloud/commit/3f2bf22d493a76b3b8cdf9077ff2fd416dc58421))
* **storage:** resolve 100% JS SDK functional compatibility issues ([c736c87](https://github.com/zuohuadong/supacloud/commit/c736c87736fe3f6ccbff565ccebc700a2b0ea780))
* **storage:** resolve bucket rls coupling, move transactional loops, and list sorting capabilities ([1296bd3](https://github.com/zuohuadong/supacloud/commit/1296bd30e4ba5498d0b9f8946d20265a4a706a44))
* **storage:** resolve upload TOCTOU concurrency and align official RLS error semantics ([a3c774c](https://github.com/zuohuadong/supacloud/commit/a3c774c4638b7acc3f057e760c12593b41e844ca))
* **storage:** sniff raw payload to force multipart parsing even when gateway overrides content-type to image/png ([2f5348e](https://github.com/zuohuadong/supacloud/commit/2f5348e540c04c343bcea54513fd090f15812c03))
* **storage:** store raw seconds in cacheControl metadata (official Supabase format) ([b5a55ee](https://github.com/zuohuadong/supacloud/commit/b5a55ee1c60a893e912d1bf65e73ec8231cc0b21))
* **storage:** stream large uploads through kong ([b06f669](https://github.com/zuohuadong/supacloud/commit/b06f669ed127b95bba7e8b20be27b2886b4f69f9))
* support github proxies for binary upgrades ([2a65cdf](https://github.com/zuohuadong/supacloud/commit/2a65cdf241c3e5389a13437fd280991f81e2ca39))
* **tasks:** allow invoker jwt to read task detail ([67c0cb2](https://github.com/zuohuadong/supacloud/commit/67c0cb29a4fd5688f6a22f447607cb6291f4ac1b))
* **tasks:** avoid malformed array literal issue in unsafe sql binding for ANY() ([a631807](https://github.com/zuohuadong/supacloud/commit/a631807e19b9bd17c3985e2552f0e78e569c9bba))
* **tasks:** patch tenant queue schema compatibility ([7d76a88](https://github.com/zuohuadong/supacloud/commit/7d76a883c278feef1184e6e8a8dc683aac68db56))
* tolerate sdk proxy background auth introspection failures ([b28564c](https://github.com/zuohuadong/supacloud/commit/b28564c92d9d0fca24eecfd920a198d9baa2776b))
* use direct GoTrue port instead of HTTPS API URL to avoid self-signed cert errors ([e531b7c](https://github.com/zuohuadong/supacloud/commit/e531b7ca510537b87b50da2fbcdf43247f44d06d))
* **web-console:** restore settings and task management UI ([c7c1e7d](https://github.com/zuohuadong/supacloud/commit/c7c1e7dacb82b427ec59d84aa5574ab30a524128))


### Elegance & Refactoring

* **api:** standardize error payload schemas across all routes for Stripe parity ([17a8164](https://github.com/zuohuadong/supacloud/commit/17a8164c0f39eaf318b4e8961ec67f0b26f9e32d))
* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([29a71da](https://github.com/zuohuadong/supacloud/commit/29a71da7ddbc326f0b16b7eeb4bb159784e347c7))
* **core:** use resolveDbName and parameterized queries for schema routing and postgres reflection ([177ef72](https://github.com/zuohuadong/supacloud/commit/177ef72275778d091a616f69a836efd87895053e))
* **edge-functions:** migrate version artifacts into internal revisions ([bd475aa](https://github.com/zuohuadong/supacloud/commit/bd475aa89989eea6a94668362b41b7fbee050765))
* **queue:** remove legacy pg-listen implementation ([ca186df](https://github.com/zuohuadong/supacloud/commit/ca186df82178acf6611226645b7d27d038ba6071))
* **realtime:** revert native realtime and restore official docker integration ([861377f](https://github.com/zuohuadong/supacloud/commit/861377f33569c28e637629d59234db22b2936560))
* remove legacy sql result alias ([d9c85e3](https://github.com/zuohuadong/supacloud/commit/d9c85e3916de88bb38b86e943a63a903789379bd))


### Performance Improvements

* reduce management hot path load ([2309d46](https://github.com/zuohuadong/supacloud/commit/2309d46b5f4ecfaad69742dcc7bfe80834615afe))


### Miscellaneous Chores

* align error codes and resolve DB roles in management API ([90cffb5](https://github.com/zuohuadong/supacloud/commit/90cffb50fbec47665c284b91407844322fe4f336))
* bump version (+0.0.1) for management-api and mcp-server ([c94f4af](https://github.com/zuohuadong/supacloud/commit/c94f4af59caf2423d422a99a99aa8fbc6dff7709))
* cleanup scratch files and commit modified files ([0598301](https://github.com/zuohuadong/supacloud/commit/0598301d11d550f677667bf14c470284cecd7b5d))
* **deps:** bump @svadmin/core in /packages/management-api ([#81](https://github.com/zuohuadong/supacloud/issues/81)) ([31a67a9](https://github.com/zuohuadong/supacloud/commit/31a67a91d39662a4bbe07d2413ec38c347e2f357))
* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/management-api ([#86](https://github.com/zuohuadong/supacloud/issues/86)) ([f3b2e58](https://github.com/zuohuadong/supacloud/commit/f3b2e58119e817e2a859d54aaf1c51cd41d7946e))
* flush remaining test suite fixes and project modifications ([686ad4b](https://github.com/zuohuadong/supacloud/commit/686ad4bb59b1e087c9bf621d9663b259f0f33d27))
* **management-api:** translate all queue worker comments to English ([406e693](https://github.com/zuohuadong/supacloud/commit/406e6937e014d751f99f67fa435000441a87f863))
* **management-api:** translate all remaining Chinese comments to English ([c1d5670](https://github.com/zuohuadong/supacloud/commit/c1d567063e99a47eefb38f8d00e89a6915e4a057))
* push all accumulated compliance and runtime integrations ([8a6fec0](https://github.com/zuohuadong/supacloud/commit/8a6fec02a010bc035670181c3394333325e891a3))
* release main ([4e7f2a6](https://github.com/zuohuadong/supacloud/commit/4e7f2a620baed1671e5d7005fc1d8b587982f208))
* release main ([3b1237f](https://github.com/zuohuadong/supacloud/commit/3b1237f22412a4485de2c4af21e6fd62babde48c))
* release main ([d6bd16a](https://github.com/zuohuadong/supacloud/commit/d6bd16a00f934b0c0c84110e7239abf942ab791e))
* release main ([dd7c341](https://github.com/zuohuadong/supacloud/commit/dd7c341b6b67b0b5c08140d67214a201cdc183d4))
* release main ([6688e2a](https://github.com/zuohuadong/supacloud/commit/6688e2ae64e6a80164a87f43cf0cdf85d862657f))
* release main ([f6bcb28](https://github.com/zuohuadong/supacloud/commit/f6bcb289706b6f06dbd914e3c9e0e34ea1b5cdbc))
* release main ([2133e72](https://github.com/zuohuadong/supacloud/commit/2133e7297156f2a16f155aaecaa04061acd8dbba))
* release main ([425f7da](https://github.com/zuohuadong/supacloud/commit/425f7da9d8816edab8a7a71d9ac95f1d6cf06e44))
* release main ([0355c8b](https://github.com/zuohuadong/supacloud/commit/0355c8befe2755b2a4e4d72c71a76123e1a7b6b8))
* release main ([14cc502](https://github.com/zuohuadong/supacloud/commit/14cc5024e876f5f7cb923d4306458acf3d004449))
* release main ([7537614](https://github.com/zuohuadong/supacloud/commit/7537614cbe0428dc53c44d4e47129938f99d55a2))
* release main ([bbc5871](https://github.com/zuohuadong/supacloud/commit/bbc58717a7377d6200b272cba70a402ae4971e2e))
* release main ([f0b4377](https://github.com/zuohuadong/supacloud/commit/f0b437729739e80d3acd7fb23c49624a2d96dcee))
* release main ([8b3d432](https://github.com/zuohuadong/supacloud/commit/8b3d4327ecf5e80ce091489a652108cbaa4b09b5))
* release main ([51e6d88](https://github.com/zuohuadong/supacloud/commit/51e6d882f5aaf4a20ddba2597df748647d898c6e))
* release main ([19b57d6](https://github.com/zuohuadong/supacloud/commit/19b57d655005f78d914f1b8ee61632067e87f8e7))
* release main ([7924b79](https://github.com/zuohuadong/supacloud/commit/7924b79abf2d1cab65026dbff344b7b6a20a8bfe))
* release main ([e229440](https://github.com/zuohuadong/supacloud/commit/e2294400adc88ad4ceebf5f5fdc67a57ed38334a))
* release main ([f86eac7](https://github.com/zuohuadong/supacloud/commit/f86eac758cc98a0a3fe8688f31ec34139be015a6))
* release main ([b6e4a0d](https://github.com/zuohuadong/supacloud/commit/b6e4a0d3f71b76248cfac5e9780984dd91ac39c6))
* release main ([9354c26](https://github.com/zuohuadong/supacloud/commit/9354c26bb259a9a1b89fdbdbf28a2b1b2c540af0))
* release main ([237cb3e](https://github.com/zuohuadong/supacloud/commit/237cb3ed1be202291f43653f533784a8c035e337))
* release main ([62a5a31](https://github.com/zuohuadong/supacloud/commit/62a5a315685c1bb3c308b45975f899cccd12b844))
* release main ([17f4b3a](https://github.com/zuohuadong/supacloud/commit/17f4b3a8883e241dd874836a004f2258efa490af))
* release main ([c572c9e](https://github.com/zuohuadong/supacloud/commit/c572c9ed5c2cab7b86a7f222f7b72912dc9f6e7e))
* release main ([bd45ae9](https://github.com/zuohuadong/supacloud/commit/bd45ae9daa1815d9c4b7a9c0888865d8e1bdb4b7))
* release main ([afb147c](https://github.com/zuohuadong/supacloud/commit/afb147c118cbe967ea8d60c826ae3553e0ea96e0))
* release main ([b6882d4](https://github.com/zuohuadong/supacloud/commit/b6882d4bce2b7add34022481a8ce09d02194ae42))
* release main ([ea97458](https://github.com/zuohuadong/supacloud/commit/ea97458072ef45486dd34948f61a03a404238e63))
* release main ([847e8f3](https://github.com/zuohuadong/supacloud/commit/847e8f3d26d570cdd36e2a87f25a63cf34fb5398))
* release main ([86f2d95](https://github.com/zuohuadong/supacloud/commit/86f2d95fe4dae6528eb1e4945846db413e0696c3))
* release main ([1bca726](https://github.com/zuohuadong/supacloud/commit/1bca72644a7d79dc91335c2146196fc109814877))
* release main ([87a7fc5](https://github.com/zuohuadong/supacloud/commit/87a7fc5fd94492fee00dc8639025548f3f51bef4))
* release main ([67cc94b](https://github.com/zuohuadong/supacloud/commit/67cc94b2722f4949577c9b6791c81df25632ecf5))
* release main ([cff457b](https://github.com/zuohuadong/supacloud/commit/cff457bdf2bc8584b154952162d0e5c621d13a87))
* release main ([608b396](https://github.com/zuohuadong/supacloud/commit/608b3963c1010c8cde63d42cd0f2a24d06a1e15e))
* release main ([65e28b5](https://github.com/zuohuadong/supacloud/commit/65e28b57270c313813cf5aea7f6385a7795623cf))
* release main ([a7d687f](https://github.com/zuohuadong/supacloud/commit/a7d687f39cea00f70dae78e10457d8708819e823))
* release main ([b4f8a93](https://github.com/zuohuadong/supacloud/commit/b4f8a935f2ea3353ca600667f3f429f003ffa208))
* release main ([3209d62](https://github.com/zuohuadong/supacloud/commit/3209d627dee3c616410c7d344a0214d1b1a8e628))
* release main ([5d65e29](https://github.com/zuohuadong/supacloud/commit/5d65e296f0ff5db2df3e72147ab67ad8df7554de))
* release main ([5482646](https://github.com/zuohuadong/supacloud/commit/5482646ff7e300d620811fdc0186a9821ebbdb28))
* release main ([c651ce5](https://github.com/zuohuadong/supacloud/commit/c651ce5093164409134d67ca264d71219c8c1f30))
* release main ([97e23fc](https://github.com/zuohuadong/supacloud/commit/97e23fcf4f87521e54e0ef84bb8d1466ce44c7ea))
* release main ([e8f9dc3](https://github.com/zuohuadong/supacloud/commit/e8f9dc37135e8e32da71d9ea51926f9ac9641c8a))
* release main ([6de326e](https://github.com/zuohuadong/supacloud/commit/6de326e3fa82d41b997f7004c46db1d5923381e4))
* release main ([02a4a21](https://github.com/zuohuadong/supacloud/commit/02a4a21936c2b536c57b207edd85f9c76c3cd7a7))
* release main ([e3ca779](https://github.com/zuohuadong/supacloud/commit/e3ca779c5b77188c009c92e619543e36b27d559b))
* release main ([fb5e6f7](https://github.com/zuohuadong/supacloud/commit/fb5e6f7ae0dc1f74802bbdbd97d66b6aa04d52ff))
* release main ([bbcd637](https://github.com/zuohuadong/supacloud/commit/bbcd6370f559448e5e8cfc4679b949e8e4a2fdeb))
* release main ([34a2d74](https://github.com/zuohuadong/supacloud/commit/34a2d74737f627dac011eb88872d9754fa5b6a1e))
* release main ([a8dd5ae](https://github.com/zuohuadong/supacloud/commit/a8dd5ae146b736029568ed47a82c16932304f47b))
* release main ([eedd89d](https://github.com/zuohuadong/supacloud/commit/eedd89d3cccda79b9a939dbb03e252f262b06fcf))
* release main ([b6756c9](https://github.com/zuohuadong/supacloud/commit/b6756c9c1ffee750f1750ae19630d7b15eff0961))
* release main ([86f5978](https://github.com/zuohuadong/supacloud/commit/86f5978cf56826143493442305c49e1eeb4e4105))
* release main ([27ea761](https://github.com/zuohuadong/supacloud/commit/27ea761d62381ecf32fa0563b17c83b9e6943561))
* release main ([6575ad3](https://github.com/zuohuadong/supacloud/commit/6575ad378405d2435784556c113eff8583a9317f))
* release main ([18b513f](https://github.com/zuohuadong/supacloud/commit/18b513f47ccbfd3ed5c3279d751924b617f7e127))
* release main ([854f4ac](https://github.com/zuohuadong/supacloud/commit/854f4ac060bc11343bb45c52ad5ea4e6d3b4a11b))
* release main ([31b095c](https://github.com/zuohuadong/supacloud/commit/31b095c43748f28bc1422a077df320d95e543175))
* release main ([870112e](https://github.com/zuohuadong/supacloud/commit/870112e8b4314f334b5007a7d148f4fd965a242d))
* release main ([cb5a91c](https://github.com/zuohuadong/supacloud/commit/cb5a91c2fbb230e42a204d060bd5b3158654eb93))
* release main ([83229a7](https://github.com/zuohuadong/supacloud/commit/83229a71488b1de5f33105ab53f3be31bdefb4d9))
* release main ([e9101e0](https://github.com/zuohuadong/supacloud/commit/e9101e0120f7ccb84ac7584051c7f556bbdf84a6))
* release main ([3aad1b2](https://github.com/zuohuadong/supacloud/commit/3aad1b20a67ec2cb0c782f63fa7a95e01e6b8eaa))
* release main ([9d84e39](https://github.com/zuohuadong/supacloud/commit/9d84e39ea4fb5ffa9cfb90b9d5c917a65eca774d))
* release main ([ec63fb2](https://github.com/zuohuadong/supacloud/commit/ec63fb24cc1e5589d7a3db04340956b26feabe04))
* release main ([e014f72](https://github.com/zuohuadong/supacloud/commit/e014f7292b04f5b7490f0e13b2591009b9201d97))
* release main ([44d8344](https://github.com/zuohuadong/supacloud/commit/44d8344d36e813ac22c179ae5c4ed643b970bbb9))
* release main ([177be2a](https://github.com/zuohuadong/supacloud/commit/177be2a31983509e5262ca289136c4b078c8b8c3))
* release main ([5bffa54](https://github.com/zuohuadong/supacloud/commit/5bffa5453d2d9d8eeccd0f5a861ffc08ab0aa724))
* release main ([1175844](https://github.com/zuohuadong/supacloud/commit/1175844cbcbca91e9a5fbde14433ae016d756e41))
* release main ([519e551](https://github.com/zuohuadong/supacloud/commit/519e5518f0b23aca34ffc4488cf41c6bd320b08b))
* release main ([28dd468](https://github.com/zuohuadong/supacloud/commit/28dd46854718e4cc7ce0484098cea9051be75814))
* release main ([71845b0](https://github.com/zuohuadong/supacloud/commit/71845b0e1da740825cef3131ec89f4962bfeb268))
* release main ([7065db9](https://github.com/zuohuadong/supacloud/commit/7065db93a028d9b48ed093cc5f00f6c21547f2ee))
* release main ([91ab682](https://github.com/zuohuadong/supacloud/commit/91ab6821ccd527283000ad9d85c59ba4db6061a0))
* release main ([7bcb4fb](https://github.com/zuohuadong/supacloud/commit/7bcb4fb720707213d057ef743ba1b4fcf29f49a1))
* release main ([97d3e7b](https://github.com/zuohuadong/supacloud/commit/97d3e7b673c61a6925743754887581e1fb53bdac))
* release main ([c1fb3b8](https://github.com/zuohuadong/supacloud/commit/c1fb3b8757cb80d86b8bde559458f0f5693b0f19))
* release main ([1659cf1](https://github.com/zuohuadong/supacloud/commit/1659cf1de67ecb6cef082717df1769fc204b0942))
* release main ([a23a693](https://github.com/zuohuadong/supacloud/commit/a23a6939233998aa24449826bb001c1402d9ba37))
* release main ([fb49e13](https://github.com/zuohuadong/supacloud/commit/fb49e13f6d7bfe38bf45345840a3a72eb7a17594))
* release main ([95faa91](https://github.com/zuohuadong/supacloud/commit/95faa91498b3f4c8a169bf1f9fdd2d32fad365a2))
* release main ([3333fe8](https://github.com/zuohuadong/supacloud/commit/3333fe8485536a5eb89ff56ea2cea8d1d63024be))
* release main ([0ae1d8f](https://github.com/zuohuadong/supacloud/commit/0ae1d8fd69b730c04bbc5eca67cf3eb993c13285))
* release main ([916dc05](https://github.com/zuohuadong/supacloud/commit/916dc052673f991dc508f8125020b94f86ebc3c2))
* release main ([adc35d5](https://github.com/zuohuadong/supacloud/commit/adc35d57af65a5d0ebc04b144909dc81c3084220))
* release main ([#106](https://github.com/zuohuadong/supacloud/issues/106)) ([c057d26](https://github.com/zuohuadong/supacloud/commit/c057d269c1abb56c5c0df6b1209d8a16c9b5881f))
* release main ([#109](https://github.com/zuohuadong/supacloud/issues/109)) ([87897d6](https://github.com/zuohuadong/supacloud/commit/87897d61a305d4fe1350b74a60507a222492aab3))
* release main ([#111](https://github.com/zuohuadong/supacloud/issues/111)) ([e136d89](https://github.com/zuohuadong/supacloud/commit/e136d896020555aee7472f1d27b2d0215c98cd2e))
* release main ([#75](https://github.com/zuohuadong/supacloud/issues/75)) ([58492af](https://github.com/zuohuadong/supacloud/commit/58492afd48273e018bf0df202ab9d7e0a2ac4b79))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([11ff3e7](https://github.com/zuohuadong/supacloud/commit/11ff3e76eeb4f752e51ea3b0b8d6024196f6e99a))
* **release:** bump management-api to 0.8.0 ([4fac643](https://github.com/zuohuadong/supacloud/commit/4fac6430d1f9d395ed0530d784876a3bdf6da8d0))
* **release:** bump unified versions by 0.0.1 ([98dd8ee](https://github.com/zuohuadong/supacloud/commit/98dd8eeaed49ec51fe638a8a8fa72c5bad8c217f))
* **release:** bump version to 0.7.5 ([18c3b41](https://github.com/zuohuadong/supacloud/commit/18c3b4141233fdb47ebd33d78926b7db6cad75ca))
* **release:** bump version to 0.7.6 ([cad136f](https://github.com/zuohuadong/supacloud/commit/cad136f9b95ffe6da7a4b98b1b43bff749adcfc5))
* **release:** bump version to 0.7.7 ([ff94ae8](https://github.com/zuohuadong/supacloud/commit/ff94ae87e6af76b64b03ffb4aefdba0e71af5f6e))
* **release:** bump version to 0.7.8 ([7e15b76](https://github.com/zuohuadong/supacloud/commit/7e15b7671db74a1964e2f845612fc8eb84d06396))
* remove obsolete debug artifacts ([d5fcd34](https://github.com/zuohuadong/supacloud/commit/d5fcd3401eb7d4c71e29922a2ee523ba327d3870))
* setup release-please for automated versioning and update svadmin dependencies ([2f8cd9e](https://github.com/zuohuadong/supacloud/commit/2f8cd9e8c79fbdccc36bf6e37754af212c9d2589))
* **ts:** finish TypeScript 6 typecheck migration ([b34fa1a](https://github.com/zuohuadong/supacloud/commit/b34fa1aa93dff56a1a9347c33f9691098cb708f5))
* upgrade svadmin to latest version and fix breaking changes in query/mutation hooks ([3f4df1e](https://github.com/zuohuadong/supacloud/commit/3f4df1e413fb3ee713681701232b15860fec8e0d))

## [0.15.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.14.1...management-api-v0.15.0) (2026-05-15)


### Features

* optimize tenant runtime lifecycle ([c5fcf96](https://github.com/zuohuadong/supacloud/commit/c5fcf962f6f6689400ee920a44d22c35970bb268))


### Bug Fixes

* provision_runtime fails on Ubuntu due to Group=nobody and missing auth schema ([#110](https://github.com/zuohuadong/supacloud/issues/110)) ([0bef1c6](https://github.com/zuohuadong/supacloud/commit/0bef1c6e81578071c7a23cf621f17dc8594881c9))

## [0.14.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.14.0...management-api-v0.14.1) (2026-05-15)


### Bug Fixes

* restore project reprovisions missing resources ([a8b3ec3](https://github.com/zuohuadong/supacloud/commit/a8b3ec3eed145628f5551880f705b2b97b769d1b))

## [0.14.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.8...management-api-v0.14.0) (2026-05-15)


### Features

* **management-api:** add Swagger detail annotations to all 121 route handlers ([02f049c](https://github.com/zuohuadong/supacloud/commit/02f049c515d716edb2fe3ec6a914cfea78235689))


### Bug Fixes

* auth middleware response format mismatch with route schemas ([#107](https://github.com/zuohuadong/supacloud/issues/107)) ([c76a6f8](https://github.com/zuohuadong/supacloud/commit/c76a6f84f3788d754db7f94accf7c178cd6907cb))
* **management-api:** enforce Swagger route coverage ([4ec22db](https://github.com/zuohuadong/supacloud/commit/4ec22db97820ae8b75b73d10d9f659593c842482))
* **management-api:** pin Supabase JS compliance ref ([205e57d](https://github.com/zuohuadong/supacloud/commit/205e57d36409eb58c99db2804b162248d9dbb592))

## [0.13.8](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.7...management-api-v0.13.8) (2026-05-12)


### Bug Fixes

* **ci:** repair release asset upload ([98d5537](https://github.com/zuohuadong/supacloud/commit/98d5537ad77ab381e42d91ab011cedeea38498f9))

## [0.13.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.6...management-api-v0.13.7) (2026-05-12)


### Bug Fixes

* add function invoke route, repair stale projects, web-console deployment ([dedab66](https://github.com/zuohuadong/supacloud/commit/dedab667e4a200470a1d6c5d4dfada8df17e32ea))
* improve one-click install robustness, add function invoke route, repair stale projects ([5cdbe8a](https://github.com/zuohuadong/supacloud/commit/5cdbe8a0f7800e3b1b1e903976bcc8c33e61d1b1))
* use direct GoTrue port instead of HTTPS API URL to avoid self-signed cert errors ([73f1902](https://github.com/zuohuadong/supacloud/commit/73f19020218aa08e5fcfc430be039cc512833ef6))

## [0.13.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.5...management-api-v0.13.6) (2026-05-11)


### Bug Fixes

* **management-api:** harden storage list metadata parsing ([5b596ff](https://github.com/zuohuadong/supacloud/commit/5b596ff4436a666aec1d232c9858a4173785671e))

## [0.13.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.4...management-api-v0.13.5) (2026-05-10)


### Bug Fixes

* harden management API edge cases ([d938f51](https://github.com/zuohuadong/supacloud/commit/d938f51b52f4762a2c55068b59f23616b9d7df3e))

## [0.13.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.3...management-api-v0.13.4) (2026-05-10)


### Performance Improvements

* reduce management hot path load ([e5f4c82](https://github.com/zuohuadong/supacloud/commit/e5f4c82f58cb1d515c9c6f94d77fe8032ecdbe26))

## [0.13.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.2...management-api-v0.13.3) (2026-05-08)


### Miscellaneous Chores

* **deps:** bump @svadmin/core in /packages/management-api ([#81](https://github.com/zuohuadong/supacloud/issues/81)) ([dd6cba3](https://github.com/zuohuadong/supacloud/commit/dd6cba30a7882e35ec8114e90091f94ec05c47bc))
* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/management-api ([#86](https://github.com/zuohuadong/supacloud/issues/86)) ([49b03f5](https://github.com/zuohuadong/supacloud/commit/49b03f554cadd557595436e7112535f6250d3a2d))

## [0.13.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.1...management-api-v0.13.2) (2026-05-08)


### Bug Fixes

* **installer:** align pigsty supabase install path ([a14e33a](https://github.com/zuohuadong/supacloud/commit/a14e33a7a9b0b44f138c219fcf779a9a8d5cc242))
* **management-api:** reconcile custom domain runtime routes ([6a0b8de](https://github.com/zuohuadong/supacloud/commit/6a0b8def0215407f14508916866944ac54b6225a))

## [0.13.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.0...management-api-v0.13.1) (2026-05-08)


### Bug Fixes

* **installer:** derive studio domain from API host ([4d94d49](https://github.com/zuohuadong/supacloud/commit/4d94d49f0e3615e7dfe420dea7cc72ba91fc41d9))

## [0.13.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.19...management-api-v0.13.0) (2026-05-08)


### Features

* **gateway:** manage certificates through Kong ([3d5930f](https://github.com/zuohuadong/supacloud/commit/3d5930fb5eb78ed32fb96b06d0f824446504ae22))

## [0.12.19](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.18...management-api-v0.12.19) (2026-05-07)


### Bug Fixes

* **runtime:** respect ssl config for tenant urls ([d8ace81](https://github.com/zuohuadong/supacloud/commit/d8ace81412b4caa87fe00982539310452faeaaa1))
* **runtime:** respect ssl config for tenant urls ([d0852b2](https://github.com/zuohuadong/supacloud/commit/d0852b2e3d95a1c4ab33a30916df68aa15a41a64))

## [0.12.18](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.17...management-api-v0.12.18) (2026-05-07)


### Bug Fixes

* **edge-runtime:** preserve env for waitUntil tasks ([1e43fbf](https://github.com/zuohuadong/supacloud/commit/1e43fbf6eb22a8fff3218326dae4c6e0b8fb4176))
* **edge-runtime:** preserve env for waitUntil tasks ([424152c](https://github.com/zuohuadong/supacloud/commit/424152c21265e67ec5812453d3cfc2a5ed064b87))

## [0.12.17](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.16...management-api-v0.12.17) (2026-05-06)


### Bug Fixes

* **management-api:** accept serialized routing config ([edb5e4d](https://github.com/zuohuadong/supacloud/commit/edb5e4d329e255e22ee48c5c8bab7b6c833ad2ac))
* **tasks:** allow invoker jwt to read task detail ([e99cf7b](https://github.com/zuohuadong/supacloud/commit/e99cf7b1e7994f738a446410ca0f5f5ac98f5042))

## [0.12.16](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.15...management-api-v0.12.16) (2026-05-06)


### Bug Fixes

* **install:** skip legacy supabase compose stack ([4bcf1fa](https://github.com/zuohuadong/supacloud/commit/4bcf1faacc036ddf55aa17c5124ca87e2d8083fa))

## [0.12.15](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.14...management-api-v0.12.15) (2026-05-04)


### Bug Fixes

* **pigsty:** align 4.3 upgrade with supacloud storage defaults ([e3e6881](https://github.com/zuohuadong/supacloud/commit/e3e68818aad04c9d967d83d05a03cb58331bf453))

## [0.12.14](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.13...management-api-v0.12.14) (2026-05-04)


### Bug Fixes

* **security:** harden storage and proxy surfaces ([03e0efa](https://github.com/zuohuadong/supacloud/commit/03e0efad117902d014dc855732a0d337bce1c764))

## [0.12.13](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.12...management-api-v0.12.13) (2026-05-01)


### Bug Fixes

* **gateway:** include hosted frontend origins in cors ([672b764](https://github.com/zuohuadong/supacloud/commit/672b764ad066ad5751ec98210175fdd9053b9a5a))

## [0.12.12](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.11...management-api-v0.12.12) (2026-04-29)


### Bug Fixes

* **ci:** provide websocket for sdk compliance ([26ffa43](https://github.com/zuohuadong/supacloud/commit/26ffa437772b99d3fb02fc770c3097e24414d012))
* **ci:** retry official cli bootstrap downloads ([420f0ad](https://github.com/zuohuadong/supacloud/commit/420f0ada19af72b74b6b981979098603551cc6d2))

## [0.12.11](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.10...management-api-v0.12.11) (2026-04-29)


### Bug Fixes

* **edge-runtime:** inject Bun function env ([54aefe5](https://github.com/zuohuadong/supacloud/commit/54aefe576cb351fe2dd37c4a9b8e74ed4c34f517))

## [0.12.10](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.9...management-api-v0.12.10) (2026-04-29)


### Bug Fixes

* **management-api:** expose unmasked runtime env internally ([713702b](https://github.com/zuohuadong/supacloud/commit/713702bb3950e4df9cd5ed18850073e5710fd040))

## [0.12.9](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.8...management-api-v0.12.9) (2026-04-29)


### Bug Fixes

* **management-api:** inject internal supabase runtime secrets ([13c9f15](https://github.com/zuohuadong/supacloud/commit/13c9f15483083e8a14d6c708276f6a322a786992))

## [0.12.8](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.7...management-api-v0.12.8) (2026-04-29)


### Bug Fixes

* **management-api:** harden project queue reliability ([0f857e3](https://github.com/zuohuadong/supacloud/commit/0f857e3e2ec937eaff63d163017fdafb93135027))
* **management-api:** harden storage and background contracts ([d952a86](https://github.com/zuohuadong/supacloud/commit/d952a86fcc112fb8c44c105e82a41f9b5c56790b))

## [0.12.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.6...management-api-v0.12.7) (2026-04-29)


### Bug Fixes

* **management-api:** resolve functions tenants from custom domains ([5baf0d5](https://github.com/zuohuadong/supacloud/commit/5baf0d5ec4e75089228167963d3b96261f2ef75f))

## [0.12.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.5...management-api-v0.12.6) (2026-04-29)


### Bug Fixes

* **management-api:** allow public storage reads on custom domains ([db33913](https://github.com/zuohuadong/supacloud/commit/db33913ed919c63549732a0c4f6d3c98a50f4a45))

## [0.12.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.4...management-api-v0.12.5) (2026-04-28)


### Bug Fixes

* **management-api:** grant postgrest authenticator database access ([f64e7d8](https://github.com/zuohuadong/supacloud/commit/f64e7d8988293dd8cec0626147e819532cc9c086))

## [0.12.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.3...management-api-v0.12.4) (2026-04-28)


### Bug Fixes

* **management-api:** grant auth roles tenant database access ([196ec92](https://github.com/zuohuadong/supacloud/commit/196ec922bd876bf42081e1fbfbb5ad28f84f710e))
* **management-api:** isolate background auth encryption regression ([d447a84](https://github.com/zuohuadong/supacloud/commit/d447a847177f23590c35fa721e002d24e893fe8d))
* **management-api:** stabilize encrypted background task regression ([70e4c44](https://github.com/zuohuadong/supacloud/commit/70e4c44c72fad7eb88c0662750b6d4ac56bfcdc8))
* **management-api:** use node random uuid in sdk proxy ([5ceb267](https://github.com/zuohuadong/supacloud/commit/5ceb2671020fea9413d99fca883b11d46271bb31))

## [0.12.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.2...management-api-v0.12.3) (2026-04-28)


### Bug Fixes

* **management-api:** encrypt background task credentials ([7f7b815](https://github.com/zuohuadong/supacloud/commit/7f7b815ceb2b7b5a5f7368772b6483882f0a7b36))

## [0.12.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.1...management-api-v0.12.2) (2026-04-27)


### Bug Fixes

* ship web console with binary upgrades ([c96e44a](https://github.com/zuohuadong/supacloud/commit/c96e44a17aa88948498cbdab7743c1d834a4ba8b))

## [0.12.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.0...management-api-v0.12.1) (2026-04-27)


### Bug Fixes

* stabilize edge runtime under binary upgrades ([428453a](https://github.com/zuohuadong/supacloud/commit/428453a0fa15a0cf77e3e7db3939f766ad94cbcb))

## [0.12.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.7...management-api-v0.12.0) (2026-04-27)


### Features

* add queue client api ([1463b8d](https://github.com/zuohuadong/supacloud/commit/1463b8db899c0762e680b3ed1894dfbd5e1463df))
* improve database sql cli workflows ([1d1ac83](https://github.com/zuohuadong/supacloud/commit/1d1ac83d7518f223e048b8caedd1420460b1e70e))


### Bug Fixes

* publish background tasks for realtime ([16582be](https://github.com/zuohuadong/supacloud/commit/16582be1fe7f0a74ea94a31af1d5d0ee526b991e))
* skip missing tenant dbs during realtime reconcile ([300ce92](https://github.com/zuohuadong/supacloud/commit/300ce923eea65e21a280e29954f58a3d4945aa98))


### Elegance & Refactoring

* remove legacy sql result alias ([3565c00](https://github.com/zuohuadong/supacloud/commit/3565c00f197a35e129785cce299ee48b9f91f7b8))

## [0.11.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.6...management-api-v0.11.7) (2026-04-27)


### Bug Fixes

* allow supacloud async cors headers ([b27af99](https://github.com/zuohuadong/supacloud/commit/b27af995e9e4ff209df63b72652ca18d25186217))
* materialize juicefs upload streams ([4378f9c](https://github.com/zuohuadong/supacloud/commit/4378f9cab99e9c11f8714a82232de71f7c82a8da))
* materialize storage upload streams ([a55ba02](https://github.com/zuohuadong/supacloud/commit/a55ba02b6735b3df92971d79ede6da01706a92a6))

## [0.11.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.5...management-api-v0.11.6) (2026-04-27)


### Bug Fixes

* extend rest proxy timeout ([716839d](https://github.com/zuohuadong/supacloud/commit/716839db4170023e7f4f2044fd9318ac4f84f7b7))

## [0.11.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.4...management-api-v0.11.5) (2026-04-27)


### Bug Fixes

* make production upgrades binary-first ([08e9046](https://github.com/zuohuadong/supacloud/commit/08e9046aa2f91def72b2a8796aa1aeb719240f66))
* support github proxies for binary upgrades ([598269c](https://github.com/zuohuadong/supacloud/commit/598269c26e9a04ea1c7c5dd543c13206c58e5f9d))

## [0.11.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.3...management-api-v0.11.4) (2026-04-25)


### Bug Fixes

* **cli:** push migrations through management API ([cee9927](https://github.com/zuohuadong/supacloud/commit/cee9927d29cb0ef514ae5a33080e6cf1c74bdecc))
* **cli:** push migrations via management api ([5b06fa2](https://github.com/zuohuadong/supacloud/commit/5b06fa249802335fbb3c4e77d3f5cefe8c4336b8))

## [0.11.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.2...management-api-v0.11.3) (2026-04-24)


### Bug Fixes

* harden realtime tasks and data-plane boundaries ([f6bdfd1](https://github.com/zuohuadong/supacloud/commit/f6bdfd1b92d501507e27ad6ed73ecd3b46cc3e97))
* **management-api:** default to port 9090 ([c842879](https://github.com/zuohuadong/supacloud/commit/c842879db34f256651c0845ce70b6f1c7640f329))

## [0.11.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.1...management-api-v0.11.2) (2026-04-23)


### Bug Fixes

* **auth:** accept project service role on management routes ([eac98e5](https://github.com/zuohuadong/supacloud/commit/eac98e557450e997bf2f4a41146f9deaf1230c90))

## [0.11.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.0...management-api-v0.11.1) (2026-04-23)


### Bug Fixes

* **functions:** harden runtime routing and diagnostics ([41bade2](https://github.com/zuohuadong/supacloud/commit/41bade2ccef44f581aa1a6c6d0678f912084b6c0))
* **queue:** keep edge functions on dedicated worker ([693b1e3](https://github.com/zuohuadong/supacloud/commit/693b1e30274f426cadb9638ff96b9dba87b98361))

## [0.11.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.5...management-api-v0.11.0) (2026-04-23)


### Features

* **self-host:** add PG18 compose stack and refresh tenant env ([d865bdb](https://github.com/zuohuadong/supacloud/commit/d865bdb96b29ec8abdea6a0e93190d0cbd7d8371))


### Bug Fixes

* **storage:** stream large uploads through kong ([5001aa0](https://github.com/zuohuadong/supacloud/commit/5001aa0ddfb3e8556d5d03d155d677986376a962))
* **web-console:** restore settings and task management UI ([3f7ef75](https://github.com/zuohuadong/supacloud/commit/3f7ef756f3e151a9678f998d8e638f324ab7f77a))

## [0.10.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.4...management-api-v0.10.5) (2026-04-20)


### Bug Fixes

* **queue:** migrate foundation worker to stable pg-listen ([fa90fe3](https://github.com/zuohuadong/supacloud/commit/fa90fe3e27238a0f9f79beaa8e881e78ea631c0e))


### Elegance & Refactoring

* **queue:** remove legacy pg-listen implementation ([9707808](https://github.com/zuohuadong/supacloud/commit/9707808c945d214f0f9477df2bfc31d4ce83840e))

## [0.10.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.3...management-api-v0.10.4) (2026-04-19)


### Bug Fixes

* **management-api:** set duplex on sdk-proxy test requests ([80f852d](https://github.com/zuohuadong/supacloud/commit/80f852d709294204bb502d537ceaf5ec5f86cf1c))


### Miscellaneous Chores

* release main ([239aea7](https://github.com/zuohuadong/supacloud/commit/239aea7e22bae05cc3c7840bc6c0fd7b322a8862))
* release main ([8d020be](https://github.com/zuohuadong/supacloud/commit/8d020be4e8d374f0cf0498a97e4beb6a88e57fb0))

## [0.10.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.2...management-api-v0.10.3) (2026-04-19)


### Bug Fixes

* **management-api:** harden sdk proxy unit test isolation ([4a5fd35](https://github.com/zuohuadong/supacloud/commit/4a5fd353ad8c25003c2f37d8c582c682c2acf81c))

## [0.10.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.1...management-api-v0.10.2) (2026-04-19)


### Bug Fixes

* **edge-runtime:** keep embedded child restarting ([7ca588a](https://github.com/zuohuadong/supacloud/commit/7ca588ad211c28c3f7ddff9b550d3fdb304d1feb))
* **realtime:** connect tenants with admin database credentials ([e1ae210](https://github.com/zuohuadong/supacloud/commit/e1ae210134942c04d4d5a4dbdc6d46e6f154d245))
* **realtime:** proxy websocket traffic via management ws ([de062c0](https://github.com/zuohuadong/supacloud/commit/de062c08bd543c5867f2fe592f815ea735c8bb95))
* **realtime:** reconcile missing tenants and use valid enc key ([5cc41df](https://github.com/zuohuadong/supacloud/commit/5cc41df549ca6a8ee18bd06a7d090d4ebaa41738))
* **realtime:** reconcile tenant schema privileges ([f2dc5b7](https://github.com/zuohuadong/supacloud/commit/f2dc5b703dd9c7b64041af07e419c8f42e5a2c24))
* **realtime:** route websocket through root proxy ([73f6501](https://github.com/zuohuadong/supacloud/commit/73f6501f2fd4b5653752767dcb57b14623e9ad51))
* **realtime:** sign tenant reconcile admin tokens correctly ([03c3207](https://github.com/zuohuadong/supacloud/commit/03c320787b1bdaef0ef05de81a5f350108d0fd7f))
* **realtime:** use node crypto for admin JWT signing ([601e951](https://github.com/zuohuadong/supacloud/commit/601e951d76548131b02404319c68d4224a627df8))


### Miscellaneous Chores

* **ts:** finish TypeScript 6 typecheck migration ([5e2ae90](https://github.com/zuohuadong/supacloud/commit/5e2ae9024cf356eb6892402a62bf4036b8ad00dc))

## [0.10.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.0...management-api-v0.10.1) (2026-04-18)


### Bug Fixes

* **edge-runtime:** avoid double-managed runtime restarts ([5a27175](https://github.com/zuohuadong/supacloud/commit/5a271758fff9bbe008f8d8aade559e4d8dffab3e))
* **gateway:** preserve functions proxy path prefix ([f51bb1f](https://github.com/zuohuadong/supacloud/commit/f51bb1fa76be90ead2b065802650a14121f79b36))
* **proxy:** forward function POST bodies with duplex ([7784522](https://github.com/zuohuadong/supacloud/commit/7784522331003fd97ab04b62ace90035eb79d385))
* **routing:** unify tenant domain and port resolution ([5911e97](https://github.com/zuohuadong/supacloud/commit/5911e97cc39007ceea95a79b3c4b6d4db7a2b344))
* **tasks:** patch tenant queue schema compatibility ([370adfa](https://github.com/zuohuadong/supacloud/commit/370adfa6009dc72d956a47e3c69e9cda99acd7f0))


### Elegance & Refactoring

* **edge-functions:** migrate version artifacts into internal revisions ([e9c0890](https://github.com/zuohuadong/supacloud/commit/e9c0890013bb23b0189dd089c3e7d79507ee37b2))

## [0.10.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.9.1...management-api-v0.10.0) (2026-04-17)


### Features

* **tasks:** deploy background task and message queue features to servers ([e66cdac](https://github.com/zuohuadong/supacloud/commit/e66cdac9c34f34990de5675ca75bfca9894cc3b4))
* updates and fixes based on recent local changes ([449c710](https://github.com/zuohuadong/supacloud/commit/449c71089721658d25737ac7df1c196b3bc9bb1d))


### Bug Fixes

* **db:** remove index creation from ddlQuery to avoid execution failure on partial schema ([23a4546](https://github.com/zuohuadong/supacloud/commit/23a45468d6316b0550683e046560a6768e770890))
* **db:** use sql.unsafe for sequential DDL execution to prevent prepared statement errors ([5e255c6](https://github.com/zuohuadong/supacloud/commit/5e255c690358e91f76507f522b8490b3cad02083))
* **deps:** remove dredd, upgrade MCP SDK, override hono/path-to-regexp to eliminate 26 audit vulnerabilities ([695ef77](https://github.com/zuohuadong/supacloud/commit/695ef770b48f50174546f683294841da90e63223))
* **tasks:** avoid malformed array literal issue in unsafe sql binding for ANY() ([cb2630a](https://github.com/zuohuadong/supacloud/commit/cb2630aa89ed8b2910965682d2724e971582fe7f))

## [0.9.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.9.0...management-api-v0.9.1) (2026-04-14)


### Bug Fixes

* **auth:** restore empty string fallback for OpenAPI enum compliance ([f62da87](https://github.com/zuohuadong/supacloud/commit/f62da87304c3526fe50cf1684ff115e2975fac11))
* **openapi:** satisfy strict schema enums and ref length requirements ([9f47811](https://github.com/zuohuadong/supacloud/commit/9f47811e8a834cced46e8946b620f233c41e2973))
* **openapi:** use predefined enums for missing auth config providers instead of empty strings ([b2ebf64](https://github.com/zuohuadong/supacloud/commit/b2ebf647f4bb69d90e9745e6a3c8435f52e3d310))


### Miscellaneous Chores

* cleanup scratch files and commit modified files ([328a728](https://github.com/zuohuadong/supacloud/commit/328a7285b5956693105c7d1086338e53194cf013))

## [0.9.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.8.0...management-api-v0.9.0) (2026-04-14)


### Features

* add /auth/session API for Studio auth support ([0235e89](https://github.com/zuohuadong/supacloud/commit/0235e89352b545c231ea62e71e698f7e90f519da))
* add ACME SSL support for Angie ([b6c94fa](https://github.com/zuohuadong/supacloud/commit/b6c94fa5b9dc061969dd0568f0e0df9cc0d70b5f))
* add CI/CD integration, Bun SSR support, and multi-project Kong routing ([fc88b53](https://github.com/zuohuadong/supacloud/commit/fc88b533dd75b40e035de6cf97837a088f507bd8))
* add CLI project management commands ([11110b3](https://github.com/zuohuadong/supacloud/commit/11110b3744d92947b4b1335c81ae581c64d1ac2d))
* add complete Studio Cloud API compatibility layer ([741e1ab](https://github.com/zuohuadong/supacloud/commit/741e1ab28046985d3ae610f0d2e67f2c54398d21))
* add connection_count to project database info ([bfa0da3](https://github.com/zuohuadong/supacloud/commit/bfa0da38ec0c6c2e6455384f7d51c3018f179aa0))
* add deploy API and remove sensitive info ([f41e56e](https://github.com/zuohuadong/supacloud/commit/f41e56e9c70b147063e006d7f3be4b60712ea19e))
* add MCP settings page in Web Console platform sidebar ([150a7b0](https://github.com/zuohuadong/supacloud/commit/150a7b051b026aa4ea85827cdb8790a7660ce619))
* add OAuth providers, frontend hosting service and ECC SSL support ([f9f5b40](https://github.com/zuohuadong/supacloud/commit/f9f5b4076fe55f36a30ad7f8e247f6065eb57886))
* add pg-listen LISTEN/NOTIFY for event-driven task processing, bump v0.5.3 ([35fb9cc](https://github.com/zuohuadong/supacloud/commit/35fb9cc8041387083eb7fdca90098812fc3be88f))
* add Realtime service with multi-tenant support, update Kong gateway with /realtime/v1 route ([28eed96](https://github.com/zuohuadong/supacloud/commit/28eed96d8da0c72563aa1283ee78036182fb641c))
* add Signed URLs, TUS resumable upload, and Edge Functions SDK compatibility ([cdaeca1](https://github.com/zuohuadong/supacloud/commit/cdaeca12094796ac92f38114cf23b6728e63a057))
* add Studio auth API routes (/platform/auth/user, /platform/subscription) ([5ce339e](https://github.com/zuohuadong/supacloud/commit/5ce339e2c33509ebae462c830c12bd3b63ad4624))
* add Studio compatibility routes (/platform/projects, /platform/profile) ([89f8f6b](https://github.com/zuohuadong/supacloud/commit/89f8f6b566b6955c24e679da3661f75520144aad))
* add supabase-js SDK compatible storage routes, update Kong gateway to route /storage/v1 to management API ([007928f](https://github.com/zuohuadong/supacloud/commit/007928f7f3410b7887a1e0b880762a6bd8f581ef))
* align studio api with official types and fix dockerfile build with bun ([cae9a5e](https://github.com/zuohuadong/supacloud/commit/cae9a5e93c0cd475476ac11cb7bc1cd009133cb4))
* **api:** complete architecture hardening and Elysia schema validation implementation ([5d93b9a](https://github.com/zuohuadong/supacloud/commit/5d93b9ad1303efda36a3069e208096c5187f70ed))
* **auth:** add platform login/signup/logout endpoints for Studio ([bbf356d](https://github.com/zuohuadong/supacloud/commit/bbf356d7a91bd8680bba21595f02bac69f90c1b5))
* **auth:** add Webhooks, SSO/SAML, and MFA management APIs for Studio parity ([8962502](https://github.com/zuohuadong/supacloud/commit/89625027ccd487e7b6e05edeaaeee597b8270898))
* **auth:** implement proper admin authentication ([7485e1a](https://github.com/zuohuadong/supacloud/commit/7485e1ace591ccbd6eb59e4317bd51375b1fe54e))
* **auth:** migrate edge function templates to Deno.serve() API ([35458c6](https://github.com/zuohuadong/supacloud/commit/35458c625ed4855b1575d1530b718fc3a4076123))
* **auth:** use environment variables for admin credentials ([4e4b499](https://github.com/zuohuadong/supacloud/commit/4e4b499731e409369ea9f7fab8ea79d137d1ee95))
* **cli:** add postgres config, pooler, network-restrictions, and storage policies endpoints ([83f5629](https://github.com/zuohuadong/supacloud/commit/83f5629333738661b791a1f32fa057cad601d0f7))
* complete v3-v9 comprehensive compliance audit and bump version 0.0.1 ([8e3ac9f](https://github.com/zuohuadong/supacloud/commit/8e3ac9f5285611d2366bc0f652827befce822cde))
* **core:** harden realtime scale limits, dynamic PK resolution, and log retrieval ([4c83505](https://github.com/zuohuadong/supacloud/commit/4c83505dac2636c14072de29188bab53c54ed321))
* **core:** integrate official walrus architecture to realtime schema ([824d88d](https://github.com/zuohuadong/supacloud/commit/824d88dcf5ecf093027d9509af12b47ea0c1a3d4))
* **core:** Native Supabase compatibility fixes for Realtime, Storage RLS, and Edge Functions ([44ba883](https://github.com/zuohuadong/supacloud/commit/44ba8836347e8c2d04911330cd4bb8546eed71e5))
* custom domain support, edge-runtime auto-deps, test fixes ([3fb55a9](https://github.com/zuohuadong/supacloud/commit/3fb55a950d262da432e5eaa29fd455135709491a))
* deploy imaginary, rewrite storage with Bun.S3 + image transform API ([532aa29](https://github.com/zuohuadong/supacloud/commit/532aa29d8296defe9e83cef39f17dfe50eaa12b4))
* **edge-functions:** implement per-function verify_jwt configuration ([d9e060b](https://github.com/zuohuadong/supacloud/commit/d9e060b68f89ddca5e87e59bfb4c34f9f4e49c4f))
* **edge-runtime:** merge Deno.serve() compatibility into WorkerPool sandbox ([25feca2](https://github.com/zuohuadong/supacloud/commit/25feca24a09287bcb34866b5923cc676a67ba60a))
* **edge-runtime:** natively expose core SUPABASE_* variables to Deno function sandbox ([0d3022d](https://github.com/zuohuadong/supacloud/commit/0d3022d7515129366fd06908ca39f255e1e81f79))
* **edge:** module cache invalidation on deploy + Angie CORS template ([456df57](https://github.com/zuohuadong/supacloud/commit/456df57c65876aa80adea84d545a9ae4a6d2d274))
* **edge:** server-side Bun.build() bundling pipeline + multi-file bundle deploy ([4010992](https://github.com/zuohuadong/supacloud/commit/401099230b49a9ba08f5ef4cee6beab143d02b37))
* embed Streamable HTTP MCP endpoint with JWT token system, v0.5.5 ([9e7bc7e](https://github.com/zuohuadong/supacloud/commit/9e7bc7e294e5829bb53e39840d1928143ee68276))
* expand MCP server with 17 new tools (auth/storage/org/tasks), bump v0.5.4 ([0aece2a](https://github.com/zuohuadong/supacloud/commit/0aece2a0ab18b796f86357046fa478f16b5e708e))
* **extensions:** expand auto-install whitelist with pg_cron, pgvector, postgis, pgaudit ([031edf1](https://github.com/zuohuadong/supacloud/commit/031edf19af077336a477050e3ad5bfa5e2903bf5))
* implement real service health checks using systemd ([6769e70](https://github.com/zuohuadong/supacloud/commit/6769e70ee70af7c0378dd52df77867266e256264))
* integrate web-console with Management API for /admin route ([12ab321](https://github.com/zuohuadong/supacloud/commit/12ab3212e33678f356c0327fd9eb9e859f9763a2))
* **management-api:** abstract realtime tenant routing and config fallbacks for sdk parity ([2bf0165](https://github.com/zuohuadong/supacloud/commit/2bf0165531d84dc831b615ccb5668d776b8b00de))
* **management-api:** add MCP project isolation, schema introspection, and AI SQL tools ([5c3f0ab](https://github.com/zuohuadong/supacloud/commit/5c3f0ab6357d64f0a72f660f8035bf6d4e8a1db8))
* **management-api:** add tenant-scoped custom path rate limiting via Kong ([511d702](https://github.com/zuohuadong/supacloud/commit/511d702361c00770efd43315b8b6756bf8392878))
* **management-api:** add web console tasks tracking & custom rate limits UI ([2f6baa1](https://github.com/zuohuadong/supacloud/commit/2f6baa120d9bf9c0ecbb6d20c7071eada5756595))
* **management-api:** implement Postgres LISTEN/NOTIFY queue worker for AI & MQTT events ([cca34a9](https://github.com/zuohuadong/supacloud/commit/cca34a955d33547292444e3fcf04b712f839f4f7))
* **management-api:** implement S3 fetch adapter and improve shared CI database routing ([3c4cd1b](https://github.com/zuohuadong/supacloud/commit/3c4cd1b71668507c0be60761ae2ae4c8277c208c))
* **management-api:** use async getProjectRef and update edge runtime config to use external config.ts bindings ([e38abdb](https://github.com/zuohuadong/supacloud/commit/e38abdb7290a4e9b635f79a3dc5a6acdd3cffc35))
* **mcp:** add supreme capability pack (mock data, security audit, slow queries, edge functions) ([00c5b7c](https://github.com/zuohuadong/supacloud/commit/00c5b7c883cfd6a734e9aa9e769a1398b7c94b68))
* **mcp:** expose edge function logs and update tools documentation ([046956f](https://github.com/zuohuadong/supacloud/commit/046956f6959b57610fc2e15115513c4bd405fe56))
* **platform:** massive stabilization update across edge-runtime, mcp, routing, and sdk-proxy compatibility ([38f010a](https://github.com/zuohuadong/supacloud/commit/38f010ac111ef2cd098f63c328d2d6e2cebafbe3))
* **proxy:** align management API and realtime service with official Supabase parity ([ca5bc8f](https://github.com/zuohuadong/supacloud/commit/ca5bc8f6fceb3d06e4fcf883b7f79a2e54c8ed17))
* **realtime:** enrich LISTEN/NOTIFY triggers with full OLD/NEW records and auto-attach DDL event trigger ([abf10ce](https://github.com/zuohuadong/supacloud/commit/abf10ce665a883302f97634a4c94e32fe9d08809))
* **realtime:** replace docker realtime dependency with native SupaCloud Elysia implementation ([c12f986](https://github.com/zuohuadong/supacloud/commit/c12f9864b0a8ede034f56d119c0145a325599a56))
* refactor core management scripts to native typescript services (v0.3.23) ([2b8ffd8](https://github.com/zuohuadong/supacloud/commit/2b8ffd88a091b9488d96c61a0d55bce0336bd3c0))
* refactor installation & management arch (Shell + Bun Binary) ([3737800](https://github.com/zuohuadong/supacloud/commit/3737800f70010e0fac377071f129a3e55f404daa))
* return real API keys in /v1/projects/:ref from database ([75c00d0](https://github.com/zuohuadong/supacloud/commit/75c00d05832406f286000c37f5639758cf1e5ba4))
* return real database version and size in /v1/projects/:ref ([37bb3ad](https://github.com/zuohuadong/supacloud/commit/37bb3ad07e64912640f83f6950325d8437b9ab9f))
* **schema:** add PostgREST pre-request context + supabase_migrations schema for CLI compatibility ([0faf348](https://github.com/zuohuadong/supacloud/commit/0faf348072997a42f9d5ddb0506ce02a467e8c4e))
* **sdk/e2e:** finalize sdk proxy passthrough and structural snapshot tests ([b316f93](https://github.com/zuohuadong/supacloud/commit/b316f938906863fa7563e33ebe92d1ee656c006a))
* **secrets:** auto-inject standard secrets on project creation ([e2c96da](https://github.com/zuohuadong/supacloud/commit/e2c96da4af940cdad4d5e6ab697de44731d83c3e))
* **secrets:** DB-backed project secrets with dynamic runtime injection ([0b06bc6](https://github.com/zuohuadong/supacloud/commit/0b06bc6775adae14060fae7cffe8f2b7c5b14dea))
* **static:** add multi-core cluster mode via SO_REUSEPORT ([e3e1b6c](https://github.com/zuohuadong/supacloud/commit/e3e1b6c15bb4c9e9f8d7796c7730778b05de107f))
* **static:** implement HTTP 206 Range requests and graceful shutdown ([f30adc8](https://github.com/zuohuadong/supacloud/commit/f30adc8c4c8dd93fc91055d02aabf2a6b6b4b8e3))
* **storage:** implement multi-driver adapter and shadow RLS evaluator ([d183d1d](https://github.com/zuohuadong/supacloud/commit/d183d1d68c2ec2d5f053c1dcb136c36043484535))
* **studio:** add auth rewrites and patch auth-provider ([bfec167](https://github.com/zuohuadong/supacloud/commit/bfec16729bdc947a22d8398a689eeec855591376))
* **studio:** add missing API endpoints for Studio compatibility ([1fe6025](https://github.com/zuohuadong/supacloud/commit/1fe6025a3eec2036432f6a8b9eba2f73576f26ed))
* **studio:** implement fully functional pg_cron, table data browser, and live container logs ([6810655](https://github.com/zuohuadong/supacloud/commit/681065598cc5c0502edad7747a84f2dbfa0c45be))
* **studio:** real TypeScript type generation and pg_stat usage metrics ([d38b846](https://github.com/zuohuadong/supacloud/commit/d38b8462b2ce6f450408b58f947a87faab121f79))
* **supacloud:** UI/UX optimization, CORS resolution, and AI agent breadcrumbs ([def0c30](https://github.com/zuohuadong/supacloud/commit/def0c30fe63502a6717a760f19d98c0962ba76ab))
* support custom domain for projects ([1baf485](https://github.com/zuohuadong/supacloud/commit/1baf48540321f41abea30b1b574bb3bef4f7a6c6))
* **system:** add realtime CDC prerequisites setup and imaginary proxy enhancements ([f826345](https://github.com/zuohuadong/supacloud/commit/f8263452c955f50297b2ee1b0aec0732d1be09aa))
* v0.4.0 - SupaCloud Pages hosting, Platform Management, Studio login auth ([dc53e9d](https://github.com/zuohuadong/supacloud/commit/dc53e9df13006c01cc82d381da023e8e4c55325c))
* **v0.5.1:** add provider toggle switch, ignore .claude/.agents ([b89f4c9](https://github.com/zuohuadong/supacloud/commit/b89f4c976d6483ea32d6d6cadfdc82a8cbb60751))
* **web-console:** integrate realtime health, custom domains and oauth panels ([b316f93](https://github.com/zuohuadong/supacloud/commit/b316f938906863fa7563e33ebe92d1ee656c006a))


### Bug Fixes

* /platform/projects/default returns first project for Studio compatibility ([e8afdd3](https://github.com/zuohuadong/supacloud/commit/e8afdd3efefe7c095e5e5ea7b43a6d1a4562f445))
* add /api/auth/* route hijack to router.service.ts for Studio auth support ([b38d60a](https://github.com/zuohuadong/supacloud/commit/b38d60aa00c5df0374f1b6f044b3208667e9a232))
* add /platform/ prefix to all Studio routes ([afd7dd1](https://github.com/zuohuadong/supacloud/commit/afd7dd11ff21859a4e8d37eabb44f1719a3b5ae8))
* add /platform/ prefix to pg-meta routes and enhance v1 project details for Studio Settings menu ([7e3a3b9](https://github.com/zuohuadong/supacloud/commit/7e3a3b92441ae73a97dc3b88f6e6da8baa28c2fe))
* add global error handlers to prevent silent crashes and log fatal errors ([940e0eb](https://github.com/zuohuadong/supacloud/commit/940e0eb100c6c0dd9001898d497d50e546db444f))
* align API response format with Studio expectations ([b014b05](https://github.com/zuohuadong/supacloud/commit/b014b053be41c0c796ca4c7839f52318d93aa4b0))
* align vanity-subdomains endpoint to OpenAPI spec and drop @aws-sdk/client-s3 ([6e2c29f](https://github.com/zuohuadong/supacloud/commit/6e2c29f5ead53da0eac0381549df0192760b64b5))
* allow cleanup tasks to run without project existing ([3568c3e](https://github.com/zuohuadong/supacloud/commit/3568c3e01a4b9432c66defdf548dd9a9f60195a4))
* **api:** fix ReferenceError due to Temporal Dead Zone for staticAssetCache ([7203f84](https://github.com/zuohuadong/supacloud/commit/7203f84d1ee25ce783ae97101ef5886ee2ed27ce))
* **api:** natively support tenant JWTs (service_role_key) for authentication on backend ([b9a4910](https://github.com/zuohuadong/supacloud/commit/b9a49108d2c0b4e1131d878d283f685d1a49432b))
* **api:** tolerate empty password and hostname in DATABASE_URL parsing ([c2dffb1](https://github.com/zuohuadong/supacloud/commit/c2dffb13c661d9111ded0ee4b701061ed92348d1))
* **auth,infra:** 401 pre-flight and all-in-one local docker ([b7fb005](https://github.com/zuohuadong/supacloud/commit/b7fb00575e04cfec3a46df4209e214c6016f0bea))
* **auth:** forward pagination and search params to GoTrue for admin list users route ([c111988](https://github.com/zuohuadong/supacloud/commit/c1119884791b65b4918f66bdfb14294570eb468e))
* **auth:** make login/signup body optional for Studio compatibility ([de0b212](https://github.com/zuohuadong/supacloud/commit/de0b212457268523bebddb09af6d6505aee8de8a))
* **auth:** respect mailer_autoconfirm setting when global SMTP is configured ([7db6dbf](https://github.com/zuohuadong/supacloud/commit/7db6dbfb18b4c935c9507a0a324dc089e14a0514))
* **ci:** align test schema with official supabase-js migrations for 100% SDK compatibility ([2113066](https://github.com/zuohuadong/supacloud/commit/2113066d111de419f50b4ca243aaf1cdbce1c6a2))
* **ci:** fix E2E tests db insertion returning undefined and fix missing jwtSecret in CI tests ([a503a59](https://github.com/zuohuadong/supacloud/commit/a503a59cc88ffe6007d680459309cb7daf7880ed))
* **ci:** fix EdgeRuntime 9000 port collision with Minio and prevent Project creation edge crashes ([618fdb3](https://github.com/zuohuadong/supacloud/commit/618fdb30fbfe422754d2208bb080a3d70d8a3552))
* **ci:** make official SDK compliance non-blocking tracking metric ([a89f081](https://github.com/zuohuadong/supacloud/commit/a89f081cef506183dbef7b56097d0b54db53fa31))
* **ci:** remove sql.end() from mid-pipeline compliance scripts to prevent connection poisoning ([e742bb2](https://github.com/zuohuadong/supacloud/commit/e742bb2e508686e22a1de156de5875728d86c142))
* **ci:** repair unit test syntax and SDK parity monorepo compatibility ([423a576](https://github.com/zuohuadong/supacloud/commit/423a5761bb08b2c6abc659a60f810ec8eda4a789))
* **ci:** resolve EdgeRuntime port collision and API schema validation errors in integration tests ([f9c3932](https://github.com/zuohuadong/supacloud/commit/f9c39327898bceef1e5a39d6811adbc04b88dc53))
* **ci:** resolve FK constraint violation in CLI compliance and make all compliance scripts non-blocking ([2eb7671](https://github.com/zuohuadong/supacloud/commit/2eb76719c0b5857c3e2054a3b399df2bf15d1aea))
* **ci:** rewrite CLI compliance tests to use --db-url for self-hosted mode ([8511532](https://github.com/zuohuadong/supacloud/commit/8511532015e9df4c5b8c1e560c3f1fdb61932436))
* **ci:** robust environment flag checks and S3 array buffer type coercions ([6dfa66b](https://github.com/zuohuadong/supacloud/commit/6dfa66b14096a884ab60dce6ee7028e0c624c1ca))
* clean up mcp routes and release ([51fe8f9](https://github.com/zuohuadong/supacloud/commit/51fe8f9b00f8a5c7aa641e8d6b6022a6314e571c))
* **compat:** complete Supabase parity hardening for DB extensions, Signed URLs and API tests ([eec1199](https://github.com/zuohuadong/supacloud/commit/eec11993992c4b98766c4b190fa3286185656c06))
* **compatibility:** address P0, P1, and P2 compatibility issues ([c8b7655](https://github.com/zuohuadong/supacloud/commit/c8b7655ccca65f418877d09766566fc49c4a95c8))
* **compatibility:** address realtime array ids, ws cleanup, and schema dependencies ([973831c](https://github.com/zuohuadong/supacloud/commit/973831c4138e8a174a7d0a5eb443945a55e03336))
* **compat:** make database schema loading idempotent, sync runtime roles, and move upload state to postgres ([5c237a7](https://github.com/zuohuadong/supacloud/commit/5c237a7c8518cb1c41578910d8fc35264faf4baf))
* **compat:** make full supabase schema idempotent, enforce RLS on signed uploads, scope db_user grants, and fix health probe ([3184fa0](https://github.com/zuohuadong/supacloud/commit/3184fa088688971b1a1948831e93c9acb934e5e7))
* **compat:** replace Deno.env.get with bun-native Bun.env[] in edge function templates ([4dd1380](https://github.com/zuohuadong/supacloud/commit/4dd1380fff42d9097b4cce7e36c6b08f1aa9d3cf))
* **compat:** replace postgres driver with native bun:sql for edge auth closures ([411fa1c](https://github.com/zuohuadong/supacloud/commit/411fa1c027b7da86f4b84bec4a20ba03185758cd))
* **compat:** resolve deep semantic deviations spanning Realtime, Auth, and Storage ([6186cc1](https://github.com/zuohuadong/supacloud/commit/6186cc11fe100db23a9c01afabdf1707da307ccc))
* **compat:** resolve Remaining P0 SDK mismatches for Storage response formats ([bedd6e5](https://github.com/zuohuadong/supacloud/commit/bedd6e578895642c44974766d24c444901fc223f))
* **compat:** resolve Remaining P1/P2 Storage and auth issues from Phase 19 audit ([7636cf8](https://github.com/zuohuadong/supacloud/commit/7636cf81b6c465df380ebe2273a5e6e1dd6a261e))
* **compat:** resolve storage runtime metadata fidelity and explicitly link custom provider physical identities using postgres bindings ([60446ed](https://github.com/zuohuadong/supacloud/commit/60446ed22875bbb065735b7b0eb7635c858c315a))
* **compat:** StorageRLS return truthiness, phantom dry-run objects, schema grants order, and Edge JWT_SECRET injection ([11e1b5a](https://github.com/zuohuadong/supacloud/commit/11e1b5a963040e6f54eb617a371a2051b069e320))
* **compat:** use bunjs native postgres import for edge functions instead of deno url ([42265c5](https://github.com/zuohuadong/supacloud/commit/42265c57b4001cb0ce7d821dc88cec3859c07549))
* complete cleanup pipeline for project deletion (runtime → db → router) ([8fd43e1](https://github.com/zuohuadong/supacloud/commit/8fd43e1e2c556a08185612384d43f1375455effb))
* **config:** correct edgeRuntimeInternal default port 9001→9000 ([0ac61b9](https://github.com/zuohuadong/supacloud/commit/0ac61b96682a0d796418d25a8763547216bcc6eb))
* **config:** resolve env file quote-stripping bug that corrupted URLs ([d542b43](https://github.com/zuohuadong/supacloud/commit/d542b43514c9c5a4b7bd09def84a6db4741fad4b))
* **core:** apply full supabase.sql schema during project bootstrap ([928bbd0](https://github.com/zuohuadong/supacloud/commit/928bbd046fc4926ddd1b14cb8415bd6fe0f4e2b6))
* **core:** harden infrastructure, sys roles, and pipeline cleanups ([940c57f](https://github.com/zuohuadong/supacloud/commit/940c57ff48c151e7c1a449a7c61bcabea6c6ee81))
* **db:** add migration to enforce ON DELETE CASCADE on project_tasks FK ([96c7036](https://github.com/zuohuadong/supacloud/commit/96c7036b8e845223816a495c18c076854adc4941))
* **db:** correct missing table generation check for platform_settings in initialization scope ([a02621b](https://github.com/zuohuadong/supacloud/commit/a02621b48f0c99d86f4435c999e01773d7f893da))
* **e2e:** fix storage routing, postgrest schema reload, and CI gotrue boot crashes ([7f5145b](https://github.com/zuohuadong/supacloud/commit/7f5145b84ce0d626ff01186ef858c7fd8041d6bb))
* **e2e:** force storage to use postgres global database in proxy mode and debug gotrue boot ([44ca8e5](https://github.com/zuohuadong/supacloud/commit/44ca8e5cecf5d8c15898c14dd300311a7c5eed5f))
* **e2e:** mock task workers and dynamically provision minio bucket in CI via AWS SDK ([be5dd1e](https://github.com/zuohuadong/supacloud/commit/be5dd1e03b1e8a014ecc90e013743a2ff2c938a6))
* **e2e:** resolve 6 CI test failures ([4680754](https://github.com/zuohuadong/supacloud/commit/468075469e5c521fd7781d5de746abd77ef34a93))
* **e2e:** resolve multiple syntax errors, s3 provisioning mock and bucket snapshot error mapping ([1f99f3c](https://github.com/zuohuadong/supacloud/commit/1f99f3c0852c08c82343adcc8fb2430d077c17a6))
* **e2e:** stabilize CI pipeline by bypassing realtime provision and natively bootstrapping storage tables ([86244ac](https://github.com/zuohuadong/supacloud/commit/86244ac048d1384d7b8c0c62f5b544d83d5cef83))
* **e2e:** switch ci postgres connection to supabase_admin to bypass auth namespace permission denied ([cf926bd](https://github.com/zuohuadong/supacloud/commit/cf926bdcf11cc2635c23a0a1f1a675271a0e5fb2))
* **edge-runtime:** bypass verifyJwt for CORS preflight OPTIONS requests to prevent 401 errors ([62c3918](https://github.com/zuohuadong/supacloud/commit/62c3918186beb78aac4d496ffee24f7d1c7c0798))
* **edge-runtime:** sync manager port to 9000 to match Kong gateway routes ([cbd57e2](https://github.com/zuohuadong/supacloud/commit/cbd57e24835f834d5ec947cf6a5043dfcedd56b1))
* **edge:** accept bun-bundled function formats and pass EDGE_FUNCTIONS_DIR to runtime ([e1caa1c](https://github.com/zuohuadong/supacloud/commit/e1caa1c61c2392cf9154836391d77b0ade62dcfc))
* **edge:** increase timeouts for AI streaming (20s→120s pool, 300s proxy) ([66a146f](https://github.com/zuohuadong/supacloud/commit/66a146f9188fb7ce0ec31a02f86b3687a28faf73))
* ensure API returns pure arrays instead of objects with .data property ([2d23a9b](https://github.com/zuohuadong/supacloud/commit/2d23a9b3a6102182728a972271bb314fc7e9b4c9))
* explicit @sinclair/typebox dependency to prevent elysia/edge-runtime crash during CI e2e tests proxy boot ([3a288e0](https://github.com/zuohuadong/supacloud/commit/3a288e0317bceba940145f9e2aa8e306ab17b10d))
* export handleMcp, use Bun.serve to bypass Elysia body parsing for MCP ([c7c8005](https://github.com/zuohuadong/supacloud/commit/c7c8005da7b28d5d5d76fe80c3153f8fac3f4497))
* fully fix project creation flow ([457f74c](https://github.com/zuohuadong/supacloud/commit/457f74c6c330d780b691bf3ce787b055606d2e3c))
* **gateway:** allow x-upsert and Cache-Control headers in CORS to support native Supabase SDK storage uploads ([cf30f82](https://github.com/zuohuadong/supacloud/commit/cf30f82d43a4462fd124e5874ad94c7e3847d033))
* **gateway:** append Supabase-specific explicit headers (accept-profile, Range, x-supabase-api-version) to Kong CORS plugin configuration ([668deb6](https://github.com/zuohuadong/supacloud/commit/668deb6525e5a6c4b06e47b32ae00b2790baa493))
* **gateway:** increase default Kong timeouts to 500s for AI/OCR inference ([0002963](https://github.com/zuohuadong/supacloud/commit/0002963fff5477c15d3d793e35320fe1c177dd11))
* **gateway:** resolve edge runtime startup loops and enhance auth proxy routing stability ([404f472](https://github.com/zuohuadong/supacloud/commit/404f472954e7730c9940cb0160fc28e650893d73))
* **gw:** import gatewayService in index ([d5bfae7](https://github.com/zuohuadong/supacloud/commit/d5bfae7e382ee1644417b8f4912fe257e4632246))
* **gw:** route mcp over native gateway internally, bump dep ([19084ea](https://github.com/zuohuadong/supacloud/commit/19084ea79c9e2a18f0548c2d9d45ffa7fcaa6af7))
* **gw:** use dynamic import for gatewayService to prevent bun initialization error ([4e36e09](https://github.com/zuohuadong/supacloud/commit/4e36e0968eaec14808d3a5441781b470bc1f7d98))
* **gw:** use explicit CORS origins instead of regex for Kong compatibility ([931257e](https://github.com/zuohuadong/supacloud/commit/931257e2b2a12dafd218327880970673e930f43e))
* import studioAuthRoutes and studioV1Routes in index.ts ([da9f284](https://github.com/zuohuadong/supacloud/commit/da9f284397dc0091a52218545bd7b03b217a776c))
* **install:** auto-configure pg_hba localhost auth and management-api env vars ([b949101](https://github.com/zuohuadong/supacloud/commit/b949101d79738b3bd9db7712033f57df4da8e7c8))
* **management-api:** adapt Elysia query schema for svadmin useList pagination compatibility ([1164982](https://github.com/zuohuadong/supacloud/commit/1164982049f0e58487e99fde358e8ec294f82e0b))
* **management-api:** add anon rls policies and realtime schema db grants for sdk tests ([0935df4](https://github.com/zuohuadong/supacloud/commit/0935df4e37a6679b7d95f72b0175aa5a0e4997d8))
* **management-api:** add missing GRANT ALL privileges for anon, authenticated and service_role to storage schema in supabase.sql ([86f8c05](https://github.com/zuohuadong/supacloud/commit/86f8c053cb6130b817bbb9942ea2200923286cfd))
* **management-api:** add missing realtime rls policies to official sdk test suite setup ([771eb2f](https://github.com/zuohuadong/supacloud/commit/771eb2f8e68cb7359f0a6d3f75e1a2d069572614))
* **management-api:** add rebuildAllTenantConfigs method to hotfix existing projects with missing Kong CORS headers ([2219e98](https://github.com/zuohuadong/supacloud/commit/2219e98315f4ab88cdb4d0c92ac7b8ab056d9552))
* **management-api:** add x-supabase-api-version to allowed CORS headers in Kong gateway generator ([47b1d21](https://github.com/zuohuadong/supacloud/commit/47b1d21145a2463b074416979977d0f3c2d3941b))
* **management-api:** comply with rfc 1123 hostname rules and aws s3 specs ([3c85991](https://github.com/zuohuadong/supacloud/commit/3c859914540da2863b36772f2f574f9fe2231782))
* **management-api:** correct proxy ws route to match phoenix websocket mount point exactly ([fee612e](https://github.com/zuohuadong/supacloud/commit/fee612e1aef3906e1e17259fe10b235dcd65da48))
* **management-api:** correctly report realtime, storage, and gateway health ([d7db021](https://github.com/zuohuadong/supacloud/commit/d7db0211479ad5b4ac095416c5c06084b4502c02))
* **management-api:** fix Bun SQL database connection issue ([b02a521](https://github.com/zuohuadong/supacloud/commit/b02a521f3934982df8ef32ce9e31c36fe6967e15))
* **management-api:** fix database initialization and table schema ([a724eb6](https://github.com/zuohuadong/supacloud/commit/a724eb669dbf97c3a7fde0c4dc02596ebb743c0b))
* **management-api:** fix storage path double-nesting, imaginary POST body, and bucket listing stubs ([ec73ccc](https://github.com/zuohuadong/supacloud/commit/ec73ccca02755f7f408da2ac33b285cc0b39e3ff))
* **management-api:** fix Studio Angie template missing /grafana/, /auth/, /api routes ([9bb5ffb](https://github.com/zuohuadong/supacloud/commit/9bb5ffbe032e4e1cffc88e2130e28a21692b13cc))
* **management-api:** fix typescript compilation error by exporting checkAuth instead of removed authMiddleware ([9793475](https://github.com/zuohuadong/supacloud/commit/9793475cd1ebb1ec22c0e7e4d35861b0fc537bd0))
* **management-api:** make edge runtime port dynamically configurable from environment ([687a46f](https://github.com/zuohuadong/supacloud/commit/687a46fb42ddb161600d1f4ed39aac6fe6d8d235))
* **management-api:** normalize project response timestamps and update functions secrets schema formatting ([d01830e](https://github.com/zuohuadong/supacloud/commit/d01830ec48af64d67815022c3d73b877a8e6adeb))
* **management-api:** refine s3 ports and storage adapter error handling ([e55295c](https://github.com/zuohuadong/supacloud/commit/e55295c2952a087d0a0f71c9293246507d230ad4))
* **management-api:** register dynamically created buckets in database to prevent downstream RLS foreign key violations ([a8a7e95](https://github.com/zuohuadong/supacloud/commit/a8a7e959c754546b1c691233d077e21bddf0f0a6))
* **management-api:** remove malicious sdk parity minio port rewrite and resolve edge-runtime container port collision ([85783ad](https://github.com/zuohuadong/supacloud/commit/85783adf5761005456cb38442700ffd02f70208c))
* **management-api:** revert realtime proxy path to use /socket/websocket to fix HTTP 404 dropping connections ([39ec00d](https://github.com/zuohuadong/supacloud/commit/39ec00d5296c6e7467bea4e21f6b525f7779dcf9))
* **management-api:** spoof realtime host header and dump api logs on ci failure ([666a088](https://github.com/zuohuadong/supacloud/commit/666a088d4052e95e2819969aa60b9ddb73bf5678))
* **management-api:** strictly align P0/P1 OpenAPI endpoints and refactor Vanity Subdomain schemas ([bda552b](https://github.com/zuohuadong/supacloud/commit/bda552b40e9587da43c958a3f248a5384161f14d))
* **management-api:** use aws4fetch for robust s3 operations and fix realtime CDC prereqs timeouts ([e1c4bbc](https://github.com/zuohuadong/supacloud/commit/e1c4bbcf47b7c44262726ff4c825e613510b0a75))
* **management-api:** use native S3 fetch adapter for CI uploads and standardize WS proxy headers ([7e1b47a](https://github.com/zuohuadong/supacloud/commit/7e1b47a04ddaf2c20f38005b633ee3e97c167c3e))
* **mcp:** allow X-Client-Info CORS header for supabase-js ([f98e915](https://github.com/zuohuadong/supacloud/commit/f98e915a9026ac9d32fcdc511cdb7e1d1bdcf6eb))
* **mcp:** complete CORS headers including apikey, Prefer, and Content-Profile ([03f6f2e](https://github.com/zuohuadong/supacloud/commit/03f6f2ebd80b5c635fd1c5240c82e6238e2581b3))
* **mcp:** fix execute_sql 404 and add /mcp/migrations endpoint ([77a4521](https://github.com/zuohuadong/supacloud/commit/77a4521410e5f9f3f47f50b22cabfd4759c2d30e))
* **mcp:** Query correct service_role_key column ([1d5206f](https://github.com/zuohuadong/supacloud/commit/1d5206fd8ff7270bb5f535b98a288b6d71714b00))
* mount Studio routes before main routes to ensure correct override ([4b4020e](https://github.com/zuohuadong/supacloud/commit/4b4020e29da28caeabad6db6a9dc6616ea83d1c9))
* **openapi:** align ref generation, service health, config responses with official Supabase OpenAPI spec ([f42fcbd](https://github.com/zuohuadong/supacloud/commit/f42fcbdedd1d05733a40e8ca9e0785a299137f9e))
* **openapi:** resolve TS error for custom hostname data property ([8007248](https://github.com/zuohuadong/supacloud/commit/8007248dd5274de0d41e8b86bc451f201a64ebb4))
* pass raw request to MCP transport handleRequest ([e97cd1d](https://github.com/zuohuadong/supacloud/commit/e97cd1da74c03fde3b178629401ef2fc6fa1906d))
* **postgrest:** enable OpenAPI mode, db-pre-request, and single-source config ([8960ecc](https://github.com/zuohuadong/supacloud/commit/8960ecc2d18ec381740d06a18194e2993d2347a7))
* **project:** replace hardcoded localhost with config.baseDomain for database host response ([7a4996e](https://github.com/zuohuadong/supacloud/commit/7a4996ebb4b2d9a5559193a8b9637ed3ee0af4bd))
* **project:** return credentials in project creation API and support custom api/studio domains ([127553e](https://github.com/zuohuadong/supacloud/commit/127553e9a744c7446936d3c5e41aa9280c8b36e6))
* **proxy:** resolve Elysia routing precedence and e2e testing bugs ([24194b8](https://github.com/zuohuadong/supacloud/commit/24194b8b7510d082d88b8c33fae6f353caa7977c))
* **proxy:** update Elysia wildcard routing for correct SDK REST and Auth passthrough ([4191d47](https://github.com/zuohuadong/supacloud/commit/4191d471b443808ad8cac2d9657bb0f8abb02ea6))
* **realtime:** correct subscribeTenant arity (TS2554) ([c96216b](https://github.com/zuohuadong/supacloud/commit/c96216b00f6b339a5534f5825791598316ee3263))
* **realtime:** resolve websocket protocol encoding, path matching, and presence syncs ([343fb6d](https://github.com/zuohuadong/supacloud/commit/343fb6df7714a73e1f578e542b8c628bdab8b7dc))
* **realtime:** route WebSocket to self-seeded tenant realtime-dev via host header ([5c54191](https://github.com/zuohuadong/supacloud/commit/5c541914ce95821a2dda7a0e8879cbe54f09af97))
* remove SSL from Angie config ([2277dc2](https://github.com/zuohuadong/supacloud/commit/2277dc232c9c8b48e67a77d4b3f805bce9ddae34))
* repair 2 failing getProjectHealth tests, fix providers page undefined variable, bump v0.5.2 ([c3883a5](https://github.com/zuohuadong/supacloud/commit/c3883a5a67e85340de081b130d8dd9940fc9322f))
* resolve auth endpoints and pigsty infra config ([babda5b](https://github.com/zuohuadong/supacloud/commit/babda5bfdedbc308737a824407e1306849e47af4))
* resolve core bugs, secure webhooks, and separate platform UI ([d4a2832](https://github.com/zuohuadong/supacloud/commit/d4a28327a40392ad869cb1cdd2ec8f3f1958f9a9))
* resolve Kong connection issues ([72f889b](https://github.com/zuohuadong/supacloud/commit/72f889b8dcc8a16f51063fc5f86d89c9a7a9a04f))
* resolve TypeScript errors in CLI and task.worker ([b013254](https://github.com/zuohuadong/supacloud/commit/b0132540c9c68b3f28235db2c2caec8d30948d25))
* resolve unit test and automation suite failures due to ci overriding jwt and absent db configurations ([03308a4](https://github.com/zuohuadong/supacloud/commit/03308a451669a0e335407bdbbdb50671a247856e))
* return real projects in /platform/profile for Studio multi-project support ([0cae3a7](https://github.com/zuohuadong/supacloud/commit/0cae3a75e6c4781f41200627816035023c765f1f))
* return Studio-compatible format in /v1/projects/:ref route ([65b7e78](https://github.com/zuohuadong/supacloud/commit/65b7e78bf94cde5ff542388680e62817e3ecb6c1))
* rewrite MCP route with onRequest lifecycle to bypass Elysia body parsing ([38de0fc](https://github.com/zuohuadong/supacloud/commit/38de0fc4c2fb95a125cb3046f7b02a5b6de81621))
* **router:** change default angieSitesDir to /etc/angie/http.d ([e086ba0](https://github.com/zuohuadong/supacloud/commit/e086ba0ccc34f3cb4864071dfea2792b3eca1342))
* **router:** enforce HTTP/1.1 for Kong proxies to prevent 502 Bad Gateway due to upstream connection drops ([efc2437](https://github.com/zuohuadong/supacloud/commit/efc2437cf10c6c4b6397bdd7034e79e84f22658e))
* **security:** enforce API auth middleware and fix SPA routing ([7d1d288](https://github.com/zuohuadong/supacloud/commit/7d1d288428aa1a0e5e961ca791b63870e08f4f23))
* **services:** mock S3 provision and cleanup in CI mode to prevent destructive saga rollbacks ([4191d47](https://github.com/zuohuadong/supacloud/commit/4191d471b443808ad8cac2d9657bb0f8abb02ea6))
* standardize HTTP status codes in API error responses and improve CI health checks ([8bb3e73](https://github.com/zuohuadong/supacloud/commit/8bb3e7349870c38c05dfa7aadf9b7672704e28e5))
* **static:** replace sirv-cli with Bun-native disk-read static server ([17115cf](https://github.com/zuohuadong/supacloud/commit/17115cf77965cb659a7fbf669d1b4007c2509ab4))
* stop PgListener infinite reconnect on fatal auth errors (SCRAM-SHA-256) ([82e915d](https://github.com/zuohuadong/supacloud/commit/82e915d11529df175ceeb1cccb72655a39618e51))
* **storage:** add s3 compensatory rollbacks on db materialization drops, and align move/copy verifications ([9d7f68c](https://github.com/zuohuadong/supacloud/commit/9d7f68c40bc7907bad5202bb02c399a920cc7028))
* **storage:** align listV2 payload schema with supersonic sdk cursor logic, delimit switches, and correct folder signatures ([9d7a3e7](https://github.com/zuohuadong/supacloud/commit/9d7a3e70deba32cd179ca654309e6ae5ce1bfe24))
* **storage:** align sdk outputs, append cache-controls, rewrite native id mappings, format schema json boundaries, handle download dispositions and purge social scale traps ([7fec32b](https://github.com/zuohuadong/supacloud/commit/7fec32bf6f682bd7bdddd55c5b4ff23780e021e9))
* **storage:** align upload Id with official API and fix bucket-not-found status ([224f91d](https://github.com/zuohuadong/supacloud/commit/224f91dde0322200b3dfe838386925c204c25ced))
* **storage:** bypass Elysia multipart parser to correctly support supabase-js SDK uploads missing body field names ([da5b2d5](https://github.com/zuohuadong/supacloud/commit/da5b2d52dcea0ddd624f4fe1236582ab7d6cd5bf))
* **storage:** correct wechat compilation, enforce move atomicity, validate upload persistence, and align bucket delete constraints ([34d453c](https://github.com/zuohuadong/supacloud/commit/34d453c988d915f153fbd31a91ce49d6fe81372e))
* **storage:** enforce bucket transaction atomicity, query limits, and 23505 constraints ([dd8efea](https://github.com/zuohuadong/supacloud/commit/dd8efeaf5c5c05e687da6faa7964310292db1239))
* **storage:** enforce move & tus assertions, isolate admin overriden buckets, format cdn restrictions and insert database defaults ([223c8b0](https://github.com/zuohuadong/supacloud/commit/223c8b0c567f832f353a67e3ccc1b2cb562a765e))
* **storage:** enforce move transactional rollbacks, v1 list search binding, v2 delimiter defaults, and 404 project trace handling ([8cb79cc](https://github.com/zuohuadong/supacloud/commit/8cb79cc691dfc8847594310e906fe3742a9d6cf4))
* **storage:** enforce RLS on existence checks and defer POST/PUT materialization ([eeaf9dc](https://github.com/zuohuadong/supacloud/commit/eeaf9dc84f45b507cf218d14c852db964d80196e))
* **storage:** fix list observability, empty bucket status matching, signed upload checks and delete isolation ([c56e4c5](https://github.com/zuohuadong/supacloud/commit/c56e4c5fd60ee6c513ee0becace29be52d923bfe))
* **storage:** implement list-v2 folder collapsing, apply db mimetypes, and track rollback logging ([c5e8608](https://github.com/zuohuadong/supacloud/commit/c5e86084ed773e06c0e1778431feb3ca2d4738c3))
* **storage:** implement missing endpoints and payload compatibility ([38536e1](https://github.com/zuohuadong/supacloud/commit/38536e1b4127290be99a3fe725ced39b3ae04e82))
* **storage:** map list timestamps, enforce tus limits, and resolve public bucket overrides ([4ca7054](https://github.com/zuohuadong/supacloud/commit/4ca705471d2c89bd174d09d21782a4bd37fc8612))
* **storage:** migrate PUT to use custom multipart buffer boundary extractor ([6668cee](https://github.com/zuohuadong/supacloud/commit/6668cee8ee28195ea53a3dcf360cb36dac90e9df))
* **storage:** resolve 100% JS SDK functional compatibility issues ([d557c64](https://github.com/zuohuadong/supacloud/commit/d557c649a574d2d9b8fae9d6a54cbd3f22f249a1))
* **storage:** resolve bucket rls coupling, move transactional loops, and list sorting capabilities ([a66f8a6](https://github.com/zuohuadong/supacloud/commit/a66f8a60e4125e9fe89e26a6cb302ff485f91926))
* **storage:** resolve upload TOCTOU concurrency and align official RLS error semantics ([3d1ada3](https://github.com/zuohuadong/supacloud/commit/3d1ada31c0c7b7bdb7b4e50e9ce88b0c64dd0e88))
* **storage:** sniff raw payload to force multipart parsing even when gateway overrides content-type to image/png ([15c3a93](https://github.com/zuohuadong/supacloud/commit/15c3a931536d4868d9265ede6c27acd53eb303c9))
* **storage:** store raw seconds in cacheControl metadata (official Supabase format) ([2f273dd](https://github.com/zuohuadong/supacloud/commit/2f273dd9b133f67db8c5efb11993bff2912f67e7))
* Studio multi-project support - hijack /api/platform/* to Management API, use localhost:3000 for Studio ([3c3d642](https://github.com/zuohuadong/supacloud/commit/3c3d6420c4fd00d863d089175481d2a243f176fe))
* Studio should proxy directly to studio container, not through Kong ([e43352c](https://github.com/zuohuadong/supacloud/commit/e43352c6b219f019da36ccca5259e23f75d96d10))
* **studio:** enhance pg-meta proxy and resolve dynamic project ref 404s ([270281b](https://github.com/zuohuadong/supacloud/commit/270281b719f1698bea2ec6fa254432ecab676528))
* **studio:** fix project ref consistency and missing config endpoints to resolve frontend crashes ([db77d46](https://github.com/zuohuadong/supacloud/commit/db77d463152d72dd4c9d391df6dc4d82bd672e98))
* sync studio.ts with correct format ([149f270](https://github.com/zuohuadong/supacloud/commit/149f270d6471e60fc62e7bc7828148ca7694553f))
* **test:** finalize DatabaseService mocks and ensure all tests pass ([813873a](https://github.com/zuohuadong/supacloud/commit/813873a3c3aebcbaa697ca96bf95707305db886c))
* **test:** major testing mock improvements and ci workflow cleanup ([b94f361](https://github.com/zuohuadong/supacloud/commit/b94f361b7a5a9b6ac1b93bdf1d9e21c41d8e6c55))
* **test:** mock withRetry in integration tests to ensure 100% pass rate ([98df69c](https://github.com/zuohuadong/supacloud/commit/98df69c30c3408813d343f620da4a2996439e287))
* **tests:** fix test failures ([4c9d1d3](https://github.com/zuohuadong/supacloud/commit/4c9d1d33bed053e8ed1246bc654183157d4f70ea))
* TypeScript error in studio.ts logger.error call ([f583d98](https://github.com/zuohuadong/supacloud/commit/f583d987d2d5c66a1ceabfb97323899f95e85692))
* update RealtimeService to use JWT-signed auth for admin API, fix PG defaults ([49f99f2](https://github.com/zuohuadong/supacloud/commit/49f99f2db140e197a41a1d3803694a5a139c9959))
* update tests to match refactored code ([138c0d0](https://github.com/zuohuadong/supacloud/commit/138c0d0440791f6f7d6dfb9a511b445b69d534a4))
* use correct service names (patroni instead of postgresql) and handle optional services ([d8a0948](https://github.com/zuohuadong/supacloud/commit/d8a09487090f730e2f97267480777984600b7ec0))
* use Elysia body param for MCP request reconstruction ([c30bc32](https://github.com/zuohuadong/supacloud/commit/c30bc3242dc072e4545cc82bddf0d0eebc2fcaf8))
* use WebStandardStreamableHTTPServerTransport for Bun compatibility ([219a467](https://github.com/zuohuadong/supacloud/commit/219a46731c087238d3980baa44440a91021a9cb6))
* **workflow:** restore build-binaries triggers and fix tests mock isolation ([9b53c0a](https://github.com/zuohuadong/supacloud/commit/9b53c0af784f60b61446c4a68553dccd858ce6cf))


### Elegance & Refactoring

* **api:** standardize error payload schemas across all routes for Stripe parity ([dc0955c](https://github.com/zuohuadong/supacloud/commit/dc0955ced1ca18264ee748a2d30f6c2e78c95f39))
* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([75c7dfd](https://github.com/zuohuadong/supacloud/commit/75c7dfd272ee2c9ca4f638a8493596c20a4ae4bf))
* complete legacy Deno/Bun runtime cleanup and migration ([174a0b1](https://github.com/zuohuadong/supacloud/commit/174a0b130aabd67df0e0f8b712087af8367749cf))
* **core:** use resolveDbName and parameterized queries for schema routing and postgres reflection ([4e493e7](https://github.com/zuohuadong/supacloud/commit/4e493e7b6779bf130a9ab2bacdd3c0639efe8c8a))
* **cors:** move CORS from edge functions to Angie gateway layer ([2ce8c41](https://github.com/zuohuadong/supacloud/commit/2ce8c41b3aa28db8a72ed3eab473e9b4d42484fc))
* eliminate all [@ts-ignore](https://github.com/ts-ignore), implement all TODOs, centralize remaining env ([514f1f0](https://github.com/zuohuadong/supacloud/commit/514f1f027c3cd73795f8bbda2861c43c470ab12b))
* eliminate technical debt - split projects.ts, centralize env vars, remove all any types ([13500d1](https://github.com/zuohuadong/supacloud/commit/13500d172805cfe3af14dac3f250de3550a8b7b0))
* **gateway:** complete migration to native Kong Gateway and remove legacy Angie ([e966862](https://github.com/zuohuadong/supacloud/commit/e966862ddea6504a35be2e454375cd591895c7ba))
* **gateway:** unify edge proxy to native kong rest api ([eb1a97a](https://github.com/zuohuadong/supacloud/commit/eb1a97ab82b9a6deeb961e5a7c4ca4f87a79f192))
* **realtime:** revert native realtime and restore official docker integration ([42d7a78](https://github.com/zuohuadong/supacloud/commit/42d7a78d018f388098624b0d32cf9dd69483cdec))
* remove legacy Deno/Bun runtime switch, unify to Bun Edge Runtime ([393c688](https://github.com/zuohuadong/supacloud/commit/393c688cf7591fdab124e498d59af64e751ac37b))
* remove legacy supabase-vector/auth container deps, fix ASSETS null guard ([4bb0323](https://github.com/zuohuadong/supacloud/commit/4bb032334fea13bc09eb99042100c14d6bab1ba9))
* split frontend.service.ts + eliminate all process.env from services ([60d5dcd](https://github.com/zuohuadong/supacloud/commit/60d5dcd525877b2ab38a457563246eb277fb54a6))
* split OAuth service from tenant-runtime ([c46cf62](https://github.com/zuohuadong/supacloud/commit/c46cf6293a8bc41bbabe22379510830b81f935c2))
* split project.service.ts, implement cluster module, S3 ops ([767e221](https://github.com/zuohuadong/supacloud/commit/767e22198a64da17bb5a286da41f2fc10c79f262))
* **web-console:** finalize AutoTable hybrid migration for auth and tables pages ([209608b](https://github.com/zuohuadong/supacloud/commit/209608b1f53e2cefb3f1b39dd33614c70b83ab34))


### Performance Improvements

* **api:** implement O(1) memory caching and pre-compression for static assets ([a0bd52e](https://github.com/zuohuadong/supacloud/commit/a0bd52e426a619324c7aa6bb07cc7a18e20e8138))
* replace node:fs legacy I/O with fully-optimized Bun native APIs across the project ([4bc99c8](https://github.com/zuohuadong/supacloud/commit/4bc99c84173c1859cb3a095c2d007c343fdbc754))


### Miscellaneous Chores

* align error codes and resolve DB roles in management API ([7fbece6](https://github.com/zuohuadong/supacloud/commit/7fbece6c322c13820bde368b52ffc73fcb952ee5))
* bump version (+0.0.1) for management-api and mcp-server ([16a7624](https://github.com/zuohuadong/supacloud/commit/16a76241fb7d7416ab9c25d331e471d6221fb9bc))
* **deps:** update [@svadmin](https://github.com/svadmin) components to latest versions in console and api ([0d30e5b](https://github.com/zuohuadong/supacloud/commit/0d30e5b73b63875bd9f5763a2a17ff1c5487e774))
* flush remaining test suite fixes and project modifications ([b678a77](https://github.com/zuohuadong/supacloud/commit/b678a77bf72e4bcaf75f9963153f8802ec0d869e))
* **management-api:** bump version to 0.6.3 ([c0cd667](https://github.com/zuohuadong/supacloud/commit/c0cd66712f7a6db9b91e2ca6363cf8acd477eb11))
* **management-api:** translate all queue worker comments to English ([0cfcf66](https://github.com/zuohuadong/supacloud/commit/0cfcf66ff6367d43f5c2199aa63f5b656659f8c2))
* **management-api:** translate all remaining Chinese comments to English ([48658e5](https://github.com/zuohuadong/supacloud/commit/48658e55c3d2026c7649ddc0c5225a5e496b8073))
* push all accumulated compliance and runtime integrations ([adba09c](https://github.com/zuohuadong/supacloud/commit/adba09ca0752da3ad240f728873f460076246ab2))
* **release:** 0.3.21 ([c184eb0](https://github.com/zuohuadong/supacloud/commit/c184eb01ff8b33aea2f29c43fe26963247a98f0b))
* **release:** 0.3.22 ([295efa9](https://github.com/zuohuadong/supacloud/commit/295efa9bd52ed8a75f3a743416f07317d3670399))
* **release:** bump management-api to 0.8.0 ([d06c666](https://github.com/zuohuadong/supacloud/commit/d06c666627697d5e726482b8d59b8e8c96e23e6d))
* **release:** bump unified versions by 0.0.1 ([f077a45](https://github.com/zuohuadong/supacloud/commit/f077a45e572aca73e68885df2e454a09d8086894))
* **release:** bump version to 0.7.5 ([3ae01cd](https://github.com/zuohuadong/supacloud/commit/3ae01cdf471f1f9af6cde99b2c99d9de39a9ac6b))
* **release:** bump version to 0.7.6 ([e1a78f1](https://github.com/zuohuadong/supacloud/commit/e1a78f1ea8a2899419179f3411b7f3375b9f861f))
* **release:** bump version to 0.7.7 ([6fa9d4c](https://github.com/zuohuadong/supacloud/commit/6fa9d4c81a151f0e4916beba33c62fd53c2908f0))
* **release:** bump version to 0.7.8 ([98a2c5e](https://github.com/zuohuadong/supacloud/commit/98a2c5e07054a78930f1e15fb6f7c57b4a049154))
* remove redundant migration files, init.ts is the single source of truth ([1315a6d](https://github.com/zuohuadong/supacloud/commit/1315a6d1cca18a8fe4c21b4e3507545f4c13b698))
* save state before rewriting history ([1209d29](https://github.com/zuohuadong/supacloud/commit/1209d29b79c3471a9bddbade72b1a294035562a1))
* setup release-please for automated versioning and update svadmin dependencies ([3c62ac6](https://github.com/zuohuadong/supacloud/commit/3c62ac6f096850471bd55226a84d2605e293d751))
* update @modelcontextprotocol/sdk and @svadmin/ui versions and remove @svadmin/editor dependency ([37df3a7](https://github.com/zuohuadong/supacloud/commit/37df3a7601e64a7be15bbda1ec504be1864a808c))
* upgrade svadmin framework to core@0.19.2, ui@0.23.0, elysia@0.10.0 ([c6b1fdf](https://github.com/zuohuadong/supacloud/commit/c6b1fdf93a486116a64656baac563a7791a76be6))
* upgrade svadmin framework to core@0.19.3, ui@0.23.2, elysia@0.10.1 ([212387f](https://github.com/zuohuadong/supacloud/commit/212387fb11ab8031317b69c74c3389529a6fa547))
* upgrade svadmin to latest version and fix breaking changes in query/mutation hooks ([58dd961](https://github.com/zuohuadong/supacloud/commit/58dd96111cbdfb481e89a68b4ea28c8a9d83cf93))
