"""One-time, branch-scoped preparation of manifests, embedded starters and lockfiles.
Removed after the generated edits are reviewed. No main-branch writes or releases.
"""
from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]
VERSION = "7.8.2"

def replace_once(path: Path, before: str, after: str) -> None:
    text = path.read_text()
    if after in text:
        return
    if text.count(before) != 1:
        raise RuntimeError(f"Expected exactly one unchanged insertion point: {path}")
    path.write_text(text.replace(before, after, 1))

for package in ["app", "supacloud-js"]:
    path = ROOT / "packages" / package / "package.json"
    data = json.loads(path.read_text())
    data["dependencies"]["rxjs"] = VERSION
    data["exports"]["./reactive"] = {
        "types": "./dist/reactive.d.ts",
        "import": "./dist/reactive.js",
        "default": "./dist/reactive.js",
    }
    step = "bun build src/reactive.ts --outdir dist --target browser --external rxjs"
    if step not in data["scripts"]["build:js"]:
        data["scripts"]["build:js"] += " && " + step
    if "REACTIVE.md" not in data["files"]:
        data["files"].append("REACTIVE.md")
    path.write_text(json.dumps(data, indent=2) + "\n")
    readme = path.parent / "README.md"
    addition = "\n## Default reactive support\n\nRxJS is provided by default. See [Reactive development](REACTIVE.md) for the\n`/reactive` entry, SDK compatibility, cancellation and durable-output boundaries.\nOrdinary Promise APIs and non-reactive entrypoints are unchanged.\n"
    text = readme.read_text()
    if addition not in text:
        readme.write_text(text + addition)

for name in ["app-starter.ts", "app-starter-templates.ts"]:
    path = ROOT / "packages/cli/src/shared/tools" / name
    imports = 'import { STARTER_REACTIVE_GUIDE, STARTER_REACTIVE_TEST, STARTER_REACTIVE_AGENTS } from "./app-starter-reactive";\n'
    text = path.read_text()
    if imports not in text:
        path.write_text(imports + text)
    replace_once(path, 'elysia: "2.0.0-beta.19",', 'elysia: "2.0.0-beta.19",\n                rxjs: appMetadata.dependencies.rxjs,')
    before = '"scripts/environment.ts": STARTER_ENVIRONMENT,'
    after = '\n'.join([
        '"REACTIVE.md": STARTER_REACTIVE_GUIDE,',
        '        "AGENTS.md": STARTER_REACTIVE_AGENTS,',
        '        "tests/reactive.test.ts": STARTER_REACTIVE_TEST,',
        '        ' + before,
    ])
    text = path.read_text()
    if after not in text and '"AGENTS.md":' in text:
        raise RuntimeError(f"Do not replace existing application instructions: {path}")
    replace_once(path, before, after)

path = ROOT / "docs/engineering-goals.md"
addition = "\n## Default reactive development\n\nRxJS is the supported default for event composition; single-result commands keep\nasync/await. Starters include the dependency, REACTIVE.md, AI guidance and cleanup\ntests. Preserve the project-bound `@supacloud/js` client and its Promise APIs. See\n[Reactive development](reactive-development.md) and\n[Framework transport integration](../packages/app/REACTIVE.md).\n"
text = path.read_text()
if addition not in text:
    path.write_text(text + addition)

tracked = subprocess.check_output(["git", "ls-files", "packages/**/bun.lock"], cwd=ROOT, text=True).splitlines()
for relative in tracked:
    path = ROOT / relative
    text = path.read_text()
    if '"@supacloud/app"' in text or '"@supacloud/js"' in text:
        subprocess.run(["bun", "install", "--lockfile-only", "--ignore-scripts", "--cwd", str(path.parent)], cwd=ROOT, check=True)
