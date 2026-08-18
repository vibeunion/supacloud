from pathlib import Path

path = Path("packages/management-api/src/middleware/auth.ts")
content = path.read_text()
old = '"/pause", "/restore", "/restart", "/read-replicas", "/endpoint", "/upgrade", "/upgrade-status", "/enforced"'
new = '"/pause", "/restore", "/restart", "/read-replicas", "/endpoint", "/endpoints", "/upgrade", "/upgrade-status", "/enforced"'
if content.count(old) != 1:
    raise RuntimeError("Expected one project.read endpoint capability mapping")
path.write_text(content.replace(old, new, 1))
