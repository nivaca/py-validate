# validate.py — Schematron validation from the terminal

Schematron-layer validator for the SMTrad project. It extracts the ISO
Schematron rules embedded in the ODD (`smed-schema.xml`) and runs them
against one or more TEI documents with Saxon (XPath 3.1), producing a
complete report — free of oXygen's display cap — with per-rule counts and,
in verbose mode, the line number and `xml:id` of every offender.

**Why it exists.** oXygen exhibits three silent failure modes documented in
this project's history: the *validation highlights* cap (100 by default;
errors beyond it are dropped without warning), *first-match shadowing*
between rules sharing an identical context, and structurally empty rules
that invalidate the whole schema. This script eliminates the first by
design (it lists everything, or states exactly how many items were left
out), and makes the other two visible by always reporting a verifiable
total count.

---

## 1. Requirements

| Component | Version | Role |
|---|---|---|
| Python | ≥ 3.9 | interpreter |
| [saxonche](https://pypi.org/project/saxonche/) | ≥ 12 | XSLT 3.0 / XPath 3.1 engine (Saxon C) |
| [lxml](https://pypi.org/project/lxml/) | ≥ 4.9 | line-number resolution |
| `extract-isosch.xsl` + `common/functions.xsl` | TEI Stylesheets (`dev` branch) | ODD → `.sch` extraction (only with `-o`) |

Saxon's XPath 3.1 binding is a superset of oXygen's engine, so
`matches()`, `tokenize()`, `some/every … satisfies`, `if/then/else` and the
rules' `<let>` elements evaluate identically in both environments.

## 2. Installation

```sh
# 1. Python dependencies
pip install saxonche lxml

# 2. TEI stylesheets (only needed for extraction with -o).
#    The folder layout below must be preserved next to the script,
#    because extract-isosch.xsl imports ../common/functions.xsl:
mkdir -p odds common
curl -sL -o odds/extract-isosch.xsl \
  https://raw.githubusercontent.com/TEIC/Stylesheets/dev/odds/extract-isosch.xsl
curl -sL -o common/functions.xsl \
  https://raw.githubusercontent.com/TEIC/Stylesheets/dev/common/functions.xsl
```

Resulting layout:

```
validate/
├── validate.py
├── odds/
│   └── extract-isosch.xsl
└── common/
    └── functions.xsl
```

Paths to `odds/` and `common/` are resolved relative to the script
(`Path(__file__).parent`), not to the working directory: you can invoke it
from anywhere.

## 3. Usage

```
python3 validate.py (-o ODD | -s SCH | -r RNG) [-v] [--max N] DOC.xml [...]
```

| Option | Effect |
|---|---|
| `-o, --odd PATH` | Extracts the `.sch` from an ODD **with embedded Schematron** (cached, §4) and validates against it. An ODD without embedded rules (e.g. an uncompiled `tei_all.odd`) is rejected with a message, rather than validated against an empty schema (§7) |
| `-s, --sch PATH` | Uses an already-extracted `.sch`; skips extraction |
| `-r, --rng PATH` | **Harvests** the `sch:ns`/`sch:pattern` annotations embedded in an ODD-generated RelaxNG (deduplicated, cached) and validates against them — the very rules Jing ignores |
| `-v, --verbose` | Detailed listing: line, `xml:id`, message per offender |
| `--max N` | Maximum offenders in the detailed listing (default 50). If there are more, the script **says how many were left out** — it never truncates silently |

The three rule sources are mutually exclusive and exactly one is required.

### Recipes

```sh
# Daily cycle: extract if needed and validate
python3 validate.py -o ../smed-schema/smed-schema.xml ../salmarc_ed_lat.xml

# Full report for a correction campaign
python3 validate.py -o ../smed-schema/smed-schema.xml -v --max 999 \
    ../salmarc_ed_lat.xml > pending.txt

# Several documents against a fixed .sch
python3 validate.py -s smed-schema.sch -v ed_lat.xml ed_es.xml

# Against the Guidelines' Schematron, harvested from the tei_all RNG (§7)
python3 validate.py -r tei_all.rng -v document.xml

# One artifact for both layers: structure with Jing, rules with -r
jing smed-schema.rng ed_lat.xml && python3 validate.py -r smed-schema.rng ed_lat.xml

# In a Makefile or pre-commit hook (non-zero exit code on violations)
python3 validate.py -s smed-schema.sch ed_lat.xml || echo "pending issues"
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | no violations |
| 1 | one or more violations |
| 2 | invocation error (argparse) |
| 3 | environment error (missing file, ODD/RNG without rules), with a message on stderr |

## 4. Configuration and caching

- **Extraction cache**: with `-o`, the `.sch` is written next to the ODD
  (same name, `.sch` extension); with `-r`, next to the RNG
  (`.harvested.sch` extension). They are regenerated only when the source's
  mtime is newer. The `[caché] ... está al día` message indicates a cache
  hit. To force regeneration: `touch` the source or delete the derivative.
- **Namespace prefixes**: read from the `<ns>` elements of the `.sch`
  itself (currently only `tei:`). Nothing to configure by hand.
- **No configuration file**: all observable state lives in the command line
  and in the two artifacts (ODD, `.sch`).

## 5. How it works

### Pipeline

1. **Extraction** (`-o` only): Saxon applies `extract-isosch.xsl` to the
   ODD and produces the ISO Schematron with `queryBinding="xslt2"` — one
   `pattern` per `constraintSpec`, as the standard TEI chain does.
2. **Rule loading**: lxml parses the `.sch` and builds the list of
   patterns → rules → (`context`, `let*`, `assert`/`report` tests).
3. **Execution**: for each rule, context nodes are located with Saxon
   (`//(context)` for relative contexts; absolute ones as-is) and each test
   is evaluated as an *effective boolean value* in XPath 3.1. `<let>`
   elements are translated to the native `let $x := (...) return (...)`.
4. **Report**: aggregate counts per rule message; with `-v`, each offender
   is resolved to a physical line and `xml:id` via `fn:path()` (Saxon) →
   conversion of the `Q{uri}` notation to prefixes → node lookup with lxml
   (`sourceline` + nearest ancestor bearing `@xml:id`).

### ISO Schematron semantics implemented

Covered — the exact subset the smed ODD uses:

- `pattern`, `rule`, `assert`, `report`, `let`;
- `current()` (an XSLT function used by the P5 Guidelines rules): translated
  into a context-node binding (`let $VALIDATE_CTX := .`) with textual
  substitution, which reproduces its Schematron semantics exactly;
- **first-match shadowing within each pattern**: a node matched by an
  earlier rule of the same pattern is excluded from later ones, per the
  standard. (The TEI extraction emits one pattern per constraintSpec, which
  makes shadowing *across* constraintSpecs impossible by construction — the
  runner honors it regardless, for fidelity.)

Not implemented — the script **warns on stderr once per kind** and
continues: `phase` (all patterns are run), abstract patterns/rules
(skipped), `diagnostics`, `xsl:key`, `sch:value-of` inside messages (text
is flattened: the message appears without the interpolated value), and
elements from other namespaces such as `sqf:fix` (oXygen Quick Fixes, which
do not affect verdicts). None of this occurs with the smed ODD; with
Guidelines Schematron (§7) you will see the `value-of` and `sqf` notices.

### Performance

Full edition (~28,000 lines, 28 rules, including per-empty-lem
`//*[@xml:id = ...]` scans): **≈ 1–2 s** on ordinary hardware. The dominant
cost is those O(n²) scans; should they ever matter, the alternative
documented in the ODD is `id()` on a Saxon engine.

## 6. Reading the output

```
[caché] smed-schema.sch está al día
[esquema] 28 patterns, 28 reglas, prefijos: tei

== salmarc_ed_lat.xml — 250 infracciones (0.8s) ==
  219  Empty lem must have a corresp attribute.
   30  An empty lem must be followed by an rdg with @type="variation-present".
    1  Every pointer in the corresp attribute of this empty lem must be ...

-- detalle (primeras 300) --
  l.  2637  [o5h_cfj_2cc]  An empty lem must be followed by an rdg with ...
```

- The `[...]` lines go to **stderr** (the script's own diagnostics); the
  report goes to **stdout** — redirecting with `> pending.txt` captures the
  report only. (Runtime messages are in Spanish; rule messages come from
  the schema itself.)
- In the detail, the `xml:id` is that of the **nearest identifiable
  ancestor** of the offending node (typically the `<app>`), and the line is
  that of the offending node itself in the source file.
- The total in the header is always exact; `--max` limits only the listing,
  never the count.

## 7. Validating against a standard ODD (tei_all and friends)

A stock customization ODD such as `tei_all.odd` is a manifest of
`moduleRef`s: its Schematron rules live in the Guidelines sources
(`p5subset.xml`), not in the file itself. That is why `-o` **rejects** it
with exit code 3 instead of validating against an empty schema that would
approve any document. Two routes:

- **Canonical route**: compile the ODD against `p5subset.xml` with
  `odd2odd.xsl` (full TEI chain; requires cloning the Stylesheets
  repository) and feed the compiled ODD to `-o`.
- **Pragmatic route (recommended)**: `-r tei_all.rng`. The RelaxNG
  distributed by TEI and by oXygen
  (`frameworks/tei/xml/tei/custom/schema/relaxng/`) carries exactly the
  same rules embedded; the script harvests, deduplicates and runs them.
  Bear in mind that with a standard schema the proportions are the reverse
  of smed's: the bulk of standard validation is the RelaxNG layer (Jing),
  and P5's Schematron adds only a few dozen co-constraints — here the
  runner is the side dish, not the main course.

A note on counts: an ODD-generated `.rng` embeds, besides your own rules,
the Guidelines' Schematron for every included module (e.g. "Abstract model
violation: Lines may not contain hi", P5's rule on `tei:l`). The `-r` route
therefore validates a **superset** of the `-o` route — more patterns, and
potentially new violations that oXygen would report as well. Harvested
patterns left without usable rules (empty or abstract) are dropped, which
is why the `[esquema]` figure can be lower than the `[cosecha]` one.

The `-r` route works equally well with your **own** `.rng`: a single
artifact then feeds both layers (structure with Jing, rules with the
runner), removing the risk of a `.rng` and a `.sch` drifting apart through
asymmetric regeneration.

## 8. What this script does NOT validate

The **RelaxNG structural layer** (content models, permitted attributes) is
the business of the `.rng` generated from the same ODD. From the terminal:

```sh
jing smed-schema.rng salmarc_ed_lat.xml     # apt install jing / brew install jing
```

Jing ignores the Schematron embedded in the RNG — precisely the gap this
script fills. The two commands together replicate oXygen's full validation,
without caps and with machine-processable output.

## 9. Known problems and troubleshooting

| Symptom | Cause | Remedy |
|---|---|---|
| `OSError: failed to load external entity "X.xml"` | The document does not exist at the given path (lxml's cryptic message) | Check the path; recent versions of the script check first (`No existe el documento: /absolute/path`) |
| `No encuentro .../odds/extract-isosch.xsl` | TEI stylesheets missing, or wrong folder layout | Repeat §2, preserving `odds/` and `common/` next to the script |
| `XTSE0165 ... functions.xsl` | `extract-isosch.xsl` present but `common/functions.xsl` missing | Download the second stylesheet |
| `[ERROR XPath] regla '...'` | A `.sch` test fails to compile/evaluate in XPath 3.1 | Inspect that rule in the ODD; all other rules keep running |
| `[aviso] elemento Schematron no implementado: X` | The `.sch` uses constructs outside the subset (§5) | Extend the runner or reformulate the rule |
| The `.sch` does not reflect a recent ODD/RNG change | mtime cache with odd clocks/copies (Dropbox) | `touch` the source or delete the derivative (`.sch` / `.harvested.sch`) |
| `El ODD X no contiene Schematron embebido` (exit 3) | Uncompiled customization ODD (e.g. `tei_all.odd`) | Use `-r` on its generated RNG, or compile with `odd2odd` (§7). Saxon prints its own `XTMM9000` error first: same diagnosis, raw form |
| `El RelaxNG X no contiene anotaciones Schematron` (exit 3) | RNG generated without embedded rules | Regenerate it from the ODD with the standard chain, or use `-o`/`-s` |
| `[aviso] sch:value-of en mensajes...` / `...elementos ajenos (sqf)...` | Guidelines Schematron (§7) | Informational; verdicts are unaffected |
| `[aviso] elementos ajenos a Schematron ignorados (p. ej. report de http://www.tei-c.org/ns/1.0)` | An `assert`/`report` ended up in the TEI namespace instead of Schematron's — in your own ODD this means a rule that was **never enforced** by any route | Locate it (`python3 -c "from lxml import etree; t=etree.parse('X.rng'); [print(e.sourceline, ' '.join((e.text or '').split())[:70]) for e in t.iter('{http://www.tei-c.org/ns/1.0}report')]"`) and fix the namespace at the source |
| Counts differ from oXygen's | oXygen's highlights cap, or a stale `.rng` in oXygen | Raise the cap (Options → Preferences → Editor → Document Checking) and regenerate the `.rng`; the script's figure is the exact one |

## 10. Design history

Decisions best not re-litigated without rereading the project's history:

- **A purpose-built runner rather than a packaged implementation**:
  `pyschematron` (XPath 2.0 in pure Python) takes minutes on this corpus
  because of the `//*[@xml:id=…]` scans; Jing does not support
  `queryBinding="xslt2"`; SchXslt requires managing additional XSLT
  artifacts. Saxon via `saxonche` was already a project dependency and
  delivers C-level speed with the correct binding.
- **No hidden cap**: the `--max 50` default limits the *detail*, but the
  script always states the total and how many items were left unlisted — a
  direct answer to the oXygen cap episode (July 2026).
- **Rejection of empty schemas**: an ODD or RNG without rules terminates
  with exit code 3 instead of "validating" vacuously — closing off the
  fourth possible silent failure mode (a contentless schema that approves
  everything).
- **One pattern per constraintSpec**: inherited from the TEI extraction; it
  makes the cross-constraintSpec shadowing that afflicted older versions of
  the schema structurally impossible.
