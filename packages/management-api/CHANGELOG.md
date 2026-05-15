# Changelog

## [0.14.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.14.0...management-api-v0.14.1) (2026-05-15)


### 🐛 Bug Fixes

* restore project reprovisions missing resources ([a8b3ec3](https://github.com/zuohuadong/supacloud/commit/a8b3ec3eed145628f5551880f705b2b97b769d1b))

## [0.14.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.8...management-api-v0.14.0) (2026-05-15)


### 🚀 Features

* **management-api:** add Swagger detail annotations to all 121 route handlers ([02f049c](https://github.com/zuohuadong/supacloud/commit/02f049c515d716edb2fe3ec6a914cfea78235689))


### 🐛 Bug Fixes

* auth middleware response format mismatch with route schemas ([#107](https://github.com/zuohuadong/supacloud/issues/107)) ([c76a6f8](https://github.com/zuohuadong/supacloud/commit/c76a6f84f3788d754db7f94accf7c178cd6907cb))
* **management-api:** enforce Swagger route coverage ([4ec22db](https://github.com/zuohuadong/supacloud/commit/4ec22db97820ae8b75b73d10d9f659593c842482))
* **management-api:** pin Supabase JS compliance ref ([205e57d](https://github.com/zuohuadong/supacloud/commit/205e57d36409eb58c99db2804b162248d9dbb592))

## [0.13.8](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.7...management-api-v0.13.8) (2026-05-12)


### 🐛 Bug Fixes

* **ci:** repair release asset upload ([98d5537](https://github.com/zuohuadong/supacloud/commit/98d5537ad77ab381e42d91ab011cedeea38498f9))

## [0.13.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.6...management-api-v0.13.7) (2026-05-12)


### 🐛 Bug Fixes

* add function invoke route, repair stale projects, web-console deployment ([dedab66](https://github.com/zuohuadong/supacloud/commit/dedab667e4a200470a1d6c5d4dfada8df17e32ea))
* improve one-click install robustness, add function invoke route, repair stale projects ([5cdbe8a](https://github.com/zuohuadong/supacloud/commit/5cdbe8a0f7800e3b1b1e903976bcc8c33e61d1b1))
* use direct GoTrue port instead of HTTPS API URL to avoid self-signed cert errors ([73f1902](https://github.com/zuohuadong/supacloud/commit/73f19020218aa08e5fcfc430be039cc512833ef6))

## [0.13.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.5...management-api-v0.13.6) (2026-05-11)


### 🐛 Bug Fixes

* **management-api:** harden storage list metadata parsing ([5b596ff](https://github.com/zuohuadong/supacloud/commit/5b596ff4436a666aec1d232c9858a4173785671e))

## [0.13.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.4...management-api-v0.13.5) (2026-05-10)


### 🐛 Bug Fixes

* harden management API edge cases ([d938f51](https://github.com/zuohuadong/supacloud/commit/d938f51b52f4762a2c55068b59f23616b9d7df3e))

## [0.13.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.3...management-api-v0.13.4) (2026-05-10)


### ⚡ Performance Improvements

* reduce management hot path load ([e5f4c82](https://github.com/zuohuadong/supacloud/commit/e5f4c82f58cb1d515c9c6f94d77fe8032ecdbe26))

## [0.13.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.2...management-api-v0.13.3) (2026-05-08)


### 🔧 Miscellaneous Chores

* **deps:** bump @svadmin/core in /packages/management-api ([#81](https://github.com/zuohuadong/supacloud/issues/81)) ([dd6cba3](https://github.com/zuohuadong/supacloud/commit/dd6cba30a7882e35ec8114e90091f94ec05c47bc))
* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/management-api ([#86](https://github.com/zuohuadong/supacloud/issues/86)) ([49b03f5](https://github.com/zuohuadong/supacloud/commit/49b03f554cadd557595436e7112535f6250d3a2d))

## [0.13.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.1...management-api-v0.13.2) (2026-05-08)


### 🐛 Bug Fixes

* **installer:** align pigsty supabase install path ([a14e33a](https://github.com/zuohuadong/supacloud/commit/a14e33a7a9b0b44f138c219fcf779a9a8d5cc242))
* **management-api:** reconcile custom domain runtime routes ([6a0b8de](https://github.com/zuohuadong/supacloud/commit/6a0b8def0215407f14508916866944ac54b6225a))

## [0.13.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.13.0...management-api-v0.13.1) (2026-05-08)


### 🐛 Bug Fixes

* **installer:** derive studio domain from API host ([4d94d49](https://github.com/zuohuadong/supacloud/commit/4d94d49f0e3615e7dfe420dea7cc72ba91fc41d9))

## [0.13.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.19...management-api-v0.13.0) (2026-05-08)


### 🚀 Features

* **gateway:** manage certificates through Kong ([3d5930f](https://github.com/zuohuadong/supacloud/commit/3d5930fb5eb78ed32fb96b06d0f824446504ae22))

## [0.12.19](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.18...management-api-v0.12.19) (2026-05-07)


### 🐛 Bug Fixes

* **runtime:** respect ssl config for tenant urls ([d8ace81](https://github.com/zuohuadong/supacloud/commit/d8ace81412b4caa87fe00982539310452faeaaa1))
* **runtime:** respect ssl config for tenant urls ([d0852b2](https://github.com/zuohuadong/supacloud/commit/d0852b2e3d95a1c4ab33a30916df68aa15a41a64))

## [0.12.18](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.17...management-api-v0.12.18) (2026-05-07)


### 🐛 Bug Fixes

* **edge-runtime:** preserve env for waitUntil tasks ([1e43fbf](https://github.com/zuohuadong/supacloud/commit/1e43fbf6eb22a8fff3218326dae4c6e0b8fb4176))
* **edge-runtime:** preserve env for waitUntil tasks ([424152c](https://github.com/zuohuadong/supacloud/commit/424152c21265e67ec5812453d3cfc2a5ed064b87))

## [0.12.17](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.16...management-api-v0.12.17) (2026-05-06)


### 🐛 Bug Fixes

* **management-api:** accept serialized routing config ([edb5e4d](https://github.com/zuohuadong/supacloud/commit/edb5e4d329e255e22ee48c5c8bab7b6c833ad2ac))
* **tasks:** allow invoker jwt to read task detail ([e99cf7b](https://github.com/zuohuadong/supacloud/commit/e99cf7b1e7994f738a446410ca0f5f5ac98f5042))

## [0.12.16](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.15...management-api-v0.12.16) (2026-05-06)


### 🐛 Bug Fixes

* **install:** skip legacy supabase compose stack ([4bcf1fa](https://github.com/zuohuadong/supacloud/commit/4bcf1faacc036ddf55aa17c5124ca87e2d8083fa))

## [0.12.15](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.14...management-api-v0.12.15) (2026-05-04)


### 🐛 Bug Fixes

* **pigsty:** align 4.3 upgrade with supacloud storage defaults ([e3e6881](https://github.com/zuohuadong/supacloud/commit/e3e68818aad04c9d967d83d05a03cb58331bf453))

## [0.12.14](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.13...management-api-v0.12.14) (2026-05-04)


### 🐛 Bug Fixes

* **security:** harden storage and proxy surfaces ([03e0efa](https://github.com/zuohuadong/supacloud/commit/03e0efad117902d014dc855732a0d337bce1c764))

## [0.12.13](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.12...management-api-v0.12.13) (2026-05-01)


### 🐛 Bug Fixes

* **gateway:** include hosted frontend origins in cors ([672b764](https://github.com/zuohuadong/supacloud/commit/672b764ad066ad5751ec98210175fdd9053b9a5a))

## [0.12.12](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.11...management-api-v0.12.12) (2026-04-29)


### 🐛 Bug Fixes

* **ci:** provide websocket for sdk compliance ([26ffa43](https://github.com/zuohuadong/supacloud/commit/26ffa437772b99d3fb02fc770c3097e24414d012))
* **ci:** retry official cli bootstrap downloads ([420f0ad](https://github.com/zuohuadong/supacloud/commit/420f0ada19af72b74b6b981979098603551cc6d2))

## [0.12.11](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.10...management-api-v0.12.11) (2026-04-29)


### 🐛 Bug Fixes

* **edge-runtime:** inject Bun function env ([54aefe5](https://github.com/zuohuadong/supacloud/commit/54aefe576cb351fe2dd37c4a9b8e74ed4c34f517))

## [0.12.10](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.9...management-api-v0.12.10) (2026-04-29)


### 🐛 Bug Fixes

* **management-api:** expose unmasked runtime env internally ([713702b](https://github.com/zuohuadong/supacloud/commit/713702bb3950e4df9cd5ed18850073e5710fd040))

## [0.12.9](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.8...management-api-v0.12.9) (2026-04-29)


### 🐛 Bug Fixes

* **management-api:** inject internal supabase runtime secrets ([13c9f15](https://github.com/zuohuadong/supacloud/commit/13c9f15483083e8a14d6c708276f6a322a786992))

## [0.12.8](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.7...management-api-v0.12.8) (2026-04-29)


### 🐛 Bug Fixes

* **management-api:** harden project queue reliability ([0f857e3](https://github.com/zuohuadong/supacloud/commit/0f857e3e2ec937eaff63d163017fdafb93135027))
* **management-api:** harden storage and background contracts ([d952a86](https://github.com/zuohuadong/supacloud/commit/d952a86fcc112fb8c44c105e82a41f9b5c56790b))

## [0.12.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.6...management-api-v0.12.7) (2026-04-29)


### 🐛 Bug Fixes

* **management-api:** resolve functions tenants from custom domains ([5baf0d5](https://github.com/zuohuadong/supacloud/commit/5baf0d5ec4e75089228167963d3b96261f2ef75f))

## [0.12.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.5...management-api-v0.12.6) (2026-04-29)


### 🐛 Bug Fixes

* **management-api:** allow public storage reads on custom domains ([db33913](https://github.com/zuohuadong/supacloud/commit/db33913ed919c63549732a0c4f6d3c98a50f4a45))

## [0.12.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.4...management-api-v0.12.5) (2026-04-28)


### 🐛 Bug Fixes

* **management-api:** grant postgrest authenticator database access ([f64e7d8](https://github.com/zuohuadong/supacloud/commit/f64e7d8988293dd8cec0626147e819532cc9c086))

## [0.12.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.3...management-api-v0.12.4) (2026-04-28)


### 🐛 Bug Fixes

* **management-api:** grant auth roles tenant database access ([196ec92](https://github.com/zuohuadong/supacloud/commit/196ec922bd876bf42081e1fbfbb5ad28f84f710e))
* **management-api:** isolate background auth encryption regression ([d447a84](https://github.com/zuohuadong/supacloud/commit/d447a847177f23590c35fa721e002d24e893fe8d))
* **management-api:** stabilize encrypted background task regression ([70e4c44](https://github.com/zuohuadong/supacloud/commit/70e4c44c72fad7eb88c0662750b6d4ac56bfcdc8))
* **management-api:** use node random uuid in sdk proxy ([5ceb267](https://github.com/zuohuadong/supacloud/commit/5ceb2671020fea9413d99fca883b11d46271bb31))

## [0.12.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.2...management-api-v0.12.3) (2026-04-28)


### 🐛 Bug Fixes

* **management-api:** encrypt background task credentials ([7f7b815](https://github.com/zuohuadong/supacloud/commit/7f7b815ceb2b7b5a5f7368772b6483882f0a7b36))

## [0.12.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.1...management-api-v0.12.2) (2026-04-27)


### 🐛 Bug Fixes

* ship web console with binary upgrades ([c96e44a](https://github.com/zuohuadong/supacloud/commit/c96e44a17aa88948498cbdab7743c1d834a4ba8b))

## [0.12.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.12.0...management-api-v0.12.1) (2026-04-27)


### 🐛 Bug Fixes

* stabilize edge runtime under binary upgrades ([428453a](https://github.com/zuohuadong/supacloud/commit/428453a0fa15a0cf77e3e7db3939f766ad94cbcb))

## [0.12.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.7...management-api-v0.12.0) (2026-04-27)


### 🚀 Features

* add queue client api ([1463b8d](https://github.com/zuohuadong/supacloud/commit/1463b8db899c0762e680b3ed1894dfbd5e1463df))
* improve database sql cli workflows ([1d1ac83](https://github.com/zuohuadong/supacloud/commit/1d1ac83d7518f223e048b8caedd1420460b1e70e))


### 🐛 Bug Fixes

* publish background tasks for realtime ([16582be](https://github.com/zuohuadong/supacloud/commit/16582be1fe7f0a74ea94a31af1d5d0ee526b991e))
* skip missing tenant dbs during realtime reconcile ([300ce92](https://github.com/zuohuadong/supacloud/commit/300ce923eea65e21a280e29954f58a3d4945aa98))


### 💅 Elegance & Refactoring

* remove legacy sql result alias ([3565c00](https://github.com/zuohuadong/supacloud/commit/3565c00f197a35e129785cce299ee48b9f91f7b8))

## [0.11.7](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.6...management-api-v0.11.7) (2026-04-27)


### 🐛 Bug Fixes

* allow supacloud async cors headers ([b27af99](https://github.com/zuohuadong/supacloud/commit/b27af995e9e4ff209df63b72652ca18d25186217))
* materialize juicefs upload streams ([4378f9c](https://github.com/zuohuadong/supacloud/commit/4378f9cab99e9c11f8714a82232de71f7c82a8da))
* materialize storage upload streams ([a55ba02](https://github.com/zuohuadong/supacloud/commit/a55ba02b6735b3df92971d79ede6da01706a92a6))

## [0.11.6](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.5...management-api-v0.11.6) (2026-04-27)


### 🐛 Bug Fixes

* extend rest proxy timeout ([716839d](https://github.com/zuohuadong/supacloud/commit/716839db4170023e7f4f2044fd9318ac4f84f7b7))

## [0.11.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.4...management-api-v0.11.5) (2026-04-27)


### 🐛 Bug Fixes

* make production upgrades binary-first ([08e9046](https://github.com/zuohuadong/supacloud/commit/08e9046aa2f91def72b2a8796aa1aeb719240f66))
* support github proxies for binary upgrades ([598269c](https://github.com/zuohuadong/supacloud/commit/598269c26e9a04ea1c7c5dd543c13206c58e5f9d))

## [0.11.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.3...management-api-v0.11.4) (2026-04-25)


### 🐛 Bug Fixes

* **cli:** push migrations through management API ([cee9927](https://github.com/zuohuadong/supacloud/commit/cee9927d29cb0ef514ae5a33080e6cf1c74bdecc))
* **cli:** push migrations via management api ([5b06fa2](https://github.com/zuohuadong/supacloud/commit/5b06fa249802335fbb3c4e77d3f5cefe8c4336b8))

## [0.11.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.2...management-api-v0.11.3) (2026-04-24)


### 🐛 Bug Fixes

* harden realtime tasks and data-plane boundaries ([f6bdfd1](https://github.com/zuohuadong/supacloud/commit/f6bdfd1b92d501507e27ad6ed73ecd3b46cc3e97))
* **management-api:** default to port 9090 ([c842879](https://github.com/zuohuadong/supacloud/commit/c842879db34f256651c0845ce70b6f1c7640f329))

## [0.11.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.1...management-api-v0.11.2) (2026-04-23)


### 🐛 Bug Fixes

* **auth:** accept project service role on management routes ([eac98e5](https://github.com/zuohuadong/supacloud/commit/eac98e557450e997bf2f4a41146f9deaf1230c90))

## [0.11.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.11.0...management-api-v0.11.1) (2026-04-23)


### 🐛 Bug Fixes

* **functions:** harden runtime routing and diagnostics ([41bade2](https://github.com/zuohuadong/supacloud/commit/41bade2ccef44f581aa1a6c6d0678f912084b6c0))
* **queue:** keep edge functions on dedicated worker ([693b1e3](https://github.com/zuohuadong/supacloud/commit/693b1e30274f426cadb9638ff96b9dba87b98361))

## [0.11.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.5...management-api-v0.11.0) (2026-04-23)


### 🚀 Features

* **self-host:** add PG18 compose stack and refresh tenant env ([d865bdb](https://github.com/zuohuadong/supacloud/commit/d865bdb96b29ec8abdea6a0e93190d0cbd7d8371))


### 🐛 Bug Fixes

* **storage:** stream large uploads through kong ([5001aa0](https://github.com/zuohuadong/supacloud/commit/5001aa0ddfb3e8556d5d03d155d677986376a962))
* **web-console:** restore settings and task management UI ([3f7ef75](https://github.com/zuohuadong/supacloud/commit/3f7ef756f3e151a9678f998d8e638f324ab7f77a))

## [0.10.5](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.4...management-api-v0.10.5) (2026-04-20)


### 🐛 Bug Fixes

* **queue:** migrate foundation worker to stable pg-listen ([fa90fe3](https://github.com/zuohuadong/supacloud/commit/fa90fe3e27238a0f9f79beaa8e881e78ea631c0e))


### 💅 Elegance & Refactoring

* **queue:** remove legacy pg-listen implementation ([9707808](https://github.com/zuohuadong/supacloud/commit/9707808c945d214f0f9477df2bfc31d4ce83840e))

## [0.10.4](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.3...management-api-v0.10.4) (2026-04-19)


### 🐛 Bug Fixes

* **management-api:** set duplex on sdk-proxy test requests ([80f852d](https://github.com/zuohuadong/supacloud/commit/80f852d709294204bb502d537ceaf5ec5f86cf1c))


### 🔧 Miscellaneous Chores

* release main ([239aea7](https://github.com/zuohuadong/supacloud/commit/239aea7e22bae05cc3c7840bc6c0fd7b322a8862))
* release main ([8d020be](https://github.com/zuohuadong/supacloud/commit/8d020be4e8d374f0cf0498a97e4beb6a88e57fb0))

## [0.10.3](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.2...management-api-v0.10.3) (2026-04-19)


### 🐛 Bug Fixes

* **management-api:** harden sdk proxy unit test isolation ([4a5fd35](https://github.com/zuohuadong/supacloud/commit/4a5fd353ad8c25003c2f37d8c582c682c2acf81c))

## [0.10.2](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.1...management-api-v0.10.2) (2026-04-19)


### 🐛 Bug Fixes

* **edge-runtime:** keep embedded child restarting ([7ca588a](https://github.com/zuohuadong/supacloud/commit/7ca588ad211c28c3f7ddff9b550d3fdb304d1feb))
* **realtime:** connect tenants with admin database credentials ([e1ae210](https://github.com/zuohuadong/supacloud/commit/e1ae210134942c04d4d5a4dbdc6d46e6f154d245))
* **realtime:** proxy websocket traffic via management ws ([de062c0](https://github.com/zuohuadong/supacloud/commit/de062c08bd543c5867f2fe592f815ea735c8bb95))
* **realtime:** reconcile missing tenants and use valid enc key ([5cc41df](https://github.com/zuohuadong/supacloud/commit/5cc41df549ca6a8ee18bd06a7d090d4ebaa41738))
* **realtime:** reconcile tenant schema privileges ([f2dc5b7](https://github.com/zuohuadong/supacloud/commit/f2dc5b703dd9c7b64041af07e419c8f42e5a2c24))
* **realtime:** route websocket through root proxy ([73f6501](https://github.com/zuohuadong/supacloud/commit/73f6501f2fd4b5653752767dcb57b14623e9ad51))
* **realtime:** sign tenant reconcile admin tokens correctly ([03c3207](https://github.com/zuohuadong/supacloud/commit/03c320787b1bdaef0ef05de81a5f350108d0fd7f))
* **realtime:** use node crypto for admin JWT signing ([601e951](https://github.com/zuohuadong/supacloud/commit/601e951d76548131b02404319c68d4224a627df8))


### 🔧 Miscellaneous Chores

* **ts:** finish TypeScript 6 typecheck migration ([5e2ae90](https://github.com/zuohuadong/supacloud/commit/5e2ae9024cf356eb6892402a62bf4036b8ad00dc))

## [0.10.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.10.0...management-api-v0.10.1) (2026-04-18)


### 🐛 Bug Fixes

* **edge-runtime:** avoid double-managed runtime restarts ([5a27175](https://github.com/zuohuadong/supacloud/commit/5a271758fff9bbe008f8d8aade559e4d8dffab3e))
* **gateway:** preserve functions proxy path prefix ([f51bb1f](https://github.com/zuohuadong/supacloud/commit/f51bb1fa76be90ead2b065802650a14121f79b36))
* **proxy:** forward function POST bodies with duplex ([7784522](https://github.com/zuohuadong/supacloud/commit/7784522331003fd97ab04b62ace90035eb79d385))
* **routing:** unify tenant domain and port resolution ([5911e97](https://github.com/zuohuadong/supacloud/commit/5911e97cc39007ceea95a79b3c4b6d4db7a2b344))
* **tasks:** patch tenant queue schema compatibility ([370adfa](https://github.com/zuohuadong/supacloud/commit/370adfa6009dc72d956a47e3c69e9cda99acd7f0))


### 💅 Elegance & Refactoring

* **edge-functions:** migrate version artifacts into internal revisions ([e9c0890](https://github.com/zuohuadong/supacloud/commit/e9c0890013bb23b0189dd089c3e7d79507ee37b2))

## [0.10.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.9.1...management-api-v0.10.0) (2026-04-17)


### 🚀 Features

* **tasks:** deploy background task and message queue features to servers ([e66cdac](https://github.com/zuohuadong/supacloud/commit/e66cdac9c34f34990de5675ca75bfca9894cc3b4))
* updates and fixes based on recent local changes ([449c710](https://github.com/zuohuadong/supacloud/commit/449c71089721658d25737ac7df1c196b3bc9bb1d))


### 🐛 Bug Fixes

* **db:** remove index creation from ddlQuery to avoid execution failure on partial schema ([23a4546](https://github.com/zuohuadong/supacloud/commit/23a45468d6316b0550683e046560a6768e770890))
* **db:** use sql.unsafe for sequential DDL execution to prevent prepared statement errors ([5e255c6](https://github.com/zuohuadong/supacloud/commit/5e255c690358e91f76507f522b8490b3cad02083))
* **deps:** remove dredd, upgrade MCP SDK, override hono/path-to-regexp to eliminate 26 audit vulnerabilities ([695ef77](https://github.com/zuohuadong/supacloud/commit/695ef770b48f50174546f683294841da90e63223))
* **tasks:** avoid malformed array literal issue in unsafe sql binding for ANY() ([cb2630a](https://github.com/zuohuadong/supacloud/commit/cb2630aa89ed8b2910965682d2724e971582fe7f))

## [0.9.1](https://github.com/zuohuadong/supacloud/compare/management-api-v0.9.0...management-api-v0.9.1) (2026-04-14)


### 🐛 Bug Fixes

* **auth:** restore empty string fallback for OpenAPI enum compliance ([f62da87](https://github.com/zuohuadong/supacloud/commit/f62da87304c3526fe50cf1684ff115e2975fac11))
* **openapi:** satisfy strict schema enums and ref length requirements ([9f47811](https://github.com/zuohuadong/supacloud/commit/9f47811e8a834cced46e8946b620f233c41e2973))
* **openapi:** use predefined enums for missing auth config providers instead of empty strings ([b2ebf64](https://github.com/zuohuadong/supacloud/commit/b2ebf647f4bb69d90e9745e6a3c8435f52e3d310))


### 🔧 Miscellaneous Chores

* cleanup scratch files and commit modified files ([328a728](https://github.com/zuohuadong/supacloud/commit/328a7285b5956693105c7d1086338e53194cf013))

## [0.9.0](https://github.com/zuohuadong/supacloud/compare/management-api-v0.8.0...management-api-v0.9.0) (2026-04-14)


### 🚀 Features

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


### 🐛 Bug Fixes

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


### 💅 Elegance & Refactoring

* **api:** standardize error payload schemas across all routes for Stripe parity ([dc0955c](https://github.com/zuohuadong/supacloud/commit/dc0955ced1ca18264ee748a2d30f6c2e78c95f39))
* **auth:** use GoTrue magic link verification for miniprogram and upgrade edge fn syntax ([75c7dfd](https://github.com/zuohuadong/supacloud/commit/75c7dfd272ee2c9ca4f638a8493596c20a4ae4bf))
* complete legacy Deno/Bun runtime cleanup and migration ([174a0b1](https://github.com/zuohuadong/supacloud/commit/174a0b130aabd67df0e0f8b712087af8367749cf))
* **core:** use resolveDbName and parameterized queries for schema routing and postgres reflection ([4e493e7](https://github.com/zuohuadong/supacloud/commit/4e493e7b6779bf130a9ab2bacdd3c0639efe8c8a))
* **cors:** move CORS from edge functions to Angie gateway layer ([2ce8c41](https://github.com/zuohuadong/supacloud/commit/2ce8c41b3aa28db8a72ed3eab473e9b4d42484fc))
* eliminate all [@ts-ignore](https://github.com/ts-ignore), implement all TODOs, centralize remaining env ([514f1f0](https://github.com/zuohuadong/supacloud/commit/514f1f027c3cd73795f8bbda2861c43c470ab12b))
* eliminate technical debt — split projects.ts, centralize env vars, remove all any types ([13500d1](https://github.com/zuohuadong/supacloud/commit/13500d172805cfe3af14dac3f250de3550a8b7b0))
* **gateway:** complete migration to native Kong Gateway and remove legacy Angie ([e966862](https://github.com/zuohuadong/supacloud/commit/e966862ddea6504a35be2e454375cd591895c7ba))
* **gateway:** unify edge proxy to native kong rest api ([eb1a97a](https://github.com/zuohuadong/supacloud/commit/eb1a97ab82b9a6deeb961e5a7c4ca4f87a79f192))
* **realtime:** revert native realtime and restore official docker integration ([42d7a78](https://github.com/zuohuadong/supacloud/commit/42d7a78d018f388098624b0d32cf9dd69483cdec))
* remove legacy Deno/Bun runtime switch, unify to Bun Edge Runtime ([393c688](https://github.com/zuohuadong/supacloud/commit/393c688cf7591fdab124e498d59af64e751ac37b))
* remove legacy supabase-vector/auth container deps, fix ASSETS null guard ([4bb0323](https://github.com/zuohuadong/supacloud/commit/4bb032334fea13bc09eb99042100c14d6bab1ba9))
* split frontend.service.ts + eliminate all process.env from services ([60d5dcd](https://github.com/zuohuadong/supacloud/commit/60d5dcd525877b2ab38a457563246eb277fb54a6))
* split OAuth service from tenant-runtime ([c46cf62](https://github.com/zuohuadong/supacloud/commit/c46cf6293a8bc41bbabe22379510830b81f935c2))
* split project.service.ts, implement cluster module, S3 ops ([767e221](https://github.com/zuohuadong/supacloud/commit/767e22198a64da17bb5a286da41f2fc10c79f262))
* **web-console:** finalize AutoTable hybrid migration for auth and tables pages ([209608b](https://github.com/zuohuadong/supacloud/commit/209608b1f53e2cefb3f1b39dd33614c70b83ab34))


### ⚡ Performance Improvements

* **api:** implement O(1) memory caching and pre-compression for static assets ([a0bd52e](https://github.com/zuohuadong/supacloud/commit/a0bd52e426a619324c7aa6bb07cc7a18e20e8138))
* replace node:fs legacy I/O with fully-optimized Bun native APIs across the project ([4bc99c8](https://github.com/zuohuadong/supacloud/commit/4bc99c84173c1859cb3a095c2d007c343fdbc754))


### 🔧 Miscellaneous Chores

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
