#!/usr/bin/env python3
"""Regenerate the deterministic bundle manifest for this repository tree."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "MANIFEST.json"
EXCLUDED_PARTS = {"node_modules", "dist", "coverage", ".git", "__pycache__"}
EXCLUDED_SUFFIXES = {".tsbuildinfo"}


def included(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return (
        path != OUTPUT
        and not any(part in EXCLUDED_PARTS for part in relative.parts)
        and path.suffix not in EXCLUDED_SUFFIXES
    )


files = []
for path in sorted((p for p in ROOT.rglob("*") if p.is_file() and included(p)), key=lambda p: p.as_posix()):
    content = path.read_bytes()
    files.append(
        {
            "path": path.relative_to(ROOT).as_posix(),
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    )

OUTPUT.write_text(
    json.dumps({"version": "3.3.0", "files": files}, indent=2) + "\n",
    encoding="utf-8",
)
print({"status": "ok", "version": "3.3.0", "files": len(files)})
