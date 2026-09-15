# Compiler Diagnostic Codes

Every public compiler diagnostic has a stable code, an actionable page, and a
negative fixture requirement. Codes are owned by exactly one registry; aliases
may share a page only when they describe the same rule family.

Run the gate with:

```sh
bun run check:diagnostic-docs
```

To intentionally regenerate the generated pages after a reviewed diagnostic
contract change:

```sh
bun scripts/check_diagnostic_docs.ts --write
```

| Code | Diagnostic names | Owner |
| --- | --- | --- |
| [SC1001](SC1001.md) | `circular-dependency` | compiler |
| [SC1002](SC1002.md) | `scope-violation` | compiler |
| [SC1003](SC1003.md) | `module-boundary-violation`, `module-boundary` | compiler |
| [SC1004](SC1004.md) | `circular-module-import` | compiler |
| [SC1005](SC1005.md) | `orphan-module` | compiler |
| [SC1006](SC1006.md) | `invalid-boundary-preset` | compiler |
| [SC1007](SC1007.md) | `circular-existing-alias` | compiler |
| [SC2001](SC2001.md) | `missing-deps`, `unresolved-token` | compiler |
| [SC2002](SC2002.md) | `duplicate-token`, `duplicate-module` | compiler |
| [SC2003](SC2003.md) | `disallow-controller-direct-db` | compiler |
| [SC2004](SC2004.md) | `self-dependency-violation` | compiler |
| [SC2005](SC2005.md) | `skip-self-dependency-violation` | compiler |
| [SC2006](SC2006.md) | `export-unprovided-token` | compiler |
| [SC2007](SC2007.md) | `unresolved-alias-target` | compiler |
| [SC2008](SC2008.md) | `self-referencing-alias` | compiler |
| [SC2009](SC2009.md) | `missing-token-factory` | compiler |
| [SC2010](SC2010.md) | `provider-type-mismatch` | compiler |
| [SC2011](SC2011.md) | `unsupported-provider-helper` | compiler |
| [SC3001](SC3001.md) | `shadowed-route` | compiler |
| [SC3002](SC3002.md) | `unresolved-route-redirect` | compiler |
| [SC3003](SC3003.md) | `circular-route-redirect` | compiler |
| [SC3004](SC3004.md) | `invalid-http-method-body` | compiler |
| [SC3005](SC3005.md) | `unmatched-route-parameter` | compiler |
| [SC3006](SC3006.md) | `missing-route-parameter-binding`, `missing-path-param` | compiler |
| [SC3007](SC3007.md) | `duplicate-route` | compiler |
| [SC3008](SC3008.md) | `missing-body-schema` | compiler |
| [SC3009](SC3009.md) | `unused-route-schema` | compiler |
| [SC3010](SC3010.md) | `malformed-route-path` | compiler |
| [SC3011](SC3011.md) | `duplicate-path-param` | compiler |
| [SC3012](SC3012.md) | `wildcard-not-trailing` | compiler |
| [SC3013](SC3013.md) | `invalid-query-param-name` | compiler |
| [SC3014](SC3014.md) | `unmatched-path-param-decorator` | compiler |
| [SC3015](SC3015.md) | `invalid-query-default-type` | compiler |
| [SC3016](SC3016.md) | `disallowed-body-on-get-delete`, `invalid-body-binding` | compiler |
| [SC3017](SC3017.md) | `duplicate-query-param-binding` | compiler |
| [SC3018](SC3018.md) | `conflicting-route-method` | compiler |
| [SC3019](SC3019.md) | `missing-param-colon` | compiler |
| [SC3020](SC3020.md) | `invalid-route-contract` | compiler |
| [SC3021](SC3021.md) | `route-contract-required` | compiler |
| [SC3022](SC3022.md) | `route-contract-unverified` | compiler |
| [SC3023](SC3023.md) | `route-contract-evidence-required` | compiler |
| [SC3024](SC3024.md) | `invalid-route-response-map` | compiler |
| [SC3025](SC3025.md) | `invalid-route-response-selector` | compiler |
| [SC3026](SC3026.md) | `conflicting-route-response-schema` | compiler |
| [SC3027](SC3027.md) | `duplicate-route-response-selector` | compiler |
| [SC4001](SC4001.md) | `command-missing-permission` | compiler |
| [SC4002](SC4002.md) | `duplicate-command` | compiler |
| [SC4003](SC4003.md) | `route-command-unresolved` | compiler |
| [SC4004](SC4004.md) | `command-governance-unsupported` | compiler |
| [SC4005](SC4005.md) | `route-command-binding-disabled`, `route-command-binding-disallowed` | compiler |
| [SC4006](SC4006.md) | `command-transaction-readonly` | compiler |
| [SC4007](SC4007.md) | `invalid-job-scope` | compiler |
| [SC4010](SC4010.md) | `dynamic-aspect-reference` | compiler |
| [SC4011](SC4011.md) | `invalid-aspect-reference` | compiler |
| [SC4012](SC4012.md) | `invalid-command-mode` | compiler |
| [SC4013](SC4013.md) | `invalid-command-rpc` | compiler |
| [SC4014](SC4014.md) | `command-rpc-unavailable` | compiler |
| [SC4015](SC4015.md) | `invalid-job-timeout` | compiler |
| [SC4016](SC4016.md) | `invalid-job-attempts` | compiler |
| [SC4017](SC4017.md) | `invalid-job-idempotency` | compiler |
| [SC4018](SC4018.md) | `invalid-job-mode` | compiler |
| [SC4019](SC4019.md) | `invalid-job-schema` | compiler |
| [SC4020](SC4020.md) | `command-persistence-required` | compiler |
| [SC4021](SC4021.md) | `command-external-transaction` | compiler |
| [SC4022](SC4022.md) | `command-permission-unsupported` | compiler |
| [SC4023](SC4023.md) | `command-audit-unsupported` | compiler |
| [SC4024](SC4024.md) | `command-idempotency-unsupported` | compiler |
| [SC4025](SC4025.md) | `command-transaction-rpc-only` | compiler |
| [SC4026](SC4026.md) | `command-transaction-unsupported` | compiler |
| [SC5001](SC5001.md) | `unused-root-provider` | compiler |
| [SC6001](SC6001.md) | `generated-any` | type-safety |
| [SC6002](SC6002.md) | `source-any` | type-safety |
| [SC6003](SC6003.md) | `source-type-assertion` | type-safety |
| [SC6004](SC6004.md) | `source-non-null-assertion` | type-safety |
| [SC6005](SC6005.md) | `source-implicit-widening` | type-safety |
| [SC6006](SC6006.md) | `source-type-suppression` | type-safety |
| [SC6101](SC6101.md) | `invalid-feature-states` | compiler |
| [SC6102](SC6102.md) | `duplicate-feature-transition` | compiler |
| [SC6103](SC6103.md) | `invalid-feature-transition` | compiler |
| [SC6104](SC6104.md) | `feature-command-unresolved` | compiler |
| [SC6105](SC6105.md) | `feature-governance-drift` | compiler |
| [SC6106](SC6106.md) | `feature-route-unresolved` | compiler |
| [SC6107](SC6107.md) | `feature-route-drift` | compiler |
| [SC6108](SC6108.md) | `invalid-feature-spec` | compiler |
