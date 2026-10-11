import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
plans = payload.get('plans', [payload])
assert 1 <= len(plans) <= 20
allowed = {1771, 1774, 1776, 1778, 1779, 1780, 1781, 1782, 1784, 1785, 1786, 1787, 1788}
results = {}

def git(*args, check=True):
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args], check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def safe_path(value):
    path = Path(value)
    assert not path.is_absolute() and '..' not in path.parts and '.git' not in path.parts
    assert path.resolve().is_relative_to(Path.cwd()) and not path.is_symlink()
    return path

def change_text(source, changes):
    previous = 0
    for start, end, replacement in changes:
        assert type(start) is int and type(end) is int and previous <= start <= end <= len(source)
        assert isinstance(replacement, str)
        previous = end
    for start, end, replacement in reversed(changes):
        source = source[:start] + replacement + source[end:]
    return source

git('config', 'user.name', 'SupaCloud Review')
git('config', 'user.email', 'review@supacloud.invalid')
git('config', 'core.autocrlf', 'false')
for plan in plans:
    pr = plan['pr']
    assert type(pr) is int and pr in allowed and pr not in results
    for key in ['head', 'merge', 'tree']:
        assert re.fullmatch('[a-f0-9]{40}', plan[key])
    assert re.fullmatch(r'refs/remotes/review/[A-Za-z0-9_-]+', plan['merge_ref'])
    git('fetch', '--no-tags', 'origin', f"+refs/pull/{pr}/head:refs/remotes/review/input")
    assert git('rev-parse', 'refs/remotes/review/input').stdout.strip() == plan['head'], 'PR head moved; re-review required'
    if 'merge_from_pr' in plan:
        source = results[plan['merge_from_pr']]['sha']
        git('update-ref', plan['merge_ref'], source)
    else:
        source = plan['merge']
        git('fetch', '--no-tags', 'origin', f"+{source}:{plan['merge_ref']}")
    if 'merge_tree' in plan:
        assert git('rev-parse', source + '^{tree}').stdout.strip() == plan['merge_tree'], 'Prerequisite tree changed'
    git('checkout', '--detach', plan['head'])
    result = git('merge', '--no-ff', '--no-commit', plan['merge_ref'], check=False)
    assert result.returncode in (0, 1), result.stderr
    for entry in plan['files']:
        path = safe_path(entry['path'])
        content = path.read_text()
        assert hashlib.sha256(content.encode()).hexdigest() == entry['sha256'], f'Unexpected conflict contents: {path}'
        pattern = r'^<<<<<<< HEAD\n(.*?)^=======\n(.*?)^>>>>>>> ' + re.escape(plan['merge_ref']) + r'\n'
        conflicts = list(re.finditer(pattern, content, re.M | re.S))
        assert len(conflicts) == len(entry['resolutions']), f'Unexpected conflict count: {path}'
        for match, resolution in reversed(list(zip(conflicts, entry['resolutions']))):
            if isinstance(resolution, str):
                replacement = resolution
            else:
                assert resolution['side'] in ('ours', 'theirs')
                replacement = match[1 if resolution['side'] == 'ours' else 2].rstrip('\n')
                replacement = change_text(replacement, resolution.get('changes', []))
            content = content[:match.start()] + replacement.rstrip('\n') + '\n' + content[match.end():]
        path.write_text(content)
        git('add', '--', str(path))
    assert not git('ls-files', '-u').stdout, 'Unresolved merge entries remain'
    for entry in plan.get('edits', []):
        path = safe_path(entry['path'])
        if entry['before_sha256'] is None:
            assert not path.exists(), f'New file already exists: {path}'
            content = ''
        else:
            content = path.read_text()
            assert hashlib.sha256(content.encode()).hexdigest() == entry['before_sha256'], f'Edit base changed: {path}'
        content = change_text(content, entry['changes'])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        git('add', '--', str(path))
    git('diff', '--cached', '--check')
    assert git('write-tree').stdout.strip() == plan['tree'], 'Tree differs from locally tested result'
    git('commit', '-m', f"fix(review): integrate PR #{pr} with reviewed base\n\nExact tree {plan['tree']} reproduced from pinned commits; protected main is not changed.")
    sha = git('rev-parse', 'HEAD').stdout.strip()
    branch = f"review/prepared-pr-{pr}-{plan['tree'][:12]}"
    results[pr] = {'sha': sha, 'branch': branch, 'pr': pr, 'head': plan['head'], 'merge': source, 'tree': plan['tree']}
    print(f"Prepared PR {pr}: {sha}; verified tree {plan['tree']}")
Path('/tmp/prepared-review-commits.json').write_text(json.dumps(list(results.values()), indent=2))
Path('/tmp/prepared-review-refs.txt').write_text(''.join(f"{r['branch']} {r['sha']}\n" for r in results.values()))
