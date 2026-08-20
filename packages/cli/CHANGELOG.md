# Changelog

## Unreleased

### Features

* **cli:** add atomic named and explicit environment profiles with secret-safe status output
* **cli:** add immutable frontend release upload, activation, and authoritative readback
* **functions:** deploy caller-hash-bound prebuilt runtime artifacts without rebundling

### Bug Fixes

* **cli:** fail closed for production and read-only writes, and require exact production confirmation
* **functions:** bound release mutation response reads and report uncertain outcomes without response content
* **cli:** honor explicit project refs consistently while preventing production cross-ref writes

## [0.33.0](https://github.com/vibeunion/supacloud/compare/cli-v0.32.0...cli-v0.33.0) (2026-08-20)


### Features

* **cli:** support SupaCloud Lite commands ([92545ae](https://github.com/vibeunion/supacloud/commit/92545ae4181ae9b9e971f663c78d96b1e6ac2a46))

## [0.32.0](https://github.com/vibeunion/supacloud/compare/cli-v0.31.0...cli-v0.32.0) (2026-08-20)


### Features

* **gateway:** support SPA fallback mode for custom static routes ([#1011](https://github.com/vibeunion/supacloud/issues/1011)) ([455bf23](https://github.com/vibeunion/supacloud/commit/455bf2348442b8c7fa3d2b3c76653ed5cd1fbc83))

## [0.31.0](https://github.com/vibeunion/supacloud/compare/cli-v0.30.0...cli-v0.31.0) (2026-08-19)


### Features

* **cli:** deploy self-contained function bundle directories ([#1004](https://github.com/vibeunion/supacloud/issues/1004)) ([d942a37](https://github.com/vibeunion/supacloud/commit/d942a37f65914e83cda5b2634351bb9a6976619b))
* **cli:** migrate project OAuth signing keys ([765d1de](https://github.com/vibeunion/supacloud/commit/765d1dead3ca9816a018487a7844292a37a493cb))
* **database:** harden migration safety and schema reloads ([#1000](https://github.com/vibeunion/supacloud/issues/1000)) ([dabebf8](https://github.com/vibeunion/supacloud/commit/dabebf8fddeaebc4fa5422959f9e631df7019cc1))

## [0.30.0](https://github.com/vibeunion/supacloud/compare/cli-v0.29.0...cli-v0.30.0) (2026-08-18)


### Features

* **cli:** add release canary fixture disable replay ([4734cb9](https://github.com/vibeunion/supacloud/commit/4734cb9b276133ffb170c18b9b8c384ab3b7cf5e))


### Bug Fixes

* **cli:** match release fixture pending RPC contract ([#974](https://github.com/vibeunion/supacloud/issues/974)) ([7b25b77](https://github.com/vibeunion/supacloud/commit/7b25b7754d15aeec3e5c06ed4eba8ed80d8d14c0))

## [0.29.0](https://github.com/vibeunion/supacloud/compare/cli-v0.28.1...cli-v0.29.0) (2026-08-18)


### Features

* **cli:** replay release canary fixture receipts ([821c6ec](https://github.com/vibeunion/supacloud/commit/821c6ec43298698ac44a86d1c311ef0a3f9fbe6f))

## [0.28.1](https://github.com/vibeunion/supacloud/compare/cli-v0.28.0...cli-v0.28.1) (2026-08-18)


### Bug Fixes

* **cli:** harden auth user and login link boundaries ([#961](https://github.com/vibeunion/supacloud/issues/961)) ([7319f2f](https://github.com/vibeunion/supacloud/commit/7319f2f4afd170af30f72c4a4df52cd478e45e0a))

## [0.28.0](https://github.com/vibeunion/supacloud/compare/cli-v0.27.0...cli-v0.28.0) (2026-08-18)


### Features

* **cli:** expose controlled auth user and login link lifecycle ([4effe92](https://github.com/vibeunion/supacloud/commit/4effe9204638b4aa1db82263acdbfa25468f1006))

## [0.27.0](https://github.com/vibeunion/supacloud/compare/cli-v0.26.0...cli-v0.27.0) (2026-08-18)


### Features

* **cli:** add authoritative project endpoint projection ([9fb670b](https://github.com/vibeunion/supacloud/commit/9fb670b0391149fe6da91a69f4132b40c75c0ef2))

## [0.26.0](https://github.com/vibeunion/supacloud/compare/cli-v0.25.0...cli-v0.26.0) (2026-08-18)


### Features

* **cli:** add release canary OAuth client controls ([8c928f3](https://github.com/vibeunion/supacloud/commit/8c928f39e1e4e195296f777589ada1548cbab080))

## [0.25.0](https://github.com/vibeunion/supacloud/compare/cli-v0.24.0...cli-v0.25.0) (2026-08-18)


### Features

* **cli:** add project recovery controls ([723f3d1](https://github.com/vibeunion/supacloud/commit/723f3d16690225462d79c80b30e5e580b8142531))

## [0.24.0](https://github.com/vibeunion/supacloud/compare/cli-v0.23.0...cli-v0.24.0) (2026-08-17)


### Features

* **cli:** add verified logical backup restore ([d9dd65f](https://github.com/vibeunion/supacloud/commit/d9dd65f1381b2ced1e5f508fd326c3429feadb75))

## [0.23.0](https://github.com/vibeunion/supacloud/compare/cli-v0.22.1...cli-v0.23.0) (2026-08-17)


### Features

* **cli:** add verified release controls ([#937](https://github.com/vibeunion/supacloud/issues/937)) ([d6012c8](https://github.com/vibeunion/supacloud/commit/d6012c8d86afeea2651bfe5856c4ce121b82f9c8))

## [0.22.1](https://github.com/vibeunion/supacloud/compare/cli-v0.22.0...cli-v0.22.1) (2026-08-16)


### Miscellaneous Chores

* migrate repository references to vibeunion org ([#933](https://github.com/vibeunion/supacloud/issues/933)) ([642e14f](https://github.com/vibeunion/supacloud/commit/642e14fa6284be97ab6e964d726f9ffcf7ebf4af))

## [0.22.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.21.4...cli-v0.22.0) (2026-08-13)


### Features

* **cli:** add migration inventory action ([#824](https://github.com/zuohuadong/supacloud/issues/824)) ([d5d81b1](https://github.com/zuohuadong/supacloud/commit/d5d81b1145d4d80ac65adcd2c472785887d42686))
* **cli:** add multi-environment env profiles ([#803](https://github.com/zuohuadong/supacloud/issues/803)) ([e2b98e4](https://github.com/zuohuadong/supacloud/commit/e2b98e4ae993e5ce234eef2184ab3638c1244919))
* **cli:** add scheduled function revision CAS ([eaa84f3](https://github.com/zuohuadong/supacloud/commit/eaa84f3f66bebc707a75eecad6e66870989ec398))
* **cli:** add storage bucket lifecycle ([#822](https://github.com/zuohuadong/supacloud/issues/822)) ([e4c9b4c](https://github.com/zuohuadong/supacloud/commit/e4c9b4c8998a1149a527d38c277bf3d77f0f7572))
* **cli:** expose installed package version ([#816](https://github.com/zuohuadong/supacloud/issues/816)) ([9081fda](https://github.com/zuohuadong/supacloud/commit/9081fdabd8cac373cb87d6d39226c42a20e424ea))
* **cli:** load project secrets from environment ([#806](https://github.com/zuohuadong/supacloud/issues/806)) ([f3952e0](https://github.com/zuohuadong/supacloud/commit/f3952e003cd26f87419eec69a43127095ad13908))
* extend Supabase-compatible platform capabilities ([adef019](https://github.com/zuohuadong/supacloud/commit/adef019261f82f123043ab4c7a047e6ad6956e56))
* **functions:** add active version concurrency control ([7a7e8b9](https://github.com/zuohuadong/supacloud/commit/7a7e8b95cb1e4001765f40302cb5ddbb7b6db372))
* **functions:** deploy exact prebuilt artifacts ([bd3ccf8](https://github.com/zuohuadong/supacloud/commit/bd3ccf853397fd5768a6d54d3885ad8b97c2c403))
* **gateway:** add managed functions upstream ([a3f8f74](https://github.com/zuohuadong/supacloud/commit/a3f8f744dc4056d50eb70826b298e0e90a861408))
* **platform:** add durable project mutation journal ([#854](https://github.com/zuohuadong/supacloud/issues/854)) ([4dc089c](https://github.com/zuohuadong/supacloud/commit/4dc089c82ac31e7c3e33953f24552b98e2470012))
* **runtime:** attest canonical activations ([#868](https://github.com/zuohuadong/supacloud/issues/868)) ([636433e](https://github.com/zuohuadong/supacloud/commit/636433e1dbaaac04ae8d842d858b647a1667b0ce))
* **storage:** add bucket revision CAS ([15f18b0](https://github.com/zuohuadong/supacloud/commit/15f18b08b763b319ebd09efcc7af45deee269044))


### Bug Fixes

* address release-blocking review findings ([0154fdb](https://github.com/zuohuadong/supacloud/commit/0154fdbab758c9d9c6a80fb877b15848a5ace5df))
* **admin:** support project create domain flags ([#800](https://github.com/zuohuadong/supacloud/issues/800)) ([c47e19c](https://github.com/zuohuadong/supacloud/commit/c47e19c88e1efcaa9864e1902f47a24be22c92ee))
* baseline migrations through authorized ledger API ([5cb9518](https://github.com/zuohuadong/supacloud/commit/5cb9518b9eccce5501acd79c65784a0f9ca879d4))
* **cli:** bind legacy migration identities to content ([#876](https://github.com/zuohuadong/supacloud/issues/876)) ([14a7bd0](https://github.com/zuohuadong/supacloud/commit/14a7bd03fbdc88c73fa8a6d87eb563598c972f71))
* **cli:** bind migration pushes to remote content ([#881](https://github.com/zuohuadong/supacloud/issues/881)) ([20d6fc2](https://github.com/zuohuadong/supacloud/commit/20d6fc23adb098a6f4647a96789b2e3d43f633eb))
* **cli:** block release writes in read-only mode ([d49aa43](https://github.com/zuohuadong/supacloud/commit/d49aa4388011dafb0e143d54536bbc643040cfea))
* **cli:** bound release mutation response reads ([#842](https://github.com/zuohuadong/supacloud/issues/842)) ([265d9f5](https://github.com/zuohuadong/supacloud/commit/265d9f5473d222dc561c3d591d683c166278cb59))
* **cli:** fail early on migration identity conflicts ([978462c](https://github.com/zuohuadong/supacloud/commit/978462c7aaf5f88719907c344a96b7b6939cb4ef))
* **cli:** harden environment secret boundaries ([#815](https://github.com/zuohuadong/supacloud/issues/815)) ([f62b21d](https://github.com/zuohuadong/supacloud/commit/f62b21daaa2d591f5d887439bededa9977db3312))
* **cli:** harden project read responses ([#861](https://github.com/zuohuadong/supacloud/issues/861)) ([923f145](https://github.com/zuohuadong/supacloud/commit/923f14587ed58b091704436abc66fc3197f5cf46))
* **cli:** keep version command standalone ([#818](https://github.com/zuohuadong/supacloud/issues/818)) ([419d212](https://github.com/zuohuadong/supacloud/commit/419d212386be2076358ad39579f1c862fe81a311))
* **cli:** order and validate migration versions ([9e07e2f](https://github.com/zuohuadong/supacloud/commit/9e07e2fa4ca9c026621fccc5d79c62b0352884d9))
* **cli:** preserve auth mutation failure contract ([#807](https://github.com/zuohuadong/supacloud/issues/807)) ([34d9e01](https://github.com/zuohuadong/supacloud/commit/34d9e01cec1314b9a76650ca1910809f464fe185))
* **cli:** preserve migration version identity ([2a11d53](https://github.com/zuohuadong/supacloud/commit/2a11d5355c43badb7839dcb5e4011aea8703624f))
* **cli:** probe application profiles through data API ([#855](https://github.com/zuohuadong/supacloud/issues/855)) ([c25ff09](https://github.com/zuohuadong/supacloud/commit/c25ff097344ff10b3adaf73b5b941e9642bed9bf))
* **cli:** read legacy scheduled function metadata ([#870](https://github.com/zuohuadong/supacloud/issues/870)) ([9e32501](https://github.com/zuohuadong/supacloud/commit/9e32501f75b59bab2d39eaaa30ea2a3f25b79aec))
* **cli:** recognize direct-apply migration markers ([#530](https://github.com/zuohuadong/supacloud/issues/530)) ([33f433d](https://github.com/zuohuadong/supacloud/commit/33f433d5e4e1d132dd50a8b1d312f0485119bee0))
* **cli:** recognize historical migration hash markers ([a9d55ff](https://github.com/zuohuadong/supacloud/commit/a9d55ff8cce32d475ba4e270ae1c6acaf1929737))
* **cli:** recognize historical migration hash markers ([b372e25](https://github.com/zuohuadong/supacloud/commit/b372e25073bc2ae54578365b524784e41610a010))
* **cli:** redact database mutation failures ([#883](https://github.com/zuohuadong/supacloud/issues/883)) ([8193fe3](https://github.com/zuohuadong/supacloud/commit/8193fe3d42613d55c3df56df7360614d6fe53999))
* **cli:** require atomic function policy receipts ([#797](https://github.com/zuohuadong/supacloud/issues/797)) ([a8c5c52](https://github.com/zuohuadong/supacloud/commit/a8c5c52e63224d5fa8c7fe4a8914c3432358236c))
* **cli:** skip explicit baseline migration markers ([7254552](https://github.com/zuohuadong/supacloud/commit/725455278446582663750097dd870609b36f56c1))
* **cli:** skip explicit baseline migration markers ([756f7ec](https://github.com/zuohuadong/supacloud/commit/756f7ec20702905fe874b93f411e1bb69e6e3a30))
* **edge-functions:** align CLI bundles with runtime policy ([#745](https://github.com/zuohuadong/supacloud/issues/745)) ([1ee2f94](https://github.com/zuohuadong/supacloud/commit/1ee2f94752efb0855a1528bd0049c733ae4cc6e5))
* **functions:** activate code and jwt policy atomically ([447bbf5](https://github.com/zuohuadong/supacloud/commit/447bbf5e1f44651bfb790e54af502a7536b4a52c))
* **functions:** activate code and JWT policy atomically ([c6c5fa9](https://github.com/zuohuadong/supacloud/commit/c6c5fa95aeea7dd09a53de196a98a540622a6d59))
* **functions:** support legacy v0 CAS and readback ([5ee1b8b](https://github.com/zuohuadong/supacloud/commit/5ee1b8b5ec5f7177839cb22d497156e93bca589a))
* **management:** disable external mutation reconciliation ([#864](https://github.com/zuohuadong/supacloud/issues/864)) ([c8a2ad1](https://github.com/zuohuadong/supacloud/commit/c8a2ad1de949d7b8b9caf5074e42212a4942f866))
* **migrations:** preserve transactional migration compatibility ([#520](https://github.com/zuohuadong/supacloud/issues/520)) ([360b6cb](https://github.com/zuohuadong/supacloud/commit/360b6cb2222e094dc8539a953503c2d03f4154a5))
* **platform:** baseline migrations through authorized ledger route ([d494cca](https://github.com/zuohuadong/supacloud/commit/d494cca0d80573ff904d37a08ed72e11f10bb46b))
* **platform:** harden durable project mutations ([#863](https://github.com/zuohuadong/supacloud/issues/863)) ([b59867c](https://github.com/zuohuadong/supacloud/commit/b59867c249fa8c25756149c7cb06c06f15217abf))


### Miscellaneous Chores

* release main ([48db1e2](https://github.com/zuohuadong/supacloud/commit/48db1e2df3cffe2fa70b730dff957bc2539d6617))
* release main ([fac53ca](https://github.com/zuohuadong/supacloud/commit/fac53ca02906676502cded4620b47a05465a7c5d))
* release main ([00bf23d](https://github.com/zuohuadong/supacloud/commit/00bf23d2c371b4ba4ddb31f20bb289c769848e06))
* release main ([4030977](https://github.com/zuohuadong/supacloud/commit/4030977d61182b07e36755e367575859c475b862))
* release main ([7509029](https://github.com/zuohuadong/supacloud/commit/7509029e27b3656885c1dccf55ed2f990f4b8e95))
* release main ([975702e](https://github.com/zuohuadong/supacloud/commit/975702e1a8e2c99fc242692a0027645912355c96))
* release main ([2b9f9c6](https://github.com/zuohuadong/supacloud/commit/2b9f9c6c82f1ff31b838f56a51d78f8924d4b627))
* release main ([84f6bc4](https://github.com/zuohuadong/supacloud/commit/84f6bc41795c4602b86a2552ca47c74a0d9337b9))
* release main ([256ce28](https://github.com/zuohuadong/supacloud/commit/256ce289a17fc2187b4bca7080d619d6e7512eda))
* release main ([5833a36](https://github.com/zuohuadong/supacloud/commit/5833a36b277b5fa5e26482d39c14bd7bb5d2d4f6))
* release main ([1c87f14](https://github.com/zuohuadong/supacloud/commit/1c87f14afda9f662cbbe9cee82eb515bd1462b81))
* release main ([#521](https://github.com/zuohuadong/supacloud/issues/521)) ([1230bf3](https://github.com/zuohuadong/supacloud/commit/1230bf3a6d1db6885c67da140d4ef318ec8cdec3))
* release main ([#617](https://github.com/zuohuadong/supacloud/issues/617)) ([45e6527](https://github.com/zuohuadong/supacloud/commit/45e6527d49329903237a6298bfefce27ed1466d4))
* release main ([#629](https://github.com/zuohuadong/supacloud/issues/629)) ([c58c4a4](https://github.com/zuohuadong/supacloud/commit/c58c4a41a1c6719a5e17a0f2c8f7ce2cff9951af))
* release main ([#641](https://github.com/zuohuadong/supacloud/issues/641)) ([80c6b6b](https://github.com/zuohuadong/supacloud/commit/80c6b6be2ac968869c52b180e6c9fdc8a8b816bf))
* release main ([#746](https://github.com/zuohuadong/supacloud/issues/746)) ([216dd76](https://github.com/zuohuadong/supacloud/commit/216dd76ea36c521ebad31356ba0924be5626a924))
* release main ([#796](https://github.com/zuohuadong/supacloud/issues/796)) ([f336cc1](https://github.com/zuohuadong/supacloud/commit/f336cc1443a4159b242ed754a8410e0403c2f132))
* release main ([#801](https://github.com/zuohuadong/supacloud/issues/801)) ([d88ef58](https://github.com/zuohuadong/supacloud/commit/d88ef587c283b40e7290fbbb47e3495fdd1c16c0))
* release main ([#814](https://github.com/zuohuadong/supacloud/issues/814)) ([5e99377](https://github.com/zuohuadong/supacloud/commit/5e99377cc1cb8fa2e48565c2fc551d03131914b0))
* release main ([#823](https://github.com/zuohuadong/supacloud/issues/823)) ([80fd010](https://github.com/zuohuadong/supacloud/commit/80fd01015ff3008c4ccd83d4d8b8efd125cda48c))
* release main ([#835](https://github.com/zuohuadong/supacloud/issues/835)) ([4d8348a](https://github.com/zuohuadong/supacloud/commit/4d8348a6bfc4779edfc6c2a7eec60bc4e0383ddb))
* release main ([#841](https://github.com/zuohuadong/supacloud/issues/841)) ([83a0367](https://github.com/zuohuadong/supacloud/commit/83a03676f5d2334523c8c52d646e875467256b10))
* release main ([#858](https://github.com/zuohuadong/supacloud/issues/858)) ([7cd1d59](https://github.com/zuohuadong/supacloud/commit/7cd1d59a743a01d385020cdbec6b6af41534a276))
* release main ([#862](https://github.com/zuohuadong/supacloud/issues/862)) ([8b745af](https://github.com/zuohuadong/supacloud/commit/8b745af77c4d36d49bec57e4b13f57cf65e6a795))
* release main ([#865](https://github.com/zuohuadong/supacloud/issues/865)) ([78ef6b1](https://github.com/zuohuadong/supacloud/commit/78ef6b1a13c5582cb91ed81d2c4d4ff658342bb9))
* release main ([#867](https://github.com/zuohuadong/supacloud/issues/867)) ([42ea8f3](https://github.com/zuohuadong/supacloud/commit/42ea8f3d3ee33197abb5b2e931f0ea299006c7e6))
* release main ([#872](https://github.com/zuohuadong/supacloud/issues/872)) ([65a97e0](https://github.com/zuohuadong/supacloud/commit/65a97e03e23b64c81894c3fa8d5ba6f701007a79))
* release main ([#877](https://github.com/zuohuadong/supacloud/issues/877)) ([362efa0](https://github.com/zuohuadong/supacloud/commit/362efa060559231f55ca78672ee06cb32afd1611))
* release main ([#882](https://github.com/zuohuadong/supacloud/issues/882)) ([85d7e8e](https://github.com/zuohuadong/supacloud/commit/85d7e8e070e0d6aad75ad17c0ab859dda47bcc81))
* release main ([#888](https://github.com/zuohuadong/supacloud/issues/888)) ([00c5417](https://github.com/zuohuadong/supacloud/commit/00c5417a8b3d95931299ad4ec94fffc201329cac))

## [0.21.4](https://github.com/zuohuadong/supacloud/compare/cli-v0.21.3...cli-v0.21.4) (2026-08-12)


### Bug Fixes

* **cli:** redact database mutation failures ([#883](https://github.com/zuohuadong/supacloud/issues/883)) ([8193fe3](https://github.com/zuohuadong/supacloud/commit/8193fe3d42613d55c3df56df7360614d6fe53999))

## [0.21.3](https://github.com/zuohuadong/supacloud/compare/cli-v0.21.2...cli-v0.21.3) (2026-08-12)


### Bug Fixes

* **cli:** bind migration pushes to remote content ([#881](https://github.com/zuohuadong/supacloud/issues/881)) ([20d6fc2](https://github.com/zuohuadong/supacloud/commit/20d6fc23adb098a6f4647a96789b2e3d43f633eb))

## [0.21.2](https://github.com/zuohuadong/supacloud/compare/cli-v0.21.1...cli-v0.21.2) (2026-08-12)


### Bug Fixes

* **cli:** bind legacy migration identities to content ([#876](https://github.com/zuohuadong/supacloud/issues/876)) ([14a7bd0](https://github.com/zuohuadong/supacloud/commit/14a7bd03fbdc88c73fa8a6d87eb563598c972f71))

## [0.21.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.21.0...cli-v0.21.1) (2026-08-12)


### Bug Fixes

* **cli:** read legacy scheduled function metadata ([#870](https://github.com/zuohuadong/supacloud/issues/870)) ([9e32501](https://github.com/zuohuadong/supacloud/commit/9e32501f75b59bab2d39eaaa30ea2a3f25b79aec))

## [0.21.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.20.0...cli-v0.21.0) (2026-08-12)


### Features

* **runtime:** attest canonical activations ([#868](https://github.com/zuohuadong/supacloud/issues/868)) ([636433e](https://github.com/zuohuadong/supacloud/commit/636433e1dbaaac04ae8d842d858b647a1667b0ce))

## [0.20.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.19.1...cli-v0.20.0) (2026-08-12)


### Features

* **cli:** add migration inventory action ([#824](https://github.com/zuohuadong/supacloud/issues/824)) ([d5d81b1](https://github.com/zuohuadong/supacloud/commit/d5d81b1145d4d80ac65adcd2c472785887d42686))
* **cli:** add multi-environment env profiles ([#803](https://github.com/zuohuadong/supacloud/issues/803)) ([e2b98e4](https://github.com/zuohuadong/supacloud/commit/e2b98e4ae993e5ce234eef2184ab3638c1244919))
* **cli:** add scheduled function revision CAS ([eaa84f3](https://github.com/zuohuadong/supacloud/commit/eaa84f3f66bebc707a75eecad6e66870989ec398))
* **cli:** add storage bucket lifecycle ([#822](https://github.com/zuohuadong/supacloud/issues/822)) ([e4c9b4c](https://github.com/zuohuadong/supacloud/commit/e4c9b4c8998a1149a527d38c277bf3d77f0f7572))
* **cli:** expose installed package version ([#816](https://github.com/zuohuadong/supacloud/issues/816)) ([9081fda](https://github.com/zuohuadong/supacloud/commit/9081fdabd8cac373cb87d6d39226c42a20e424ea))
* **cli:** load project secrets from environment ([#806](https://github.com/zuohuadong/supacloud/issues/806)) ([f3952e0](https://github.com/zuohuadong/supacloud/commit/f3952e003cd26f87419eec69a43127095ad13908))
* extend Supabase-compatible platform capabilities ([adef019](https://github.com/zuohuadong/supacloud/commit/adef019261f82f123043ab4c7a047e6ad6956e56))
* **functions:** add active version concurrency control ([7a7e8b9](https://github.com/zuohuadong/supacloud/commit/7a7e8b95cb1e4001765f40302cb5ddbb7b6db372))
* **functions:** deploy exact prebuilt artifacts ([bd3ccf8](https://github.com/zuohuadong/supacloud/commit/bd3ccf853397fd5768a6d54d3885ad8b97c2c403))
* **gateway:** add managed functions upstream ([a3f8f74](https://github.com/zuohuadong/supacloud/commit/a3f8f744dc4056d50eb70826b298e0e90a861408))
* **platform:** add durable project mutation journal ([#854](https://github.com/zuohuadong/supacloud/issues/854)) ([4dc089c](https://github.com/zuohuadong/supacloud/commit/4dc089c82ac31e7c3e33953f24552b98e2470012))
* **storage:** add bucket revision CAS ([15f18b0](https://github.com/zuohuadong/supacloud/commit/15f18b08b763b319ebd09efcc7af45deee269044))


### Bug Fixes

* address release-blocking review findings ([0154fdb](https://github.com/zuohuadong/supacloud/commit/0154fdbab758c9d9c6a80fb877b15848a5ace5df))
* **admin:** support project create domain flags ([#800](https://github.com/zuohuadong/supacloud/issues/800)) ([c47e19c](https://github.com/zuohuadong/supacloud/commit/c47e19c88e1efcaa9864e1902f47a24be22c92ee))
* baseline migrations through authorized ledger API ([5cb9518](https://github.com/zuohuadong/supacloud/commit/5cb9518b9eccce5501acd79c65784a0f9ca879d4))
* **cli:** block release writes in read-only mode ([d49aa43](https://github.com/zuohuadong/supacloud/commit/d49aa4388011dafb0e143d54536bbc643040cfea))
* **cli:** bound release mutation response reads ([#842](https://github.com/zuohuadong/supacloud/issues/842)) ([265d9f5](https://github.com/zuohuadong/supacloud/commit/265d9f5473d222dc561c3d591d683c166278cb59))
* **cli:** fail early on migration identity conflicts ([978462c](https://github.com/zuohuadong/supacloud/commit/978462c7aaf5f88719907c344a96b7b6939cb4ef))
* **cli:** harden environment secret boundaries ([#815](https://github.com/zuohuadong/supacloud/issues/815)) ([f62b21d](https://github.com/zuohuadong/supacloud/commit/f62b21daaa2d591f5d887439bededa9977db3312))
* **cli:** harden project read responses ([#861](https://github.com/zuohuadong/supacloud/issues/861)) ([923f145](https://github.com/zuohuadong/supacloud/commit/923f14587ed58b091704436abc66fc3197f5cf46))
* **cli:** keep version command standalone ([#818](https://github.com/zuohuadong/supacloud/issues/818)) ([419d212](https://github.com/zuohuadong/supacloud/commit/419d212386be2076358ad39579f1c862fe81a311))
* **cli:** order and validate migration versions ([9e07e2f](https://github.com/zuohuadong/supacloud/commit/9e07e2fa4ca9c026621fccc5d79c62b0352884d9))
* **cli:** preserve auth mutation failure contract ([#807](https://github.com/zuohuadong/supacloud/issues/807)) ([34d9e01](https://github.com/zuohuadong/supacloud/commit/34d9e01cec1314b9a76650ca1910809f464fe185))
* **cli:** preserve migration version identity ([2a11d53](https://github.com/zuohuadong/supacloud/commit/2a11d5355c43badb7839dcb5e4011aea8703624f))
* **cli:** probe application profiles through data API ([#855](https://github.com/zuohuadong/supacloud/issues/855)) ([c25ff09](https://github.com/zuohuadong/supacloud/commit/c25ff097344ff10b3adaf73b5b941e9642bed9bf))
* **cli:** recognize direct-apply migration markers ([#530](https://github.com/zuohuadong/supacloud/issues/530)) ([33f433d](https://github.com/zuohuadong/supacloud/commit/33f433d5e4e1d132dd50a8b1d312f0485119bee0))
* **cli:** recognize historical migration hash markers ([a9d55ff](https://github.com/zuohuadong/supacloud/commit/a9d55ff8cce32d475ba4e270ae1c6acaf1929737))
* **cli:** recognize historical migration hash markers ([b372e25](https://github.com/zuohuadong/supacloud/commit/b372e25073bc2ae54578365b524784e41610a010))
* **cli:** require atomic function policy receipts ([#797](https://github.com/zuohuadong/supacloud/issues/797)) ([a8c5c52](https://github.com/zuohuadong/supacloud/commit/a8c5c52e63224d5fa8c7fe4a8914c3432358236c))
* **cli:** skip explicit baseline migration markers ([7254552](https://github.com/zuohuadong/supacloud/commit/725455278446582663750097dd870609b36f56c1))
* **cli:** skip explicit baseline migration markers ([756f7ec](https://github.com/zuohuadong/supacloud/commit/756f7ec20702905fe874b93f411e1bb69e6e3a30))
* **edge-functions:** align CLI bundles with runtime policy ([#745](https://github.com/zuohuadong/supacloud/issues/745)) ([1ee2f94](https://github.com/zuohuadong/supacloud/commit/1ee2f94752efb0855a1528bd0049c733ae4cc6e5))
* **functions:** activate code and jwt policy atomically ([447bbf5](https://github.com/zuohuadong/supacloud/commit/447bbf5e1f44651bfb790e54af502a7536b4a52c))
* **functions:** activate code and JWT policy atomically ([c6c5fa9](https://github.com/zuohuadong/supacloud/commit/c6c5fa95aeea7dd09a53de196a98a540622a6d59))
* **functions:** support legacy v0 CAS and readback ([5ee1b8b](https://github.com/zuohuadong/supacloud/commit/5ee1b8b5ec5f7177839cb22d497156e93bca589a))
* **management:** disable external mutation reconciliation ([#864](https://github.com/zuohuadong/supacloud/issues/864)) ([c8a2ad1](https://github.com/zuohuadong/supacloud/commit/c8a2ad1de949d7b8b9caf5074e42212a4942f866))
* **migrations:** preserve transactional migration compatibility ([#520](https://github.com/zuohuadong/supacloud/issues/520)) ([360b6cb](https://github.com/zuohuadong/supacloud/commit/360b6cb2222e094dc8539a953503c2d03f4154a5))
* **platform:** baseline migrations through authorized ledger route ([d494cca](https://github.com/zuohuadong/supacloud/commit/d494cca0d80573ff904d37a08ed72e11f10bb46b))
* **platform:** harden durable project mutations ([#863](https://github.com/zuohuadong/supacloud/issues/863)) ([b59867c](https://github.com/zuohuadong/supacloud/commit/b59867c249fa8c25756149c7cb06c06f15217abf))


### Miscellaneous Chores

* release main ([48db1e2](https://github.com/zuohuadong/supacloud/commit/48db1e2df3cffe2fa70b730dff957bc2539d6617))
* release main ([fac53ca](https://github.com/zuohuadong/supacloud/commit/fac53ca02906676502cded4620b47a05465a7c5d))
* release main ([00bf23d](https://github.com/zuohuadong/supacloud/commit/00bf23d2c371b4ba4ddb31f20bb289c769848e06))
* release main ([4030977](https://github.com/zuohuadong/supacloud/commit/4030977d61182b07e36755e367575859c475b862))
* release main ([7509029](https://github.com/zuohuadong/supacloud/commit/7509029e27b3656885c1dccf55ed2f990f4b8e95))
* release main ([975702e](https://github.com/zuohuadong/supacloud/commit/975702e1a8e2c99fc242692a0027645912355c96))
* release main ([2b9f9c6](https://github.com/zuohuadong/supacloud/commit/2b9f9c6c82f1ff31b838f56a51d78f8924d4b627))
* release main ([84f6bc4](https://github.com/zuohuadong/supacloud/commit/84f6bc41795c4602b86a2552ca47c74a0d9337b9))
* release main ([256ce28](https://github.com/zuohuadong/supacloud/commit/256ce289a17fc2187b4bca7080d619d6e7512eda))
* release main ([5833a36](https://github.com/zuohuadong/supacloud/commit/5833a36b277b5fa5e26482d39c14bd7bb5d2d4f6))
* release main ([1c87f14](https://github.com/zuohuadong/supacloud/commit/1c87f14afda9f662cbbe9cee82eb515bd1462b81))
* release main ([#521](https://github.com/zuohuadong/supacloud/issues/521)) ([1230bf3](https://github.com/zuohuadong/supacloud/commit/1230bf3a6d1db6885c67da140d4ef318ec8cdec3))
* release main ([#617](https://github.com/zuohuadong/supacloud/issues/617)) ([45e6527](https://github.com/zuohuadong/supacloud/commit/45e6527d49329903237a6298bfefce27ed1466d4))
* release main ([#629](https://github.com/zuohuadong/supacloud/issues/629)) ([c58c4a4](https://github.com/zuohuadong/supacloud/commit/c58c4a41a1c6719a5e17a0f2c8f7ce2cff9951af))
* release main ([#641](https://github.com/zuohuadong/supacloud/issues/641)) ([80c6b6b](https://github.com/zuohuadong/supacloud/commit/80c6b6be2ac968869c52b180e6c9fdc8a8b816bf))
* release main ([#746](https://github.com/zuohuadong/supacloud/issues/746)) ([216dd76](https://github.com/zuohuadong/supacloud/commit/216dd76ea36c521ebad31356ba0924be5626a924))
* release main ([#796](https://github.com/zuohuadong/supacloud/issues/796)) ([f336cc1](https://github.com/zuohuadong/supacloud/commit/f336cc1443a4159b242ed754a8410e0403c2f132))
* release main ([#801](https://github.com/zuohuadong/supacloud/issues/801)) ([d88ef58](https://github.com/zuohuadong/supacloud/commit/d88ef587c283b40e7290fbbb47e3495fdd1c16c0))
* release main ([#814](https://github.com/zuohuadong/supacloud/issues/814)) ([5e99377](https://github.com/zuohuadong/supacloud/commit/5e99377cc1cb8fa2e48565c2fc551d03131914b0))
* release main ([#823](https://github.com/zuohuadong/supacloud/issues/823)) ([80fd010](https://github.com/zuohuadong/supacloud/commit/80fd01015ff3008c4ccd83d4d8b8efd125cda48c))
* release main ([#835](https://github.com/zuohuadong/supacloud/issues/835)) ([4d8348a](https://github.com/zuohuadong/supacloud/commit/4d8348a6bfc4779edfc6c2a7eec60bc4e0383ddb))
* release main ([#841](https://github.com/zuohuadong/supacloud/issues/841)) ([83a0367](https://github.com/zuohuadong/supacloud/commit/83a03676f5d2334523c8c52d646e875467256b10))
* release main ([#858](https://github.com/zuohuadong/supacloud/issues/858)) ([7cd1d59](https://github.com/zuohuadong/supacloud/commit/7cd1d59a743a01d385020cdbec6b6af41534a276))
* release main ([#862](https://github.com/zuohuadong/supacloud/issues/862)) ([8b745af](https://github.com/zuohuadong/supacloud/commit/8b745af77c4d36d49bec57e4b13f57cf65e6a795))

## [0.19.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.19.0...cli-v0.19.1) (2026-08-12)


### Bug Fixes

* **cli:** harden project read responses ([#861](https://github.com/zuohuadong/supacloud/issues/861)) ([923f145](https://github.com/zuohuadong/supacloud/commit/923f14587ed58b091704436abc66fc3197f5cf46))
* **platform:** harden durable project mutations ([#863](https://github.com/zuohuadong/supacloud/issues/863)) ([b59867c](https://github.com/zuohuadong/supacloud/commit/b59867c249fa8c25756149c7cb06c06f15217abf))

## [0.19.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.18.0...cli-v0.19.0) (2026-08-11)


### Features

* **platform:** add durable project mutation journal ([#854](https://github.com/zuohuadong/supacloud/issues/854)) ([4dc089c](https://github.com/zuohuadong/supacloud/commit/4dc089c82ac31e7c3e33953f24552b98e2470012))


### Bug Fixes

* **cli:** probe application profiles through data API ([#855](https://github.com/zuohuadong/supacloud/issues/855)) ([c25ff09](https://github.com/zuohuadong/supacloud/commit/c25ff097344ff10b3adaf73b5b941e9642bed9bf))

## [0.18.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.17.1...cli-v0.18.0) (2026-08-11)


### Features

* **cli:** add migration inventory action ([#824](https://github.com/zuohuadong/supacloud/issues/824)) ([d5d81b1](https://github.com/zuohuadong/supacloud/commit/d5d81b1145d4d80ac65adcd2c472785887d42686))
* **cli:** add multi-environment env profiles ([#803](https://github.com/zuohuadong/supacloud/issues/803)) ([e2b98e4](https://github.com/zuohuadong/supacloud/commit/e2b98e4ae993e5ce234eef2184ab3638c1244919))
* **cli:** add scheduled function revision CAS ([eaa84f3](https://github.com/zuohuadong/supacloud/commit/eaa84f3f66bebc707a75eecad6e66870989ec398))
* **cli:** add storage bucket lifecycle ([#822](https://github.com/zuohuadong/supacloud/issues/822)) ([e4c9b4c](https://github.com/zuohuadong/supacloud/commit/e4c9b4c8998a1149a527d38c277bf3d77f0f7572))
* **cli:** expose installed package version ([#816](https://github.com/zuohuadong/supacloud/issues/816)) ([9081fda](https://github.com/zuohuadong/supacloud/commit/9081fdabd8cac373cb87d6d39226c42a20e424ea))
* **cli:** load project secrets from environment ([#806](https://github.com/zuohuadong/supacloud/issues/806)) ([f3952e0](https://github.com/zuohuadong/supacloud/commit/f3952e003cd26f87419eec69a43127095ad13908))
* complete safe database promotion workflow ([6763d10](https://github.com/zuohuadong/supacloud/commit/6763d10eb4e6b715259a1e445c5921dc276d6dfd))
* extend Supabase-compatible platform capabilities ([adef019](https://github.com/zuohuadong/supacloud/commit/adef019261f82f123043ab4c7a047e6ad6956e56))
* **functions:** add active version concurrency control ([7a7e8b9](https://github.com/zuohuadong/supacloud/commit/7a7e8b95cb1e4001765f40302cb5ddbb7b6db372))
* **functions:** deploy exact prebuilt artifacts ([bd3ccf8](https://github.com/zuohuadong/supacloud/commit/bd3ccf853397fd5768a6d54d3885ad8b97c2c403))
* **gateway:** add managed functions upstream ([a3f8f74](https://github.com/zuohuadong/supacloud/commit/a3f8f744dc4056d50eb70826b298e0e90a861408))
* improve frontend hosting and console experience ([dc8422c](https://github.com/zuohuadong/supacloud/commit/dc8422c1c15be3c01b73ddb90d12b835c674880f))
* **storage:** add bucket revision CAS ([15f18b0](https://github.com/zuohuadong/supacloud/commit/15f18b08b763b319ebd09efcc7af45deee269044))


### Bug Fixes

* address release-blocking review findings ([0154fdb](https://github.com/zuohuadong/supacloud/commit/0154fdbab758c9d9c6a80fb877b15848a5ace5df))
* **admin:** support project create domain flags ([#800](https://github.com/zuohuadong/supacloud/issues/800)) ([c47e19c](https://github.com/zuohuadong/supacloud/commit/c47e19c88e1efcaa9864e1902f47a24be22c92ee))
* baseline migrations through authorized ledger API ([5cb9518](https://github.com/zuohuadong/supacloud/commit/5cb9518b9eccce5501acd79c65784a0f9ca879d4))
* **cli:** block release writes in read-only mode ([d49aa43](https://github.com/zuohuadong/supacloud/commit/d49aa4388011dafb0e143d54536bbc643040cfea))
* **cli:** bound release mutation response reads ([#842](https://github.com/zuohuadong/supacloud/issues/842)) ([265d9f5](https://github.com/zuohuadong/supacloud/commit/265d9f5473d222dc561c3d591d683c166278cb59))
* **cli:** fail early on migration identity conflicts ([978462c](https://github.com/zuohuadong/supacloud/commit/978462c7aaf5f88719907c344a96b7b6939cb4ef))
* **cli:** harden environment secret boundaries ([#815](https://github.com/zuohuadong/supacloud/issues/815)) ([f62b21d](https://github.com/zuohuadong/supacloud/commit/f62b21daaa2d591f5d887439bededa9977db3312))
* **cli:** keep version command standalone ([#818](https://github.com/zuohuadong/supacloud/issues/818)) ([419d212](https://github.com/zuohuadong/supacloud/commit/419d212386be2076358ad39579f1c862fe81a311))
* **cli:** order and validate migration versions ([9e07e2f](https://github.com/zuohuadong/supacloud/commit/9e07e2fa4ca9c026621fccc5d79c62b0352884d9))
* **cli:** preserve auth mutation failure contract ([#807](https://github.com/zuohuadong/supacloud/issues/807)) ([34d9e01](https://github.com/zuohuadong/supacloud/commit/34d9e01cec1314b9a76650ca1910809f464fe185))
* **cli:** preserve migration version identity ([2a11d53](https://github.com/zuohuadong/supacloud/commit/2a11d5355c43badb7839dcb5e4011aea8703624f))
* **cli:** recognize direct-apply migration markers ([#530](https://github.com/zuohuadong/supacloud/issues/530)) ([33f433d](https://github.com/zuohuadong/supacloud/commit/33f433d5e4e1d132dd50a8b1d312f0485119bee0))
* **cli:** recognize historical migration hash markers ([a9d55ff](https://github.com/zuohuadong/supacloud/commit/a9d55ff8cce32d475ba4e270ae1c6acaf1929737))
* **cli:** recognize historical migration hash markers ([b372e25](https://github.com/zuohuadong/supacloud/commit/b372e25073bc2ae54578365b524784e41610a010))
* **cli:** require atomic function policy receipts ([#797](https://github.com/zuohuadong/supacloud/issues/797)) ([a8c5c52](https://github.com/zuohuadong/supacloud/commit/a8c5c52e63224d5fa8c7fe4a8914c3432358236c))
* **cli:** skip explicit baseline migration markers ([7254552](https://github.com/zuohuadong/supacloud/commit/725455278446582663750097dd870609b36f56c1))
* **cli:** skip explicit baseline migration markers ([756f7ec](https://github.com/zuohuadong/supacloud/commit/756f7ec20702905fe874b93f411e1bb69e6e3a30))
* **edge-functions:** align CLI bundles with runtime policy ([#745](https://github.com/zuohuadong/supacloud/issues/745)) ([1ee2f94](https://github.com/zuohuadong/supacloud/commit/1ee2f94752efb0855a1528bd0049c733ae4cc6e5))
* **functions:** activate code and jwt policy atomically ([447bbf5](https://github.com/zuohuadong/supacloud/commit/447bbf5e1f44651bfb790e54af502a7536b4a52c))
* **functions:** activate code and JWT policy atomically ([c6c5fa9](https://github.com/zuohuadong/supacloud/commit/c6c5fa95aeea7dd09a53de196a98a540622a6d59))
* **functions:** support legacy v0 CAS and readback ([5ee1b8b](https://github.com/zuohuadong/supacloud/commit/5ee1b8b5ec5f7177839cb22d497156e93bca589a))
* **migrations:** preserve transactional migration compatibility ([#520](https://github.com/zuohuadong/supacloud/issues/520)) ([360b6cb](https://github.com/zuohuadong/supacloud/commit/360b6cb2222e094dc8539a953503c2d03f4154a5))
* **platform:** baseline migrations through authorized ledger route ([d494cca](https://github.com/zuohuadong/supacloud/commit/d494cca0d80573ff904d37a08ed72e11f10bb46b))


### Miscellaneous Chores

* release main ([48db1e2](https://github.com/zuohuadong/supacloud/commit/48db1e2df3cffe2fa70b730dff957bc2539d6617))
* release main ([fac53ca](https://github.com/zuohuadong/supacloud/commit/fac53ca02906676502cded4620b47a05465a7c5d))
* release main ([00bf23d](https://github.com/zuohuadong/supacloud/commit/00bf23d2c371b4ba4ddb31f20bb289c769848e06))
* release main ([4030977](https://github.com/zuohuadong/supacloud/commit/4030977d61182b07e36755e367575859c475b862))
* release main ([7509029](https://github.com/zuohuadong/supacloud/commit/7509029e27b3656885c1dccf55ed2f990f4b8e95))
* release main ([975702e](https://github.com/zuohuadong/supacloud/commit/975702e1a8e2c99fc242692a0027645912355c96))
* release main ([2b9f9c6](https://github.com/zuohuadong/supacloud/commit/2b9f9c6c82f1ff31b838f56a51d78f8924d4b627))
* release main ([84f6bc4](https://github.com/zuohuadong/supacloud/commit/84f6bc41795c4602b86a2552ca47c74a0d9337b9))
* release main ([256ce28](https://github.com/zuohuadong/supacloud/commit/256ce289a17fc2187b4bca7080d619d6e7512eda))
* release main ([5833a36](https://github.com/zuohuadong/supacloud/commit/5833a36b277b5fa5e26482d39c14bd7bb5d2d4f6))
* release main ([1c87f14](https://github.com/zuohuadong/supacloud/commit/1c87f14afda9f662cbbe9cee82eb515bd1462b81))
* release main ([77e93ee](https://github.com/zuohuadong/supacloud/commit/77e93eef13a85052561c1858322d8f5eb1365091))
* release main ([4cedd82](https://github.com/zuohuadong/supacloud/commit/4cedd827eeb6ad003875f6cfac786e727dde2003))
* release main ([0bd41fc](https://github.com/zuohuadong/supacloud/commit/0bd41fc27495e5e61f00bd1136c8f3a4176dfac2))
* release main ([#521](https://github.com/zuohuadong/supacloud/issues/521)) ([1230bf3](https://github.com/zuohuadong/supacloud/commit/1230bf3a6d1db6885c67da140d4ef318ec8cdec3))
* release main ([#617](https://github.com/zuohuadong/supacloud/issues/617)) ([45e6527](https://github.com/zuohuadong/supacloud/commit/45e6527d49329903237a6298bfefce27ed1466d4))
* release main ([#629](https://github.com/zuohuadong/supacloud/issues/629)) ([c58c4a4](https://github.com/zuohuadong/supacloud/commit/c58c4a41a1c6719a5e17a0f2c8f7ce2cff9951af))
* release main ([#641](https://github.com/zuohuadong/supacloud/issues/641)) ([80c6b6b](https://github.com/zuohuadong/supacloud/commit/80c6b6be2ac968869c52b180e6c9fdc8a8b816bf))
* release main ([#746](https://github.com/zuohuadong/supacloud/issues/746)) ([216dd76](https://github.com/zuohuadong/supacloud/commit/216dd76ea36c521ebad31356ba0924be5626a924))
* release main ([#796](https://github.com/zuohuadong/supacloud/issues/796)) ([f336cc1](https://github.com/zuohuadong/supacloud/commit/f336cc1443a4159b242ed754a8410e0403c2f132))
* release main ([#801](https://github.com/zuohuadong/supacloud/issues/801)) ([d88ef58](https://github.com/zuohuadong/supacloud/commit/d88ef587c283b40e7290fbbb47e3495fdd1c16c0))
* release main ([#814](https://github.com/zuohuadong/supacloud/issues/814)) ([5e99377](https://github.com/zuohuadong/supacloud/commit/5e99377cc1cb8fa2e48565c2fc551d03131914b0))
* release main ([#823](https://github.com/zuohuadong/supacloud/issues/823)) ([80fd010](https://github.com/zuohuadong/supacloud/commit/80fd01015ff3008c4ccd83d4d8b8efd125cda48c))
* release main ([#835](https://github.com/zuohuadong/supacloud/issues/835)) ([4d8348a](https://github.com/zuohuadong/supacloud/commit/4d8348a6bfc4779edfc6c2a7eec60bc4e0383ddb))

## [0.17.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.17.0...cli-v0.17.1) (2026-08-11)


### Bug Fixes

* **functions:** support legacy v0 CAS and readback ([5ee1b8b](https://github.com/zuohuadong/supacloud/commit/5ee1b8b5ec5f7177839cb22d497156e93bca589a))

## [0.17.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.16.0...cli-v0.17.0) (2026-08-11)


### Features

* **cli:** add scheduled function revision CAS ([eaa84f3](https://github.com/zuohuadong/supacloud/commit/eaa84f3f66bebc707a75eecad6e66870989ec398))
* **functions:** add active version concurrency control ([7a7e8b9](https://github.com/zuohuadong/supacloud/commit/7a7e8b95cb1e4001765f40302cb5ddbb7b6db372))
* **functions:** deploy exact prebuilt artifacts ([bd3ccf8](https://github.com/zuohuadong/supacloud/commit/bd3ccf853397fd5768a6d54d3885ad8b97c2c403))
* **storage:** add bucket revision CAS ([15f18b0](https://github.com/zuohuadong/supacloud/commit/15f18b08b763b319ebd09efcc7af45deee269044))


### Bug Fixes

* **cli:** fail early on migration identity conflicts ([978462c](https://github.com/zuohuadong/supacloud/commit/978462c7aaf5f88719907c344a96b7b6939cb4ef))

## [0.16.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.15.0...cli-v0.16.0) (2026-08-11)


### Features

* **cli:** add migration inventory action ([#824](https://github.com/zuohuadong/supacloud/issues/824)) ([d5d81b1](https://github.com/zuohuadong/supacloud/commit/d5d81b1145d4d80ac65adcd2c472785887d42686))
* **cli:** add storage bucket lifecycle ([#822](https://github.com/zuohuadong/supacloud/issues/822)) ([e4c9b4c](https://github.com/zuohuadong/supacloud/commit/e4c9b4c8998a1149a527d38c277bf3d77f0f7572))

## [0.15.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.14.6...cli-v0.15.0) (2026-08-11)


### Features

* **cli:** add multi-environment env profiles ([#803](https://github.com/zuohuadong/supacloud/issues/803)) ([e2b98e4](https://github.com/zuohuadong/supacloud/commit/e2b98e4ae993e5ce234eef2184ab3638c1244919))
* **cli:** expose installed package version ([#816](https://github.com/zuohuadong/supacloud/issues/816)) ([9081fda](https://github.com/zuohuadong/supacloud/commit/9081fdabd8cac373cb87d6d39226c42a20e424ea))
* **cli:** load project secrets from environment ([#806](https://github.com/zuohuadong/supacloud/issues/806)) ([f3952e0](https://github.com/zuohuadong/supacloud/commit/f3952e003cd26f87419eec69a43127095ad13908))


### Bug Fixes

* **cli:** block release writes in read-only mode ([d49aa43](https://github.com/zuohuadong/supacloud/commit/d49aa4388011dafb0e143d54536bbc643040cfea))
* **cli:** harden environment secret boundaries ([#815](https://github.com/zuohuadong/supacloud/issues/815)) ([f62b21d](https://github.com/zuohuadong/supacloud/commit/f62b21daaa2d591f5d887439bededa9977db3312))
* **cli:** keep version command standalone ([#818](https://github.com/zuohuadong/supacloud/issues/818)) ([419d212](https://github.com/zuohuadong/supacloud/commit/419d212386be2076358ad39579f1c862fe81a311))
* **cli:** preserve auth mutation failure contract ([#807](https://github.com/zuohuadong/supacloud/issues/807)) ([34d9e01](https://github.com/zuohuadong/supacloud/commit/34d9e01cec1314b9a76650ca1910809f464fe185))

## [0.14.6](https://github.com/zuohuadong/supacloud/compare/cli-v0.14.5...cli-v0.14.6) (2026-08-10)


### Bug Fixes

* **admin:** support project create domain flags ([#800](https://github.com/zuohuadong/supacloud/issues/800)) ([c47e19c](https://github.com/zuohuadong/supacloud/commit/c47e19c88e1efcaa9864e1902f47a24be22c92ee))

## [0.14.5](https://github.com/zuohuadong/supacloud/compare/cli-v0.14.4...cli-v0.14.5) (2026-08-10)


### Bug Fixes

* **cli:** require atomic function policy receipts ([#797](https://github.com/zuohuadong/supacloud/issues/797)) ([a8c5c52](https://github.com/zuohuadong/supacloud/commit/a8c5c52e63224d5fa8c7fe4a8914c3432358236c))

## [0.14.4](https://github.com/zuohuadong/supacloud/compare/cli-v0.14.3...cli-v0.14.4) (2026-08-10)


### Bug Fixes

* **edge-functions:** align CLI bundles with runtime policy ([#745](https://github.com/zuohuadong/supacloud/issues/745)) ([1ee2f94](https://github.com/zuohuadong/supacloud/commit/1ee2f94752efb0855a1528bd0049c733ae4cc6e5))

## [0.14.3](https://github.com/zuohuadong/supacloud/compare/cli-v0.14.2...cli-v0.14.3) (2026-08-04)


### Bug Fixes

* **functions:** activate code and jwt policy atomically ([447bbf5](https://github.com/zuohuadong/supacloud/commit/447bbf5e1f44651bfb790e54af502a7536b4a52c))
* **functions:** activate code and JWT policy atomically ([c6c5fa9](https://github.com/zuohuadong/supacloud/commit/c6c5fa95aeea7dd09a53de196a98a540622a6d59))

## [0.14.2](https://github.com/zuohuadong/supacloud/compare/cli-v0.14.1...cli-v0.14.2) (2026-08-02)


### Bug Fixes

* address release-blocking review findings ([0154fdb](https://github.com/zuohuadong/supacloud/commit/0154fdbab758c9d9c6a80fb877b15848a5ace5df))

## [0.14.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.14.0...cli-v0.14.1) (2026-07-29)


### Bug Fixes

* baseline migrations through authorized ledger API ([5cb9518](https://github.com/zuohuadong/supacloud/commit/5cb9518b9eccce5501acd79c65784a0f9ca879d4))
* **platform:** baseline migrations through authorized ledger route ([d494cca](https://github.com/zuohuadong/supacloud/commit/d494cca0d80573ff904d37a08ed72e11f10bb46b))

## [0.14.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.13.0...cli-v0.14.0) (2026-07-29)


### Features

* **gateway:** add managed functions upstream ([a3f8f74](https://github.com/zuohuadong/supacloud/commit/a3f8f744dc4056d50eb70826b298e0e90a861408))

## [0.13.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.12.4...cli-v0.13.0) (2026-07-28)


### Features

* extend Supabase-compatible platform capabilities ([adef019](https://github.com/zuohuadong/supacloud/commit/adef019261f82f123043ab4c7a047e6ad6956e56))

## [0.12.4](https://github.com/zuohuadong/supacloud/compare/cli-v0.12.3...cli-v0.12.4) (2026-07-22)


### Bug Fixes

* **cli:** recognize direct-apply migration markers ([#530](https://github.com/zuohuadong/supacloud/issues/530)) ([33f433d](https://github.com/zuohuadong/supacloud/commit/33f433d5e4e1d132dd50a8b1d312f0485119bee0))

## [0.12.3](https://github.com/zuohuadong/supacloud/compare/cli-v0.12.2...cli-v0.12.3) (2026-07-22)


### Bug Fixes

* **cli:** recognize historical migration hash markers ([a9d55ff](https://github.com/zuohuadong/supacloud/commit/a9d55ff8cce32d475ba4e270ae1c6acaf1929737))
* **cli:** recognize historical migration hash markers ([b372e25](https://github.com/zuohuadong/supacloud/commit/b372e25073bc2ae54578365b524784e41610a010))

## [0.12.2](https://github.com/zuohuadong/supacloud/compare/cli-v0.12.1...cli-v0.12.2) (2026-07-22)


### Bug Fixes

* **cli:** order and validate migration versions ([9e07e2f](https://github.com/zuohuadong/supacloud/commit/9e07e2fa4ca9c026621fccc5d79c62b0352884d9))
* **cli:** preserve migration version identity ([2a11d53](https://github.com/zuohuadong/supacloud/commit/2a11d5355c43badb7839dcb5e4011aea8703624f))
* **cli:** skip explicit baseline migration markers ([7254552](https://github.com/zuohuadong/supacloud/commit/725455278446582663750097dd870609b36f56c1))
* **cli:** skip explicit baseline migration markers ([756f7ec](https://github.com/zuohuadong/supacloud/commit/756f7ec20702905fe874b93f411e1bb69e6e3a30))

## [0.12.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.12.0...cli-v0.12.1) (2026-07-22)


### Bug Fixes

* **migrations:** preserve transactional migration compatibility ([#520](https://github.com/zuohuadong/supacloud/issues/520)) ([360b6cb](https://github.com/zuohuadong/supacloud/commit/360b6cb2222e094dc8539a953503c2d03f4154a5))

## [0.12.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.11.0...cli-v0.12.0) (2026-07-19)


### Features

* complete safe database promotion workflow ([6763d10](https://github.com/zuohuadong/supacloud/commit/6763d10eb4e6b715259a1e445c5921dc276d6dfd))
* improve frontend hosting and console experience ([dc8422c](https://github.com/zuohuadong/supacloud/commit/dc8422c1c15be3c01b73ddb90d12b835c674880f))

## [0.11.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.10.0...cli-v0.11.0) (2026-07-18)


### Features

* **cli:** restore adoption tooling and AI skill ([f562cf0](https://github.com/zuohuadong/supacloud/commit/f562cf0c55003c26ede796ffa060e7014392691c))

## [0.10.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.9.2...cli-v0.10.0) (2026-07-17)


### Features

* **gateway:** support protocol-scoped redirects ([62d02b7](https://github.com/zuohuadong/supacloud/commit/62d02b7eea7eb182462db7a36a3424f379923d87))
* **gateway:** support protocol-scoped redirects ([8a81652](https://github.com/zuohuadong/supacloud/commit/8a81652d463fea3b5265b44de0e74970c4604e27))


### Bug Fixes

* **gateway:** harden redirect route updates ([278c177](https://github.com/zuohuadong/supacloud/commit/278c1776742ed4530bdab0c8c234b2e59cea34b6))

## [0.9.2](https://github.com/zuohuadong/supacloud/compare/cli-v0.9.1...cli-v0.9.2) (2026-07-15)


### Bug Fixes

* **management-api:** support Pigsty 4.4 production compatibility ([d8f6959](https://github.com/zuohuadong/supacloud/commit/d8f6959623e6f09e0e665e3353d56fd7fdbab6de))

## [0.9.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.9.0...cli-v0.9.1) (2026-07-11)


### Miscellaneous Chores

* **deps-dev:** bump typescript from 6.0.3 to 7.0.2 in /packages/cli ([#416](https://github.com/zuohuadong/supacloud/issues/416)) ([46065d1](https://github.com/zuohuadong/supacloud/commit/46065d178735719b480621608ff755a385f4ebdc))

## [0.9.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.8.0...cli-v0.9.0) (2026-07-11)


### Features

* security hardening, idempotent install, and CI reliability fixes ([eb15db0](https://github.com/zuohuadong/supacloud/commit/eb15db0e58b8b2a2d19e4e99d92360a33da116a4))

## [0.8.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.7.0...cli-v0.8.0) (2026-06-28)


### Features

* **supacloud:** add unified entrypoint package ([3364a9d](https://github.com/zuohuadong/supacloud/commit/3364a9de44fad1ae9ddb3959f5416995e94dcf74))

## [0.7.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.6.2...cli-v0.7.0) (2026-06-23)


### Features

* **cli:** add gateway/caddy config tools to cli and admin ([4f5df4f](https://github.com/zuohuadong/supacloud/commit/4f5df4f2ea3f3aca94f95fe47ebc72bc9821e20f))

## [0.6.2](https://github.com/zuohuadong/supacloud/compare/cli-v0.6.1...cli-v0.6.2) (2026-06-03)


### Miscellaneous Chores

* upgrade all dependencies to latest minor ([e9719d9](https://github.com/zuohuadong/supacloud/commit/e9719d983c9303c783ddcd3d772c7e7c56e985b9))

## [0.6.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.6.0...cli-v0.6.1) (2026-05-29)


### Miscellaneous Chores

* **deps:** mark setup-buildx-action v4 PR merged ([e0cadc5](https://github.com/zuohuadong/supacloud/commit/e0cadc5fa00711c15b4d37a8ccf16ea7a7adbe24))

## [0.6.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.5.0...cli-v0.6.0) (2026-05-24)


### Features

* **cli:** add queue and task diagnostics tools ([#181](https://github.com/zuohuadong/supacloud/issues/181)) ([3493dc2](https://github.com/zuohuadong/supacloud/commit/3493dc2923024017cd6c6ca879de606a96b2c184))

## [0.5.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.4.1...cli-v0.5.0) (2026-05-16)


### Features

* **cli:** configure edge function runtime flags ([9c8e496](https://github.com/zuohuadong/supacloud/commit/9c8e496b665fd13c21fbca7d6a9f4cc12d32af58))
* configure edge function runtime flags from CLI ([5276e9d](https://github.com/zuohuadong/supacloud/commit/5276e9df0c950b74206edd5b092ae58ad94a8916))
* improve database sql cli workflows ([cd405b7](https://github.com/zuohuadong/supacloud/commit/cd405b7a667b62a9e98c2216fc772b0f64dc59cc))


### Bug Fixes

* **ci:** normalize release changelog headings ([63f3f4d](https://github.com/zuohuadong/supacloud/commit/63f3f4d37c951f7493cada1cd09e37dfa7eb19ca))
* **ci:** use ascii release notes sections ([2fde822](https://github.com/zuohuadong/supacloud/commit/2fde8225e9a01077e09308c88dd982e81368c90e))
* clarify project cli command name ([bbe32dc](https://github.com/zuohuadong/supacloud/commit/bbe32dccb65ba91d66a8741077dee9f75e0413fa))
* **cli:** add migration baseline repair ([0bd0c00](https://github.com/zuohuadong/supacloud/commit/0bd0c00703488cef130928badda05f7603c8e784))
* **cli:** handle migration list arrays ([5402290](https://github.com/zuohuadong/supacloud/commit/54022903063c00779eff4fa852b5b691e3964e1c))
* **cli:** infer management URL from project API domains ([3ec0087](https://github.com/zuohuadong/supacloud/commit/3ec008799ecf259643141d8c24620b638d21be12))
* **cli:** parse secrets upsert strings ([7a9b1bd](https://github.com/zuohuadong/supacloud/commit/7a9b1bd150d6e49fe6cbd56b359dd87f4b42c9b5))
* **cli:** push migrations through management API ([2d5827e](https://github.com/zuohuadong/supacloud/commit/2d5827e1adb3cc5617f2a994c6280013b5e85a1a))
* **cli:** push migrations via management api ([8d45c6e](https://github.com/zuohuadong/supacloud/commit/8d45c6e2b0525396b699094b3b2c737cb169eac1))
* **database:** consume sql rows response only ([98fede7](https://github.com/zuohuadong/supacloud/commit/98fede7ba3ed80a5d51f9bbb1f1e79eeab901eef))


### Elegance & Refactoring

* remove legacy sql result alias ([3b14b89](https://github.com/zuohuadong/supacloud/commit/3b14b894dfb6cdd03304fbec0a5060439e52d3db))


### Miscellaneous Chores

* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/cli ([#80](https://github.com/zuohuadong/supacloud/issues/80)) ([1e00f38](https://github.com/zuohuadong/supacloud/commit/1e00f38c987cd064892f01c48fb50587f1ba5d25))
* release main ([fef7214](https://github.com/zuohuadong/supacloud/commit/fef7214018950c6294e9ede6bc03e9c1cb4494b1))
* release main ([d1cfc6f](https://github.com/zuohuadong/supacloud/commit/d1cfc6f16d702e9e906ccdc839566da2433fa0e6))
* release main ([0848af3](https://github.com/zuohuadong/supacloud/commit/0848af33b2bbc432058e4fc5711824c31bdb6de6))
* release main ([d179e78](https://github.com/zuohuadong/supacloud/commit/d179e786a33f011b3412191b6daadc33a1dc977f))
* release main ([93d8e86](https://github.com/zuohuadong/supacloud/commit/93d8e866b40df0aed02a5e52f1b7aff7ec3e5e9e))
* release main ([1095682](https://github.com/zuohuadong/supacloud/commit/10956829679b6ba4de12f19150deff1a058b836f))
* release main ([3d2dc9e](https://github.com/zuohuadong/supacloud/commit/3d2dc9e68388fc6255ecfa90af363f1a4feaa4d1))
* release main ([c597a22](https://github.com/zuohuadong/supacloud/commit/c597a22d2b36a0e0b327ab77456bde81dbb29525))
* release main ([9fddfb3](https://github.com/zuohuadong/supacloud/commit/9fddfb327fd5e62c20e620d0d9046a13722a94e2))
* release main ([1ecbc25](https://github.com/zuohuadong/supacloud/commit/1ecbc254d4f9cc95c56da279c50ac5e8186cba90))
* release main ([4c02b71](https://github.com/zuohuadong/supacloud/commit/4c02b7122fc26d4a43cb45576621b94e9073addc))
* release main ([cf795eb](https://github.com/zuohuadong/supacloud/commit/cf795eb4acc0de5e947c23cafe22ab93fe06ed0d))
* release main ([aab74b9](https://github.com/zuohuadong/supacloud/commit/aab74b933cf7706fa7fe9eadd8231f206c54309b))
* release main ([43198f3](https://github.com/zuohuadong/supacloud/commit/43198f3d108a43a8bd6468f927ae0f91508d0756))
* release main ([1433283](https://github.com/zuohuadong/supacloud/commit/143328300650aa4eb7036db536cffb6a8cdea675))
* release main ([e761103](https://github.com/zuohuadong/supacloud/commit/e761103b02817ba0f741bede271777b0a067bb2f))
* release main ([77cbf82](https://github.com/zuohuadong/supacloud/commit/77cbf824d2120f59af592ce44300f587c2657913))
* release main ([03a4bfa](https://github.com/zuohuadong/supacloud/commit/03a4bfa21a066aa0ce52b1c14e4cf5daa7f3057d))
* release main ([d2757c8](https://github.com/zuohuadong/supacloud/commit/d2757c800d0f8116bd484e307adf8390e2aba9da))
* release main ([eb82b4d](https://github.com/zuohuadong/supacloud/commit/eb82b4dc38dc4e00401a259030b007ce3d986272))
* release main ([#113](https://github.com/zuohuadong/supacloud/issues/113)) ([3c98a4c](https://github.com/zuohuadong/supacloud/commit/3c98a4c9353f5d53ad1517e4e56a779cece4aded))
* release main ([#114](https://github.com/zuohuadong/supacloud/issues/114)) ([02b89e6](https://github.com/zuohuadong/supacloud/commit/02b89e6d9d1ff7ac85148342415d3f6ae9277fd8))
* release main ([#75](https://github.com/zuohuadong/supacloud/issues/75)) ([6e10ff2](https://github.com/zuohuadong/supacloud/commit/6e10ff2d2c15077b2cdf87c161f5285e4d1240c2))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([2e4376a](https://github.com/zuohuadong/supacloud/commit/2e4376a43affe224eb83c3d2c0f7761eb5fb204a))

## [0.4.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.4.0...cli-v0.4.1) (2026-05-15)


### Bug Fixes

* **ci:** normalize release changelog headings ([a446d69](https://github.com/zuohuadong/supacloud/commit/a446d692c12257753da8603617c3313982a56f87))
* **ci:** use ascii release notes sections ([fc1e24c](https://github.com/zuohuadong/supacloud/commit/fc1e24cc6e549da308a9d312b918eefbc1e9b418))

## [0.4.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.3.7...cli-v0.4.0) (2026-05-15)


### Features

* **cli:** configure edge function runtime flags ([19c0352](https://github.com/zuohuadong/supacloud/commit/19c0352419360136206fe7f7d225f9c23fc1d34f))
* configure edge function runtime flags from CLI ([a18375b](https://github.com/zuohuadong/supacloud/commit/a18375b81baa35d72db44729b86dca3ee3271cfd))
* improve database sql cli workflows ([d2faf45](https://github.com/zuohuadong/supacloud/commit/d2faf45cf2f962169a28798fb8b626f0e68f6835))


### Bug Fixes

* clarify project cli command name ([52e3a9c](https://github.com/zuohuadong/supacloud/commit/52e3a9cd7ca2fc50e68c2be9982a115f4b21e7c4))
* **cli:** add migration baseline repair ([c290dc5](https://github.com/zuohuadong/supacloud/commit/c290dc52d34e0eb29750793fd80db1113ba480f1))
* **cli:** handle migration list arrays ([584c4a2](https://github.com/zuohuadong/supacloud/commit/584c4a2eda52d8ef6923cb3f6604adb8c9c48b9e))
* **cli:** infer management URL from project API domains ([c5eb874](https://github.com/zuohuadong/supacloud/commit/c5eb874ec4d108f9bb0a8bb530b35269de8cca41))
* **cli:** parse secrets upsert strings ([f648ec1](https://github.com/zuohuadong/supacloud/commit/f648ec1a904dc08384a901a9f586d4deedcc9e44))
* **cli:** push migrations through management API ([300afb4](https://github.com/zuohuadong/supacloud/commit/300afb4a9e56eb15f68da6b1c3b85a0af321689a))
* **cli:** push migrations via management api ([46f6fbc](https://github.com/zuohuadong/supacloud/commit/46f6fbccea1e7188b0faa2dc6d1cb9c8af1f49d0))
* **database:** consume sql rows response only ([3c829df](https://github.com/zuohuadong/supacloud/commit/3c829df24894cbbb184bfb4cb57da9d1506ff31c))


### Elegance & Refactoring

* remove legacy sql result alias ([d9c85e3](https://github.com/zuohuadong/supacloud/commit/d9c85e3916de88bb38b86e943a63a903789379bd))


### Miscellaneous Chores

* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/cli ([#80](https://github.com/zuohuadong/supacloud/issues/80)) ([d814cc2](https://github.com/zuohuadong/supacloud/commit/d814cc2711f76a0ed889f3bb0ceabac1e675536a))
* release main ([cff457b](https://github.com/zuohuadong/supacloud/commit/cff457bdf2bc8584b154952162d0e5c621d13a87))
* release main ([608b396](https://github.com/zuohuadong/supacloud/commit/608b3963c1010c8cde63d42cd0f2a24d06a1e15e))
* release main ([65e28b5](https://github.com/zuohuadong/supacloud/commit/65e28b57270c313813cf5aea7f6385a7795623cf))
* release main ([a7d687f](https://github.com/zuohuadong/supacloud/commit/a7d687f39cea00f70dae78e10457d8708819e823))
* release main ([6dc7e2a](https://github.com/zuohuadong/supacloud/commit/6dc7e2a47c96f8d12e8edfd62041c274883c51c2))
* release main ([466e7a9](https://github.com/zuohuadong/supacloud/commit/466e7a9ebe635a8c47378c9e25a14e14e0962441))
* release main ([34a2d74](https://github.com/zuohuadong/supacloud/commit/34a2d74737f627dac011eb88872d9754fa5b6a1e))
* release main ([a8dd5ae](https://github.com/zuohuadong/supacloud/commit/a8dd5ae146b736029568ed47a82c16932304f47b))
* release main ([a922faf](https://github.com/zuohuadong/supacloud/commit/a922faf477bac633cb1852d780fedad772ad8161))
* release main ([c5d39ab](https://github.com/zuohuadong/supacloud/commit/c5d39abf5b1391210fbc39d90f15c2144ed979d3))
* release main ([eedd89d](https://github.com/zuohuadong/supacloud/commit/eedd89d3cccda79b9a939dbb03e252f262b06fcf))
* release main ([b6756c9](https://github.com/zuohuadong/supacloud/commit/b6756c9c1ffee750f1750ae19630d7b15eff0961))
* release main ([a09deaf](https://github.com/zuohuadong/supacloud/commit/a09deaf3b66fb6ff407b23fd6a6a7e57afe3ebe3))
* release main ([723eff5](https://github.com/zuohuadong/supacloud/commit/723eff5454a47abe52fe25f047dc554d4c927798))
* release main ([870112e](https://github.com/zuohuadong/supacloud/commit/870112e8b4314f334b5007a7d148f4fd965a242d))
* release main ([cb5a91c](https://github.com/zuohuadong/supacloud/commit/cb5a91c2fbb230e42a204d060bd5b3158654eb93))
* release main ([519e551](https://github.com/zuohuadong/supacloud/commit/519e5518f0b23aca34ffc4488cf41c6bd320b08b))
* release main ([28dd468](https://github.com/zuohuadong/supacloud/commit/28dd46854718e4cc7ce0484098cea9051be75814))
* release main ([71845b0](https://github.com/zuohuadong/supacloud/commit/71845b0e1da740825cef3131ec89f4962bfeb268))
* release main ([7065db9](https://github.com/zuohuadong/supacloud/commit/7065db93a028d9b48ed093cc5f00f6c21547f2ee))
* release main ([#75](https://github.com/zuohuadong/supacloud/issues/75)) ([58492af](https://github.com/zuohuadong/supacloud/commit/58492afd48273e018bf0df202ab9d7e0a2ac4b79))
* release main ([#91](https://github.com/zuohuadong/supacloud/issues/91)) ([11ff3e7](https://github.com/zuohuadong/supacloud/commit/11ff3e76eeb4f752e51ea3b0b8d6024196f6e99a))

## [0.3.7](https://github.com/zuohuadong/supacloud/compare/cli-v0.3.6...cli-v0.3.7) (2026-05-08)


### Miscellaneous Chores

* **deps:** bump zod from 3.25.76 to 4.4.3 in /packages/cli ([#80](https://github.com/zuohuadong/supacloud/issues/80)) ([db1075a](https://github.com/zuohuadong/supacloud/commit/db1075a35c32e129c705e74a069c4e53eb17f0db))

## [0.3.6](https://github.com/zuohuadong/supacloud/compare/cli-v0.3.5...cli-v0.3.6) (2026-05-08)


### Bug Fixes

* **cli:** infer management URL from project API domains ([41de422](https://github.com/zuohuadong/supacloud/commit/41de422003627bedaae2056916dedad7d012ee54))

## [0.3.5](https://github.com/zuohuadong/supacloud/compare/cli-v0.3.4...cli-v0.3.5) (2026-04-29)


### Bug Fixes

* **cli:** parse secrets upsert strings ([6677a74](https://github.com/zuohuadong/supacloud/commit/6677a74a90a3b3c0cb9506bf6a44644e7f69fd09))

## [0.3.4](https://github.com/zuohuadong/supacloud/compare/cli-v0.3.3...cli-v0.3.4) (2026-04-29)


### Bug Fixes

* **cli:** add migration baseline repair ([739a118](https://github.com/zuohuadong/supacloud/commit/739a118ab5bae4a4d63b6a593d71640a48835604))

## [0.3.3](https://github.com/zuohuadong/supacloud/compare/cli-v0.3.2...cli-v0.3.3) (2026-04-29)


### Bug Fixes

* **cli:** handle migration list arrays ([6d5ab05](https://github.com/zuohuadong/supacloud/commit/6d5ab05995590d974d255a1edeb13899ad5d9d2b))

## [0.3.2](https://github.com/zuohuadong/supacloud/compare/cli-v0.3.1...cli-v0.3.2) (2026-04-27)


### Bug Fixes

* clarify project cli command name ([e715e59](https://github.com/zuohuadong/supacloud/commit/e715e597e7773dae98f3868f179139a510e6f54a))

## [0.3.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.3.0...cli-v0.3.1) (2026-04-27)


### Bug Fixes

* **database:** consume sql rows response only ([75c3f68](https://github.com/zuohuadong/supacloud/commit/75c3f6818211cf326954cb75c530ef25e48b901b))

## [0.3.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.2.0...cli-v0.3.0) (2026-04-27)


### Features

* improve database sql cli workflows ([1d1ac83](https://github.com/zuohuadong/supacloud/commit/1d1ac83d7518f223e048b8caedd1420460b1e70e))


### Elegance & Refactoring

* remove legacy sql result alias ([3565c00](https://github.com/zuohuadong/supacloud/commit/3565c00f197a35e129785cce299ee48b9f91f7b8))

## [0.2.0](https://github.com/zuohuadong/supacloud/compare/cli-v0.1.2...cli-v0.2.0) (2026-04-26)


### Features

* **cli:** configure edge function runtime flags ([fa0be85](https://github.com/zuohuadong/supacloud/commit/fa0be85be7843425868cc9f991813650a33b2b34))
* configure edge function runtime flags from CLI ([4992d8d](https://github.com/zuohuadong/supacloud/commit/4992d8d363f83b32db5fd4d7f93934f6d3273b9c))

## [0.1.2](https://github.com/zuohuadong/supacloud/compare/cli-v0.1.1...cli-v0.1.2) (2026-04-25)


### Bug Fixes

* **cli:** push migrations through management API ([cee9927](https://github.com/zuohuadong/supacloud/commit/cee9927d29cb0ef514ae5a33080e6cf1c74bdecc))
* **cli:** push migrations via management api ([5b06fa2](https://github.com/zuohuadong/supacloud/commit/5b06fa249802335fbb3c4e77d3f5cefe8c4336b8))

## [0.1.1](https://github.com/zuohuadong/supacloud/compare/cli-v0.1.0...cli-v0.1.1) (2026-04-19)


### Miscellaneous Chores

* release main ([239aea7](https://github.com/zuohuadong/supacloud/commit/239aea7e22bae05cc3c7840bc6c0fd7b322a8862))
* release main ([8d020be](https://github.com/zuohuadong/supacloud/commit/8d020be4e8d374f0cf0498a97e4beb6a88e57fb0))
