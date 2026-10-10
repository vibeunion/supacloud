import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text())
assert isinstance(plan['pr'], int) and plan['pr'] in {1771, 1774, 1776, 1778, 1779, 1780, 1781, 1782, 1784, 1785, 1786, 1787, 1788}
for key in ['head', 'merge', 'tree']:
    assert re.fullmatch('[a-f0-9]{40}', plan[key])
assert re.fullmatch(r'refs/remotes/review/[A-Za-z0-9_-]+', plan['merge_ref'])

def git(*args, check=True):
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

git('config', 'user.name', 'SupaCloud Review')
git('config', 'user.email', 'review@supacloud.invalid')
git('fetch', '--no-tags', 'origin', f"refs/pull/{plan['pr']}/head:refs/remotes/review/input")
assert git('rev-parse', 'refs/remotes/review/input').stdout.strip() == plan['head'], 'PR head moved; re-review required'
git('fetch', '--no-tags', 'origin', f"{plan['merge']}:{plan['merge_ref']}")
git('checkout', '--detach', plan['head'])
result = git('merge', '--no-ff', '--no-commit', plan['merge_ref'], check=False)
assert result.returncode in (0, 1), result.stderr
for entry in plan['files']:
    path = Path(entry['path'])
    assert not path.is_absolute() and '..' not in path.parts and '.git' not in path.parts
    content = path.read_text()
    assert hashlib.sha256(content.encode()).hexdigest() == entry['sha256'], f'Unexpected conflict contents: {path}'
    pattern = r'^<<<<<<< HEAD\n.*?^>>>>>>> ' + re.escape(plan['merge_ref']) + r'\n'
    conflicts = list(re.finditer(pattern, content, re.M | re.S))
    assert len(conflicts) == len(entry['resolutions']), f'Unexpected conflict count: {path}'
    for match, replacement in reversed(list(zip(conflicts, entry['resolutions']))):
        content = content[:match.start()] + replacement + '\n' + content[match.end():]
    path.write_text(content)
    git('add', '--', str(path))
assert not git('ls-files', '-u').stdout, 'Unresolved merge entries remain'
git('diff', '--cached', '--check')
assert git('write-tree').stdout.strip() == plan['tree'], 'Tree differs from locally tested result'
git('commit', '-m', f"fix(review): integrate PR #{plan['pr']} with reviewed base\n\nExact tree {plan['tree']} reproduced from pinned commits; protected main is not changed.")
sha = git('rev-parse', 'HEAD').stdout.strip()
branch = f"review/prepared-pr-{plan['pr']}-{plan['tree'][:12]}"
Path('/tmp/prepared-review-commit.json').write_text(json.dumps({'sha': sha, 'branch': branch, **{k: plan[k] for k in ['pr', 'head', 'merge', 'tree']}}, indent=2))
with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    output.write(f'branch={branch}\nsha={sha}\n')
print(f'Prepared PR {plan["pr"]}: {sha}; verified tree {plan["tree"]}')
