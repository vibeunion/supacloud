from base64 import b64encode
from pathlib import Path
import runpy

runpy.run_path('.github/scripts/fix-auth-cli-boundaries.py', run_name='__main__')
for path in (
    'packages/cli/src/shared/tools/auth-tools.ts',
    'packages/cli/src/shared/tools/auth-tools.test.ts',
):
    encoded = b64encode(Path(path).read_bytes()).decode('ascii')
    print(f'AUTH_CLI_REVIEW_FILE::{path}::{encoded}')
