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

`bun run check` 会构建包、执行真实 `supabase-js` 集成测试、生成 npm tarball、在临时消费者项目中安装 tarball，并验证 npm CLI、公开 API、PGlite WASM 和版本一致性。它还会构建 host 单二进制，在不含 Bun/Node/npm 的 `PATH` 下验证 Functions、PGlite contrib 扩展、持久数据升级、升级前快照和恢复。

## Standalone binaries

本地构建当前平台：

```bash
bun run build:standalone:host
bun run test:standalone
```

Release workflow 为 Linux x64 baseline/arm64、macOS x64/arm64 和 Windows x64 baseline 构建独立产物。Linux x64 产物必须在发布 runner 上完成真实黑盒测试；其他交叉编译产物在具备对应原生 runner 前只视为已构建，不能替代平台验收。

Lite release 会同时上传 `SHA256SUMS`、项目自身的 `SUPACLOUD-LITE-APACHE-2.0.txt`、`THIRD_PARTY_NOTICES.md` 和 `LICENSES/*.txt`，并为发布资产生成 provenance。正式对外分发 macOS 或 Windows 产物前，还应按项目发布策略完成代码签名；构建成功不代表已经签名或公证。
