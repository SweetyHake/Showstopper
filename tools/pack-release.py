#!/usr/bin/env python3
"""Build clean Foundry VTT release archives (showstopper.zip and showstopper-plus.zip) without TS sources or dev harnesses."""

from __future__ import annotations

import json
import os
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent

ROOT_FILES = [
    "module.json",
    "LICENSE",
]

OPTIONAL_ROOT_FILES = [
    "CHANGELOG.md",
]

RUNTIME_DIRS = [
    "assets",
    "lang",
    "scripts",
    "styles",
    "templates",
]

EXCLUDED_SUFFIXES = (".mts", ".ts", ".map")


def should_include(rel_posix: str) -> bool:
    parts = rel_posix.split("/")
    name = parts[-1]
    if any(p.startswith(".") or p.startswith("_") for p in parts):
        return False
    if name.endswith(EXCLUDED_SUFFIXES):
        return False
    return True


def build_package_zip(pkg_dir: Path, out_zip: Path) -> None:
    entries: list[tuple[Path, str]] = []

    for fname in ROOT_FILES:
        fpath = pkg_dir / fname
        if not fpath.is_file():
            raise FileNotFoundError(f"[{pkg_dir.name}] Missing required root file: {fname}")
        entries.append((fpath, fname))

    for fname in OPTIONAL_ROOT_FILES:
        fpath = pkg_dir / fname
        if fpath.is_file():
            entries.append((fpath, fname))

    for dname in RUNTIME_DIRS:
        dpath = pkg_dir / dname
        if not dpath.is_dir():
            continue
        for r, dirs, files in os.walk(dpath):
            dirs[:] = sorted(d for d in dirs if not d.startswith((".", "_")))
            for f in sorted(files):
                full = Path(r) / f
                rel = full.relative_to(pkg_dir).as_posix()
                if should_include(rel):
                    entries.append((full, rel))

    # Validate manifest references before writing archive
    manifest = json.loads((pkg_dir / "module.json").read_text(encoding="utf-8"))
    archived_set = {rel for _, rel in entries}
    required_refs: list[str] = []
    required_refs.extend(manifest.get("esmodules", []))
    required_refs.extend(s["src"] for s in manifest.get("styles", []) if isinstance(s, dict) and "src" in s)
    required_refs.extend(l["path"] for l in manifest.get("languages", []) if isinstance(l, dict) and "path" in l)
    if manifest.get("license"):
        required_refs.append(manifest["license"])

    missing = [ref for ref in required_refs if ref not in archived_set]
    if missing:
        raise RuntimeError(f"[{manifest.get('id', pkg_dir.name)}] Manifest references missing from archive: {missing}")

    if out_zip.exists():
        out_zip.unlink()

    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for full, rel in entries:
            zf.write(full, arcname=rel)

    with zipfile.ZipFile(out_zip, "r") as zf:
        bad = zf.testzip()
        if bad is not None:
            raise RuntimeError(f"Corrupt entry in archive {out_zip.name}: {bad}")
        names = zf.namelist()

    size_mb = out_zip.stat().st_size / (1024 * 1024)
    print(f"Built {out_zip.name} (id={manifest.get('id')}): {len(names)} files, {size_mb:.2f} MiB")


def main() -> None:
    build_package_zip(ROOT, ROOT / "showstopper.zip")
    plus_dir = ROOT / "plus"
    if plus_dir.is_dir():
        build_package_zip(plus_dir, ROOT / "showstopper-plus.zip")


if __name__ == "__main__":
    main()
