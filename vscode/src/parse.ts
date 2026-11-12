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
  source: 'Schematron' | 'RelaxNG' | 'XML';
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
    return itemsFromMalformed(doc.error, doc.error_line);
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

/** A not-well-formed document. The parser reports where it NOTICED the
 *  problem (e.g. the closing tag that doesn't match), which is often far
 *  from the typo; for a tag mismatch, also flag the line where the unclosed
 *  tag was opened. */
export function itemsFromMalformed(message: string, line?: number | null): Item[] {
  const items: Item[] = [{ line: toLine(line), message, severity: 'error', source: 'XML' }];
  const m = /Opening and ending tag mismatch: (\S+) line (\d+) and (\S+?),?\s/.exec(message);
  if (m && Number(m[2]) !== line) {
    const [, opened, at, closing] = m;
    items.push({
      line: Number(at) - 1, severity: 'error', source: 'XML',
      message: `<${opened}> opened here is never closed: the next end tag is </${closing}>` +
        (line ? ` (line ${line})` : '') + `. Check for a typo in the element name.`,
    });
  }
  return items;
}

/** Columns [start, end) to underline on a line. jing's column points just
 *  AFTER the offending start tag, often at the end of the line, which would
 *  give an empty (invisible) range; so the underline runs from that tag's
 *  "<" to the reported column. Without a column, the line's content (minus
 *  indentation and trailing spaces) is underlined. */
export function underline(text: string, col?: number): [number, number] {
  const first = text.search(/\S/);
  const whole: [number, number] = first < 0 ? [0, text.length] : [first, text.trimEnd().length];
  if (col === undefined) { return whole; }
  const c = Math.min(col, text.length);
  const lt = c > 0 ? text.lastIndexOf('<', c - 1) : -1;
  if (lt >= 0) { return [lt, Math.max(c, lt + 1)]; }
  return c < whole[1] ? [c, whole[1]] : whole;
}

// jing: "/abs/file.xml:12:34: error: message"
const JING_RE = /^(.*?):(\d+):(\d+): (error|warning|fatal): (.*)$/;

/** `dropFatal`: leave out jing's fatal (well-formedness) errors, when
 *  validate.py has already reported the document as not well-formed. */
export function itemsFromJing(output: string, file: string, dropFatal = false): Item[] {
  const target = path.resolve(file);
  const items: Item[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = JING_RE.exec(raw.trim());
    if (!m) { continue; }
    const [, f, line, col, level, msg] = m;
    if (path.resolve(f) !== target || (dropFatal && level === 'fatal')) { continue; }
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

export interface Failure {
  message: string;
  /** True when the problem is the Python interpreter itself (missing
   *  modules), so the user should pick another one. */
  interpreter: boolean;
}

/** URL that validate.py downloaded in this run ("[descarga] URL" on
 *  stderr), if any. */
export function downloadedUrl(stderr: string): string | undefined {
  return /^\[descarga\] (\S+)/m.exec(stderr)?.[1];
}

/** Best explanation from validate.py's stderr when it produced no JSON
 *  (environment errors, exit code 3). `python` is the interpreter used. */
export function explainFailure(stderr: string, python: string): Failure {
  const mod = /No module named '?(saxonche|lxml)/.exec(stderr)?.[1];
  if (mod) {
    return {
      interpreter: true,
      message: `The Python interpreter "${python}" does not have the '${mod}' module. ` +
        `Choose an interpreter that has saxonche and lxml (schematron.pythonPath), ` +
        `or install them into this one: "${python}" -m pip install saxonche lxml`,
    };
  }
  const lines = stderr.split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !/^\[(caché|descarga|xml-model|esquema|extracción|cosecha|aviso)\]/.test(l));
  return { interpreter: false,
           message: lines.slice(-3).join(' ') || 'validate.py failed without a message.' };
}
