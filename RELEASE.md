# SupaCloud 发布指南

为了确保 `supacloud --version` 显示的版本号与 Git Tag 以及 GitHub Release 保持一致，请遵循以下发布流程。

## 推荐流程：使用自动化工具

项目已集成 `standard-version`，它可以自动：
1. 更新 `package.json` 中的版本号。
2. 根据 Git Commit 历史自动生成/更新 `CHANGELOG.md`。
3. 创建对应的 Git Tag。

### 发布步骤：

```bash
# 1. 确保在 main 分支且代码已全部提交
git checkout main
git pull origin main

# 2. 执行发布命令 (自动提升版本并生成 Changelog)
# 选项: --release-as [major|minor|patch|x.x.x]
npm run release -- --release-as 0.3.15

# 3. 推送代码和 Tag 到远程
git push --follow-tags origin main
```

---

## 手动流程 (不推荐，容易出错)

如果需要手动发布，**必须** 严格执行以下顺序：

1. **修改版本号**：手动编辑根目录下的 `package.json`，将 `"version": "0.3.11"` 修改为目标版本（如 `0.3.15`）。
2. **提交变更**：`git add package.json && git commit -m "chore(release): 0.3.15"`。
3. **打标签**：`git tag v0.3.15`。
4. **推送**：`git push origin main && git push origin v0.3.15`。

## 为什么之前的版本显示不对？

因为您（或我）之前直接执行了 `git tag v0.3.15`，但**没有修改 `package.json`**。
`supacloud` 二进制在编译时是通过 `import pkg from "../package.json"` 读取版本号的，所以它依然固化了代码里的 `0.3.11`。

> [!IMPORTANT]
> **发布的核心原则**：代码里的版本号变更是“因”，Git Tag 是“果”。必须先改代码，后打标签。
