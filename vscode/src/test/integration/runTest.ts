// Runs the extension inside a real VS Code (headless under xvfb-run on
// Linux) with a throwaway profile, so the user's own settings and extensions
// are never touched.
//
//   VALIDATE_PYTHON=/path/to/python   interpreter with saxonche + lxml (required)
//   JING=/path/to/jing                optional; RelaxNG checks are skipped without it
//   VSCODE_PATH=/usr/share/code/code  optional; otherwise a VS Code is downloaded
//   EXTRA_DOCS=/a.xml:/b.xml          optional; also open these and print their diagnostics
//
//   xvfb-run -a npm run test:integration

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const rng = (max: number) => `<grammar xmlns="http://relaxng.org/ns/structure/1.0"
         xmlns:sch="http://purl.oclc.org/dsdl/schematron"
         ns="http://www.tei-c.org/ns/1.0">
  <sch:ns prefix="tei" uri="http://www.tei-c.org/ns/1.0"/>
  <start>
    <element name="TEI">
      <sch:pattern id="max-p">
        <sch:rule context="tei:TEI">
          <sch:assert test="count(tei:p) le ${max}">A <sch:name/> may contain at most ${max} p, found <sch:value-of select="count(tei:p)"/></sch:assert>
        </sch:rule>
      </sch:pattern>
      <oneOrMore><element name="p"><zeroOrMore><choice><text/><element name="note"><text/></element></choice></zeroOrMore></element></oneOrMore>
    </element>
  </start>
</grammar>
`;
const PI = '<?xml-model href="schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>';

async function main() {
  const python = process.env.VALIDATE_PYTHON;
  if (!python) { throw new Error('Set VALIDATE_PYTHON to a Python with saxonche and lxml.'); }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schematron-it-'));
  const ws = path.join(root, 'workspace');
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(ws);
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });

  fs.writeFileSync(path.join(ws, 'schema.rng'), rng(2));

  // 4. a schema referenced by URL, served from here; the test edits the
  //    served file to check that Refresh Schema picks up the new version
  const served = path.join(root, 'served');
  fs.mkdirSync(served);
  fs.writeFileSync(path.join(served, 'remote.rng'), rng(2));
  fs.writeFileSync(path.join(served, 'remote-max1.rng'), rng(1));
  const server = http.createServer((req, res) => {
    const f = path.join(served, path.basename(req.url ?? ''));
    if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/xml' }).end(fs.readFileSync(f));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(ws, 'remote.xml'),
    PI.replace('href="schema.rng"', `href="http://127.0.0.1:${port}/remote.rng"`) +
    `\n<TEI xmlns="http://www.tei-c.org/ns/1.0">\n<p>a</p>\n<p>b</p>\n</TEI>\n`);

  // validate.py caches downloads next to the bundled copy; start clean
  const cache = path.resolve(__dirname, '..', '..', '..', 'validator', '.schema-cache');
  fs.rmSync(cache, { recursive: true, force: true });
  // 1. well-formed; 3 p (Schematron) + <bogus/> (RelaxNG), on separate lines
  fs.writeFileSync(path.join(ws, 'invalid.xml'),
    `${PI}\n<TEI xmlns="http://www.tei-c.org/ns/1.0">\n<p>a</p>\n<p>b</p>\n<p>c<bogus/></p>\n</TEI>\n`);
  // 2. not well-formed: the typo is on line 3, lxml notices it on line 5
  fs.writeFileSync(path.join(ws, 'typo.xml'),
    `${PI}\n<TEI xmlns="http://www.tei-c.org/ns/1.0">\n<p>a <notde>x\n</p>\n<p>b</note></p>\n</TEI>\n`);
  // 3. valid on disk; the test introduces an error without saving
  fs.writeFileSync(path.join(ws, 'valid.xml'),
    `${PI}\n<TEI xmlns="http://www.tei-c.org/ns/1.0">\n<p>a</p>\n</TEI>\n`);

  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'schematron.pythonPath': python,
    'schematron.jingPath': process.env.JING || 'jing',
    'schematron.changeDelayMs': 300,
    'security.workspace.trust.enabled': false,
  }, null, 2));

  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_PATH || undefined,
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..', '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      extensionTestsEnv: {
        SCHEMATRON_IT_WS: ws,
        SCHEMATRON_IT_JING: process.env.JING ? '1' : '',
        SCHEMATRON_IT_EXTRA: process.env.EXTRA_DOCS || '',
        SCHEMATRON_IT_SERVED: served,
      },
      launchArgs: [ws, '--user-data-dir', userData,
                   '--extensions-dir', path.join(root, 'extensions'),
                   '--disable-extensions', '--skip-welcome', '--skip-release-notes',
                   // stay on xvfb's X display, never the user's Wayland session
                   ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])],
    });
  } finally {
    server.close();
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
