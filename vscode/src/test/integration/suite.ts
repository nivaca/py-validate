// Runs inside the real VS Code extension host. Opens documents, waits for
// the extension's diagnostics and checks what VS Code would show the user
// (squiggles + Problems panel come from exactly these diagnostics).

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const ws = process.env.SCHEMATRON_IT_WS!;
const withJing = !!process.env.SCHEMATRON_IT_JING;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function ours(uri: vscode.Uri) {
  return vscode.languages.getDiagnostics(uri)
    .filter(d => ['Schematron', 'RelaxNG', 'XML'].includes(d.source ?? ''));
}

/** Waits until `pred` holds for the document's diagnostics. */
async function waitFor(uri: vscode.Uri, pred: (d: vscode.Diagnostic[]) => boolean,
                       what: string, ms = 30000): Promise<vscode.Diagnostic[]> {
  const end = Date.now() + ms;
  for (;;) {
    const d = ours(uri);
    if (pred(d)) { return d; }
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}; diagnostics now: ${describe(d) || '(none)'}`);
    }
    await sleep(100);
  }
}

function describe(ds: vscode.Diagnostic[]) {
  const sev = ['error', 'warning', 'info', 'hint'];
  return ds.map(d => `\n    L${d.range.start.line + 1}:${d.range.start.character}-` +
    `${d.range.end.character} ${sev[d.severity]} [${d.source}] ${d.message.slice(0, 110)}`).join('');
}

async function open(name: string) {
  const doc = await vscode.workspace.openTextDocument(path.join(ws, name));
  await vscode.window.showTextDocument(doc);
  return doc;
}

const lines = (ds: vscode.Diagnostic[], source: string) =>
  ds.filter(d => d.source === source).map(d => d.range.start.line + 1).sort((a, b) => a - b);

/** Every diagnostic must cover at least one character, or VS Code has
 *  nothing to underline. */
function assertVisible(ds: vscode.Diagnostic[]) {
  for (const d of ds) {
    assert.ok(!d.range.isEmpty,
      `empty range (nothing underlined) at L${d.range.start.line + 1}:${d.range.start.character}`);
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find(e => e.id.endsWith('validate-schematron'));
  assert.ok(ext, 'extension not loaded');
  const failures: string[] = [];
  const check = async (title: string, body: () => Promise<void>) => {
    try { await body(); console.log(`  ✓ ${title}`); } catch (e) {
      failures.push(title); console.log(`  ✗ ${title}\n    ${(e as Error).message}`);
    }
  };
  console.log(`\nVS Code ${vscode.version}, extension ${ext!.packageJSON.version}, jing: ${withJing ? 'yes' : 'no'}`);

  await check('invalid.xml: errors are underlined on the offending lines', async () => {
    const doc = await open('invalid.xml');
    const ds = await waitFor(doc.uri, d => d.some(x => x.source === 'Schematron') &&
      (!withJing || d.some(x => x.source === 'RelaxNG')), 'Schematron (and RelaxNG) diagnostics');
    console.log(`    diagnostics:${describe(ds)}`);
    assert.deepEqual(lines(ds, 'Schematron'), [2]);
    assert.match(ds.find(d => d.source === 'Schematron')!.message,
                 /A TEI may contain at most 2 p, found 3/);
    if (withJing) { assert.deepEqual(lines(ds, 'RelaxNG'), [5]); }
    for (const d of ds) { assert.equal(d.severity, vscode.DiagnosticSeverity.Error); }
    assertVisible(ds);
  });

  await check('typo.xml (not well-formed): the error points at the typo', async () => {
    const doc = await open('typo.xml');
    const ds = await waitFor(doc.uri, d => d.length > 0, 'a well-formedness diagnostic');
    console.log(`    diagnostics:${describe(ds)}`);
    const all = ds.map(d => d.range.start.line + 1);
    assert.ok(all.includes(3), `expected a diagnostic on line 3 (the <notde> typo), got lines ${all}`);
    assert.ok(ds.some(d => d.source === 'XML'), 'expected the XML well-formedness error too');
    assertVisible(ds);
  });

  await check('valid.xml: an unsaved edit is validated as you type', async () => {
    const doc = await open('valid.xml');
    await waitFor(doc.uri, () => true, 'initial run');
    await sleep(1500);                                 // let the open-time run finish
    assert.equal(ours(doc.uri).length, 0, `expected no problems, got${describe(ours(doc.uri))}`);
    const ed = new vscode.WorkspaceEdit();
    ed.insert(doc.uri, new vscode.Position(3, 0), '<p>b</p>\n<p>c</p>\n');
    await vscode.workspace.applyEdit(ed);
    const ds = await waitFor(doc.uri, d => d.length > 0, 'diagnostics after the edit');
    console.log(`    diagnostics:${describe(ds)}`);
    assert.ok(doc.isDirty, 'document should still be unsaved');
    assert.ok(!fs.readFileSync(doc.uri.fsPath, 'utf8').includes('<p>c</p>'), 'file on disk must be unchanged');
    assert.deepEqual(lines(ds, 'Schematron'), [2]);
    assertVisible(ds);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  await check('Refresh Schema: a changed remote schema is re-downloaded and applied', async () => {
    const served = process.env.SCHEMATRON_IT_SERVED!;
    const doc = await open('remote.xml');
    await sleep(2500);                                // first run downloads (max 2 p): valid
    assert.equal(ours(doc.uri).length, 0, `expected no problems, got${describe(ours(doc.uri))}`);
    // the schema changes upstream: now at most 1 p
    fs.copyFileSync(path.join(served, 'remote-max1.rng'), path.join(served, 'remote.rng'));
    await vscode.commands.executeCommand('schematron.validate');
    await sleep(2500);
    assert.equal(ours(doc.uri).length, 0, 'without a refresh the cached schema should still apply');
    const res = await vscode.commands.executeCommand<{ status: string; url?: string }>('schematron.refreshSchema');
    console.log(`    refresh result: ${JSON.stringify(res)}`);
    assert.equal(res?.status, 'refreshed');
    const ds = await waitFor(doc.uri, d => d.length > 0, 'diagnostics from the refreshed schema');
    console.log(`    diagnostics:${describe(ds)}`);
    assert.match(ds[0].message, /at most 1 p, found 2/);
    assertVisible(ds);
  });

  await check('Refresh Schema on a local schema says there is nothing to download', async () => {
    await open('invalid.xml');
    const res = await vscode.commands.executeCommand<{ status: string }>('schematron.refreshSchema');
    assert.equal(res?.status, 'local');
  });

  for (const f of (process.env.SCHEMATRON_IT_EXTRA || '').split(':').filter(Boolean)) {
    await check(`extra document ${path.basename(f)} (diagnostics printed, not checked)`, async () => {
      const doc = await vscode.workspace.openTextDocument(f);
      await vscode.window.showTextDocument(doc);
      await waitFor(doc.uri, () => true, 'run');
      await sleep(8000);
      console.log(`    diagnostics:${describe(ours(doc.uri)) || ' (none)'}`);
      assertVisible(ours(doc.uri));
    });
  }

  if (failures.length) { throw new Error(`${failures.length} check(s) failed: ${failures.join('; ')}`); }
}
