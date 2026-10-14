# Query npm publication recovery

A GitHub release or version bump does not prove that `@supacloud/query` is
available on npm. A failed `npm publish` with `E404` is not a registry visibility
delay. Do not add a static token, ignore the failure, or bump the version to retry.

## Verify the npm authorization

The package administrator must inspect the Trusted Publisher for
`@supacloud/query` in npm. Its configuration must match the existing job:

| Field | Expected value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `vibeunion` |
| Repository | `supacloud` |
| Workflow filename | `release-please.yml` |
| Environment | `npm-publish` |
| Allowed action | Direct publication with `npm publish` |

Permission to stage a release does not imply permission to publish it directly.
Do not change the package's intended approval policy merely to suppress an
error. If direct publication is not intended, stop and agree on a staged-release
workflow instead.

An authorized administrator can also inspect the configuration with:

```sh
npm trust list @supacloud/query --json --registry=https://registry.npmjs.org
```

`401` from this command means the caller cannot inspect it; it does not prove
that the configuration is missing. Never paste credentials into an issue or PR.
See the npm [Trusted Publishers documentation](https://docs.npmjs.com/trusted-publishers/).

## Retry only Query

After correcting and confirming the npm-side authorization, merge the workflow
repair, verify the intended Query version and source on `main`, and dispatch:

```sh
gh workflow run release-please.yml --repo vibeunion/supacloud --ref main -f recover_query=true
```

Leave the other recovery inputs at their defaults. This mode skips release
creation and retries only Query from the dispatch commit on `main`, using the
existing `npm-publish` environment and OIDC permissions. It does not pin an old
release tag: do not use it if `main` contains unwanted Query changes.

The shared publisher skips an already-visible exact version and verifies
registry visibility after a successful publish. A build, provenance upload,
or successful dispatch is not proof of publication. Verify the expected version
explicitly before upgrading a consumer, for example:

```sh
npm view @supacloud/query@0.3.0 version dist.integrity --json --registry=https://registry.npmjs.org
```
