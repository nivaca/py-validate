#!/usr/bin/env python3
"""Take the screenshots of the READMEs: the command line, and the VS Code
extension at work (in dark and light colours).

    python3 tools/screenshots.py [-o FOLDER] [--only cli,vscode]
                                 [--looks dark,light] [--scale 2]
                                 [--python PYTHON] [--jing JING] [--code CODE]

It writes FOLDER/cli.png and FOLDER/vscode_LOOK.png (by default in
docs/img/, where README.md, README_es.md and vscode/README.md take them
from), at SCALE times the size on the screen (2 by default, sharp on screens
of high resolution).

Every shot uses the example in docs/example/ (edition.xml, with deliberate
mistakes, and schema.rng, a small RelaxNG with Schematron rules embedded),
copied to a temporary folder; no other document is read or written.

* The command line is a real session: validate.py and validate-all.sh are
  run on the example, and their output is drawn like a terminal (Konsole's
  Breeze colours, the Hack font) with Pillow.
* VS Code runs on a hidden X display of its own (Xvfb), with a throwaway
  profile (settings, extensions) and the extension loaded from vscode/,
  compiled first. vscode/src/test/screenshots/drive.ts opens the example,
  waits for the diagnostics, and shows the Problems panel and the hover of
  one error; then ImageMagick's import takes the display. Nothing appears
  on the screen, and the user's own VS Code settings are not touched.

It needs Pillow (for this script), a Python with saxonche and lxml to run
validate.py (--python; by default the one running this script), jing for the
RelaxNG layer (--jing; optional), and, for VS Code: Xvfb, ImageMagick,
Node.js with npm, and VS Code itself (--code).
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "docs" / "example"
EXTENSION = ROOT / "vscode"
DRIVER = EXTENSION / "out" / "test" / "screenshots" / "drive.js"

KINDS = ("cli", "vscode")
LOOKS = {"dark": "Default Dark Modern", "light": "Default Light Modern"}
SCALE = 2
WINDOW = (1440, 900)  # VS Code's window, in pixels before the scale

# What the VS Code shot waits for, and whose hover it shows
EXPECTED_DIAGNOSTICS = 6  # (7 with jing: one more from RelaxNG)
HOVER = "must not contain loose text"

# The command-line session, run in a temporary folder holding the example
# and the two programs (shown as typed; run with --python and --jing)
SESSION = [
    ["python3", "validate.py", "-v", "edition.xml"],
    ["./validate-all.sh", "edition.xml"],
]

# The terminal: Konsole's Breeze scheme
BACKGROUND, FOREGROUND = "#232627", "#fcfcfc"
PROMPT, DIM, WARN = "#1cdc9a", "#bdc3c7", "#fdbc4b"
FONTS = ("Hack", "DejaVu Sans Mono", "Liberation Mono", "monospace")
FONT_SIZE, LINE_HEIGHT, MARGIN, COLUMNS = 15, 1.35, 16, 100


def say(text: str):
    print(text, flush=True)


def need(program: str, why: str) -> str:
    path = shutil.which(program)
    if not path:
        raise SystemExit(f"{program} is needed {why}")
    return path


# ---------------------------------------------------------------------------
#  The command line


def session_environment(python: str, jing: str | None) -> dict:
    """python3 and jing, as validate-all.sh calls them, are the chosen ones."""
    bindir = Path(tempfile.mkdtemp(prefix="validate-shot-bin-"))
    for name, target in (("python3", python), ("jing", jing)):
        if target:  # (a wrapper, not a symlink: a venv's python must be started by its own path)
            (bindir / name).write_text(f'#!/bin/sh\nexec {shlex.quote(target)} "$@"\n')
            (bindir / name).chmod(0o755)
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1")
    env["PATH"] = f"{bindir}{os.pathsep}{env.get('PATH', '')}"
    if not jing:  # (so that validate-all.sh falls back to lxml)
        env["PATH"] = os.pathsep.join(p for p in env["PATH"].split(os.pathsep)
                                      if not (Path(p) / "jing").exists())
    return env


def cli(out: Path, scale: float, python: str, jing: str | None):
    """Run SESSION on a copy of the example and draw it like a terminal."""
    folder = Path(tempfile.mkdtemp(prefix="validate-shot-cli-"))
    env = session_environment(python, jing)
    try:
        for f in ("edition.xml", "schema.rng"):
            shutil.copyfile(EXAMPLE / f, folder / f)
        for f in ("validate.py", "validate-all.sh"):
            shutil.copy2(ROOT / f, folder / f)
        (folder / "validate-all.sh").chmod(0o755)
        lines: list[tuple[str, str]] = []  # (kind, text): prompt or output
        for args in SESSION:
            lines.append(("prompt", shlex.join(args)))
            result = subprocess.run(args, cwd=folder, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True)
            if result.returncode not in (0, 1, 2, 3):  # (the example has mistakes on purpose)
                raise SystemExit(f"'{shlex.join(args)}' failed ({result.returncode}):\n{result.stdout}")
            text = result.stdout.replace(str(folder) + os.sep, "")
            lines += [("output", ln) for ln in text.rstrip("\n").splitlines()
                      if not ln.startswith("Picked up _JAVA_OPTIONS")]
            lines.append(("output", ""))
        lines[-1] = ("prompt", "")
        draw_terminal(lines, out, scale)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
        shutil.rmtree(Path(env["PATH"].split(os.pathsep)[0]), ignore_errors=True)


def font_file(family: str, bold: bool) -> str | None:
    try:
        path = subprocess.run(["fc-match", "-f", "%{file}", f"{family}:{'bold' if bold else 'regular'}"],
                              capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return path or None


def draw_terminal(entries: list[tuple[str, str]], out: Path, scale: float):
    from PIL import Image, ImageDraw, ImageFont

    size = round(FONT_SIZE * scale)
    regular = bold = None
    for family in FONTS:
        regular, bold = font_file(family, False), font_file(family, True)
        if regular:
            break
    font = ImageFont.truetype(regular, size) if regular else ImageFont.load_default(size)
    font_b = ImageFont.truetype(bold or regular, size) if regular else font

    rows: list[tuple[str, str]] = []  # wrap long lines at COLUMNS
    for kind, text in entries:
        text = ("$ " + text) if kind == "prompt" else text
        while len(text) > COLUMNS:
            cut = text.rfind(" ", 0, COLUMNS)
            cut = cut if cut > COLUMNS // 2 else COLUMNS
            rows.append((kind, text[:cut]))
            text = "    " + text[cut:].lstrip()
            kind = "output" if kind == "output" else "cont"
        rows.append((kind, text))

    advance = font.getlength("M")
    line_h = size * LINE_HEIGHT
    margin = MARGIN * scale
    width = round(margin * 2 + advance * COLUMNS)
    height = round(margin * 2 + line_h * len(rows))
    image = Image.new("RGB", (width, height), BACKGROUND)
    d = ImageDraw.Draw(image)
    y = margin
    for kind, text in rows:
        x = margin
        if kind == "prompt":
            d.text((x, y), "$", font=font_b, fill=PROMPT)
            x += advance * 2
            d.text((x, y), text[2:], font=font, fill=FOREGROUND)
            if not text[2:]:  # the cursor of the last prompt
                d.rectangle([x, y + size * 0.1, x + advance, y + size * 1.15], fill=FOREGROUND)
        elif kind == "cont":
            d.text((x, y), text, font=font, fill=FOREGROUND)
        else:
            lowered = text.lower()
            colour = (WARN if any(w in lowered for w in (": error:", "[!]", "[aviso]", "veredicto: infracciones"))
                      else FOREGROUND if text.startswith(("==", "===")) else DIM)
            d.text((x, y), text, font=font, fill=colour)
        y += line_h
    image.save(out, "PNG")


# ---------------------------------------------------------------------------
#  VS Code


def compile_extension():
    npm = need("npm", "to compile the extension")
    if not (EXTENSION / "node_modules").is_dir():
        subprocess.run([npm, "install", "--no-fund", "--no-audit"], cwd=EXTENSION, check=True)
    for script in ("compile", "bundle-validator"):
        subprocess.run([npm, "run", "--silent", script], cwd=EXTENSION, check=True)


def vscode_binary(given: str | None) -> str:
    """The Electron executable (the 'code' command is a script that starts it)."""
    path = Path(given or need("code", "for the VS Code shots (or use --code)")).resolve()
    if path.name == "code" and path.parent.name == "bin" and (path.parent.parent / "code").is_file():
        path = path.parent.parent / "code"  # /usr/share/code/bin/code -> /usr/share/code/code
    return str(path)


class Display:
    """A hidden X display of its own (Xvfb), of WIDTH x HEIGHT pixels."""

    def __init__(self, width: int, height: int):
        read, write = os.pipe()
        self.process = subprocess.Popen(
            [need("Xvfb", "for the VS Code shots"), "-displayfd", str(write), "-screen", "0",
             f"{width}x{height}x24", "-nolisten", "tcp"], pass_fds=(write,), stderr=subprocess.DEVNULL)
        os.close(write)
        with os.fdopen(read) as f:
            self.name = ":" + f.readline().strip()

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=10)


def vscode_settings(look: str, python: str, jing: str | None) -> dict:
    return {
        "workbench.colorTheme": LOOKS[look],
        "window.titleBarStyle": "native",  # (no window manager: no title bar at all)
        "window.menuBarVisibility": "toggle",  # (hidden until Alt is pressed)
        "window.commandCenter": False,  # (it would show "[Extension Development Host]")
        "window.newWindowDimensions": "fullscreen",
        "workbench.startupEditor": "none",
        "workbench.tips.enabled": False,
        "workbench.welcomePage.walkthroughs.openOnInstall": False,
        "workbench.secondarySideBar.defaultVisibility": "hidden",
        "workbench.layoutControl.enabled": False,
        "chat.disableAIFeatures": True,
        "chat.commandCenter.enabled": False,
        "update.mode": "none",
        "telemetry.telemetryLevel": "off",
        "extensions.ignoreRecommendations": True,
        "security.workspace.trust.enabled": False,
        "git.enabled": False,
        "editor.minimap.enabled": False,
        "editor.stickyScroll.enabled": False,
        "editor.fontSize": 14,
        "editor.wordWrap": "on",
        "files.exclude": {"**/*.harvested.sch": True},
        "schematron.pythonPath": python,
        "schematron.jingPath": jing or "jing",
        "schematron.relaxng.enabled": bool(jing),
    }


def vscode(look: str, out: Path, scale: float, python: str, jing: str | None, code: str):
    import json

    folder = Path(tempfile.mkdtemp(prefix=f"validate-shot-vscode-{look}-"))
    width, height = round(WINDOW[0] * scale), round(WINDOW[1] * scale)
    display = Display(width, height)
    vsc = None
    try:
        work = folder / "example"
        work.mkdir()
        for f in ("edition.xml", "schema.rng"):
            shutil.copyfile(EXAMPLE / f, work / f)
        handshake = folder / "handshake"
        handshake.mkdir()
        user = folder / "user-data" / "User"
        user.mkdir(parents=True)
        (user / "settings.json").write_text(json.dumps(vscode_settings(look, python, jing), indent=2))
        env = dict(os.environ, DISPLAY=display.name, SHOTS_HANDSHAKE=str(handshake),
                   SHOTS_DOC=str(work / "edition.xml"),
                   SHOTS_EXPECT=str(EXPECTED_DIAGNOSTICS + (1 if jing else 0)), SHOTS_HOVER=HOVER)
        env.pop("WAYLAND_DISPLAY", None)  # (never the user's own screen)
        vsc = subprocess.Popen(
            [code, "--extensionDevelopmentPath", str(EXTENSION), "--extensionTestsPath", str(DRIVER),
             "--user-data-dir", str(folder / "user-data"), "--extensions-dir", str(folder / "extensions"),
             "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
             "--disable-gpu", "--ozone-platform=x11", f"--force-device-scale-factor={scale:g}", str(work)],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.time() + 180
        while not (handshake / "ready").exists():
            if vsc.poll() is not None:
                raise SystemExit(f"VS Code exited ({vsc.returncode}) before the picture was ready")
            if time.time() > end:
                raise SystemExit("timed out waiting for VS Code")
            time.sleep(0.2)
        subprocess.run([need("import", "(ImageMagick) to take the picture"), "-display", display.name,
                        "-window", "root", str(out)], check=True)
        (handshake / "done").write_text("")
        vsc.wait(timeout=60)
    finally:
        if vsc and vsc.poll() is None:
            vsc.kill()
        display.close()
        shutil.rmtree(folder, ignore_errors=True)


# ---------------------------------------------------------------------------


def check_python(python: str):
    probe = subprocess.run([python, "-c", "import saxonche, lxml"], capture_output=True)
    if probe.returncode:
        raise SystemExit(f"{python} cannot import saxonche and lxml; pass --python with one that can")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Take the screenshots of the command line and the VS Code "
                                                 "extension (for the READMEs).")
    parser.add_argument("-o", "--output", type=Path, default=ROOT / "docs" / "img",
                        help="the folder of the images (default: docs/img)")
    parser.add_argument("--only", default=",".join(KINDS), help=f"which shots: {','.join(KINDS)}")
    parser.add_argument("--looks", default=",".join(LOOKS),
                        help=f"the colours of the VS Code shots: {','.join(LOOKS)} (default: both)")
    parser.add_argument("--scale", type=float, default=SCALE, help="times the size on the screen (default: 2)")
    parser.add_argument("--python", default=sys.executable,
                        help="a Python with saxonche and lxml, to run validate.py (default: this one)")
    parser.add_argument("--jing", default=shutil.which("jing"),
                        help="jing, for the RelaxNG layer (default: the one on the PATH; without it, none)")
    parser.add_argument("--code", help="VS Code (default: the 'code' command)")
    args = parser.parse_args(argv)

    kinds = [k for k in args.only.split(",") if k]
    looks = [k for k in args.looks.split(",") if k]
    for k in kinds:
        if k not in KINDS:
            raise SystemExit(f"unknown shot: {k} (choose from {', '.join(KINDS)})")
    for k in looks:
        if k not in LOOKS:
            raise SystemExit(f"unknown look: {k} (choose from {', '.join(LOOKS)})")
    if args.scale <= 0:
        raise SystemExit("the scale must be more than 0")
    try:
        import PIL  # noqa: F401
    except ImportError:
        raise SystemExit("Pillow is needed: pip install pillow") from None
    python = str(Path(args.python).expanduser())
    check_python(python)
    jing = str(Path(args.jing).expanduser().resolve()) if args.jing else None
    if not jing:
        say("(jing not found: the shots will show the Schematron layer only)")
    args.output.mkdir(parents=True, exist_ok=True)

    if "vscode" in kinds:
        code = vscode_binary(args.code)
        say("compiling the extension")
        compile_extension()
    for kind in kinds:
        if kind == "cli":
            out = args.output / "cli.png"
            say(f"cli -> {out}")
            cli(out, args.scale, python, jing)
        else:
            for look in looks:
                out = args.output / f"vscode_{look}.png"
                say(f"vscode ({look}) -> {out}")
                vscode(look, out, args.scale, python, jing, code)


if __name__ == "__main__":
    main()
