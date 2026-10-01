#!/usr/bin/env python3
"""Install, register and verify the approved UI handoff without external packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import stat
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "design-reference" / "ui-handoff-v2" / "source"
PLACEHOLDER = "COPY-UI-HANDOFF-V2-HERE.md"
RECORD = "installed.json"
CODE_SUFFIXES = {".css", ".html", ".js", ".jsx", ".scss", ".ts", ".tsx", ".vue"}


def material_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    excluded = {PLACEHOLDER, RECORD, ".DS_Store"}
    return sorted(
        path
        for path in directory.rglob("*")
        if path.is_file() and path.name not in excluded and "__MACOSX" not in path.parts
    )


def has_ui_evidence(directory: Path) -> bool:
    files = material_files(directory)
    return any(path.name == "package.json" for path in files) or any(
        path.suffix.lower() in CODE_SUFFIXES for path in files
    )


def fingerprint(directory: Path) -> dict[str, object]:
    digest = hashlib.sha256()
    files = material_files(directory)
    total_bytes = 0
    for path in files:
        relative = path.relative_to(directory).as_posix()
        content = path.read_bytes()
        total_bytes += len(content)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\0")
    return {
        "file_count": len(files),
        "total_bytes": total_bytes,
        "sha256": digest.hexdigest(),
    }


def write_record(source_label: str) -> dict[str, object]:
    if not has_ui_evidence(DESTINATION):
        raise RuntimeError(
            f"No UI source detected in {DESTINATION.relative_to(ROOT)}; copy the handoff first."
        )
    data = {
        "name": "email-operations-workspace-ui-handoff-v2",
        "source": source_label,
        "installed_at": datetime.now(timezone.utc).isoformat(),
        **fingerprint(DESTINATION),
    }
    (DESTINATION / RECORD).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return data


def safe_extract(archive: Path, destination: Path) -> None:
    root = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise RuntimeError(f"ZIP contains a symbolic link: {info.filename}")
            target = (destination / info.filename).resolve()
            if not target.is_relative_to(root):
                raise RuntimeError(f"ZIP contains an unsafe path: {info.filename}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def source_candidates(root: Path) -> list[Path]:
    candidates: list[Path] = []
    current = root
    for _ in range(3):
        candidates.extend([current / "source", current])
        children = [p for p in current.iterdir() if p.name not in {"__MACOSX", ".DS_Store"}]
        directories = [p for p in children if p.is_dir()]
        files = [p for p in children if p.is_file()]
        if len(directories) == 1 and not files:
            current = directories[0]
        else:
            break
    unique: list[Path] = []
    for candidate in candidates:
        if candidate.is_dir() and candidate not in unique:
            unique.append(candidate)
    return unique


def choose_source(root: Path) -> Path:
    candidates = source_candidates(root)
    package_candidates = [p for p in candidates if (p / "package.json").is_file()]
    if package_candidates:
        return package_candidates[0]
    evidence_candidates = [p for p in candidates if has_ui_evidence(p)]
    if evidence_candidates:
        return evidence_candidates[0]
    raise RuntimeError("Could not detect UI source files in the supplied folder or ZIP.")


def clear_destination() -> None:
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for child in DESTINATION.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def install(path: Path, replace: bool) -> dict[str, object]:
    if not path.exists():
        raise RuntimeError(f"Input does not exist: {path}")
    current = material_files(DESTINATION)
    if current and not replace:
        raise RuntimeError(
            "A UI handoff is already present. Re-run with --replace only if replacement is intended."
        )

    with tempfile.TemporaryDirectory(prefix="eow-ui-handoff-") as temporary:
        temporary_root = Path(temporary)
        if path.is_file():
            if not zipfile.is_zipfile(path):
                raise RuntimeError("The supplied file is not a ZIP archive.")
            safe_extract(path, temporary_root)
            source = choose_source(temporary_root)
        elif path.is_dir():
            source = choose_source(path.resolve())
        else:
            raise RuntimeError("Input must be a folder or ZIP archive.")

        clear_destination()
        for child in source.iterdir():
            target = DESTINATION / child.name
            if child.is_dir():
                shutil.copytree(child, target, symlinks=True)
            else:
                shutil.copy2(child, target, follow_symlinks=False)

    return write_record(path.name)


def status(allow_pending: bool) -> int:
    present = has_ui_evidence(DESTINATION)
    record_path = DESTINATION / RECORD
    record = None
    if record_path.is_file():
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            print(json.dumps({"status": "invalid", "error": str(error)}))
            return 1
    result = {
        "status": "ready" if present else "pending",
        "path": str(DESTINATION.relative_to(ROOT)),
        "registered": record is not None,
        **(fingerprint(DESTINATION) if present else {"file_count": 0}),
    }
    print(json.dumps(result, indent=2))
    return 0 if present or allow_pending else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    install_parser = subparsers.add_parser("install", help="Copy a handoff folder or ZIP")
    install_parser.add_argument("path", type=Path)
    install_parser.add_argument("--replace", action="store_true")
    subparsers.add_parser("register", help="Register manually copied UI source")
    status_parser = subparsers.add_parser("status", help="Verify UI source availability")
    status_parser.add_argument("--allow-pending", action="store_true")
    arguments = parser.parse_args()

    try:
        if arguments.command == "install":
            print(json.dumps(install(arguments.path, arguments.replace), indent=2))
            return 0
        if arguments.command == "register":
            print(json.dumps(write_record("manual-copy"), indent=2))
            return 0
        return status(arguments.allow_pending)
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        print(json.dumps({"status": "error", "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
