# README diagrams and maintenance

[English homepage](../README.md) · [中文首页](../README.zh-CN.md) · [Translation policy](translation-policy.md)

## Source of truth

`assets/readme/labels.json` contains English and Simplified Chinese labels. `scripts/readme-diagrams.mjs` owns shared geometry, node order and edges. The six generated SVGs are editable vector deliverables, checked into Git so the README works without a build step. They contain selectable text, a title and description, no scripts, embedded fonts, external images or remote assets. System font fallbacks are used; do not commit font files.

| Pair | Meaning | Do not imply |
| --- | --- | --- |
| `overview.{en,zh-CN}.svg` | Application engineering vs Lite/full-platform hosting | Three interchangeable editions or verified deployment parity |
| `build-runtime.{en,zh-CN}.svg` | Compile-time artifacts vs runtime adapter and application service responsibilities | Elysia-free hosts, arbitrary framework support or business correctness from compilation |
| `project-storage.{en,zh-CN}.svg` | Project-scoped routing and one backend per project | Bucket-level backend selection, replication or automatic failover |

Regenerate from the repository root using Node.js 22 or newer:

```bash
node scripts/readme-diagrams.mjs
node scripts/readme-diagrams.mjs --check
node --test scripts/readme-docs.test.mjs
node scripts/check-readme-docs.mjs
```

The checker validates the two homepages and the new operations/maintenance documents, not every historical document in the repository. It checks local inline Markdown link targets and fragments, non-empty image alternatives, matching English/Chinese code blocks and section markers, plus generated SVG freshness. It does not access external URLs, execute installation commands, verify npm publication, or prove business/runtime compatibility. The dedicated workflow uses read-only repository permission and does not modify merge rules.

## Review before submission

Review both languages in a browser, at README width and a narrower viewport. Check that text stays within cards, that labels do not overlap arrows, and that contrast is readable on GitHub light and dark pages; each SVG has an explicit white background. System font selection can differ across viewers. Geometry is shared, but a human still needs to review translated meaning and line length.

The figures have localized SVG titles/descriptions and README alternative text. Key architecture and failure boundaries are also repeated as ordinary Markdown below the figures, so readers do not need to rely solely on images.

## Documentation boundaries

The homepages are entry points, not operational runbooks. Installation, release verification, observation timeouts and rollback guidance now live in [platform operations](platform-operations.md) / [平台运维](platform-operations.zh-CN.md), with links to existing detailed guides. Preserve those warnings when reorganizing content. Keep repository implementation, published artifacts and dated acceptance evidence distinct.

Spanish synchronization is tracked separately in the translation policy. Do not mark it complete just because English and Chinese structural checks pass. Reverting this refresh changes documentation and generated assets only; it does not roll back running services or data.
