# Changelog

## [0.3.1](https://github.com/vibeunion/supacloud/compare/db-zenstack-v0.3.0...db-zenstack-v0.3.1) (2026-11-14)


### Bug Fixes

* **db:** support ZenStack adapter 0.3 ([#2643](https://github.com/vibeunion/supacloud/issues/2643)) ([420e5b4](https://github.com/vibeunion/supacloud/commit/420e5b4eb9c43d3a2d07c421112d781716655673))
* **deps:** align db adapter and compiler versions ([#2642](https://github.com/vibeunion/supacloud/issues/2642)) ([5f7c63a](https://github.com/vibeunion/supacloud/commit/5f7c63a32e2d85f0166f20c9a0073737ff153a47))
* **model-tooling:** close adoption boundary gaps ([#2644](https://github.com/vibeunion/supacloud/issues/2644)) ([97ec1f3](https://github.com/vibeunion/supacloud/commit/97ec1f3e8400cee7327a06ba6628a67620e31941))

## [0.3.0](https://github.com/vibeunion/supacloud/compare/db-zenstack-v0.2.2...db-zenstack-v0.3.0) (2026-11-12)


### Features

* **cli:** keep model adoption behind Management API ([#2621](https://github.com/vibeunion/supacloud/issues/2621)) ([fd9c64f](https://github.com/vibeunion/supacloud/commit/fd9c64f222764790ed060da4d644cd276edc1c7c))

## [0.2.2](https://github.com/vibeunion/supacloud/compare/db-zenstack-v0.2.1...db-zenstack-v0.2.2) (2026-11-11)


### Bug Fixes

* **quality:** resolve code quality findings ([#2590](https://github.com/vibeunion/supacloud/issues/2590)) ([eff8397](https://github.com/vibeunion/supacloud/commit/eff8397480efe5c30c5d6d270457383e5f9d7edc))

## [0.2.1](https://github.com/vibeunion/supacloud/compare/db-zenstack-v0.2.0...db-zenstack-v0.2.1) (2026-11-10)


### Bug Fixes

* **db:** accept the released ZenStack adapter minor series ([#2542](https://github.com/vibeunion/supacloud/issues/2542)) ([3eb5b81](https://github.com/vibeunion/supacloud/commit/3eb5b813a5a2a328c2776832b7fb5f85b214a2cd))

## [0.2.0](https://github.com/vibeunion/supacloud/compare/db-zenstack-v0.1.0...db-zenstack-v0.2.0) (2026-11-10)


### Features

* **app:** enforce trusted feature request context ([#2056](https://github.com/vibeunion/supacloud/issues/2056)) ([214909b](https://github.com/vibeunion/supacloud/commit/214909bc1daefe8682cb7bd857396d95b13418a3))
* complete feature slice governance contracts ([#2151](https://github.com/vibeunion/supacloud/issues/2151)) ([025cb54](https://github.com/vibeunion/supacloud/commit/025cb54d8348931f59e74e1bf1157051218eae9d))


### Bug Fixes

* **cli:** align verification target resolution ([#2052](https://github.com/vibeunion/supacloud/issues/2052)) ([3cfcc36](https://github.com/vibeunion/supacloud/commit/3cfcc362f87ecdaf82a4df303f5af436875fb36e))
* **cli:** bound starter attachment task versions ([#2013](https://github.com/vibeunion/supacloud/issues/2013)) ([85313a0](https://github.com/vibeunion/supacloud/commit/85313a059dc2ebfdcd043422c47b84a2c5fcecf1))
* **cli:** derive feature writer inputs from request contracts ([#2015](https://github.com/vibeunion/supacloud/issues/2015)) ([befd7c9](https://github.com/vibeunion/supacloud/commit/befd7c99912c696955ec237403be7b185bbbd93a))
* **cli:** sync published compiler dependency ([#2041](https://github.com/vibeunion/supacloud/issues/2041)) ([be44641](https://github.com/vibeunion/supacloud/commit/be446416b87bf009eec892bc20368e3595d7326a))
* **contracts:** preserve installed command errors and align Lite publication ([#2023](https://github.com/vibeunion/supacloud/issues/2023)) ([eb7b750](https://github.com/vibeunion/supacloud/commit/eb7b75043512bf2026a2e8e125f7c3c4f93a2700))
* **test:** accept canonical published package paths ([#2012](https://github.com/vibeunion/supacloud/issues/2012)) ([e5a356f](https://github.com/vibeunion/supacloud/commit/e5a356f4770dcd77e01a750db8a1bce4f198a9a6))

## 0.1.0

### Features

* Split the ZenStack model adapter out of `@supacloud/db`. `@supacloud/db/zenstack` and `@supacloud/db/model` re-export this package.
