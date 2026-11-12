// Puts a real VS Code into the state shown in the README screenshots, for
// tools/screenshots.py, which starts VS Code with this module as its
// --extensionTestsPath (on a hidden display, with a throwaway profile):
// the example document open with its errors underlined, the Problems panel
// listing them, and the hover of one error. Then it writes the file
// "ready" in SHOTS_HANDSHAKE, waits for the script to take the picture and
// write "done", and returns, which closes VS Code.
//
//   SHOTS_HANDSHAKE  folder for the ready/done files
//   SHOTS_DOC        the document to open
//   SHOTS_EXPECT     how many diagnostics to wait for
//   SHOTS_HOVER      text of the diagnostic whose hover is shown

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, seconds: number) {
  const end = Date.now() + seconds * 1000;
  while (!ok()) {
    if (Date.now() > end) { throw new Error(`screenshots: timed out waiting for ${what}`); }
    await sleep(100);
  }
}

export async function run(): Promise<void> {
  const handshake = process.env.SHOTS_HANDSHAKE!;
  const expect = Number(process.env.SHOTS_EXPECT || '1');
  const hover = process.env.SHOTS_HOVER || '';

  const doc = await vscode.workspace.openTextDocument(process.env.SHOTS_DOC!);
  let editor = await vscode.window.showTextDocument(doc);
  const ours = () => vscode.languages.getDiagnostics(doc.uri)
    .filter(d => ['Schematron', 'RelaxNG', 'XML'].includes(d.source ?? ''));
  await until(`${expect} diagnostics`, () => ours().length >= expect, 90);

  await vscode.commands.executeCommand('workbench.actions.view.problems');
  await sleep(500);
  editor = await vscode.window.showTextDocument(doc);   // focus back on the text

  const target = ours().find(d => d.message.includes(hover)) ?? ours()[0];
  editor.selection = new vscode.Selection(target.range.start, target.range.start);
  editor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);
  await sleep(1500);
  await vscode.commands.executeCommand('editor.action.showHover');
  await sleep(1500);

  fs.writeFileSync(path.join(handshake, 'ready'), '');
  await until('the picture', () => fs.existsSync(path.join(handshake, 'done')), 120);
}
