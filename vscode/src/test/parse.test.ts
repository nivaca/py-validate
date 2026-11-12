import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ValidateOutput, explainFailure, itemsFromJing, itemsFromValidate, severityFor,
} from '../parse';

test('severityFor maps Schematron roles', () => {
  assert.equal(severityFor(''), 'error');
  assert.equal(severityFor('Warning'), 'warning');
  assert.equal(severityFor('info'), 'info');
  assert.equal(severityFor('fatal'), 'error');
});

test('itemsFromValidate: violations, unknown lines and XPath errors', () => {
  const out: ValidateOutput = {
    version: '1.4', schema: '/s.sch', source: { path: '/s.sch', type: 'sch' },
    documents: [{
      file: '/d.xml',
      violations: [
        { pattern: 'p1', context: 'tei:p', type: 'assert', role: '', message: 'too long:',
          text: 'too long: 20', path: '/x', line: 5, xml_id: 'p2' },
        { pattern: '', context: 'x', type: 'report', role: 'warning', message: 'm',
          text: '', path: '/y', line: null, xml_id: null },
      ],
      xpath_errors: [{ message: 'broken', context: 'tei:p', error: 'NPE', nodes: 3 }],
    }],
  };
  const items = itemsFromValidate(out, '/d.xml');
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { line: 4, message: 'too long: 20', severity: 'error',
                               source: 'Schematron', code: 'p1' });
  assert.equal(items[1].line, -1);
  assert.equal(items[1].message, 'm');          // falls back to static message
  assert.equal(items[1].severity, 'warning');
  assert.match(items[2].message, /1 rule\(s\) failed.*\n• broken \[tei:p\]: NPE \(3 nodes\)/s);
});

test('itemsFromValidate: malformed document', () => {
  const out: ValidateOutput = {
    version: '1.4', schema: '/s.sch', source: { path: '/s.sch', type: 'sch' },
    documents: [{ file: '/d.xml', error: 'not well-formed', error_line: 7 }],
  };
  assert.deepEqual(itemsFromValidate(out, '/d.xml'),
    [{ line: 6, message: 'not well-formed', severity: 'error', source: 'Schematron' }]);
});

test('itemsFromJing keeps only lines for the target file', () => {
  const txt = [
    '/w/doc.xml:3:15: error: element "foo" not allowed here',
    '/w/other.xml:1:1: error: nope',
    'Picked up _JAVA_OPTIONS: -Dx=y',
    '/w/doc.xml:9:2: warning: hmm',
  ].join('\n');
  const items = itemsFromJing(txt, '/w/doc.xml');
  assert.deepEqual(items.map(i => [i.line, i.col, i.severity]),
                   [[2, 14, 'error'], [8, 1, 'warning']]);
});

test('explainFailure: missing module names the interpreter', () => {
  const f = explainFailure("ModuleNotFoundError: No module named 'saxonche'", '/usr/bin/python3');
  assert.equal(f.interpreter, true);
  assert.match(f.message, /"\/usr\/bin\/python3" does not have the 'saxonche' module/);
  assert.match(f.message, /"\/usr\/bin\/python3" -m pip install saxonche lxml/);
});

test('explainFailure: other errors keep the last meaningful lines', () => {
  assert.deepEqual(
    explainFailure('[esquema] 1 patterns\nNo existe el documento: /x.xml\n', 'python3'),
    { interpreter: false, message: 'No existe el documento: /x.xml' });
});

// End-to-end against the real validate.py, when VALIDATE_PYTHON points at an
// interpreter with saxonche (skipped otherwise).
test('validate.py --json round trip', { skip: !process.env.VALIDATE_PYTHON }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-'));
  const sch = path.join(dir, 't.sch');
  const doc = path.join(dir, 'd.xml');
  fs.writeFileSync(sch, `<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <ns prefix="tei" uri="http://www.tei-c.org/ns/1.0"/>
  <pattern id="len"><let name="max" value="3"/>
    <rule context="tei:p"><assert test="string-length(.) le $max" role="warning"><name/> too long: <value-of select="string-length(.)"/>, rend="<value-of select="@rend"/>"</assert></rule>
  </pattern>
</schema>`);
  fs.writeFileSync(doc, `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <p>ok</p>
  <p rend="x">much too long</p>
</TEI>`);
  const validator = path.resolve(__dirname, '..', '..', '..', 'validate.py');
  let stdout = '';
  try {
    execFileSync(process.env.VALIDATE_PYTHON!, [validator, '--json', '-s', sch, doc],
                 { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e: any) {
    assert.equal(e.status, 1);                  // violations found
    stdout = e.stdout.toString();
  }
  const items = itemsFromValidate(JSON.parse(stdout), doc);
  // <name/> gives the element name; value-of on an attribute gives its value,
  // with the surrounding quotes kept tight.
  assert.deepEqual(items, [{ line: 2, message: 'p too long: 13, rend="x"', severity: 'warning',
                             source: 'Schematron', code: 'len' }]);
});
