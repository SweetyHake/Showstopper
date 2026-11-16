#!/usr/bin/env python3
"""Build clean Foundry VTT release archives (showstopper.zip and showstopper-plus.zip) without TS sources or dev harnesses."""

from __future__ import annotations

import json
import os
import posixpath
import re
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parent.parent

CSS_IMPORT_RE = re.compile(r"""@import\s+(?:url\(\s*)?['"]?([^'"\)\s;]+)""")
ESM_IMPORT_RE = re.compile(r"""(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.\.?/[^'"]+)['"]""")

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
    if any(p.startswith(".") for p in parts):
        return False
    # Dev harnesses (`_smoke.mjs`, `_bench.mjs`, `_preview.html`, ...) live only under `scripts/`;
    # CSS partials such as `styles/app/_variables.css` MUST stay in the release archive.
    if parts[0] == "scripts" and any(p.startswith("_") for p in parts[1:]):
        return False
    if name.endswith(EXCLUDED_SUFFIXES):
        return False
    return True


def validate_relative_imports(
    entries: list[tuple[Path, str]],
    archived_set: set[str],
    pkg_label: str,
) -> None:
    missing: list[str] = []
    for full, rel in entries:
        if rel.endswith(".css"):
            text = full.read_text(encoding="utf-8", errors="ignore")
            for raw_ref in CSS_IMPORT_RE.findall(text):
                if raw_ref.startswith(("http://", "https://", "data:", "/")):
                    continue
                clean_ref = raw_ref.split("#", 1)[0].split("?", 1)[0]
                if not clean_ref:
                    continue
                target = posixpath.normpath((PurePosixPath(rel).parent / clean_ref).as_posix())
                if target not in archived_set:
                    missing.append(f"{rel} -> {raw_ref} (resolved: {target})")
        elif rel.endswith((".mjs", ".js")):
            text = full.read_text(encoding="utf-8", errors="ignore")
            for raw_ref in ESM_IMPORT_RE.findall(text):
                clean_ref = raw_ref.split("#", 1)[0].split("?", 1)[0]
                if not clean_ref:
                    continue
                target = posixpath.normpath((PurePosixPath(rel).parent / clean_ref).as_posix())
                if target not in archived_set:
                    missing.append(f"{rel} -> {raw_ref} (resolved: {target})")

    if missing:
        raise RuntimeError(f"[{pkg_label}] Relative imports missing from archive: {missing}")


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
        skip_prefixes = (".", "_") if dname == "scripts" else (".",)
        for r, dirs, files in os.walk(dpath):
            dirs[:] = sorted(d for d in dirs if not d.startswith(skip_prefixes))
            for f in sorted(files):
                full = Path(r) / f
                rel = full.relative_to(pkg_dir).as_posix()
                if should_include(rel):
                    entries.append((full, rel))

    # Validate manifest references and internal relative imports before writing archive
    manifest = json.loads((pkg_dir / "module.json").read_text(encoding="utf-8"))
    pkg_label = manifest.get("id", pkg_dir.name)
    archived_set = {rel for _, rel in entries}
    required_refs: list[str] = []
    required_refs.extend(manifest.get("esmodules", []))
    required_refs.extend(s["src"] for s in manifest.get("styles", []) if isinstance(s, dict) and "src" in s)
    required_refs.extend(l["path"] for l in manifest.get("languages", []) if isinstance(l, dict) and "path" in l)
    if manifest.get("license"):
        required_refs.append(manifest["license"])

    missing = [ref for ref in required_refs if ref not in archived_set]
    if missing:
        raise RuntimeError(f"[{pkg_label}] Manifest references missing from archive: {missing}")

    validate_relative_imports(entries, archived_set, pkg_label)

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
