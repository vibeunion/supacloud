# SupaCloud 发布指南

为了确保 `supacloud --version` 显示的版本号与 Git Tag 以及 GitHub Release 保持一致，请遵循以下发布流程。

## 1. 自动化发布 (推荐)

项目中已配置 [auto-release.yml](file:///d:/workspace/supacloud/.github/workflows/auto-release.yml)，这是发布新版的“金标准”流程。

### 操作方法：
1. 打开 GitHub 仓库的 **Actions** 标签页。
2. 选择左侧的 **Auto Release & Tag** 工作流。
3. 点击 **Run workflow**，选择发布类型（patch/minor/major）。
4. **它会自动完成以下所有动作**：
   - 提升 `package.json` 中的版本号。
   - 更新 `CHANGELOG.md`。
   - 自动打上 `v*` 格式的 Git Tag。
   - 自动推送回 `main`。
   - **连锁反应**：推送 Tag 会接着触发 [release-supacloud.yml](file:///d:/workspace/supacloud/.github/workflows/release-supacloud.yml) 开始构建各平台的二进制。

---

## 2. 本地快速发布 (替代方案)

如果您希望在本地执行，也请使用我们预设的脚本，**禁止直接打 Tag**。

```bash
# 执行此命令会：修改 package.json -> 生成 Changelog -> 打 Tag
npm run release -- --release-as 0.3.15

# 推送
git push --follow-tags origin main
```

## 为什么之前版本号不对？

因为之前的操作是：`直打 Tag` -> `触发构建`。
但构建时引用的 **源码** 里的 `package.json` 依然是旧的（0.3.11）。

> [!IMPORTANT]
> **发布铁律**：永远不要手动创建 `v*` 标签。必须通过 `standard-version`（即 `npm run release` 或 GitHub UI）来由内而外地提升版本。

## 为什么之前的版本显示不对？

因为您（或我）之前直接执行了 `git tag v0.3.15`，但**没有修改 `package.json`**。
`supacloud` 二进制在编译时是通过 `import pkg from "../package.json"` 读取版本号的，所以它依然固化了代码里的 `0.3.11`。

> [!IMPORTANT]
> **发布的核心原则**：代码里的版本号变更是“因”，Git Tag 是“果”。必须先改代码，后打标签。
