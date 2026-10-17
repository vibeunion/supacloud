:robot: I have created a release *beep* *boop*
---


<details><summary>management-api: 0.120.0</summary>

## [0.120.0](https://github.com/vibeunion/supacloud/compare/management-api-v0.119.0...management-api-v0.120.0) (2026-10-17)


###   BREAKING CHANGES

* **deploy:** require unified application deployment and reject legacy flows ([#1870](https://github.com/vibeunion/supacloud/issues/1870))
* **frontend:** migrate uploads to tar.zst and add read-only deployment plans ([#1771](https://github.com/vibeunion/supacloud/issues/1771))
* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.
* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.

### Features

* add agent backend authoring, runtime and observability workflows ([#1648](https://github.com/vibeunion/supacloud/issues/1648)) ([59a66d1](https://github.com/vibeunion/supacloud/commit/59a66d184a47d19c7f8895f24a6ba2c7e74e93d0))
* **app:** add governed reactive event streams and lifecycle signals ([38a26e2](https://github.com/vibeunion/supacloud/commit/38a26e2d3b83226a7488df2ef4f1f5714573aeb2))
* **app:** add verified read-only environment promotion plans ([#1785](https://github.com/vibeunion/supacloud/issues/1785)) ([454b86f](https://github.com/vibeunion/supacloud/commit/454b86fc5f7d7f01b90c801c1f0f1eaa1a53fb03))
* **app:** execute and reconcile fenced application promotions ([#1788](https://github.com/vibeunion/supacloud/issues/1788)) ([ebf9f42](https://github.com/vibeunion/supacloud/commit/ebf9f423330d129c122f247b51a71c7553330f4a))
* **applications:** journal-selected application rollback ([#1776](https://github.com/vibeunion/supacloud/issues/1776)) ([68a191c](https://github.com/vibeunion/supacloud/commit/68a191c73d9f5437303885a2f95ba33109d12bc5))
* **applications:** verified read-only deploy plan and no-op observation ([#1778](https://github.com/vibeunion/supacloud/issues/1778)) ([8d8098d](https://github.com/vibeunion/supacloud/commit/8d8098d2ae809c53da1f937d6c10139cbb153ae4))
* **app:** make preview lifecycle resumable and verifiable ([#1786](https://github.com/vibeunion/supacloud/issues/1786)) ([cfd2782](https://github.com/vibeunion/supacloud/commit/cfd2782809fcc6055fe2f4a7c98857c3de204a12))
* **app:** orchestrate application releases on platform ([#1808](https://github.com/vibeunion/supacloud/issues/1808)) ([6488889](https://github.com/vibeunion/supacloud/commit/64888896e4a26ecffb5888c26ae18f47804e60e8))
* **app:** transfer verified releases across environment projects ([#1784](https://github.com/vibeunion/supacloud/issues/1784)) ([b45db88](https://github.com/vibeunion/supacloud/commit/b45db8810bf184d564b375b299d14407bc686e2a))
* batch server-owned release preparation and simplify deploy output ([#1856](https://github.com/vibeunion/supacloud/issues/1856)) ([599d274](https://github.com/vibeunion/supacloud/commit/599d274285accb04a7e9e04617d8c91d40fa2b2a))
* **cli:** add application delivery workflow ([#1490](https://github.com/vibeunion/supacloud/issues/1490)) ([da5b4e4](https://github.com/vibeunion/supacloud/commit/da5b4e4098b0478553cc09876217441e24aa8f04))
* **cli:** bind release scopes to environments ([#1832](https://github.com/vibeunion/supacloud/issues/1832)) ([f3930d1](https://github.com/vibeunion/supacloud/commit/f3930d1ca26af1362583d965287cdc8131fa38d9))
* **console:** safely inspect delivered application development context ([#1522](https://github.com/vibeunion/supacloud/issues/1522)) ([db25fc2](https://github.com/vibeunion/supacloud/commit/db25fc2844a18aea660e5fdd5249486f40ec1458))
* default RxJS support with compatible SupaCloud JS calls ([#1556](https://github.com/vibeunion/supacloud/issues/1556)) ([b3015cb](https://github.com/vibeunion/supacloud/commit/b3015cb161c0d87e6611f6c4fc60c120a8c9fffe))
* **delivery:** inspect verified application activation history ([#1781](https://github.com/vibeunion/supacloud/issues/1781)) ([46e1ba4](https://github.com/vibeunion/supacloud/commit/46e1ba437bd6a2821d35fb69b1bd945df45e5f26))
* **deploy:** require unified application deployment and reject legacy flows ([#1870](https://github.com/vibeunion/supacloud/issues/1870)) ([ac3562d](https://github.com/vibeunion/supacloud/commit/ac3562dc65d5bd8de63d779f062d2f11c901af69))
* **deploy:** separate frontend releases from backend jobs ([#1939](https://github.com/vibeunion/supacloud/issues/1939)) ([2230abe](https://github.com/vibeunion/supacloud/commit/2230abea24fd0a9fe99cdea91ad72f35274f12d1))
* **deploy:** unify frontend upload with project deployment ([#1862](https://github.com/vibeunion/supacloud/issues/1862)) ([b022c72](https://github.com/vibeunion/supacloud/commit/b022c72331d47d2ab69ebc86fa6450fc9dcd1a37))
* **elysia:** Elysia 2 AOT evaluation and end-to-end typing architecture ([#1654](https://github.com/vibeunion/supacloud/issues/1654)) ([39ee49f](https://github.com/vibeunion/supacloud/commit/39ee49f760e85e789c43c1d18cf5729db592f6bc))
* establish single-node delivery baseline ([#1632](https://github.com/vibeunion/supacloud/issues/1632)) ([926de6c](https://github.com/vibeunion/supacloud/commit/926de6c6c72940f7c03e046908ef446c54d37621))
* **frontend:** avoid history scans during deploy and retain rollback authority ([#1763](https://github.com/vibeunion/supacloud/issues/1763)) ([772d687](https://github.com/vibeunion/supacloud/commit/772d687e885d912a37d3a03f67fd0b52cb306869))
* **frontend:** migrate uploads to tar.zst and add read-only deployment plans ([#1771](https://github.com/vibeunion/supacloud/issues/1771)) ([819fd3d](https://github.com/vibeunion/supacloud/commit/819fd3d5497a0ce86c9ee3cf1ed4ef4ae4db8637))
* **frontend:** select journal verified rollback target ([#1768](https://github.com/vibeunion/supacloud/issues/1768)) ([28d8a08](https://github.com/vibeunion/supacloud/commit/28d8a08d0e235d4fda04489d7f1760778fc54a10))
* **gateway:** auto-configure Function CORS origins ([#1749](https://github.com/vibeunion/supacloud/issues/1749)) ([5b6853b](https://github.com/vibeunion/supacloud/commit/5b6853bd563297cb632aee3b9b7e6729de18d0f4))
* **governance:** enforce strict user and platform type contracts ([#1754](https://github.com/vibeunion/supacloud/issues/1754)) ([b22f889](https://github.com/vibeunion/supacloud/commit/b22f88919c349f088848028f13b15e44994e0d9c))
* **management-api:** Developer MCP reads application development context (P1-4) ([#1519](https://github.com/vibeunion/supacloud/issues/1519)) ([7d7f0e9](https://github.com/vibeunion/supacloud/commit/7d7f0e9d1d3263614fb1104c3168521e21b69832))
* **platform:** close application platform P0/P1 capabilities ([dbaf3a6](https://github.com/vibeunion/supacloud/commit/dbaf3a6d01daa71455a8cde96e9e233743bfdfca))
* **preview:** expire and safely clean isolated previews ([#1774](https://github.com/vibeunion/supacloud/issues/1774)) ([05f0605](https://github.com/vibeunion/supacloud/commit/05f060552dc49464b791109d64662c4a4f73eecc))
* **release:** make logical backups resumable and directly observable ([#1787](https://github.com/vibeunion/supacloud/issues/1787)) ([5c8d6eb](https://github.com/vibeunion/supacloud/commit/5c8d6eb828e74c38ed0bbd257fdef8da2ee5d141))
* **storage:** migrate image transforms to imagor ([#1840](https://github.com/vibeunion/supacloud/issues/1840)) ([5b9b091](https://github.com/vibeunion/supacloud/commit/5b9b091d0f39b2f39ac7befdb051be5ad855c403))
* **storage:** support independent S3 backends per project ([#1470](https://github.com/vibeunion/supacloud/issues/1470)) ([9d1efa3](https://github.com/vibeunion/supacloud/commit/9d1efa338d71e06127d1d1656d54b771f78bce14))
* **storage:** support raw image byte transforms ([#1884](https://github.com/vibeunion/supacloud/issues/1884)) ([fc3fc20](https://github.com/vibeunion/supacloud/commit/fc3fc20429c7887e16cc4ef49d7357bab57d4a67))
* unify application backend and web deployment ([#1828](https://github.com/vibeunion/supacloud/issues/1828)) ([119fb30](https://github.com/vibeunion/supacloud/commit/119fb30381ee5636a936262319b1e50f19de994b))
* unify project deployment orchestration ([#1851](https://github.com/vibeunion/supacloud/issues/1851)) ([a69d183](https://github.com/vibeunion/supacloud/commit/a69d18384aa09194d0d4d1dc3e81d9211a679540))
* **web-console:** upgrade svadmin and type auth mutations ([#1662](https://github.com/vibeunion/supacloud/issues/1662)) ([b7bc46c](https://github.com/vibeunion/supacloud/commit/b7bc46cb3aeb57decd9265699cc66a6dd8c0d4ea))
* **worker:** add bounded runtime recipes and native adapter ([#1618](https://github.com/vibeunion/supacloud/issues/1618)) ([335354c](https://github.com/vibeunion/supacloud/commit/335354c988e63f7c58ff79d7210a9af20814e911))
* **worker:** bounded execution groups and admission controls ([#1616](https://github.com/vibeunion/supacloud/issues/1616)) ([8d870ea](https://github.com/vibeunion/supacloud/commit/8d870eabfce9bedce75d42151f5085bcef19b4c1))


### Bug Fixes

* **auth:** bind service JWT verification to project public signer ([#1958](https://github.com/vibeunion/supacloud/issues/1958)) ([21846c2](https://github.com/vibeunion/supacloud/commit/21846c2b8f7973739c848257a8a7c753b0b3fb4b))
* **auth:** preserve SupAuth JSONB contract shapes ([#1509](https://github.com/vibeunion/supacloud/issues/1509)) ([bb23592](https://github.com/vibeunion/supacloud/commit/bb235927f38f684503d4e172acee762439794afc))
* bound edge-function immutable version history ([#1563](https://github.com/vibeunion/supacloud/issues/1563)) ([793723c](https://github.com/vibeunion/supacloud/commit/793723cc55a5184e3b25ab401502e8a49f044eac))
* **ci:** avoid ECR data limit for Realtime fixture ([#1458](https://github.com/vibeunion/supacloud/issues/1458)) ([17cac42](https://github.com/vibeunion/supacloud/commit/17cac424cd521ccb1624e7bf4bb5caeb6708c59b))
* **ci:** recover empty management releases from exact tags ([#1459](https://github.com/vibeunion/supacloud/issues/1459)) ([9597609](https://github.com/vibeunion/supacloud/commit/9597609cb27b2a3279ece102b757637cc8fd993f))
* **edge-runtime:** bound background capacity and repair log ownership ([#1497](https://github.com/vibeunion/supacloud/issues/1497)) ([0370080](https://github.com/vibeunion/supacloud/commit/0370080a9a333542732e34ba3b11efea49c14fd8))
* **edge-runtime:** bound default worker memory ([#1896](https://github.com/vibeunion/supacloud/issues/1896)) ([8790b91](https://github.com/vibeunion/supacloud/commit/8790b9167543c36b6f39e9554f85f3bd01617c58))
* **edge-runtime:** separate parked retirement attestation from execution slots ([#1985](https://github.com/vibeunion/supacloud/issues/1985)) ([575c8bd](https://github.com/vibeunion/supacloud/commit/575c8bd376c6e2d547db2581f05756e8d832f8e2))
* **edge-runtime:** transfer binary payloads without extra copies ([#1928](https://github.com/vibeunion/supacloud/issues/1928)) ([022ec59](https://github.com/vibeunion/supacloud/commit/022ec59d0e1e11f74b7ce5c2f7cfeec9ac90a864))
* **gateway:** compress migration inventory responses ([#1535](https://github.com/vibeunion/supacloud/issues/1535)) ([431261f](https://github.com/vibeunion/supacloud/commit/431261fc850b993bff26b9d01843a6df524bd44b))
* **gateway:** use wildcard CORS for automatic Functions ([#1838](https://github.com/vibeunion/supacloud/issues/1838)) ([551f99f](https://github.com/vibeunion/supacloud/commit/551f99f92dd84806a098515279afe74dc59a3a2c))
* integrate reviewed customer, auth and release repairs ([#2027](https://github.com/vibeunion/supacloud/issues/2027)) ([5c07903](https://github.com/vibeunion/supacloud/commit/5c07903f20bfb069229cf3a829886fe96c78c288))
* **management-api:** allow function tracing headers in CORS ([#1735](https://github.com/vibeunion/supacloud/issues/1735)) ([27e72fc](https://github.com/vibeunion/supacloud/commit/27e72fc47415d288907e066a7a0d4604e12ee261))
* **management-api:** bind application receipts to verified backend state ([#1874](https://github.com/vibeunion/supacloud/issues/1874)) ([5b1420d](https://github.com/vibeunion/supacloud/commit/5b1420dede87c57a87d1c824764110d6b5e08b62))
* **management-api:** diagnose rejected preheat attestations safely ([#1984](https://github.com/vibeunion/supacloud/issues/1984)) ([955f689](https://github.com/vibeunion/supacloud/commit/955f689dc2d55b397de2dc9be08591f525fb6c31))
* **management-api:** distinguish active readiness from candidate preheat ([#1966](https://github.com/vibeunion/supacloud/issues/1966)) ([06644d0](https://github.com/vibeunion/supacloud/commit/06644d0fc23f2bc61e67ff62d78024d22473f92c))
* **management-api:** harden watchdog and deduplicate immutable function artifacts ([#1549](https://github.com/vibeunion/supacloud/issues/1549)) ([f6821a8](https://github.com/vibeunion/supacloud/commit/f6821a81b7ea56f0a3ccdb20104b6114a0eadafd))
* **management-api:** preserve delegated auth for release transfers ([#1876](https://github.com/vibeunion/supacloud/issues/1876)) ([818985d](https://github.com/vibeunion/supacloud/commit/818985d10535ae8e16632ddbea36dfb568f7f0e2))
* **management-api:** resolve function preflight tenants from host ([4f47210](https://github.com/vibeunion/supacloud/commit/4f47210eb5dcf878ab3cc708cf67d5751a21614d))
* **management-api:** reuse delegated principal for promotion source checks ([#1879](https://github.com/vibeunion/supacloud/issues/1879)) ([f9ecba5](https://github.com/vibeunion/supacloud/commit/f9ecba5d348f4e7ff35ec2b0a189b540c58be249))
* **management-api:** stop emitting duplicate project-ref header ([#1829](https://github.com/vibeunion/supacloud/issues/1829)) ([b1b7def](https://github.com/vibeunion/supacloud/commit/b1b7def4310ed94e678a43273b70f8463b42fdcf))
* **management:** preserve mutation transactions during host operations ([#1508](https://github.com/vibeunion/supacloud/issues/1508)) ([ebf79ac](https://github.com/vibeunion/supacloud/commit/ebf79ac8b159007325c9837fb576d84db3f62fce))
* **platform:** close preview persistence races and GraphQL governance bypasses ([#1692](https://github.com/vibeunion/supacloud/issues/1692)) ([7f22cfb](https://github.com/vibeunion/supacloud/commit/7f22cfb86da31fcb2ba2594417e24ba3c12eb61c))
* preserve reviewed watchdog webhook deadlines and failure isolation ([#1567](https://github.com/vibeunion/supacloud/issues/1567)) ([001180c](https://github.com/vibeunion/supacloud/commit/001180cd2e010a2e481f378dac2dbf135b517e3c))
* **preview:** gate readiness on branch activation evidence ([#1772](https://github.com/vibeunion/supacloud/issues/1772)) ([19bd977](https://github.com/vibeunion/supacloud/commit/19bd977415fb887195c4f164a808adef269a4cf6))
* report edge-function artifacts that fall back to separate copies ([#1564](https://github.com/vibeunion/supacloud/issues/1564)) ([d6859e3](https://github.com/vibeunion/supacloud/commit/d6859e316aea1e682262ab99bb3958f15838dcc5))
* **runtime:** preserve durable project service credentials ([#1945](https://github.com/vibeunion/supacloud/issues/1945)) ([8ba63e1](https://github.com/vibeunion/supacloud/commit/8ba63e16769f23627ecdee8fff5e65756ea21b17))
* **storage:** allow project service role to transform metadata-free objects ([#1483](https://github.com/vibeunion/supacloud/issues/1483)) ([9bd5853](https://github.com/vibeunion/supacloud/commit/9bd585373d2c9dc5c2466cc44b470696fcac0536))
* **storage:** build one imagor request per transform ([#1842](https://github.com/vibeunion/supacloud/issues/1842)) ([b273c36](https://github.com/vibeunion/supacloud/commit/b273c365a04e12b57cfc02c85ce7698e13fe2cd4))
* **storage:** source image transforms via the storage driver ([#1479](https://github.com/vibeunion/supacloud/issues/1479)) ([1935b87](https://github.com/vibeunion/supacloud/commit/1935b87d82d673bf1e57167b33c4f9306bfc0d2d))
* **storage:** verify project service auth for image transforms ([#1498](https://github.com/vibeunion/supacloud/issues/1498)) ([d6402ab](https://github.com/vibeunion/supacloud/commit/d6402abcf5df75ab405f6db6708da17888e5a91f))
* **upgrade:** scale edge workers with cpu capacity ([#1644](https://github.com/vibeunion/supacloud/issues/1644)) ([8d97de6](https://github.com/vibeunion/supacloud/commit/8d97de61999a1cf54e844b32851838013c29e66a))
* validate deployment receipts and prevent silent Web-only fallback ([#1854](https://github.com/vibeunion/supacloud/issues/1854)) ([8138707](https://github.com/vibeunion/supacloud/commit/813870786a845cee9a726f9dda2b6c889c8e8cdd))
* **web-console:** enforce typed auth URL configuration contract ([#1663](https://github.com/vibeunion/supacloud/issues/1663)) ([958efa9](https://github.com/vibeunion/supacloud/commit/958efa9a87fdb143578343a8946b1e5e4d248d71))
* **worker:** enforce safe retirement and admission grants ([6ac69dc](https://github.com/vibeunion/supacloud/commit/6ac69dcb3381c47a5f91737b958f3a730f4304f9))
* **worker:** restore admission compatibility after runtime merge ([#1625](https://github.com/vibeunion/supacloud/issues/1625)) ([8e75778](https://github.com/vibeunion/supacloud/commit/8e75778e543279ceefa21d97a35105274d72e700))
* **worker:** ship reviewed PGMQ job controls and concurrency repairs ([#1689](https://github.com/vibeunion/supacloud/issues/1689)) ([e283915](https://github.com/vibeunion/supacloud/commit/e283915e66e119b75ad1b909e18816270b5d01e3))


### Elegance & Refactoring

* use ESM-only owned packages and Lite launcher ([#1582](https://github.com/vibeunion/supacloud/issues/1582)) ([ed5ac78](https://github.com/vibeunion/supacloud/commit/ed5ac78ee3ab22567268fa276e5b016ad1e8b575))


### Performance Improvements

* parallelize deployment evidence reads ([#1860](https://github.com/vibeunion/supacloud/issues/1860)) ([fba922e](https://github.com/vibeunion/supacloud/commit/fba922e943b9021a4b09606891ecba74c47dd857))


### Miscellaneous Chores

* adopt AGPL-3.0-only licensing ([#1481](https://github.com/vibeunion/supacloud/issues/1481)) ([8787ad9](https://github.com/vibeunion/supacloud/commit/8787ad9466ebba8f487d28bf62d5f79a220b0ab8))
* adopt current Supabase SDK baseline ([#1698](https://github.com/vibeunion/supacloud/issues/1698)) ([4e6613a](https://github.com/vibeunion/supacloud/commit/4e6613aeda3c5958e44cbe9604e30cce0622a66f))
* **deps:** bump acorn in /packages/management-api ([#1715](https://github.com/vibeunion/supacloud/issues/1715)) ([f9cc4d6](https://github.com/vibeunion/supacloud/commit/f9cc4d6215ea5f7c51b5d90f139d9101c3487a18))
* **deps:** bump graphql to 17 and migrate input coercion ([dfe027f](https://github.com/vibeunion/supacloud/commit/dfe027fe507d88b1befacd8164c42588997a8342))
* **deps:** bump nanoid from 6.0.1 to 6.0.2 in /packages/management-api ([#1716](https://github.com/vibeunion/supacloud/issues/1716)) ([3ed7703](https://github.com/vibeunion/supacloud/commit/3ed770373786ae0cb4389cbbaffce8cf5804b7be))
* **deps:** complete @sinclair/typebox to typebox 1.3.34 migration ([#1655](https://github.com/vibeunion/supacloud/issues/1655)) ([87d1133](https://github.com/vibeunion/supacloud/commit/87d1133c0fa0eadf145afc6c3747f693e3e36200))
* release main ([bf9496f](https://github.com/vibeunion/supacloud/commit/bf9496f3bf625efabd75c4da1d06c469adb9b912))
* release main ([#1457](https://github.com/vibeunion/supacloud/issues/1457)) ([6c87610](https://github.com/vibeunion/supacloud/commit/6c87610a6161feef2d8bebff93e1d8a6bc08a45e))
* release main ([#1461](https://github.com/vibeunion/supacloud/issues/1461)) ([17c4d2f](https://github.com/vibeunion/supacloud/commit/17c4d2f7aef6198655224710bef3337c97caaada))
* release main ([#1474](https://github.com/vibeunion/supacloud/issues/1474)) ([6255eb7](https://github.com/vibeunion/supacloud/commit/6255eb7e7eefc4ee5cd06bef05d4c81a29be706a))
* release main ([#1482](https://github.com/vibeunion/supacloud/issues/1482)) ([ef782af](https://github.com/vibeunion/supacloud/commit/ef782afd7e281601c1444573b161c210497492e5))
* release main ([#1484](https://github.com/vibeunion/supacloud/issues/1484)) ([41b3e72](https://github.com/vibeunion/supacloud/commit/41b3e72d25dd8b1ea1d3dea5b75c90bdea9be797))
* release main ([#1492](https://github.com/vibeunion/supacloud/issues/1492)) ([eb37eeb](https://github.com/vibeunion/supacloud/commit/eb37eeb972a299f54edb356b1959800c16e6d511))
* release main ([#1495](https://github.com/vibeunion/supacloud/issues/1495)) ([ced66da](https://github.com/vibeunion/supacloud/commit/ced66dab53493e875c58f904ef0b3c26a8810928))
* release main ([#1500](https://github.com/vibeunion/supacloud/issues/1500)) ([7d9368a](https://github.com/vibeunion/supacloud/commit/7d9368a946f1d400aca11c54c3081dc8e88d8e82))
* release main ([#1507](https://github.com/vibeunion/supacloud/issues/1507)) ([b7f3a59](https://github.com/vibeunion/supacloud/commit/b7f3a59885596742a8b11fc808d898165a8989ec))
* release main ([#1550](https://github.com/vibeunion/supacloud/issues/1550)) ([06b5266](https://github.com/vibeunion/supacloud/commit/06b52667d9c23ea92053a36b0251cf93624c1014))
* release main ([#1561](https://github.com/vibeunion/supacloud/issues/1561)) ([3ee71e3](https://github.com/vibeunion/supacloud/commit/3ee71e301e7a5499780b45ec6c64e53698000029))
* release main ([#1617](https://github.com/vibeunion/supacloud/issues/1617)) ([afad389](https://github.com/vibeunion/supacloud/commit/afad38960cf086afeddcdc4565daa7b8cb429c2e))
* release main ([#1623](https://github.com/vibeunion/supacloud/issues/1623)) ([f68e24d](https://github.com/vibeunion/supacloud/commit/f68e24d942ddb71342eb80bef1c78015b4c2b079))
* release main ([#1629](https://github.com/vibeunion/supacloud/issues/1629)) ([d71addd](https://github.com/vibeunion/supacloud/commit/d71addd0e974b70505be4702e9e6d02d90e9fabc))
* release main ([#1633](https://github.com/vibeunion/supacloud/issues/1633)) ([e9db823](https://github.com/vibeunion/supacloud/commit/e9db823b47db6b0d9ebe8057792e35e34c144420))
* release main ([#1647](https://github.com/vibeunion/supacloud/issues/1647)) ([9afdb5c](https://github.com/vibeunion/supacloud/commit/9afdb5c348a2e87169e8898b3842091bb8f1ddea))
* release main ([#1657](https://github.com/vibeunion/supacloud/issues/1657)) ([1a3f7ff](https://github.com/vibeunion/supacloud/commit/1a3f7ff901f05dda38ed4827d70a91a4acccd8b3))
* release main ([#1661](https://github.com/vibeunion/supacloud/issues/1661)) ([77ea3fa](https://github.com/vibeunion/supacloud/commit/77ea3fa73707222f21561005a6be3569dae606b4))
* release main ([#1664](https://github.com/vibeunion/supacloud/issues/1664)) ([9827aa5](https://github.com/vibeunion/supacloud/commit/9827aa53b418a91a41e81bc02c50f05d09e03d4c))
* release main ([#1691](https://github.com/vibeunion/supacloud/issues/1691)) ([2d47123](https://github.com/vibeunion/supacloud/commit/2d47123013522350129d49480ce6d132595976db))
* release main ([#1695](https://github.com/vibeunion/supacloud/issues/1695)) ([2b9da10](https://github.com/vibeunion/supacloud/commit/2b9da1004b8cc1fd78cfcad79110d5c5eba5349d))
* release main ([#1736](https://github.com/vibeunion/supacloud/issues/1736)) ([0916385](https://github.com/vibeunion/supacloud/commit/09163851882373d5cc1f647e9e8d94aa1d441187))
* release main ([#1752](https://github.com/vibeunion/supacloud/issues/1752)) ([c7e8496](https://github.com/vibeunion/supacloud/commit/c7e8496de45420ac6da2513bd8e97c90f668469d))
* release main ([#1765](https://github.com/vibeunion/supacloud/issues/1765)) ([30b5e70](https://github.com/vibeunion/supacloud/commit/30b5e700ed0b493ec8049c804914762658a37a94))
* release main ([#1767](https://github.com/vibeunion/supacloud/issues/1767)) ([d31bf06](https://github.com/vibeunion/supacloud/commit/d31bf06a2bfbdb353554a44576d0c54685f46193))
* release main ([#1782](https://github.com/vibeunion/supacloud/issues/1782)) ([e433bc9](https://github.com/vibeunion/supacloud/commit/e433bc99a7239b606083ebb7801b646c7dc80f35))
* release main ([#1790](https://github.com/vibeunion/supacloud/issues/1790)) ([5a79325](https://github.com/vibeunion/supacloud/commit/5a793255c9e38b359dbf8505304edafcbc7140e6))
* release main ([#1792](https://github.com/vibeunion/supacloud/issues/1792)) ([68cf37d](https://github.com/vibeunion/supacloud/commit/68cf37db6a59f5f217cde6fd71f4081661eb121a))
* release main ([#1797](https://github.com/vibeunion/supacloud/issues/1797)) ([8ef9a93](https://github.com/vibeunion/supacloud/commit/8ef9a93dba7f13cdd0919a75e2801b86679200cd))
* release main ([#1799](https://github.com/vibeunion/supacloud/issues/1799)) ([c5cc266](https://github.com/vibeunion/supacloud/commit/c5cc266297115923f6f959442c6c2bdf61c37838))
* release main ([#1801](https://github.com/vibeunion/supacloud/issues/1801)) ([e3ef908](https://github.com/vibeunion/supacloud/commit/e3ef90828bdde715ed48d475ad69bb7e078ec3c8))
* release main ([#1803](https://github.com/vibeunion/supacloud/issues/1803)) ([225f3e3](https://github.com/vibeunion/supacloud/commit/225f3e38d6d59f7e5bf26ea08fe511eeea845630))
* release main ([#1809](https://github.com/vibeunion/supacloud/issues/1809)) ([29edcea](https://github.com/vibeunion/supacloud/commit/29edceaf39f98d42d28327fcfb60bb46558e7113))
* release main ([#1825](https://github.com/vibeunion/supacloud/issues/1825)) ([4819f95](https://github.com/vibeunion/supacloud/commit/4819f95ae7ce722b58f4858261c100c448c9975e))
* release main ([#1830](https://github.com/vibeunion/supacloud/issues/1830)) ([011c3f4](https://github.com/vibeunion/supacloud/commit/011c3f45fdbc21acccbb99edfa9220ff434b7403))
* release main ([#1831](https://github.com/vibeunion/supacloud/issues/1831)) ([d1853be](https://github.com/vibeunion/supacloud/commit/d1853bea19e5fb0e98eb176d7891c66638538320))
* release main ([#1833](https://github.com/vibeunion/supacloud/issues/1833)) ([7324384](https://github.com/vibeunion/supacloud/commit/7324384b04d358a5a80a3beb1f6d904e4becc28a))
* release main ([#1839](https://github.com/vibeunion/supacloud/issues/1839)) ([1fb9925](https://github.com/vibeunion/supacloud/commit/1fb99259a1c9a2739bb15d730e004328477b0565))
* release main ([#1841](https://github.com/vibeunion/supacloud/issues/1841)) ([5870ac2](https://github.com/vibeunion/supacloud/commit/5870ac200eac3241ca1d882079b776ef322e9b1e))
* release main ([#1843](https://github.com/vibeunion/supacloud/issues/1843)) ([a3d1f2a](https://github.com/vibeunion/supacloud/commit/a3d1f2abc91cd52b3e5c7de1b6d19bf759808499))
* release main ([#1853](https://github.com/vibeunion/supacloud/issues/1853)) ([5b0dbf7](https://github.com/vibeunion/supacloud/commit/5b0dbf7c3ffbdedb3c14e1d8c65ca1c26e716ed7))
* release main ([#1857](https://github.com/vibeunion/supacloud/issues/1857)) ([6b98454](https://github.com/vibeunion/supacloud/commit/6b9845403733f7ffac7711587982979d928702b2))
* release main ([#1861](https://github.com/vibeunion/supacloud/issues/1861)) ([6740add](https://github.com/vibeunion/supacloud/commit/6740add814e9ac6463c4fd12f558a2586ce6e94d))
* release main ([#1871](https://github.com/vibeunion/supacloud/issues/1871)) ([3204690](https://github.com/vibeunion/supacloud/commit/3204690efa816ffaea246e4990b544a8795feebb))
* release main ([#1873](https://github.com/vibeunion/supacloud/issues/1873)) ([105aa74](https://github.com/vibeunion/supacloud/commit/105aa74268a67ea94d7095c2f742738dfaaea871))
* release main ([#1880](https://github.com/vibeunion/supacloud/issues/1880)) ([4af45f2](https://github.com/vibeunion/supacloud/commit/4af45f23e9559b5595c7606a6715a6e728e237d7))
* release main ([#1898](https://github.com/vibeunion/supacloud/issues/1898)) ([8c624dc](https://github.com/vibeunion/supacloud/commit/8c624dc4d8916700ec30401fe28864bf47789f7c))
* release main ([#1930](https://github.com/vibeunion/supacloud/issues/1930)) ([2a0a7fa](https://github.com/vibeunion/supacloud/commit/2a0a7fa8ad5c2d88bd8b9ce76b9a6a1744428eb4))
* release main ([#1937](https://github.com/vibeunion/supacloud/issues/1937)) ([c63b5dd](https://github.com/vibeunion/supacloud/commit/c63b5dd722571e884dbbca379781ecf44542d643))
* release main ([#1944](https://github.com/vibeunion/supacloud/issues/1944)) ([206d711](https://github.com/vibeunion/supacloud/commit/206d711a0012bad9465283f2f2bfc5f4eb80d269))
* release main ([#1960](https://github.com/vibeunion/supacloud/issues/1960)) ([1ea85ac](https://github.com/vibeunion/supacloud/commit/1ea85acbe15eed33570672f67f341a7612bf69ac))
* release main ([#1974](https://github.com/vibeunion/supacloud/issues/1974)) ([f0273f5](https://github.com/vibeunion/supacloud/commit/f0273f5a33843be18e01adbce7575209e3ce470e))
* release main ([#1982](https://github.com/vibeunion/supacloud/issues/1982)) ([02cb9a7](https://github.com/vibeunion/supacloud/commit/02cb9a7011588e7d02e22a84f972c324e4983de4))
* release main ([#1993](https://github.com/vibeunion/supacloud/issues/1993)) ([e9198c5](https://github.com/vibeunion/supacloud/commit/e9198c5adc2012517495b7da9dc0573a80e0bdfc))
* release main ([#2030](https://github.com/vibeunion/supacloud/issues/2030)) ([2f7cf91](https://github.com/vibeunion/supacloud/commit/2f7cf91d941ab583ebe21d901069a16e55efc48a))
* upgrade dependencies and caddy ([#1821](https://github.com/vibeunion/supacloud/issues/1821)) ([91c9a4b](https://github.com/vibeunion/supacloud/commit/91c9a4bd0a14f757670822a1aa953643a00a83c9))
* upgrade workspace dependencies ([#1940](https://github.com/vibeunion/supacloud/issues/1940)) ([77ad418](https://github.com/vibeunion/supacloud/commit/77ad418e0568ceeeea0b59a10a3bbc451a68a95f))
</details>

<details><summary>edge-runtime: 0.34.0</summary>

## [0.34.0](https://github.com/vibeunion/supacloud/compare/edge-runtime-v0.33.0...edge-runtime-v0.34.0) (2026-10-17)


### Features

* **app:** add governed reactive event streams and lifecycle signals ([38a26e2](https://github.com/vibeunion/supacloud/commit/38a26e2d3b83226a7488df2ef4f1f5714573aeb2))
* batch server-owned release preparation and simplify deploy output ([#1856](https://github.com/vibeunion/supacloud/issues/1856)) ([599d274](https://github.com/vibeunion/supacloud/commit/599d274285accb04a7e9e04617d8c91d40fa2b2a))
* **elysia:** Elysia 2 AOT evaluation and end-to-end typing architecture ([#1654](https://github.com/vibeunion/supacloud/issues/1654)) ([39ee49f](https://github.com/vibeunion/supacloud/commit/39ee49f760e85e789c43c1d18cf5729db592f6bc))
* **gateway:** auto-configure Function CORS origins ([#1749](https://github.com/vibeunion/supacloud/issues/1749)) ([5b6853b](https://github.com/vibeunion/supacloud/commit/5b6853bd563297cb632aee3b9b7e6729de18d0f4))
* **governance:** enforce strict user and platform type contracts ([#1754](https://github.com/vibeunion/supacloud/issues/1754)) ([b22f889](https://github.com/vibeunion/supacloud/commit/b22f88919c349f088848028f13b15e44994e0d9c))


### Bug Fixes

* **auth:** bind service JWT verification to project public signer ([#1958](https://github.com/vibeunion/supacloud/issues/1958)) ([21846c2](https://github.com/vibeunion/supacloud/commit/21846c2b8f7973739c848257a8a7c753b0b3fb4b))
* **edge-runtime:** apply memory admission backpressure ([#1894](https://github.com/vibeunion/supacloud/issues/1894)) ([5f0b310](https://github.com/vibeunion/supacloud/commit/5f0b3109ec00e6b207581cfda312466816214429))
* **edge-runtime:** avoid recycling on idle memory plateau ([#1520](https://github.com/vibeunion/supacloud/issues/1520)) ([1241ee8](https://github.com/vibeunion/supacloud/commit/1241ee83ad1b6f411713a3c00923fdcb3c79de58))
* **edge-runtime:** bound default worker memory ([#1896](https://github.com/vibeunion/supacloud/issues/1896)) ([8790b91](https://github.com/vibeunion/supacloud/commit/8790b9167543c36b6f39e9554f85f3bd01617c58))
* **edge-runtime:** default Function CORS mode to auto ([#1834](https://github.com/vibeunion/supacloud/issues/1834)) ([61e1bdd](https://github.com/vibeunion/supacloud/commit/61e1bddd4b678933a09fe6ea9f45cbc7e9352c06))
* **edge-runtime:** exclude immediate dispatch from queue wait ([#1932](https://github.com/vibeunion/supacloud/issues/1932)) ([609ec39](https://github.com/vibeunion/supacloud/commit/609ec39dfad5b773852ad316adddd328f0a65842))
* **edge-runtime:** preserve guarded constructor identity ([#1680](https://github.com/vibeunion/supacloud/issues/1680)) ([2bae9a1](https://github.com/vibeunion/supacloud/commit/2bae9a12dd276bd2d4822e7fb2f978374a2e40d0))
* **edge-runtime:** recover admission and retain project workers ([#1897](https://github.com/vibeunion/supacloud/issues/1897)) ([26e6faf](https://github.com/vibeunion/supacloud/commit/26e6faf545e2054b689e5b17e84f36f299aa453d))
* **edge-runtime:** separate parked retirement attestation from execution slots ([#1985](https://github.com/vibeunion/supacloud/issues/1985)) ([575c8bd](https://github.com/vibeunion/supacloud/commit/575c8bd376c6e2d547db2581f05756e8d832f8e2))
* **edge-runtime:** transfer binary payloads without extra copies ([#1928](https://github.com/vibeunion/supacloud/issues/1928)) ([022ec59](https://github.com/vibeunion/supacloud/commit/022ec59d0e1e11f74b7ce5c2f7cfeec9ac90a864))
* integrate reviewed customer, auth and release repairs ([#2027](https://github.com/vibeunion/supacloud/issues/2027)) ([5c07903](https://github.com/vibeunion/supacloud/commit/5c07903f20bfb069229cf3a829886fe96c78c288))


### Miscellaneous Chores

* adopt AGPL-3.0-only licensing ([#1481](https://github.com/vibeunion/supacloud/issues/1481)) ([8787ad9](https://github.com/vibeunion/supacloud/commit/8787ad9466ebba8f487d28bf62d5f79a220b0ab8))
* adopt current Supabase SDK baseline ([#1698](https://github.com/vibeunion/supacloud/issues/1698)) ([4e6613a](https://github.com/vibeunion/supacloud/commit/4e6613aeda3c5958e44cbe9604e30cce0622a66f))
* **deps-dev:** bump @types/node in /packages/edge-runtime ([#1713](https://github.com/vibeunion/supacloud/issues/1713)) ([d213b15](https://github.com/vibeunion/supacloud/commit/d213b1535d9970d52b71e74611a7c906f895e7d2))
* **deps:** bump es-module-lexer in /packages/edge-runtime ([#1719](https://github.com/vibeunion/supacloud/issues/1719)) ([1a61870](https://github.com/vibeunion/supacloud/commit/1a6187085a154d86f6d8f13a068be33e2985364a))
* **deps:** complete @sinclair/typebox to typebox 1.3.34 migration ([#1655](https://github.com/vibeunion/supacloud/issues/1655)) ([87d1133](https://github.com/vibeunion/supacloud/commit/87d1133c0fa0eadf145afc6c3747f693e3e36200))
* release main ([#1484](https://github.com/vibeunion/supacloud/issues/1484)) ([41b3e72](https://github.com/vibeunion/supacloud/commit/41b3e72d25dd8b1ea1d3dea5b75c90bdea9be797))
* release main ([#1507](https://github.com/vibeunion/supacloud/issues/1507)) ([b7f3a59](https://github.com/vibeunion/supacloud/commit/b7f3a59885596742a8b11fc808d898165a8989ec))
* release main ([#1561](https://github.com/vibeunion/supacloud/issues/1561)) ([3ee71e3](https://github.com/vibeunion/supacloud/commit/3ee71e301e7a5499780b45ec6c64e53698000029))
* release main ([#1657](https://github.com/vibeunion/supacloud/issues/1657)) ([1a3f7ff](https://github.com/vibeunion/supacloud/commit/1a3f7ff901f05dda38ed4827d70a91a4acccd8b3))
* release main ([#1681](https://github.com/vibeunion/supacloud/issues/1681)) ([c804f96](https://github.com/vibeunion/supacloud/commit/c804f96c450e193f37f182f81002fd5ff65dfe68))
* release main ([#1695](https://github.com/vibeunion/supacloud/issues/1695)) ([2b9da10](https://github.com/vibeunion/supacloud/commit/2b9da1004b8cc1fd78cfcad79110d5c5eba5349d))
* release main ([#1736](https://github.com/vibeunion/supacloud/issues/1736)) ([0916385](https://github.com/vibeunion/supacloud/commit/09163851882373d5cc1f647e9e8d94aa1d441187))
* release main ([#1752](https://github.com/vibeunion/supacloud/issues/1752)) ([c7e8496](https://github.com/vibeunion/supacloud/commit/c7e8496de45420ac6da2513bd8e97c90f668469d))
* release main ([#1767](https://github.com/vibeunion/supacloud/issues/1767)) ([d31bf06](https://github.com/vibeunion/supacloud/commit/d31bf06a2bfbdb353554a44576d0c54685f46193))
* release main ([#1825](https://github.com/vibeunion/supacloud/issues/1825)) ([4819f95](https://github.com/vibeunion/supacloud/commit/4819f95ae7ce722b58f4858261c100c448c9975e))
* release main ([#1836](https://github.com/vibeunion/supacloud/issues/1836)) ([e09aa0e](https://github.com/vibeunion/supacloud/commit/e09aa0ef48fa795be302333da8706d120fcc06bc))
* release main ([#1857](https://github.com/vibeunion/supacloud/issues/1857)) ([6b98454](https://github.com/vibeunion/supacloud/commit/6b9845403733f7ffac7711587982979d928702b2))
* release main ([#1895](https://github.com/vibeunion/supacloud/issues/1895)) ([6991743](https://github.com/vibeunion/supacloud/commit/69917439dd0feab442fd651a61da2d0bfb0fef53))
* release main ([#1898](https://github.com/vibeunion/supacloud/issues/1898)) ([8c624dc](https://github.com/vibeunion/supacloud/commit/8c624dc4d8916700ec30401fe28864bf47789f7c))
* release main ([#1900](https://github.com/vibeunion/supacloud/issues/1900)) ([a0db9b7](https://github.com/vibeunion/supacloud/commit/a0db9b7d013803c4d31605adf125f7b6759008cf))
* release main ([#1930](https://github.com/vibeunion/supacloud/issues/1930)) ([2a0a7fa](https://github.com/vibeunion/supacloud/commit/2a0a7fa8ad5c2d88bd8b9ce76b9a6a1744428eb4))
* release main ([#1933](https://github.com/vibeunion/supacloud/issues/1933)) ([6d06b9c](https://github.com/vibeunion/supacloud/commit/6d06b9cb6beddeb585f6717fd153862f5f97bb92))
* release main ([#1944](https://github.com/vibeunion/supacloud/issues/1944)) ([206d711](https://github.com/vibeunion/supacloud/commit/206d711a0012bad9465283f2f2bfc5f4eb80d269))
* release main ([#1960](https://github.com/vibeunion/supacloud/issues/1960)) ([1ea85ac](https://github.com/vibeunion/supacloud/commit/1ea85acbe15eed33570672f67f341a7612bf69ac))
* release main ([#1982](https://github.com/vibeunion/supacloud/issues/1982)) ([02cb9a7](https://github.com/vibeunion/supacloud/commit/02cb9a7011588e7d02e22a84f972c324e4983de4))
* release main ([#2030](https://github.com/vibeunion/supacloud/issues/2030)) ([2f7cf91](https://github.com/vibeunion/supacloud/commit/2f7cf91d941ab583ebe21d901069a16e55efc48a))
* upgrade dependencies and caddy ([#1821](https://github.com/vibeunion/supacloud/issues/1821)) ([91c9a4b](https://github.com/vibeunion/supacloud/commit/91c9a4bd0a14f757670822a1aa953643a00a83c9))
* upgrade workspace dependencies ([#1940](https://github.com/vibeunion/supacloud/issues/1940)) ([77ad418](https://github.com/vibeunion/supacloud/commit/77ad418e0568ceeeea0b59a10a3bbc451a68a95f))
</details>

<details><summary>supacloud-lite: 0.31.0</summary>

## [0.31.0](https://github.com/vibeunion/supacloud/compare/supacloud-lite-v0.30.0...supacloud-lite-v0.31.0) (2026-10-17)


###   BREAKING CHANGES

* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.
* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.

### Features

* add agent backend authoring, runtime and observability workflows ([#1648](https://github.com/vibeunion/supacloud/issues/1648)) ([59a66d1](https://github.com/vibeunion/supacloud/commit/59a66d184a47d19c7f8895f24a6ba2c7e74e93d0))
* **app:** add governed reactive event streams and lifecycle signals ([38a26e2](https://github.com/vibeunion/supacloud/commit/38a26e2d3b83226a7488df2ef4f1f5714573aeb2))
* **compiler:** enforce vibecoding defaults ([886c82f](https://github.com/vibeunion/supacloud/commit/886c82f1462261e10c490586cc9446cb447a21ae))
* converge SDK-aware vibecoding defaults and local development ([#1607](https://github.com/vibeunion/supacloud/issues/1607)) ([cd66672](https://github.com/vibeunion/supacloud/commit/cd6667252a6a8fe0cc0539bc8610ebb8a818af51))
* default RxJS support with compatible SupaCloud JS calls ([#1556](https://github.com/vibeunion/supacloud/issues/1556)) ([b3015cb](https://github.com/vibeunion/supacloud/commit/b3015cb161c0d87e6611f6c4fc60c120a8c9fffe))
* **effect:** upgrade runtime governance to Effect 4 ([#1748](https://github.com/vibeunion/supacloud/issues/1748)) ([2b48efc](https://github.com/vibeunion/supacloud/commit/2b48efcbe78db2a61c0c086f3350eaa87c697e90))
* **elysia:** Elysia 2 AOT evaluation and end-to-end typing architecture ([#1654](https://github.com/vibeunion/supacloud/issues/1654)) ([39ee49f](https://github.com/vibeunion/supacloud/commit/39ee49f760e85e789c43c1d18cf5729db592f6bc))
* enable strict Effect route governance by default ([#1742](https://github.com/vibeunion/supacloud/issues/1742)) ([4e18c90](https://github.com/vibeunion/supacloud/commit/4e18c908b9c08a8895be016b4e00a0158bf539c6))
* **governance:** enforce strict user and platform type contracts ([#1754](https://github.com/vibeunion/supacloud/issues/1754)) ([b22f889](https://github.com/vibeunion/supacloud/commit/b22f88919c349f088848028f13b15e44994e0d9c))
* **lite:** add offline auth user provisioning ([#1911](https://github.com/vibeunion/supacloud/issues/1911)) ([e9c8931](https://github.com/vibeunion/supacloud/commit/e9c89319cf39d9fe2d71ceac9ab76e6856bb5d84))
* **lite:** bundle PostgreSQL extension parity set ([#1849](https://github.com/vibeunion/supacloud/issues/1849)) ([233fb1b](https://github.com/vibeunion/supacloud/commit/233fb1bb9d52673a7f38d77d47e8c1e6c0b7c5e4))
* **platform:** close application platform P0/P1 capabilities ([dbaf3a6](https://github.com/vibeunion/supacloud/commit/dbaf3a6d01daa71455a8cde96e9e233743bfdfca))
* reduce approval infrastructure wiring and reuse business contracts ([#1948](https://github.com/vibeunion/supacloud/issues/1948)) ([7c68543](https://github.com/vibeunion/supacloud/commit/7c6854338968209c2bbd658782224db238650aeb))


### Bug Fixes

* **deps,perf:** replace Bun native APIs and resolve audit vulnerabilities ([#1667](https://github.com/vibeunion/supacloud/issues/1667)) ([06a9199](https://github.com/vibeunion/supacloud/commit/06a91990c754ce586f2a2353f253dc50f4fa0f98))
* integrate reviewed customer, auth and release repairs ([#2027](https://github.com/vibeunion/supacloud/issues/2027)) ([5c07903](https://github.com/vibeunion/supacloud/commit/5c07903f20bfb069229cf3a829886fe96c78c288))
* **lite:** classify PL/pgSQL failures as server errors ([#1986](https://github.com/vibeunion/supacloud/issues/1986)) ([27c5e29](https://github.com/vibeunion/supacloud/commit/27c5e29b351e2b6bc0d3da55a1ccb6607e4e06a5))
* **lite:** close backend after startup failure ([#1903](https://github.com/vibeunion/supacloud/issues/1903)) ([3de47be](https://github.com/vibeunion/supacloud/commit/3de47be7821072b88563d51ee388bf76062040f4))
* **lite:** enforce read-only table and view requests ([#1941](https://github.com/vibeunion/supacloud/issues/1941)) ([d726716](https://github.com/vibeunion/supacloud/commit/d726716a1492a5a581f99a1aa40f15a1125a23aa))
* **lite:** enforce RPC transaction access modes ([#1936](https://github.com/vibeunion/supacloud/issues/1936)) ([fb90dcc](https://github.com/vibeunion/supacloud/commit/fb90dcc43ed49a45656e1877493eaa641ef494da))
* **lite:** normalize filesystem storage roots ([#1902](https://github.com/vibeunion/supacloud/issues/1902)) ([f1b5141](https://github.com/vibeunion/supacloud/commit/f1b5141c1e831e68aaf94b505909c9e4942a42df))
* **lite:** preserve single-column table RPC responses ([#1971](https://github.com/vibeunion/supacloud/issues/1971)) ([63edb93](https://github.com/vibeunion/supacloud/commit/63edb937322130796260a1284c09cc895735214e))
* **lite:** reject ineligible password logins ([#1998](https://github.com/vibeunion/supacloud/issues/1998)) ([479e967](https://github.com/vibeunion/supacloud/commit/479e96719209f7aed26c44663d78e1442a7097f0))
* **lite:** report effective local auth configuration in doctor ([#1907](https://github.com/vibeunion/supacloud/issues/1907)) ([c167617](https://github.com/vibeunion/supacloud/commit/c1676176bdd5a2c057114474186570b7e6d5d0dd))
* **lite:** resolve RPC overloads using required arguments ([#1967](https://github.com/vibeunion/supacloud/issues/1967)) ([e00ffaf](https://github.com/vibeunion/supacloud/commit/e00ffafd41aa52c8f14c2e81f3bb8a8914b336c8))
* **lite:** roll back rejected singular REST writes ([#1925](https://github.com/vibeunion/supacloud/issues/1925)) ([0af235d](https://github.com/vibeunion/supacloud/commit/0af235d55a3619ffd150e4b16751a27a32d1f2e0))
* pin Elysia 2 beta compatibility boundary ([#1467](https://github.com/vibeunion/supacloud/issues/1467)) ([bdb2a2e](https://github.com/vibeunion/supacloud/commit/bdb2a2e658cae4160f2a774b5c459d1a2d8fb601))
* **worker:** ship reviewed PGMQ job controls and concurrency repairs ([#1689](https://github.com/vibeunion/supacloud/issues/1689)) ([e283915](https://github.com/vibeunion/supacloud/commit/e283915e66e119b75ad1b909e18816270b5d01e3))


### Elegance & Refactoring

* use ESM-only owned packages and Lite launcher ([#1582](https://github.com/vibeunion/supacloud/issues/1582)) ([ed5ac78](https://github.com/vibeunion/supacloud/commit/ed5ac78ee3ab22567268fa276e5b016ad1e8b575))


### Miscellaneous Chores

* adopt AGPL-3.0-only licensing ([#1481](https://github.com/vibeunion/supacloud/issues/1481)) ([8787ad9](https://github.com/vibeunion/supacloud/commit/8787ad9466ebba8f487d28bf62d5f79a220b0ab8))
* adopt current Supabase SDK baseline ([#1698](https://github.com/vibeunion/supacloud/issues/1698)) ([4e6613a](https://github.com/vibeunion/supacloud/commit/4e6613aeda3c5958e44cbe9604e30cce0622a66f))
* release main ([#1474](https://github.com/vibeunion/supacloud/issues/1474)) ([6255eb7](https://github.com/vibeunion/supacloud/commit/6255eb7e7eefc4ee5cd06bef05d4c81a29be706a))
* release main ([#1484](https://github.com/vibeunion/supacloud/issues/1484)) ([41b3e72](https://github.com/vibeunion/supacloud/commit/41b3e72d25dd8b1ea1d3dea5b75c90bdea9be797))
* release main ([#1561](https://github.com/vibeunion/supacloud/issues/1561)) ([3ee71e3](https://github.com/vibeunion/supacloud/commit/3ee71e301e7a5499780b45ec6c64e53698000029))
* release main ([#1609](https://github.com/vibeunion/supacloud/issues/1609)) ([b52c79c](https://github.com/vibeunion/supacloud/commit/b52c79ceda912786f1299ae2d618172f9252607a))
* release main ([#1647](https://github.com/vibeunion/supacloud/issues/1647)) ([9afdb5c](https://github.com/vibeunion/supacloud/commit/9afdb5c348a2e87169e8898b3842091bb8f1ddea))
* release main ([#1657](https://github.com/vibeunion/supacloud/issues/1657)) ([1a3f7ff](https://github.com/vibeunion/supacloud/commit/1a3f7ff901f05dda38ed4827d70a91a4acccd8b3))
* release main ([#1668](https://github.com/vibeunion/supacloud/issues/1668)) ([a7ce18b](https://github.com/vibeunion/supacloud/commit/a7ce18b73e0a2e93df664fb8da08cd40f3bdae82))
* release main ([#1691](https://github.com/vibeunion/supacloud/issues/1691)) ([2d47123](https://github.com/vibeunion/supacloud/commit/2d47123013522350129d49480ce6d132595976db))
* release main ([#1695](https://github.com/vibeunion/supacloud/issues/1695)) ([2b9da10](https://github.com/vibeunion/supacloud/commit/2b9da1004b8cc1fd78cfcad79110d5c5eba5349d))
* release main ([#1743](https://github.com/vibeunion/supacloud/issues/1743)) ([dcbf82c](https://github.com/vibeunion/supacloud/commit/dcbf82c29fb6de94bd6be0c37df20662a6861b2e))
* release main ([#1747](https://github.com/vibeunion/supacloud/issues/1747)) ([cbdf2a4](https://github.com/vibeunion/supacloud/commit/cbdf2a426aeb5a405a4d27820fdfb51dd489b93a))
* release main ([#1767](https://github.com/vibeunion/supacloud/issues/1767)) ([d31bf06](https://github.com/vibeunion/supacloud/commit/d31bf06a2bfbdb353554a44576d0c54685f46193))
* release main ([#1825](https://github.com/vibeunion/supacloud/issues/1825)) ([4819f95](https://github.com/vibeunion/supacloud/commit/4819f95ae7ce722b58f4858261c100c448c9975e))
* release main ([#1857](https://github.com/vibeunion/supacloud/issues/1857)) ([6b98454](https://github.com/vibeunion/supacloud/commit/6b9845403733f7ffac7711587982979d928702b2))
* release main ([#1890](https://github.com/vibeunion/supacloud/issues/1890)) ([8b88c00](https://github.com/vibeunion/supacloud/commit/8b88c00e4eb523203520757219be1bc42e45e44d))
* release main ([#1904](https://github.com/vibeunion/supacloud/issues/1904)) ([c9dc22b](https://github.com/vibeunion/supacloud/commit/c9dc22b89383eefffe11ae4cfa6df57114165a78))
* release main ([#1909](https://github.com/vibeunion/supacloud/issues/1909)) ([e6590d5](https://github.com/vibeunion/supacloud/commit/e6590d539d92bd99a31e91f9a48f98d0d5a177a5))
* release main ([#1930](https://github.com/vibeunion/supacloud/issues/1930)) ([2a0a7fa](https://github.com/vibeunion/supacloud/commit/2a0a7fa8ad5c2d88bd8b9ce76b9a6a1744428eb4))
* release main ([#1937](https://github.com/vibeunion/supacloud/issues/1937)) ([c63b5dd](https://github.com/vibeunion/supacloud/commit/c63b5dd722571e884dbbca379781ecf44542d643))
* release main ([#1944](https://github.com/vibeunion/supacloud/issues/1944)) ([206d711](https://github.com/vibeunion/supacloud/commit/206d711a0012bad9465283f2f2bfc5f4eb80d269))
* release main ([#1952](https://github.com/vibeunion/supacloud/issues/1952)) ([1693369](https://github.com/vibeunion/supacloud/commit/1693369010c63e77de8012d0a8acd7b116def94c))
* release main ([#1955](https://github.com/vibeunion/supacloud/issues/1955)) ([1d93a49](https://github.com/vibeunion/supacloud/commit/1d93a491a8ee2b514e18b802db71233c4535bc23))
* release main ([#1969](https://github.com/vibeunion/supacloud/issues/1969)) ([89ba2f7](https://github.com/vibeunion/supacloud/commit/89ba2f77a0f8831cd4be3aa9ccca81886ec3bfb0))
* release main ([#1982](https://github.com/vibeunion/supacloud/issues/1982)) ([02cb9a7](https://github.com/vibeunion/supacloud/commit/02cb9a7011588e7d02e22a84f972c324e4983de4))
* release main ([#1988](https://github.com/vibeunion/supacloud/issues/1988)) ([e1b912d](https://github.com/vibeunion/supacloud/commit/e1b912df24c27cf822d1f82df6561248783abbb5))
* release main ([#1999](https://github.com/vibeunion/supacloud/issues/1999)) ([af2a885](https://github.com/vibeunion/supacloud/commit/af2a885e70d8baf3bad4cc3c8264efe62b87d8e9))
* release main ([#2030](https://github.com/vibeunion/supacloud/issues/2030)) ([2f7cf91](https://github.com/vibeunion/supacloud/commit/2f7cf91d941ab583ebe21d901069a16e55efc48a))
* unify project licensing under Apache-2.0 ([#1566](https://github.com/vibeunion/supacloud/issues/1566)) ([36dd377](https://github.com/vibeunion/supacloud/commit/36dd37796147a5e7051534d6d9535f13ad881a93))
* upgrade dependencies and caddy ([#1821](https://github.com/vibeunion/supacloud/issues/1821)) ([91c9a4b](https://github.com/vibeunion/supacloud/commit/91c9a4bd0a14f757670822a1aa953643a00a83c9))
* upgrade workspace dependencies ([#1940](https://github.com/vibeunion/supacloud/issues/1940)) ([77ad418](https://github.com/vibeunion/supacloud/commit/77ad418e0568ceeeea0b59a10a3bbc451a68a95f))
</details>

<details><summary>cli: 0.103.4</summary>

## [0.103.4](https://github.com/vibeunion/supacloud/compare/cli-v0.103.3...cli-v0.103.4) (2026-10-17)


### Bug Fixes

* **cli:** preserve starter recovery on malformed outcomes ([#2011](https://github.com/vibeunion/supacloud/issues/2011)) ([5b32129](https://github.com/vibeunion/supacloud/commit/5b321290b0099bf7cab9f02fcdff801a4c9eb4de))
* **cli:** validate starter query page envelopes ([#2009](https://github.com/vibeunion/supacloud/issues/2009)) ([e8d392b](https://github.com/vibeunion/supacloud/commit/e8d392bb8ad05ca164bbb3b5e383a95b09aba80a))
* integrate reviewed customer, auth and release repairs ([#2027](https://github.com/vibeunion/supacloud/issues/2027)) ([5c07903](https://github.com/vibeunion/supacloud/commit/5c07903f20bfb069229cf3a829886fe96c78c288))


### Miscellaneous Chores

* release main ([#2030](https://github.com/vibeunion/supacloud/issues/2030)) ([2f7cf91](https://github.com/vibeunion/supacloud/commit/2f7cf91d941ab583ebe21d901069a16e55efc48a))
</details>

<details><summary>app-svelte: 0.6.0</summary>

## [0.6.0](https://github.com/vibeunion/supacloud/compare/app-svelte-v0.5.2...app-svelte-v0.6.0) (2026-10-17)


### Features

* **app:** add governed reactive event streams and lifecycle signals ([38a26e2](https://github.com/vibeunion/supacloud/commit/38a26e2d3b83226a7488df2ef4f1f5714573aeb2))
* **supacloud-js:** add framework-neutral TanStack Query adapter ([#1637](https://github.com/vibeunion/supacloud/issues/1637)) ([071b28c](https://github.com/vibeunion/supacloud/commit/071b28c5ce992834f46a0608d68475eb295c5c3e))


### Miscellaneous Chores

* adopt AGPL-3.0-only licensing ([#1481](https://github.com/vibeunion/supacloud/issues/1481)) ([8787ad9](https://github.com/vibeunion/supacloud/commit/8787ad9466ebba8f487d28bf62d5f79a220b0ab8))
* release main ([#1484](https://github.com/vibeunion/supacloud/issues/1484)) ([41b3e72](https://github.com/vibeunion/supacloud/commit/41b3e72d25dd8b1ea1d3dea5b75c90bdea9be797))
* release main ([#1561](https://github.com/vibeunion/supacloud/issues/1561)) ([3ee71e3](https://github.com/vibeunion/supacloud/commit/3ee71e301e7a5499780b45ec6c64e53698000029))
* release main ([#1638](https://github.com/vibeunion/supacloud/issues/1638)) ([1857d39](https://github.com/vibeunion/supacloud/commit/1857d39b2639e5ddf8f0a671b4167ba9c2f15c39))
* release main ([#1825](https://github.com/vibeunion/supacloud/issues/1825)) ([4819f95](https://github.com/vibeunion/supacloud/commit/4819f95ae7ce722b58f4858261c100c448c9975e))
* release main ([#2030](https://github.com/vibeunion/supacloud/issues/2030)) ([2f7cf91](https://github.com/vibeunion/supacloud/commit/2f7cf91d941ab583ebe21d901069a16e55efc48a))
* upgrade dependencies and caddy ([#1821](https://github.com/vibeunion/supacloud/issues/1821)) ([91c9a4b](https://github.com/vibeunion/supacloud/commit/91c9a4bd0a14f757670822a1aa953643a00a83c9))
</details>

<details><summary>app: 0.28.0</summary>

## [0.28.0](https://github.com/vibeunion/supacloud/compare/app-v0.27.2...app-v0.28.0) (2026-10-17)


###   BREAKING CHANGES

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
</details>

<details><summary>compiler: 0.47.0</summary>

## [0.47.0](https://github.com/vibeunion/supacloud/compare/compiler-v0.46.7...compiler-v0.47.0) (2026-10-17)


###   BREAKING CHANGES

* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.

### Features

* add agent backend authoring, runtime and observability workflows ([#1648](https://github.com/vibeunion/supacloud/issues/1648)) ([59a66d1](https://github.com/vibeunion/supacloud/commit/59a66d184a47d19c7f8895f24a6ba2c7e74e93d0))
* add Supabase-compatible procedure client transport ([#1634](https://github.com/vibeunion/supacloud/issues/1634)) ([661351a](https://github.com/vibeunion/supacloud/commit/661351ae507877a463a5aab1bd49a27c9bd77cfa))
* **app:** add governed reactive event streams and lifecycle signals ([38a26e2](https://github.com/vibeunion/supacloud/commit/38a26e2d3b83226a7488df2ef4f1f5714573aeb2))
* **cli:** make supacloud the one-command deploy entrypoint ([#1817](https://github.com/vibeunion/supacloud/issues/1817)) ([4be5da5](https://github.com/vibeunion/supacloud/commit/4be5da5a9284220610474ca290c708ce982d51bf))
* **compiler,query,supacloud-js:** procedure façade, supabase-js compatibility, and @supacloud/query adapter ([#1653](https://github.com/vibeunion/supacloud/issues/1653)) ([8ed8d1a](https://github.com/vibeunion/supacloud/commit/8ed8d1ad594ab981e6d03333ad35248608467992))
* **compiler:** add application development context contract (P1-4) ([#1516](https://github.com/vibeunion/supacloud/issues/1516)) ([8bf40fc](https://github.com/vibeunion/supacloud/commit/8bf40fc5988aaf075c7c3d8a319798bb11e366fd))
* **compiler:** add business execution timeline to execution context (P0-3) ([#1515](https://github.com/vibeunion/supacloud/issues/1515)) ([0ec5ace](https://github.com/vibeunion/supacloud/commit/0ec5ace9c5be047a8b73b1da6ed58a5a55ab687b))
* **compiler:** add line-ending-normalized GraphQL schema diagnostics ([#1595](https://github.com/vibeunion/supacloud/issues/1595)) ([5aa4ec5](https://github.com/vibeunion/supacloud/commit/5aa4ec50a82fbf1b0a22b051039516ab5e46cf9c))
* **compiler:** add validated application resource model ([#1512](https://github.com/vibeunion/supacloud/issues/1512)) ([c7ed93b](https://github.com/vibeunion/supacloud/commit/c7ed93b5cd50107ba0c61ac002e1c254907aa6a5))
* **compiler:** diagnose browser-unsafe client schemas ([#1679](https://github.com/vibeunion/supacloud/issues/1679)) ([18582fc](https://github.com/vibeunion/supacloud/commit/18582fcc0384246d87660cb42b6b4acbdc475b5e))
* **compiler:** enforce database governance mode ([#1869](https://github.com/vibeunion/supacloud/issues/1869)) ([e5fc691](https://github.com/vibeunion/supacloud/commit/e5fc69198e6220ddf5ccbc58e1f5b31804f05273))
* **compiler:** enforce semantic Effect guardrails ([#1746](https://github.com/vibeunion/supacloud/issues/1746)) ([d1995ef](https://github.com/vibeunion/supacloud/commit/d1995ef1add86792946b5efa03e0dfb43386e3e6))
* **compiler:** enforce vibecoding defaults ([886c82f](https://github.com/vibeunion/supacloud/commit/886c82f1462261e10c490586cc9446cb447a21ae))
* **compiler:** make database source governance deterministic by default ([#1875](https://github.com/vibeunion/supacloud/issues/1875)) ([e340aed](https://github.com/vibeunion/supacloud/commit/e340aedca7c025462c23ad76a6ed0a553c061b5b))
* **compiler:** resolve bounded per-environment resource bindings ([#1523](https://github.com/vibeunion/supacloud/issues/1523)) ([3305d61](https://github.com/vibeunion/supacloud/commit/3305d618be63da23945a537715632760c67784df))
* **compiler:** ship validated development contexts in delivery builds ([#1518](https://github.com/vibeunion/supacloud/issues/1518)) ([70f944b](https://github.com/vibeunion/supacloud/commit/70f944b3b4f48b265158dfdaf9fbe91878445498))
* **compiler:** validate complete local runtime bindings before bounded projection ([#1526](https://github.com/vibeunion/supacloud/issues/1526)) ([9b085eb](https://github.com/vibeunion/supacloud/commit/9b085ebd67a79023d0d6f1a44508617fa86b1971))
* **compiler:** verify immutable release evidence without executing project configuration ([#1525](https://github.com/vibeunion/supacloud/issues/1525)) ([ab9ac43](https://github.com/vibeunion/supacloud/commit/ab9ac436a5cffe13ff46e8afe00d152ba17e2a54))
* complete Angular framework defaults integration ([#1587](https://github.com/vibeunion/supacloud/issues/1587)) ([0dec8ea](https://github.com/vibeunion/supacloud/commit/0dec8ea48f288da27824579038136dd33f8ccb20))
* default RxJS support with compatible SupaCloud JS calls ([#1556](https://github.com/vibeunion/supacloud/issues/1556)) ([b3015cb](https://github.com/vibeunion/supacloud/commit/b3015cb161c0d87e6611f6c4fc60c120a8c9fffe))
* **delivery:** declare Edge Function targets in the delivery plan ([#1893](https://github.com/vibeunion/supacloud/issues/1893)) ([1312281](https://github.com/vibeunion/supacloud/commit/131228138edd0d2a4484eea82a80257a88eaf795))
* **effect:** upgrade runtime governance to Effect 4 ([#1748](https://github.com/vibeunion/supacloud/issues/1748)) ([2b48efc](https://github.com/vibeunion/supacloud/commit/2b48efcbe78db2a61c0c086f3350eaa87c697e90))
* **elysia:** Elysia 2 AOT evaluation and end-to-end typing architecture ([#1654](https://github.com/vibeunion/supacloud/issues/1654)) ([39ee49f](https://github.com/vibeunion/supacloud/commit/39ee49f760e85e789c43c1d18cf5729db592f6bc))
* enable strict Effect route governance by default ([#1742](https://github.com/vibeunion/supacloud/issues/1742)) ([4e18c90](https://github.com/vibeunion/supacloud/commit/4e18c908b9c08a8895be016b4e00a0158bf539c6))
* **governance:** enforce strict user and platform type contracts ([#1754](https://github.com/vibeunion/supacloud/issues/1754)) ([b22f889](https://github.com/vibeunion/supacloud/commit/b22f88919c349f088848028f13b15e44994e0d9c))
* **management-api:** Developer MCP reads application development context (P1-4) ([#1519](https://github.com/vibeunion/supacloud/issues/1519)) ([7d7f0e9](https://github.com/vibeunion/supacloud/commit/7d7f0e9d1d3263614fb1104c3168521e21b69832))
* **platform:** close application platform P0/P1 capabilities ([dbaf3a6](https://github.com/vibeunion/supacloud/commit/dbaf3a6d01daa71455a8cde96e9e233743bfdfca))
* **supacloud-js:** add framework-neutral TanStack Query adapter ([#1637](https://github.com/vibeunion/supacloud/issues/1637)) ([071b28c](https://github.com/vibeunion/supacloud/commit/071b28c5ce992834f46a0608d68475eb295c5c3e))
* **supacloud-js:** add typed procedure facade and unified errors ([#1639](https://github.com/vibeunion/supacloud/issues/1639)) ([fef05e9](https://github.com/vibeunion/supacloud/commit/fef05e98ee1044e1f449bad52d18104d28e17cb4))
* **worker:** bounded execution groups and admission controls ([#1616](https://github.com/vibeunion/supacloud/issues/1616)) ([8d870ea](https://github.com/vibeunion/supacloud/commit/8d870eabfce9bedce75d42151f5085bcef19b4c1))


### Bug Fixes

* **compiler:** classify TypeBox opacity at schema boundaries ([#1471](https://github.com/vibeunion/supacloud/issues/1471)) ([ca4ba73](https://github.com/vibeunion/supacloud/commit/ca4ba733c1ac885f6bd52fda8c68afe8c4df792a))
* **compiler:** compose generated clients with frontend SDK auth ([#1603](https://github.com/vibeunion/supacloud/issues/1603)) ([7b14968](https://github.com/vibeunion/supacloud/commit/7b1496828a9ade663f2a3d4572252af966296763))
* **compiler:** forward validation context into delivery plan revalidation ([2fbec0f](https://github.com/vibeunion/supacloud/commit/2fbec0f903c0ea748a6d797df2416e53aae4ce9d))
* **compiler:** harden execution and development context projections ([#1517](https://github.com/vibeunion/supacloud/issues/1517)) ([822e902](https://github.com/vibeunion/supacloud/commit/822e9026bead5cee9006c83a3f5bfa45cf59c3ed))
* **compiler:** keep generated runtime types strict ([#1682](https://github.com/vibeunion/supacloud/issues/1682)) ([ad319f9](https://github.com/vibeunion/supacloud/commit/ad319f9614c328a5d0f69d581dd55600fd8dfcf7))
* **compiler:** preserve TypeBox module refs and recursive client contracts ([#1464](https://github.com/vibeunion/supacloud/issues/1464)) ([459b9e6](https://github.com/vibeunion/supacloud/commit/459b9e6bf9c010c0bedc1ab9a5cd3b8bae62179f))
* **db:** align Drizzle dependencies with rc5 ([#1696](https://github.com/vibeunion/supacloud/issues/1696)) ([a95da17](https://github.com/vibeunion/supacloud/commit/a95da17b58cdadc8a8148a2002a39e33cee56f3c))
* **deps,perf:** replace Bun native APIs and resolve audit vulnerabilities ([#1667](https://github.com/vibeunion/supacloud/issues/1667)) ([06a9199](https://github.com/vibeunion/supacloud/commit/06a91990c754ce586f2a2353f253dc50f4fa0f98))
* **dev:** repair watch lifecycle and development reports ([#1524](https://github.com/vibeunion/supacloud/issues/1524)) ([69fd216](https://github.com/vibeunion/supacloud/commit/69fd216cbeb3bc68ca182d488bc86e8061283468))
* **release:** keep compiler migration tuple in sync with elysia/app releases ([#1674](https://github.com/vibeunion/supacloud/issues/1674)) ([a072c7d](https://github.com/vibeunion/supacloud/commit/a072c7dbf4a6a313f7fb092256b9c3baa3b00318))
* **supacloud-js:** harden procedure execution contracts ([#1643](https://github.com/vibeunion/supacloud/issues/1643)) ([cb20731](https://github.com/vibeunion/supacloud/commit/cb20731961525ee02e8d46467bf45e9b3dbd9147))


### Miscellaneous Chores

* adopt AGPL-3.0-only licensing ([#1481](https://github.com/vibeunion/supacloud/issues/1481)) ([8787ad9](https://github.com/vibeunion/supacloud/commit/8787ad9466ebba8f487d28bf62d5f79a220b0ab8))
* adopt current Supabase SDK baseline ([#1698](https://github.com/vibeunion/supacloud/issues/1698)) ([4e6613a](https://github.com/vibeunion/supacloud/commit/4e6613aeda3c5958e44cbe9604e30cce0622a66f))
* **deps:** complete @sinclair/typebox to typebox 1.3.34 migration ([#1655](https://github.com/vibeunion/supacloud/issues/1655)) ([87d1133](https://github.com/vibeunion/supacloud/commit/87d1133c0fa0eadf145afc6c3747f693e3e36200))
* release main ([#1465](https://github.com/vibeunion/supacloud/issues/1465)) ([392b418](https://github.com/vibeunion/supacloud/commit/392b4189eb437b69d5670037e1cafbecb97d731a))
* release main ([#1472](https://github.com/vibeunion/supacloud/issues/1472)) ([bfe9ea6](https://github.com/vibeunion/supacloud/commit/bfe9ea6cd349c6039068daf414a33f7472e78a7d))
* release main ([#1474](https://github.com/vibeunion/supacloud/issues/1474)) ([6255eb7](https://github.com/vibeunion/supacloud/commit/6255eb7e7eefc4ee5cd06bef05d4c81a29be706a))
* release main ([#1475](https://github.com/vibeunion/supacloud/issues/1475)) ([125e4de](https://github.com/vibeunion/supacloud/commit/125e4de89a17bdd65e7e10b88c84c3f1af274804))
* release main ([#1484](https://github.com/vibeunion/supacloud/issues/1484)) ([41b3e72](https://github.com/vibeunion/supacloud/commit/41b3e72d25dd8b1ea1d3dea5b75c90bdea9be797))
* release main ([#1507](https://github.com/vibeunion/supacloud/issues/1507)) ([b7f3a59](https://github.com/vibeunion/supacloud/commit/b7f3a59885596742a8b11fc808d898165a8989ec))
* release main ([#1561](https://github.com/vibeunion/supacloud/issues/1561)) ([3ee71e3](https://github.com/vibeunion/supacloud/commit/3ee71e301e7a5499780b45ec6c64e53698000029))
* release main ([#1586](https://github.com/vibeunion/supacloud/issues/1586)) ([21f22d8](https://github.com/vibeunion/supacloud/commit/21f22d8dba3a1e6e704865727ed5ff4095d28eac))
* release main ([#1592](https://github.com/vibeunion/supacloud/issues/1592)) ([224f76d](https://github.com/vibeunion/supacloud/commit/224f76dfff188cf943152c3ee23cff2269d4d2b9))
* release main ([#1600](https://github.com/vibeunion/supacloud/issues/1600)) ([5209a75](https://github.com/vibeunion/supacloud/commit/5209a7589b785d8243be24ad3ec25a0ccdb7b42c))
* release main ([#1609](https://github.com/vibeunion/supacloud/issues/1609)) ([b52c79c](https://github.com/vibeunion/supacloud/commit/b52c79ceda912786f1299ae2d618172f9252607a))
* release main ([#1610](https://github.com/vibeunion/supacloud/issues/1610)) ([6517b06](https://github.com/vibeunion/supacloud/commit/6517b06bdb9cfb02062288c4bfd1d09fbab1663c))
* release main ([#1617](https://github.com/vibeunion/supacloud/issues/1617)) ([afad389](https://github.com/vibeunion/supacloud/commit/afad38960cf086afeddcdc4565daa7b8cb429c2e))
* release main ([#1633](https://github.com/vibeunion/supacloud/issues/1633)) ([e9db823](https://github.com/vibeunion/supacloud/commit/e9db823b47db6b0d9ebe8057792e35e34c144420))
* release main ([#1638](https://github.com/vibeunion/supacloud/issues/1638)) ([1857d39](https://github.com/vibeunion/supacloud/commit/1857d39b2639e5ddf8f0a671b4167ba9c2f15c39))
* release main ([#1642](https://github.com/vibeunion/supacloud/issues/1642)) ([2c2de43](https://github.com/vibeunion/supacloud/commit/2c2de431073a6097f7589bc8b2f413508aec82b4))
* release main ([#1647](https://github.com/vibeunion/supacloud/issues/1647)) ([9afdb5c](https://github.com/vibeunion/supacloud/commit/9afdb5c348a2e87169e8898b3842091bb8f1ddea))
* release main ([#1657](https://github.com/vibeunion/supacloud/issues/1657)) ([1a3f7ff](https://github.com/vibeunion/supacloud/commit/1a3f7ff901f05dda38ed4827d70a91a4acccd8b3))
* release main ([#1661](https://github.com/vibeunion/supacloud/issues/1661)) ([77ea3fa](https://github.com/vibeunion/supacloud/commit/77ea3fa73707222f21561005a6be3569dae606b4))
* release main ([#1668](https://github.com/vibeunion/supacloud/issues/1668)) ([a7ce18b](https://github.com/vibeunion/supacloud/commit/a7ce18b73e0a2e93df664fb8da08cd40f3bdae82))
* release main ([#1671](https://github.com/vibeunion/supacloud/issues/1671)) ([b413a37](https://github.com/vibeunion/supacloud/commit/b413a37ba0b1c8cf7a33649774c1935febd46f92))
* release main ([#1683](https://github.com/vibeunion/supacloud/issues/1683)) ([9393da6](https://github.com/vibeunion/supacloud/commit/9393da66289b8a341f4a3c7fe8553e53986c4bdc))
* release main ([#1691](https://github.com/vibeunion/supacloud/issues/1691)) ([2d47123](https://github.com/vibeunion/supacloud/commit/2d47123013522350129d49480ce6d132595976db))
* release main ([#1695](https://github.com/vibeunion/supacloud/issues/1695)) ([2b9da10](https://github.com/vibeunion/supacloud/commit/2b9da1004b8cc1fd78cfcad79110d5c5eba5349d))
* release main ([#1743](https://github.com/vibeunion/supacloud/issues/1743)) ([dcbf82c](https://github.com/vibeunion/supacloud/commit/dcbf82c29fb6de94bd6be0c37df20662a6861b2e))
* release main ([#1747](https://github.com/vibeunion/supacloud/issues/1747)) ([cbdf2a4](https://github.com/vibeunion/supacloud/commit/cbdf2a426aeb5a405a4d27820fdfb51dd489b93a))
* release main ([#1757](https://github.com/vibeunion/supacloud/issues/1757)) ([e65dad9](https://github.com/vibeunion/supacloud/commit/e65dad945f8be7e84a7031b2ebf754cc48ad0f1c))
* release main ([#1759](https://github.com/vibeunion/supacloud/issues/1759)) ([981e1f0](https://github.com/vibeunion/supacloud/commit/981e1f07b39a99bf012abb01a815a4bb07e01b27))
* release main ([#1767](https://github.com/vibeunion/supacloud/issues/1767)) ([d31bf06](https://github.com/vibeunion/supacloud/commit/d31bf06a2bfbdb353554a44576d0c54685f46193))
* release main ([#1809](https://github.com/vibeunion/supacloud/issues/1809)) ([29edcea](https://github.com/vibeunion/supacloud/commit/29edceaf39f98d42d28327fcfb60bb46558e7113))
* release main ([#1813](https://github.com/vibeunion/supacloud/issues/1813)) ([66c3c7b](https://github.com/vibeunion/supacloud/commit/66c3c7bf10f6991936e6983088028659ed51cab2))
* release main ([#1815](https://github.com/vibeunion/supacloud/issues/1815)) ([d1acf62](https://github.com/vibeunion/supacloud/commit/d1acf62f306e2c77ac7bf681c675cb47537f28c3))
* release main ([#1825](https://github.com/vibeunion/supacloud/issues/1825)) ([4819f95](https://github.com/vibeunion/supacloud/commit/4819f95ae7ce722b58f4858261c100c448c9975e))
* release main ([#1873](https://github.com/vibeunion/supacloud/issues/1873)) ([105aa74](https://github.com/vibeunion/supacloud/commit/105aa74268a67ea94d7095c2f742738dfaaea871))
* release main ([#1887](https://github.com/vibeunion/supacloud/issues/1887)) ([52d64a9](https://github.com/vibeunion/supacloud/commit/52d64a95d4e02401436e9ab25cb03d1bb25e64d0))
* release main ([#1890](https://github.com/vibeunion/supacloud/issues/1890)) ([8b88c00](https://github.com/vibeunion/supacloud/commit/8b88c00e4eb523203520757219be1bc42e45e44d))
* release main ([#1916](https://github.com/vibeunion/supacloud/issues/1916)) ([64838ca](https://github.com/vibeunion/supacloud/commit/64838ca0d3a75e2e5bab11fbbb5f5cca3b5f830f))
* release main ([#1918](https://github.com/vibeunion/supacloud/issues/1918)) ([1a0ecab](https://github.com/vibeunion/supacloud/commit/1a0ecab574adb8a211882f8e5604135445ab99cb))
* release main ([#1944](https://github.com/vibeunion/supacloud/issues/1944)) ([206d711](https://github.com/vibeunion/supacloud/commit/206d711a0012bad9465283f2f2bfc5f4eb80d269))
* release main ([#1952](https://github.com/vibeunion/supacloud/issues/1952)) ([1693369](https://github.com/vibeunion/supacloud/commit/1693369010c63e77de8012d0a8acd7b116def94c))
* release main ([#1954](https://github.com/vibeunion/supacloud/issues/1954)) ([3c70f03](https://github.com/vibeunion/supacloud/commit/3c70f03b5b4517c98c38bff54c46add159e3ce37))
* release main ([#1960](https://github.com/vibeunion/supacloud/issues/1960)) ([1ea85ac](https://github.com/vibeunion/supacloud/commit/1ea85acbe15eed33570672f67f341a7612bf69ac))
* release main ([#1961](https://github.com/vibeunion/supacloud/issues/1961)) ([428e1a9](https://github.com/vibeunion/supacloud/commit/428e1a91405f52b0273e51aec561c93afd39763b))
* release main ([#1982](https://github.com/vibeunion/supacloud/issues/1982)) ([02cb9a7](https://github.com/vibeunion/supacloud/commit/02cb9a7011588e7d02e22a84f972c324e4983de4))
* release main ([#1988](https://github.com/vibeunion/supacloud/issues/1988)) ([e1b912d](https://github.com/vibeunion/supacloud/commit/e1b912df24c27cf822d1f82df6561248783abbb5))
* release main ([#1999](https://github.com/vibeunion/supacloud/issues/1999)) ([af2a885](https://github.com/vibeunion/supacloud/commit/af2a885e70d8baf3bad4cc3c8264efe62b87d8e9))
* release main ([#2002](https://github.com/vibeunion/supacloud/issues/2002)) ([074028c](https://github.com/vibeunion/supacloud/commit/074028cc770ec140a66b4f7259a9f47f046de7c5))
* release main ([#2030](https://github.com/vibeunion/supacloud/issues/2030)) ([2f7cf91](https://github.com/vibeunion/supacloud/commit/2f7cf91d941ab583ebe21d901069a16e55efc48a))
* upgrade dependencies and caddy ([#1821](https://github.com/vibeunion/supacloud/issues/1821)) ([91c9a4b](https://github.com/vibeunion/supacloud/commit/91c9a4bd0a14f757670822a1aa953643a00a83c9))
* upgrade workspace dependencies ([#1940](https://github.com/vibeunion/supacloud/issues/1940)) ([77ad418](https://github.com/vibeunion/supacloud/commit/77ad418e0568ceeeea0b59a10a3bbc451a68a95f))
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).