# Schematron Validator for VS Code

Validates XML/TEI documents against Schematron rules using
[validate.py](https://codeberg.org/nivaca/py-validate). It can also check
RelaxNG structure with jing. Results appear as squiggles in the editor and in
the Problems panel.

![The extension on a TEI document: errors underlined, the message of one, the Problems panel and the count in the status bar](https://codeberg.org/nivaca/py-validate/raw/branch/main/docs/img/vscode_dark.png)

## Before you start

> **This extension needs Python on your computer, with two extra Python
> libraries: `saxonche` and `lxml`.** VS Code does not install them for you.
> Without them the extension cannot check anything, and the status bar shows
> *Schematron: failed*. Setting them up takes about five minutes, once.

### 1. Check that Python is installed

Open a terminal. In VS Code: menu **Terminal → New Terminal**. Then type:

| System | Type this | You should see |
|---|---|---|
| Linux, macOS | `python3 --version` | `Python 3.9` or a higher number |
| Windows | `py --version` | `Python 3.9` or a higher number |

If you get an error such as *command not found*, install Python first:

- **Windows and macOS:** download it from <https://www.python.org/downloads/>
  and run the installer. On Windows, tick **"Add python.exe to PATH"** on
  the installer's first screen.
- **Linux:** use your system's packages, e.g. `sudo apt install python3
  python3-venv` (Debian, Ubuntu) or `sudo dnf install python3` (Fedora).

Then close the terminal, open a new one, and check again.

### 2. Install the two libraries

They go into a folder of their own, a *virtual environment*, so that they
don't interfere with anything else on your computer. (Recent Linux and
macOS systems refuse `pip install` outside one, with an
*externally-managed-environment* error.) Copy these two lines into the
terminal, one at a time:

**Linux and macOS:**

```sh
python3 -m venv ~/.venvs/schematron
~/.venvs/schematron/bin/pip install saxonche lxml
```

**Windows** (in VS Code's terminal, which uses PowerShell):

```powershell
py -m venv $HOME\.venvs\schematron
& $HOME\.venvs\schematron\Scripts\pip install saxonche lxml
```

The second line downloads the libraries; it ends with *Successfully
installed … lxml … saxonche …*.

### 3. Tell the extension which Python to use

Open the Command Palette (**Ctrl+Shift+P**, or **Cmd+Shift+P** on macOS),
type **Schematron: Select Python Interpreter…** and press Enter. A file
picker opens in the `.venvs` folder made in step 2. Go into `schematron`
and choose:

| System | The file to choose |
|---|---|
| Linux, macOS | `bin` → `python` |
| Windows | `Scripts` → `python.exe` |

The extension checks that this Python has both libraries before it saves
your choice, and says so: *Schematron: using …*. (You can also type the
path into the setting `schematron.pythonPath` yourself.)

### 4. Check that it works

Open an XML file whose first lines include an `<?xml-model … ?>`
instruction pointing to its schema, as TEI files usually do. Within a
second or two the status bar, at the bottom right, shows
**✓ Schematron** (no problems) or **Schematron: 3** (three problems,
underlined in the text). To try it on a ready-made example, download
`validate-schematron-v.*.zip` from the
[releases](https://github.com/nivaca/py-validate/releases), unzip it, and
open `docs/example/edition.xml`: it has six deliberate mistakes in its
Schematron rules (and a seventh, structural one, if you install jing).

### Optional: jing, for structural (RelaxNG) checks

The Schematron rules are checked with the two libraries above. If you also
want the document's *structure* checked against a RelaxNG schema (which
elements may appear where), install **jing**, which needs Java:

- **Debian, Ubuntu:** `sudo apt install jing`
- **macOS:** `brew install jing-trang` (with [Homebrew](https://brew.sh))
- **Other Linux systems:** download `jing` from
  <https://github.com/relaxng/jing-trang/releases>, unzip it, and make a
  small script called `jing` that runs `exec java -jar /path/to/jing.jar "$@"`
  (make it executable with `chmod +x`). Set `schematron.jingPath` to that
  script.
- **Windows:** not supported yet; the Schematron checks work without it.

Without jing, the extension simply skips the structural checks.

### If something goes wrong

| What you see | What to do |
|---|---|
| *The Python interpreter "…" does not have the 'saxonche' module* | Step 2 was skipped or went into another Python: do step 2, then step 3. The notification's **Setup Guide** button opens these instructions. |
| *Could not run the Python interpreter "…"* | The path in step 3 is wrong; run **Schematron: Select Python Interpreter…** again. |
| *externally-managed-environment* when running `pip` | Use the commands of step 2 exactly: they install into the virtual environment. |
| Nothing at all happens in an XML file | The file has no `<?xml-model?>` line, so the extension does not know its schema: add one, set `schematron.schema`, or run **Schematron: Validate Current File**. |
| VS Code on Linux installed as a Flatpak or Snap | It cannot see the Python on your system. Install VS Code from its `.rpm` or `.deb` package instead. |
| Anything else | Run **Schematron: Show Output**: it shows each command the extension ran and the full error. |

The extension has been tested on Linux. It should work the same on macOS
and Windows, but has not been tried there yet.

## What it does

- **When it runs:** as you type (once typing pauses for
  `schematron.changeDelayMs`, 500 ms by default), on open and on save, for
  `.xml` files that carry an `<?xml-model?>` processing instruction, or for
  any XML file when `schematron.schema` is set. You can also run
  **Schematron: Validate Current File** from the Command Palette.
- **Schematron layer:** runs `validate.py --json`. The schema is auto-detected
  from `<?xml-model?>` (with the same download cache and classification as the
  command-line tool) or taken from your settings. Each failed `assert` or
  successful `report` becomes a diagnostic on the offending element's line.
  The pattern id is shown as the diagnostic code. A rule's `role="warning"` or
  `role="info"` sets its severity; everything else is an error.
- **RelaxNG layer:** if the schema source is a `.rng` file and jing is
  installed, jing's structural errors are added with line and column.
- **Incomplete results:** rules that fail to evaluate (XPath errors) are
  reported as one warning on the first line, because the verdict is then
  incomplete.
- **Status bar:** for the active file, it shows a spinner while validating,
  `✓ Schematron` when the file is clean, `Schematron: N` when there are
  problems, and `Schematron: failed` (red) when validation could not run.
  The tooltip gives the details and the time of the last check; clicking it
  opens the output log. It is hidden for XML files the extension does not
  validate.
- **Unsaved edits:** these are validated too. The editor's text is written to
  a private temporary folder (never next to your file), validated there as if
  it were your file, and deleted right after. While a tag is half-typed, you
  see a "not well-formed" error on that line until the XML is complete again.
  Unsaved text is always validated as UTF-8.
- **Not well-formed XML:** reported with source **XML**. The parser notices a
  broken tag only where it ends, sometimes many lines later, so for a tag
  mismatch the line where the unclosed tag was opened is flagged too. jing
  still runs, and its errors usually point straight at the misspelt element.
- **What is underlined:** the offending element's start tag for RelaxNG
  errors, and the line's content (without indentation) otherwise.

## Validating against an ODD

To take the rules from an **ODD** (`schematron.schemaType: "odd"`),
`validate.py` needs `odds/extract-isosch.xsl` and `common/functions.xsl`
from the [TEI Stylesheets](https://github.com/TEIC/Stylesheets) next to it.
Set `schematron.validatorPath` to a copy of `validate.py` that has them.
RelaxNG schemas and Schematron files need nothing extra.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `schematron.pythonPath` | `python3` | Interpreter with saxonche and lxml |
| `schematron.validatorPath` | *(bundled)* | Path to `validate.py` |
| `schematron.schema` | *(auto)* | Schema file, relative to the workspace folder; empty = use `<?xml-model?>` |
| `schematron.schemaType` | `rng` | Type of `schematron.schema`: `rng`, `sch` or `odd` |
| `schematron.validateOnOpen` | `true` | Validate when a file is opened |
| `schematron.validateOnSave` | `true` | Validate when a file is saved |
| `schematron.validateOnChange` | `true` | Validate as you type, including unsaved changes |
| `schematron.changeDelayMs` | `500` | How long typing must pause before validating (ms, minimum 100) |
| `schematron.relaxng.enabled` | `true` | Run jing when the schema is RelaxNG |
| `schematron.jingPath` | `jing` | jing executable |
| `schematron.timeoutSeconds` | `120` | Abort a run after this long |

Changing any `schematron.*` setting re-validates the open files.

The **Schematron** output channel (**Schematron: Show Output**) logs every
command run and its stderr.

## Commands

Open the Command Palette (Ctrl+Shift+P) and type "Schematron":

| Command | Use it to |
|---|---|
| Setup Guide | Open the setup steps above in your browser |
| Validate Current File | Validate now, unsaved changes included, or a file without `<?xml-model?>` |
| Refresh Schema | Re-download the active file's schema after it changed upstream, then re-validate the open files |
| Show Output | See exactly what ran and any error output |
| Select Python Interpreter… | Choose the Python that has saxonche and lxml |
| Clear Diagnostics | Remove all underlines and Problems entries |

**About Refresh Schema:** a schema referenced by URL is downloaded once and
then cached, so later changes to it (for example a new commit to the schema
repository on GitHub) are not seen until you refresh it. A local schema file
needs no refresh: changes to it are picked up automatically, and the command
says so.

## License

Copyright (C) 2026 Nicolas Vaughan. Free software under the GNU General
Public License, version 3 or later; see [LICENSE](https://codeberg.org/nivaca/py-validate/src/branch/main/LICENSE).

## Building

```sh
cd vscode
npm install
npm test            # set VALIDATE_PYTHON=/path/to/python to include the end-to-end test
# Real VS Code, headless (Linux), with a throwaway profile:
env -u WAYLAND_DISPLAY VALIDATE_PYTHON=/path/to/python JING=$(command -v jing) \
  VSCODE_PATH=/usr/share/code/code xvfb-run -a npm run test:integration
npx vsce package    # -> validate-schematron-<version>.vsix
code --install-extension validate-schematron-<version>.vsix
```

Packaging copies `../validate.py` into the extension, so the `.vsix` works on
its own.
