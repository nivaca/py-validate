import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import {
  Item, ValidateOutput, explainFailure, itemsFromJing, itemsFromValidate,
} from './parse';

let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let extensionRoot: string;

/** Processes of the run in flight for each document, so a newer run can
 *  cancel an older one. */
const running = new Map<string, Set<ChildProcess>>();
const generation = new Map<string, number>();
let jingMissingLogged = false;

interface RunResult { code: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException }

const cfg = (doc: vscode.TextDocument) =>
  vscode.workspace.getConfiguration('schematron', doc.uri);

export function activate(context: vscode.ExtensionContext) {
  extensionRoot = context.extensionPath;
  diagnostics = vscode.languages.createDiagnosticCollection('schematron');
  output = vscode.window.createOutputChannel('Schematron');

  context.subscriptions.push(
    diagnostics,
    output,
    vscode.commands.registerCommand('schematron.validate', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) { return; }
      if (doc.isDirty) {
        vscode.window.showInformationMessage(
          'Schematron: validating the saved version of the file; save to include your latest changes.');
      }
      void validate(doc, true);
    }),
    vscode.commands.registerCommand('schematron.clear', () => diagnostics.clear()),
    vscode.commands.registerCommand('schematron.showOutput', () => output.show()),
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (cfg(doc).get<boolean>('validateOnOpen')) { void validate(doc, false); }
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (cfg(doc).get<boolean>('validateOnSave')) { void validate(doc, false); }
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      cancel(doc.uri.toString());
      diagnostics.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('schematron')) { jingMissingLogged = false; }
    }),
  );

  for (const doc of vscode.workspace.textDocuments) {
    if (cfg(doc).get<boolean>('validateOnOpen')) { void validate(doc, false); }
  }
}

export function deactivate() {
  for (const key of running.keys()) { cancel(key); }
}

function cancel(key: string) {
  for (const p of running.get(key) ?? []) { p.kill(); }
  running.delete(key);
}

function run(cmd: string, args: string[], cwd: string, key: string,
             timeoutMs: number): Promise<RunResult> {
  return new Promise(resolve => {
    output.appendLine(`$ ${[cmd, ...args].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    const p = spawn(cmd, args, { cwd });
    const procs = running.get(key) ?? new Set();
    procs.add(p);
    running.set(key, procs);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      stderr += `\nTimed out after ${timeoutMs / 1000}s.`;
      p.kill();
    }, timeoutMs);
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    const done = (r: RunResult) => {
      clearTimeout(timer);
      procs.delete(p);
      if (stderr.trim()) { output.appendLine(stderr.trimEnd()); }
      resolve(r);
    };
    p.on('error', (e: NodeJS.ErrnoException) => done({ code: null, stdout, stderr, spawnError: e }));
    p.on('close', code => done({ code, stdout, stderr }));
  });
}

function shouldValidate(doc: vscode.TextDocument, manual: boolean): boolean {
  if (doc.uri.scheme !== 'file' || doc.languageId !== 'xml') { return false; }
  if (manual || cfg(doc).get<string>('schema')) { return true; }
  // Auto-detection needs an xml-model PI; skip other XML files silently.
  return doc.getText().includes('<?xml-model');
}

function resolveSetting(doc: vscode.TextDocument, p: string): string {
  if (!p || path.isAbsolute(p)) { return p; }
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  return path.resolve(folder ? folder.uri.fsPath : path.dirname(doc.uri.fsPath), p);
}

async function validate(doc: vscode.TextDocument, manual: boolean) {
  if (!shouldValidate(doc, manual)) { return; }
  const key = doc.uri.toString();
  cancel(key);
  const gen = (generation.get(key) ?? 0) + 1;
  generation.set(key, gen);

  const c = cfg(doc);
  const file = doc.uri.fsPath;
  const cwd = path.dirname(file);
  const timeoutMs = (c.get<number>('timeoutSeconds') ?? 120) * 1000;
  const python = c.get<string>('pythonPath') || 'python3';
  const validator = resolveSetting(doc, c.get<string>('validatorPath') ?? '')
    || path.join(extensionRoot, 'validator', 'validate.py');
  const schema = resolveSetting(doc, c.get<string>('schema') ?? '');
  const schemaFlag = { rng: '-r', sch: '-s', odd: '-o' }[c.get<string>('schemaType') ?? 'rng'] ?? '-r';

  const status = vscode.window.setStatusBarMessage(`$(sync~spin) Schematron: ${path.basename(file)}`);
  try {
    const args = [validator, '--json', ...(schema ? [schemaFlag, schema] : []), file];
    const r = await run(python, args, cwd, key, timeoutMs);
    if (generation.get(key) !== gen) { return; }        // superseded

    let items: Item[];
    let parsed: ValidateOutput | undefined;
    if (r.spawnError) {
      items = [failure(`Could not run ${python}: ${r.spawnError.message}. Check schematron.pythonPath.`)];
    } else {
      try {
        parsed = JSON.parse(r.stdout) as ValidateOutput;
        items = itemsFromValidate(parsed, file);
      } catch {
        items = [failure(explainFailure(r.stderr))];
      }
    }

    if (parsed?.source.type === 'rng' && c.get<boolean>('relaxng.enabled')) {
      items.push(...await relaxng(doc, parsed.source.path, file, cwd, key, timeoutMs));
      if (generation.get(key) !== gen) { return; }
    }

    diagnostics.set(doc.uri, items.map(i => toDiagnostic(doc, i)));
    if (manual) {
      const n = items.length;
      vscode.window.setStatusBarMessage(
        n ? `Schematron: ${n} problem${n === 1 ? '' : 's'}` : 'Schematron: valid', 5000);
    }
  } finally {
    status.dispose();
  }
}

async function relaxng(doc: vscode.TextDocument, rng: string, file: string,
                       cwd: string, key: string, timeoutMs: number): Promise<Item[]> {
  const jing = cfg(doc).get<string>('jingPath') || 'jing';
  const r = await run(jing, [rng, file], cwd, key, timeoutMs);
  if (r.spawnError) {
    if (!jingMissingLogged) {
      jingMissingLogged = true;
      output.appendLine(`jing not found (${jing}); RelaxNG layer skipped. ` +
        `Install jing, set schematron.jingPath, or disable schematron.relaxng.enabled.`);
    }
    return [];
  }
  // jing: 0 valid, 1 invalid; anything else is an environment error.
  if (r.code !== null && r.code > 1) {
    return [{ line: -1, severity: 'warning', source: 'RelaxNG',
              message: `jing failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').pop()}` }];
  }
  return itemsFromJing(r.stdout + '\n' + r.stderr, file);
}

function failure(message: string): Item {
  return { line: -1, severity: 'error', source: 'Schematron', message };
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

function toDiagnostic(doc: vscode.TextDocument, i: Item): vscode.Diagnostic {
  const lineNo = Math.min(Math.max(i.line, 0), doc.lineCount - 1);
  const line = doc.lineAt(lineNo);
  const start = i.col !== undefined
    ? Math.min(i.col, line.text.length)
    : line.firstNonWhitespaceCharacterIndex;
  const range = new vscode.Range(lineNo, start, lineNo, Math.max(line.text.length, start));
  const d = new vscode.Diagnostic(range, i.message, SEVERITY[i.severity]);
  d.source = i.source;
  if (i.code) { d.code = i.code; }
  return d;
}
