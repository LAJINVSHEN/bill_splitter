#!/usr/bin/env python3
"""Run the provisioning scripts in dependency order, stopping at the first failure.

    python scripts/provision/all.py [--dry-run] [--enable-deploy]

cloudflare.py (Pages URL) → supabase.py (needs the Pages URL for Auth redirects) →
render.py (needs Supabase values + Pages URL for CORS) → github.py (needs everything above).
Each script is idempotent, so re-running after a fix is safe.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    dry = ["--dry-run"] if "--dry-run" in sys.argv else []
    gh_extra = ["--enable-deploy"] if "--enable-deploy" in sys.argv else []
    for script, extra in (("cloudflare.py", []), ("supabase.py", []), ("render.py", []), ("github.py", gh_extra)):
        code = subprocess.run([sys.executable, str(HERE / script), *dry, *extra]).returncode
        if code != 0:
            print(f"\n{script} exited with {code}; fix the issue above and re-run (completed steps are skipped).")
            return code
    print("\nProvisioning done. Next: push to main, then python scripts/provision/smoke.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
