# Translation Policy

- `README.md` is the canonical English source.
- Each root README contains one language only: English (`README.md`), Simplified Chinese (`README.zh-CN.md`), or Spanish (`README.es-ES.md`). Do not embed complete copies of other languages in a translated README.
- Keep the language selector in this order: English, Simplified Chinese, Spanish.
- Keep commands, file paths, API names, configuration keys, and code blocks unchanged across translations.
- When a change affects installation, configuration, user-visible behavior, or compatibility, update the English README first and update translations in the same pull request when practical. Otherwise, open or link a follow-up translation task.

## README refresh status

The English and Simplified Chinese homepages and platform operations guides are synchronized in this refresh. Spanish retains its previous structure; synchronization is explicitly pending in [issue #1504](https://github.com/vibeunion/supacloud/issues/1504). Do not treat the Spanish page as synchronized with the new architecture and compatibility sections until that task is reviewed.

## Technical figures

English and Simplified Chinese figures share the renderer in `scripts/readme-diagrams.mjs` and the label table in `docs/assets/readme/labels.json`. Keep node order, edges, technical names, captions and alternative text consistent. Edit sources and regenerate both languages; do not hand-edit a single generated SVG.

Run the [README checks](readme-visuals.md) after changes. Structural parity checks do not replace human translation or architecture review. Adding a new figure locale requires updating the renderer's locale contract, tests and README references together.
