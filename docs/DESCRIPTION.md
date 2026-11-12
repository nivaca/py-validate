How validate.py was made
========================

validate.py checks TEI documents against the Schematron rules of their
schema, from the terminal, and reports every offence: how many times
each rule is broken and, for each offence, the line and the `xml:id` of
the nearest identifiable element.  It takes the rules from an ODD, from
an ISO Schematron file, or from a RelaxNG schema generated from an ODD,
which carries them embedded; it finds the schema by itself in the
document's `<?xml-model?>` instructions.  A companion script,
validate-all.sh, also checks the structure with RelaxNG, and an extension
for Visual Studio Code shows the same results in the editor, underlined
as you type.  Nicolas Vaughan made it in 2026, for the editions of the
SMTrad project.  Here I explain how it was made, in eight stages.

validate.py is free software, under the MIT licence.  It is written in
Python and stands on two libraries: saxonche (Saxon C), which evaluates
the rules with XPath 3.1, and lxml, which finds the lines and the
`xml:id`s.  The structural layer uses jing, and the extension is written
in TypeScript.

Nicolas Vaughan is Associate Professor of Literature at the School of Arts
and Humanities of the Universidad de los Andes, Bogotá, Colombia.

1.  A report without a cap
-------------------------

The project's documents were validated in oXygen, which turned out to
fail silently in three ways.  It shows at most 100 validation highlights
and drops the rest without a word; when two rules of a pattern share a
context, only the first one runs (first-match shadowing); and a rule
that is empty by mistake can invalidate the whole schema.  A document
could look clean when it was not.

The first version (1.0, July 2026) answered the first of these by
design.  It extracts the Schematron of the project's ODD with the TEI
stylesheet `extract-isosch.xsl`, keeps the result in a cache that is
renewed when the ODD changes, and runs the rules itself: patterns,
rules, asserts, reports and `let`s, with first-match shadowing inside
each pattern, as ISO Schematron prescribes.  The report gives a count
per rule, always complete; `-v` lists the offences with their line and
`xml:id`, and `--max` limits only that list, never the count, and says
how many offences were left out.

Ready-made implementations were tried first.  pyschematron took minutes
on the corpus, because of the `//*[@xml:id=…]` searches of the rules;
jing does not support `queryBinding="xslt2"`; SchXslt needed more XSLT
files to manage.  Saxon, through saxonche, was already a dependency of
the project, runs at the speed of C, and its XPath 3.1 is a superset of
oXygen's, so `matches()`, `tokenize()`, `some`/`every` and `let` behave
the same way.

2.  RelaxNG, and two layers
--------------------------

Version 1.1 (July 2026) added a second source of rules: a RelaxNG schema
generated from an ODD carries the Schematron patterns embedded in it, the
very rules that jing ignores.  validate.py harvests them, without
duplicates, into a Schematron file of its own.  Harvesting had a subtle
bug: copied out of their context, the patterns could be written with
the wrong namespace and come back as nothing.  The fix cleans up the
namespace declarations, and a self-check reads the harvested file back
and compares the number of patterns before using it.

The same version added `current()` (the TEI Guidelines' rules use it),
guards against documents that are not well-formed and against schemas
without rules (which would approve anything), an exit code of its own for
problems of the environment, and a cache that is renewed when either the
schema or the script changes.  validate-all.sh runs the two layers on the
same RelaxNG file: the structure with jing (or lxml, without it), then
the rules with validate.py, and combines their verdicts in its exit
code.

3.  Finding the schema
---------------------

From version 1.2 (July 2026) no schema has to be given: validate.py reads
the document's `<?xml-model?>` instructions, prefers a Schematron one,
then a RelaxNG one, and downloads a remote schema once, to a cache, until
`--refresh` asks for it again.  What a file is (ODD, Schematron or
RelaxNG) is decided by its content, not by its name.  validate-all.sh
gained the same detection.  Version 1.3 made the messages more useful:
the `<value-of>`s inside them are evaluated for each offence, so a
message names, for example, the exact sigla that are missing.

4.  Rules that never ran
-----------------------

A review of the code in November 2026 found the most serious kind of
problem: rules that silently did nothing.  Only the `let`s of a rule
were read, not those of its schema or its pattern, so a rule that used a
pattern's variable failed to evaluate on every node and was skipped, and
a document could pass with exit code 0.  Version 1.4 adds those `let`s,
and reports rules that fail to evaluate once each, with a warning that
the verdict is incomplete.  The same version found the lines of elements
without a namespace, and of offences on attributes.

Version 1.6 corrected the messages: `<name/>`, which the project's schema
uses 96 times, had been dropped ("Error: has corresp…"); a `<value-of>`
of an attribute printed the whole attribute, `corresp=" corresp="#" "`,
instead of its value; and the spaces around an inserted value were
changed.

5.  A Visual Studio Code extension
---------------------------------

Version 1.5 gave validate.py a `--json` report, with every offence, its
line, `xml:id`, pattern and `role`, and the rules that failed.  On it
stands an extension for Visual Studio Code (`vscode/`), which runs
validate.py, and jing for RelaxNG schemas, when a document is opened or
saved, and shows the offences as diagnostics: underlined in the text,
with the message on hover, and listed in the Problems panel.  The
extension carries its own copy of validate.py.

The next versions made it easier to set up and to read.  When the Python
it uses lacks saxonche, it says which Python it tried, and offers to
choose another, checking it before saving the setting (0.2).  A status
bar item shows the result of the current file: a spinner while it
works, a tick when the file is clean, the number of problems, or a red
"failed" when it cannot run (0.3).  Without it, a clean file looked
exactly like an extension that did not work.

6.  Two validations at once
--------------------------

After a reload, VS Code validated two files at the same moment, and one
of them read the downloaded schema while the other was still writing it:
"Premature end of data".  Worse, the truncated copy stayed in the cache,
and every later run failed in the same way.  Version 1.7 writes every
cached file (downloaded schemas, harvested and extracted rules) to a
temporary file and renames it into place, so a reader sees either no file
or a whole one; a damaged copy left by an older version is detected and
replaced, and a download that is not XML is never kept.  In a test that
re-downloaded the schema for 20 seconds while three other processes
validated, the old version failed 88 times in 635; the new one, never.

7.  Validating as you type
-------------------------

Version 0.4 of the extension validates the text being edited, unsaved
changes included, once typing pauses (half a second by default, a
setting).  The text is written to a private temporary folder, never next
to the user's file, and validate.py 1.8 has `--as`, which treats that
copy as if it were the real file, so relative `<?xml-model?>` paths still
work.  While a tag is half typed, the document is not well-formed for a
moment; validate.py now reports that as an ordinary error on its line,
not as a failure.

Testing the extension inside a real VS Code showed two problems that
tests against a simulated editor had missed.  A misspelt element, such
as `<notde>` for `<note>`, was reported where the parser noticed it,
dozens of lines later; now the line where the unclosed tag was opened is
flagged too, and jing, which still runs, points straight at it.  And
jing reports the position just after a start tag, often at the end of a
line, which gave underlines of no width that VS Code does not draw; now
the tag itself is underlined (0.4.1).

8.  Finishing touches
--------------------

A remote schema is downloaded once, so a new version of it was not seen
until the cache was emptied by hand; the extension's *Refresh Schema*
command downloads it again and validates the open files (0.5).  The
extension has an icon: an XML tag whose slash is a tick, above the red
underline it draws.  `tools/screenshots.py` makes the screenshots of the
READMEs, as in my other projects: a real session in the terminal, drawn
like Konsole, and a real VS Code on a hidden display, with a profile of
its own, so nothing appears on the screen and the user's settings are
not touched.  Both use `docs/example/`, a short TEI text with deliberate
mistakes and a small RelaxNG schema with Schematron rules embedded in it.

Testing
-------

The extension has 11 automated tests (`npm test`), run with Node's own
test runner.  They check how the reports of validate.py and of jing
become diagnostics, the severities, where the underlines start and end,
and the error messages; one of them runs validate.py from beginning to
end.  Another test (`npm run test:integration`) runs the extension
inside a real VS Code, without a screen and with a profile of its own:
it checks that the errors land on the right lines and are visibly
underlined, that a misspelt element is found, that unsaved changes are
validated, and that *Refresh Schema* picks up a schema changed on a
small web server.

validate.py is checked on small documents and schemas made for each
case (shadowing, `let`s at every level, namespaces, attributes,
malformed text, the three sources of rules), compared before and after
each change, and on the example in `docs/example/`; the cache was
checked with the test of concurrent runs described above.  The project
has now about 2,200 lines: 660 in validate.py, 160 in validate-all.sh,
590 in the extension, 450 in its tests, and 370 in the screenshot tool.
