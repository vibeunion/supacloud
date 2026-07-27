# Releasing SupaCloud Lite

## First npm release

`@supacloud/lite` 在 npm 上尚不存在时，先完成一次受控 bootstrap publish：

1. 在合并 Release Please 创建的 `supacloud-lite-v0.1.0` release 前，在 GitHub `npm-publish` environment 中临时配置 `NPM_BOOTSTRAP_TOKEN`；token 必须要求 2FA 并限制到该包。
2. 合并 release，让同一次 `Release Please` workflow 运行使用该 token 完成首次发布；如果发布 job 失败，使用该次 workflow 的 **Re-run failed jobs**，不要等待下一次 release。
3. 在 npm 包设置中配置 Trusted Publisher：user `zuohuadong`、repository `supacloud`、workflow `release-please.yml`、environment `npm-publish`，并将 allowed action 限制为 `npm publish`。
4. 删除 `NPM_BOOTSTRAP_TOKEN`。后续发布由 npm OIDC Trusted Publishing 完成。

## Verification

发布前运行：

```bash
bun install --frozen-lockfile
bun run check
bun audit --audit-level high
```

`bun run check` 会构建包、执行真实 `supabase-js` 集成测试、生成 npm tarball、在临时消费者项目中安装 tarball，并验证 CLI、公开 API、PGlite WASM 和版本一致性。
