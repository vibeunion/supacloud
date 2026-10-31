# Changelog

## [0.8.2](https://github.com/vibeunion/supacloud/compare/testing-v0.8.1...testing-v0.8.2) (2026-10-31)


### Miscellaneous Chores

* **runtime:** align Bun 1.4.4 runtime and type baseline ([#2294](https://github.com/vibeunion/supacloud/issues/2294)) ([0f08651](https://github.com/vibeunion/supacloud/commit/0f0865192720f09d693a803fb1e506e79a2a9b83))

## [0.8.1](https://github.com/vibeunion/supacloud/compare/testing-v0.8.0...testing-v0.8.1) (2026-10-25)


### Miscellaneous Chores

* **deps:** refresh the Elysia runtime and dependency matrix ([#2243](https://github.com/vibeunion/supacloud/issues/2243)) ([917ff0f](https://github.com/vibeunion/supacloud/commit/917ff0fa81e3c47d86d18e8c58fff79c0f0f67f5))

## [0.8.0](https://github.com/vibeunion/supacloud/compare/testing-v0.7.0...testing-v0.8.0) (2026-10-19)


### Features

* complete feature slice governance contracts ([#2151](https://github.com/vibeunion/supacloud/issues/2151)) ([025cb54](https://github.com/vibeunion/supacloud/commit/025cb54d8348931f59e74e1bf1157051218eae9d))

## [0.7.0](https://github.com/vibeunion/supacloud/compare/testing-v0.6.4...testing-v0.7.0) (2026-10-18)


### Features

* **app:** enforce trusted feature request context ([#2056](https://github.com/vibeunion/supacloud/issues/2056)) ([214909b](https://github.com/vibeunion/supacloud/commit/214909bc1daefe8682cb7bd857396d95b13418a3))

## [0.6.4](https://github.com/vibeunion/supacloud/compare/testing-v0.6.3...testing-v0.6.4) (2026-10-17)


### Bug Fixes

* **cli:** align verification target resolution ([#2052](https://github.com/vibeunion/supacloud/issues/2052)) ([3cfcc36](https://github.com/vibeunion/supacloud/commit/3cfcc362f87ecdaf82a4df303f5af436875fb36e))

## [0.6.3](https://github.com/vibeunion/supacloud/compare/testing-v0.6.2...testing-v0.6.3) (2026-10-17)


### Bug Fixes

* **cli:** sync published compiler dependency ([#2041](https://github.com/vibeunion/supacloud/issues/2041)) ([be44641](https://github.com/vibeunion/supacloud/commit/be446416b87bf009eec892bc20368e3595d7326a))

## [0.6.2](https://github.com/vibeunion/supacloud/compare/testing-v0.6.1...testing-v0.6.2) (2026-10-17)


### Bug Fixes

* **cli:** bound starter attachment task versions ([#2013](https://github.com/vibeunion/supacloud/issues/2013)) ([85313a0](https://github.com/vibeunion/supacloud/commit/85313a059dc2ebfdcd043422c47b84a2c5fcecf1))
* **cli:** derive feature writer inputs from request contracts ([#2015](https://github.com/vibeunion/supacloud/issues/2015)) ([befd7c9](https://github.com/vibeunion/supacloud/commit/befd7c99912c696955ec237403be7b185bbbd93a))
* **contracts:** preserve installed command errors and align Lite publication ([#2023](https://github.com/vibeunion/supacloud/issues/2023)) ([eb7b750](https://github.com/vibeunion/supacloud/commit/eb7b75043512bf2026a2e8e125f7c3c4f93a2700))
* **test:** accept canonical published package paths ([#2012](https://github.com/vibeunion/supacloud/issues/2012)) ([e5a356f](https://github.com/vibeunion/supacloud/commit/e5a356f4770dcd77e01a750db8a1bce4f198a9a6))

## [0.6.1](https://github.com/vibeunion/supacloud/compare/testing-v0.6.0...testing-v0.6.1) (2026-10-11)


### Miscellaneous Chores

* upgrade dependencies and caddy ([#1821](https://github.com/vibeunion/supacloud/issues/1821)) ([91c9a4b](https://github.com/vibeunion/supacloud/commit/91c9a4bd0a14f757670822a1aa953643a00a83c9))

## [0.6.0](https://github.com/vibeunion/supacloud/compare/testing-v0.5.2...testing-v0.6.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* @supacloud/app no longer publishes dist/index.cjs or a separate synchronous CommonJS entrypoint. CommonJS consumers should use dynamic import() or migrate to ESM. Release-please should handle the corresponding breaking version change.

### Features

* **app:** add governed reactive event streams and lifecycle signals ([38a26e2](https://github.com/vibeunion/supacloud/commit/38a26e2d3b83226a7488df2ef4f1f5714573aeb2))
* default RxJS support with compatible SupaCloud JS calls ([#1556](https://github.com/vibeunion/supacloud/issues/1556)) ([b3015cb](https://github.com/vibeunion/supacloud/commit/b3015cb161c0d87e6611f6c4fc60c120a8c9fffe))

## [0.5.2](https://github.com/vibeunion/supacloud/compare/testing-v0.5.1...testing-v0.5.2) (2026-09-28)


### Miscellaneous Chores

* adopt AGPL-3.0-only licensing ([#1481](https://github.com/vibeunion/supacloud/issues/1481)) ([8787ad9](https://github.com/vibeunion/supacloud/commit/8787ad9466ebba8f487d28bf62d5f79a220b0ab8))

## [0.5.1](https://github.com/vibeunion/supacloud/compare/testing-v0.5.0...testing-v0.5.1) (2026-09-11)


### Miscellaneous Chores

* **deps:** upgrade Bun runtime baseline from 1.4.0 to 1.4.2 ([#1271](https://github.com/vibeunion/supacloud/issues/1271)) ([f53aee5](https://github.com/vibeunion/supacloud/commit/f53aee52e93c25e017e9c693a920de5752fe3ddc))

## [0.5.0](https://github.com/vibeunion/supacloud/compare/testing-v0.4.0...testing-v0.5.0) (2026-09-05)


### Features

* migrate compiler and strengthen type safety ([81ffb9d](https://github.com/vibeunion/supacloud/commit/81ffb9dae9a09b5561f90e655f1503514d3fe1d7))

## [0.4.0](https://github.com/vibeunion/supacloud/compare/testing-v0.3.0...testing-v0.4.0) (2026-09-04)


### Features

* **compiler:** add checkProject drift detection, capabilities governance, and CLI ([#1134](https://github.com/vibeunion/supacloud/issues/1134)) ([831225a](https://github.com/vibeunion/supacloud/commit/831225a6d8d5c79392c4e261ddbffb092125c97f))

## [0.3.0](https://github.com/vibeunion/supacloud/compare/testing-v0.2.0...testing-v0.3.0) (2026-09-03)


### Features

* **compiler,app:** add module tags and boundary governance with Nx workspace configuration ([#1110](https://github.com/vibeunion/supacloud/issues/1110)) ([dda9635](https://github.com/vibeunion/supacloud/commit/dda96355ba25a53f1b550e8e95011b1c806a2003))

## [0.2.0](https://github.com/vibeunion/supacloud/compare/testing-v0.1.0...testing-v0.2.0) (2026-09-02)


### Features

* **app:** enforce command governance at runtime ([#1096](https://github.com/vibeunion/supacloud/issues/1096)) ([63f59e0](https://github.com/vibeunion/supacloud/commit/63f59e09bb98835ba3dc414e9fcc3806295850e4))

## 0.1.0 (2026-09-02)


### Features

* add database governance and testing packages (db, testing) ([#1083](https://github.com/vibeunion/supacloud/issues/1083)) ([5bb08b9](https://github.com/vibeunion/supacloud/commit/5bb08b90b7bdac3f721ded39af525ca02bd289cb))
