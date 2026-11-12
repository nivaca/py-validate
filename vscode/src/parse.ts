// Pure parsing of validate.py --json and jing output into editor-neutral
// diagnostic items. No dependency on the vscode API, so it can be unit-tested
// with plain Node.

import * as path from 'path';

export type Severity = 'error' | 'warning' | 'info';

export interface Item {
  /** 0-based line; -1 when unknown (shown on the first line). */
  line: number;
  /** 0-based column, when the tool reports one. */
  col?: number;
  message: string;
  severity: Severity;
  source: 'Schematron' | 'RelaxNG';
  code?: string;
}

export interface Violation {
  pattern: string;
  context: string;
  type: 'assert' | 'report';
  role: string;
  message: string;
  text: string;
  path: string;
  line: number | null;
  xml_id: string | null;
}

export interface XPathError {
  message: string;
  context: string;
  error: string;
  nodes: number;
}

export interface DocumentResult {
  file: string;
  violations?: Violation[];
  xpath_errors?: XPathError[];
  seconds?: number;
  error?: string;
  error_line?: number | null;
}

export interface ValidateOutput {
  version: string;
  schema: string;
  source: { path: string; type: 'rng' | 'sch' | 'odd' };
  documents: DocumentResult[];
}

/** Schematron `role` wins when it names a level; otherwise every failed
 *  assert or successful report is an error. */
export function severityFor(role: string): Severity {
  const r = role.trim().toLowerCase();
  if (r === 'warning' || r === 'warn') { return 'warning'; }
  if (r === 'info' || r === 'information' || r === 'hint') { return 'info'; }
  return 'error';
}

const toLine = (n: number | null | undefined) => (n && n > 0 ? n - 1 : -1);

export function itemsFromValidate(out: ValidateOutput, file: string): Item[] {
  const target = path.resolve(file);
  const doc = out.documents.find(d => path.resolve(d.file) === target)
    ?? out.documents[0];
  if (!doc) { return []; }
  if (doc.error) {
    return [{ line: toLine(doc.error_line), message: doc.error,
              severity: 'error', source: 'Schematron' }];
  }
  const items: Item[] = (doc.violations ?? []).map(v => ({
    line: toLine(v.line),
    message: v.text || v.message,
    severity: severityFor(v.role),
    source: 'Schematron' as const,
    code: v.pattern || undefined,
  }));
  const errs = doc.xpath_errors ?? [];
  if (errs.length) {
    const detail = errs
      .map(e => `• ${e.message || '(no message)'} [${e.context}]: ${e.error} (${e.nodes} nodes)`)
      .join('\n');
    items.push({
      line: -1,
      severity: 'warning',
      source: 'Schematron',
      message: `${errs.length} rule(s) failed to evaluate; the verdict is incomplete.\n${detail}`,
    });
  }
  return items;
}

// jing: "/abs/file.xml:12:34: error: message"
const JING_RE = /^(.*?):(\d+):(\d+): (error|warning|fatal): (.*)$/;

export function itemsFromJing(output: string, file: string): Item[] {
  const target = path.resolve(file);
  const items: Item[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = JING_RE.exec(raw.trim());
    if (!m) { continue; }
    const [, f, line, col, level, msg] = m;
    if (path.resolve(f) !== target) { continue; }
    items.push({
      line: Number(line) - 1,
      col: Math.max(Number(col) - 1, 0),
      message: msg,
      severity: level === 'warning' ? 'warning' : 'error',
      source: 'RelaxNG',
    });
  }
  return items;
}

/** Best one-line explanation from validate.py's stderr when it produced no
 *  JSON (environment errors, exit code 3). */
export function explainFailure(stderr: string): string {
  if (/No module named '?(saxonche|lxml)/.test(stderr)) {
    const mod = /No module named '?(\w+)/.exec(stderr)?.[1];
    return `Python module '${mod}' is missing: pip install saxonche lxml ` +
      `(or point schematron.pythonPath at an interpreter that has them).`;
  }
  const lines = stderr.split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !/^\[(caché|descarga|xml-model|esquema|extracción|cosecha|aviso)\]/.test(l));
  return lines.slice(-3).join(' ') || 'validate.py failed without a message.';
}
