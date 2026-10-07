"""Stage source-only changes; the maintainer must add the reviewed CI workflow separately."""
from pathlib import Path
import runpy
import subprocess

runpy.run_path(str(Path(__file__).with_name("source-repair.py")), run_name="__main__")
workflow = ".github/workflows/worker-queue-controls.yml"
subprocess.run(["git", "reset", "--", workflow], check=True)
Path(workflow).unlink()
paths = subprocess.check_output(["git", "diff", "--cached", "--name-only"], text=True).splitlines()
assert len(paths) == 20 and all(not path.startswith(".github/workflows/") for path in paths)
subprocess.run(["git", "diff", "--cached", "--check"], check=True)
print("Prepared 20 source/test changes. Workflow definition excluded from Actions token push.")
