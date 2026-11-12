import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Item, ValidateOutput, downloadedUrl, explainFailure, itemsFromJing, itemsFromValidate,
  underline,
} from './parse';

let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let extensionRoot: string;

/** Processes of the run in flight for each document, so a newer run can
 *  cancel an older one. */
const running = new Map<string, Set<ChildProcess>>();
const generation = new Map<string, number>();
let jingMissingLogged = false;
/** The interpreter notification is shown once until the settings change,
 *  not on every save. */
let interpreterNotified = false;

/** Last validation outcome per document, shown in the status bar for the
 *  active editor (so a clean result is visible too, not just problems). */
type Outcome =
  | { state: 'running' }
  | { state: 'done'; errors: number; warnings: number; infos: number; relaxng: boolean; at: Date }
  | { state: 'failed'; message: string; at: Date };
const outcomes = new Map<string, Outcome>();
let statusItem: vscode.StatusBarItem;

/** Pending "validate after typing" timers, per document. */
const changeTimers = new Map<string, NodeJS.Timeout>();

function clearChangeTimer(key: string) {
  const t = changeTimers.get(key);
  if (t) { clearTimeout(t); changeTimers.delete(key); }
}

interface RunResult { code: number | null; stdout: string; stderr: string; spawnError?: NodeJS.ErrnoException }

const cfg = (doc: vscode.TextDocument) =>
  vscode.workspace.getConfiguration('schematron', doc.uri);

export function activate(context: vscode.ExtensionContext) {
  extensionRoot = context.extensionPath;
  diagnostics = vscode.languages.createDiagnosticCollection('schematron');
  output = vscode.window.createOutputChannel('Schematron');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'Schematron';
  statusItem.command = 'schematron.showOutput';

  context.subscriptions.push(
    diagnostics,
    output,
    statusItem,
    vscode.window.onDidChangeActiveTextEditor(() => updateStatus()),
    vscode.commands.registerCommand('schematron.validate', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) { void validate(doc, true); }
    }),
    vscode.commands.registerCommand('schematron.clear', () => diagnostics.clear()),
    vscode.commands.registerCommand('schematron.showOutput', () => output.show()),
    vscode.commands.registerCommand('schematron.selectInterpreter', chooseInterpreter),
    vscode.commands.registerCommand('schematron.refreshSchema', refreshSchema),
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (cfg(doc).get<boolean>('validateOnOpen')) { void validate(doc, false); }
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      clearChangeTimer(doc.uri.toString());
      if (cfg(doc).get<boolean>('validateOnSave')) { void validate(doc, false); }
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      const doc = e.document;
      if (!e.contentChanges.length || doc.uri.scheme !== 'file' || doc.languageId !== 'xml') { return; }
      const c = cfg(doc);
      if (!c.get<boolean>('validateOnChange')) { return; }
      // Wait until typing pauses; every change restarts the wait.
      const key = doc.uri.toString();
      clearChangeTimer(key);
      changeTimers.set(key, setTimeout(() => {
        changeTimers.delete(key);
        void validate(doc, false);
      }, Math.max(c.get<number>('changeDelayMs') ?? 500, 100)));
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      clearChangeTimer(doc.uri.toString());
      cancel(doc.uri.toString());
      outcomes.delete(doc.uri.toString());
      diagnostics.delete(doc.uri);
      updateStatus();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('schematron')) { return; }
      jingMissingLogged = false;
      interpreterNotified = false;
      revalidateOpen();
    }),
  );

  for (const doc of vscode.workspace.textDocuments) {
    if (cfg(doc).get<boolean>('validateOnOpen')) { void validate(doc, false); }
  }
}

/** Re-validate open XML documents that already have results (or are
 *  candidates), e.g. after a settings change. */
function revalidateOpen() {
  for (const doc of vscode.workspace.textDocuments) {
    void validate(doc, false);
  }
}

export function deactivate() {
  for (const key of changeTimers.keys()) { clearChangeTimer(key); }
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

/** Validates `doc` and shows the results. `refresh` re-downloads a remote
 *  schema first (validate.py --refresh). Returns validate.py's run, or
 *  undefined when the document was skipped or a newer run superseded it. */
async function validate(doc: vscode.TextDocument, manual: boolean,
                        refresh = false): Promise<RunResult | undefined> {
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

  setOutcome(key, { state: 'running' });
  let failedMessage: string | undefined;
  // Unsaved edits: validate the editor's text from a private temporary copy
  // (never next to the user's file); --as makes validate.py resolve relative
  // xml-model hrefs and report as if it were the real file.
  let tmpDir: string | undefined;
  let input = file;
  if (doc.isDirty) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schematron-'));
    input = path.join(tmpDir, path.basename(file));
    fs.writeFileSync(input, doc.getText(), 'utf8');
  }
  try {
    const args = [validator, '--json', ...(refresh ? ['--refresh'] : []),
                  ...(schema ? [schemaFlag, schema] : []),
                  ...(tmpDir ? ['--as', file] : []), input];
    const r = await run(python, args, cwd, key, timeoutMs);
    if (generation.get(key) !== gen) { return; }        // superseded

    let items: Item[];
    let parsed: ValidateOutput | undefined;
    if (r.spawnError) {
      const msg = `Could not run the Python interpreter "${python}" ` +
        `(${r.spawnError.code ?? r.spawnError.message}). Set schematron.pythonPath ` +
        `to a Python that has saxonche and lxml.`;
      items = [failure(msg)];
      failedMessage = msg;
      void notifyInterpreter(msg);
    } else {
      try {
        parsed = JSON.parse(r.stdout) as ValidateOutput;
        items = itemsFromValidate(parsed, file);
      } catch {
        const f = explainFailure(r.stderr, python);
        items = [failure(f.message)];
        failedMessage = f.message;
        if (f.interpreter) { void notifyInterpreter(f.message); }
      }
    }

    let relaxngRan = false;
    // On text that is not well-formed jing still runs: its errors before the
    // fatal one often pinpoint the typo ("element notde not allowed"); only
    // its fatal error is dropped, as validate.py already reported it.
    const malformed = parsed?.documents.some(d => d.error) ?? false;
    if (parsed?.source.type === 'rng' && c.get<boolean>('relaxng.enabled')) {
      const rItems = await relaxng(doc, parsed.source.path, input, cwd, key, timeoutMs, malformed);
      if (generation.get(key) !== gen) { return; }
      relaxngRan = rItems !== null;
      items.push(...(rItems ?? []));
    }

    diagnostics.set(doc.uri, items.map(i => toDiagnostic(doc, i)));
    const count = (s: Item['severity']) => items.filter(i => i.severity === s).length;
    setOutcome(key, failedMessage !== undefined
      ? { state: 'failed', message: failedMessage, at: new Date() }
      : { state: 'done', errors: count('error'), warnings: count('warning'),
          infos: count('info'), relaxng: relaxngRan, at: new Date() });
    return r;
  } finally {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  }
}

function setOutcome(key: string, o: Outcome) {
  outcomes.set(key, o);
  updateStatus();
}

/** Status bar item for the active editor's document: spinner while running,
 *  a check mark when clean, counts when there are problems. Hidden for
 *  documents the extension does not validate. */
function updateStatus() {
  const doc = vscode.window.activeTextEditor?.document;
  const o = doc && outcomes.get(doc.uri.toString());
  if (!o) { statusItem.hide(); return; }
  statusItem.backgroundColor = undefined;
  const click = '\n\nClick to show the Schematron output.';
  const time = (d: Date) => d.toLocaleTimeString();
  if (o.state === 'running') {
    statusItem.text = '$(sync~spin) Schematron';
    statusItem.tooltip = 'Validating…';
  } else if (o.state === 'failed') {
    statusItem.text = '$(alert) Schematron: failed';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusItem.tooltip = `Validation could not run (${time(o.at)}):\n${o.message}${click}`;
  } else {
    const layers = o.relaxng ? 'Schematron and RelaxNG' : 'Schematron';
    const n = o.errors + o.warnings + o.infos;
    if (n === 0) {
      statusItem.text = '$(check) Schematron';
      statusItem.tooltip = `Valid: no ${layers} problems (checked ${time(o.at)}).${click}`;
    } else {
      statusItem.text = `$(${o.errors ? 'error' : 'warning'}) Schematron: ${n}`;
      const parts = [[o.errors, 'error'], [o.warnings, 'warning'], [o.infos, 'info']]
        .filter(([k]) => k).map(([k, w]) => `${k} ${w}${k === 1 ? '' : 's'}`);
      statusItem.tooltip = `${parts.join(', ')} (${layers}, checked ${time(o.at)}). ` +
        `See the Problems panel.${click}`;
    }
  }
  statusItem.show();
}

async function relaxng(doc: vscode.TextDocument, rng: string, file: string,
                       cwd: string, key: string, timeoutMs: number,
                       dropFatal = false): Promise<Item[] | null> {
  const jing = cfg(doc).get<string>('jingPath') || 'jing';
  const r = await run(jing, [rng, file], cwd, key, timeoutMs);
  if (r.spawnError) {
    if (!jingMissingLogged) {
      jingMissingLogged = true;
      output.appendLine(`jing not found (${jing}); RelaxNG layer skipped. ` +
        `Install jing, set schematron.jingPath, or disable schematron.relaxng.enabled.`);
    }
    return null;                                    // layer did not run
  }
  // jing: 0 valid, 1 invalid; anything else is an environment error.
  if (r.code !== null && r.code > 1) {
    return [{ line: -1, severity: 'warning', source: 'RelaxNG',
              message: `jing failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').pop()}` }];
  }
  return itemsFromJing(r.stdout + '\n' + r.stderr, file, dropFatal);
}

export type RefreshResult =
  | { status: 'refreshed'; url: string }
  | { status: 'local' | 'failed' | 'no-document' };

/** Schematron: Refresh Schema. Re-downloads the active document's remote
 *  schema (the cached copy is otherwise kept forever), which also
 *  regenerates the harvested rules, then re-validates every open file, as
 *  others may share the schema. A local schema needs no refresh: changes
 *  to it are picked up automatically. Returns the outcome (used by tests). */
async function refreshSchema(): Promise<RefreshResult> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== 'xml' || doc.uri.scheme !== 'file') {
    vscode.window.showWarningMessage('Schematron: open the XML document whose schema you want to refresh.');
    return { status: 'no-document' };
  }
  const name = path.basename(doc.uri.fsPath);
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Schematron: refreshing the schema of ${name}…` },
    () => validate(doc, true, true));
  if (!r || r.spawnError || !r.stdout.trim().startsWith('{')) {
    vscode.window.showErrorMessage(
      'Schematron: the schema could not be refreshed. See the status bar or Schematron: Show Output.');
    return { status: 'failed' };
  }
  const url = downloadedUrl(r.stderr);
  if (!url) {
    vscode.window.showInformationMessage(
      `Schematron: the schema of ${name} is a local file, so there is nothing to download; ` +
      `changes to it are picked up automatically.`);
    return { status: 'local' };
  }
  for (const other of vscode.workspace.textDocuments) {
    if (other !== doc) { void validate(other, false); }
  }
  vscode.window.showInformationMessage(`Schematron: schema refreshed from ${url}`);
  return { status: 'refreshed', url };
}

async function notifyInterpreter(message: string) {
  if (interpreterNotified) { return; }
  interpreterNotified = true;
  const choose = 'Choose Interpreter…', settings = 'Open Settings';
  const pick = await vscode.window.showErrorMessage(`Schematron: ${message}`, choose, settings);
  if (pick === choose) {
    await chooseInterpreter();
  } else if (pick === settings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'schematron.pythonPath');
  }
}

/** Lets the user pick a Python executable, checks that it can import
 *  saxonche and lxml, and saves it as the user-level schematron.pythonPath. */
async function chooseInterpreter() {
  const venvs = path.join(os.homedir(), '.venvs');
  const uris = await vscode.window.showOpenDialog({
    title: 'Python interpreter with saxonche and lxml',
    openLabel: 'Use This Interpreter',
    canSelectMany: false,
    defaultUri: vscode.Uri.file(venvs),
  });
  const python = uris?.[0]?.fsPath;
  if (!python) { return; }
  const r = await run(python, ['-c', 'import saxonche, lxml'], os.homedir(),
                      'interpreter-check', 30000);
  if (r.spawnError || r.code !== 0) {
    const why = r.spawnError
      ? `it could not be run (${r.spawnError.code ?? r.spawnError.message})`
      : 'it cannot import saxonche and lxml';
    const again = 'Choose Another…';
    const pick = await vscode.window.showErrorMessage(
      `Schematron: "${python}" was not saved because ${why}. ` +
      `Install them with: "${python}" -m pip install saxonche lxml`, again);
    if (pick === again) { await chooseInterpreter(); }
    return;
  }
  // Saving the setting triggers onDidChangeConfiguration, which re-validates.
  await vscode.workspace.getConfiguration('schematron')
    .update('pythonPath', python, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Schematron: using ${python}`);
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
  const [start, end] = underline(doc.lineAt(lineNo).text, i.col);
  const range = new vscode.Range(lineNo, start, lineNo, end);
  const d = new vscode.Diagnostic(range, i.message, SEVERITY[i.severity]);
  d.source = i.source;
  if (i.code) { d.code = i.code; }
  return d;
}
