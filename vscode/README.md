# Schematron Validator for VS Code

Validates XML/TEI documents against Schematron rules using
[validate.py](https://codeberg.org/nivaca/validate). It can also check
RelaxNG structure with jing. Results appear as squiggles in the editor and in
the Problems panel.

## What it does

- **When it runs:** on open and on save of `.xml` files that carry an
  `<?xml-model?>` processing instruction, or of any XML file when
  `schematron.schema` is set. You can also run **Schematron: Validate Current
  File** from the Command Palette.
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
- **Saved files only:** validation always runs on the saved file on disk, not
  on unsaved edits.

## Requirements

- Python 3 with `saxonche` and `lxml`: `pip install saxonche lxml`. If they
  live in a virtualenv, set `schematron.pythonPath` to its `bin/python`, or
  run **Schematron: Select Python Interpreter…**. That command opens a file
  picker, checks that the Python you pick can import both modules, and saves
  it as a user setting. If validation fails because the interpreter lacks
  them, a notification names the interpreter it tried and offers the same
  picker. The notification appears once, not on every save, and again only
  after you change a setting.
- Optional: `jing` on your `PATH` (or set `schematron.jingPath`) for the
  RelaxNG layer.
- Optional: to validate against an **ODD** (`schematron.schemaType: "odd"`),
  `validate.py` needs `odds/extract-isosch.xsl` and `common/functions.xsl`
  from the TEI Stylesheets next to it. Set `schematron.validatorPath` to a
  checkout of the repository that has them.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `schematron.pythonPath` | `python3` | Interpreter with saxonche and lxml |
| `schematron.validatorPath` | *(bundled)* | Path to `validate.py` |
| `schematron.schema` | *(auto)* | Schema file, relative to the workspace folder; empty = use `<?xml-model?>` |
| `schematron.schemaType` | `rng` | Type of `schematron.schema`: `rng`, `sch` or `odd` |
| `schematron.validateOnOpen` | `true` | Validate when a file is opened |
| `schematron.validateOnSave` | `true` | Validate when a file is saved |
| `schematron.relaxng.enabled` | `true` | Run jing when the schema is RelaxNG |
| `schematron.jingPath` | `jing` | jing executable |
| `schematron.timeoutSeconds` | `120` | Abort a run after this long |

Changing any `schematron.*` setting re-validates the open files.

The **Schematron** output channel (**Schematron: Show Output**) logs every
command run and its stderr.

## Building

```sh
cd vscode
npm install
npm test            # set VALIDATE_PYTHON=/path/to/python to include the end-to-end test
npx vsce package    # -> validate-schematron-<version>.vsix
code --install-extension validate-schematron-<version>.vsix
```

Packaging copies `../validate.py` into the extension, so the `.vsix` works on
its own.
