#!/usr/bin/env python3
"""Self-contained smoke tests for folder and ZIP UI handoff installation."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "ui_handoff.py"
FIXTURE = ROOT / "apps" / "web"


def make_repo(parent: Path, name: str) -> Path:
    repo = parent / name
    (repo / "scripts").mkdir(parents=True)
    (repo / "design-reference" / "ui-handoff-v2" / "source").mkdir(parents=True)
    shutil.copy2(HELPER, repo / "scripts" / "ui_handoff.py")
    return repo


def run(repo: Path, *arguments: str) -> dict[str, object]:
    result = subprocess.run(
        [sys.executable, str(repo / "scripts" / "ui_handoff.py"), *arguments],
        cwd=repo,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    return json.loads(result.stdout)


with tempfile.TemporaryDirectory(prefix=".ui-handoff-test-", dir=ROOT) as temporary:
    temporary_root = Path(temporary)

    folder_repo = make_repo(temporary_root, "folder-repo")
    folder_install = run(folder_repo, "install", str(FIXTURE))
    folder_status = run(folder_repo, "status")
    assert folder_install["file_count"] > 0 and folder_status["status"] == "ready"

    archive = temporary_root / "ui-handoff.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in FIXTURE.rglob("*"):
            if path.is_file() and "dist" not in path.parts and path.suffix != ".tsbuildinfo":
                target = Path("email-operations-workspace-ui-handoff-v2/source") / path.relative_to(FIXTURE)
                bundle.write(path, target)

    zip_repo = make_repo(temporary_root, "zip-repo")
    zip_install = run(zip_repo, "install", str(archive))
    zip_status = run(zip_repo, "status")
    assert zip_install["file_count"] > 0 and zip_status["status"] == "ready"

print({"status": "ok", "folder_install": "ok", "zip_install": "ok"})
