#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Nicolas Vaughan <nivaca@fastmail.com>
# This file is part of validate-schematron. See the LICENSE file for details.
"""Makes the release bundles in dist/: python3 tools/bundle-zip.py

* dist/validate-schematron-v.VERSION.zip (the version of validate.py), with
  the program in a folder of the same name: validate.py, validate-all.sh,
  the READMEs, the licence and docs/ (the descriptions, the screenshots and
  the example).  It is made from the files git tracks, so nothing that only
  lives in this folder gets in (node_modules, the TEI stylesheets in odds/
  and common/, schema caches, test documents, editor lock files ...).  Left
  out as well: what is not part of the program (tools/, with the scripts
  that make the bundles and the screenshots; vscode/, the extension, which
  is distributed as its .vsix; and src/ with pyproject.toml, the package
  scaffold, not yet in use) and hidden files.  validate-all.sh keeps its
  permission to run.
* dist/validate-schematron-EXTVERSION.vsix, the VS Code extension (the
  version of vscode/package.json), packaged with vsce (Node.js and npm are
  needed; --no-vsix leaves it out).

dist is made in the program's folder if need be; --output gives another
folder.  If any of the bundled files has changes not committed yet, it
says so, since the zip takes the files as they are now.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # (above tools/)
DIST = os.path.join(HERE, "dist")
NAME = "validate-schematron"

#  What is in the repository but not part of the program
NOT_PART = ("tools/", "vscode/", "src/", "pyproject.toml")


def version() -> str:
    """validate.py's __version__, read without importing it (that would
    need saxonche and lxml)."""
    with open(os.path.join(HERE, "validate.py"), encoding="utf-8") as f:
        m = re.search(r'^__version__\s*=\s*"([^"]+)"', f.read(), re.M)
    if not m:
        sys.exit("bundle-zip.py: no __version__ in validate.py")
    return m.group(1)


def extension_version() -> str:
    with open(os.path.join(HERE, "vscode", "package.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def name() -> str:
    """The name of the zip, without .zip: validate-schematron-v.1.8."""
    return f"{NAME}-v.{version()}"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=HERE, capture_output=True, text=True, check=True).stdout


def files() -> list[str]:
    """The files of the distribution, relative to the program's folder."""
    out = []
    for f in git("ls-files", "-z").split("\0"):
        if not f or f.startswith(NOT_PART) or any(p.startswith(".") for p in f.split("/")):
            continue
        if os.path.isfile(os.path.join(HERE, f)):  # (tracked but deleted: left out)
            out.append(f)
    return sorted(out)


def uncommitted(paths: list[str]) -> list[str]:
    status = git("status", "--porcelain", "--", *paths)
    return [line[3:] for line in status.splitlines()]


def bundle_zip(folder: str) -> str:
    """Writes the zip into FOLDER; returns its path."""
    path = os.path.join(folder, name() + ".zip")
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files():
            src = os.path.join(HERE, f)
            info = zipfile.ZipInfo.from_file(src, name() + "/" + f)
            #  (ordinary permissions, whatever this folder has: rw-r--r--, or
            #  rwxr-xr-x for what can be run, as validate-all.sh)
            mode = 0o755 if os.access(src, os.X_OK) else 0o644
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(src, "rb") as data:
                z.writestr(info, data.read())
    os.replace(tmp, path)
    return path


def bundle_vsix(folder: str) -> str:
    """Packages the extension into FOLDER; returns its path."""
    npm, npx = shutil.which("npm"), shutil.which("npx")
    if not (npm and npx):
        sys.exit("bundle-zip.py: Node.js and npm are needed for the .vsix (or use --no-vsix)")
    ext = os.path.join(HERE, "vscode")
    if not os.path.isdir(os.path.join(ext, "node_modules")):
        subprocess.run([npm, "ci", "--no-fund", "--no-audit"], cwd=ext, check=True)
    path = os.path.join(folder, f"{NAME}-{extension_version()}.vsix")
    subprocess.run([npx, "vsce", "package", "-o", path], cwd=ext, check=True,
                   stdout=subprocess.DEVNULL)
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="tools/bundle-zip.py",
        description=f"Make the release bundles: {name()}.zip and the extension's .vsix.")
    parser.add_argument("-o", "--output", metavar="FOLDER", default=None,
                        help="the folder to write them in (default: dist, in the program's folder)")
    parser.add_argument("-l", "--list", action="store_true",
                        help="only list the files the zip would have")
    parser.add_argument("--no-vsix", action="store_true", help="make only the zip")
    args = parser.parse_args(argv)
    if args.list:
        print("\n".join(files()))
        return
    if args.output is None:
        args.output = DIST
        os.makedirs(DIST, exist_ok=True)
    elif not os.path.isdir(args.output):
        sys.exit(f"bundle-zip.py: there is no folder {args.output}")
    changed = uncommitted(files())
    if changed:
        print("Note: not committed yet, bundled as they are now: " + ", ".join(changed))
    try:
        path = bundle_zip(args.output)
    except OSError as e:
        sys.exit(f"bundle-zip.py: {e}")
    with zipfile.ZipFile(path) as z:
        count = len(z.namelist())
    print(f"Wrote {path} ({count} files, {os.path.getsize(path) / 1e6:.1f} MB).")
    if not args.no_vsix:
        vsix = bundle_vsix(args.output)
        print(f"Wrote {vsix} ({os.path.getsize(vsix) / 1e3:.0f} kB).")


if __name__ == "__main__":
    main()
