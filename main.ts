// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It implements all of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// matching lines at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
// The command line, output, safe paths, format detection, JSON edits and the write are the kit starter's;
// unified diffs, SEARCH/REPLACE, V4A and the three-tier matching were written in this session.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.
//
// Judgment calls (SPEC.md sentences with more than one plausible reading; each is literal where the spec
// speaks, and the choice is recorded so the crosscheck can challenge it):
// - A `*** End of File` line with no chunk open is a parse error at its own line (it "ends a chunk", so
//   with no chunk there is nothing to end; a section left with no chunk at all reports at its Update line).
// - A second `---`/`+++` pair inside one section header overwrites the first (the spec lets a pair that
//   is "already part of a section's header" stand, without saying first or last wins).
// - A `diff --git` line whose paths hold spaces is a parse error (the form is `diff --git a/<X> b/<Y>`;
//   the practice pool's paths never hold spaces).
// - A `\` line after a `-` line never changes the result's final break by itself: only a `\` line
//   following the hunk's last context or `+` line does (section 6, read literally; practice u-noeol
//   confirms the result ends with a break when no such `\` follows).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** For a path that exists because a move edit put it there: the path it was moved from (transitively). */
  readonly movedFrom = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  diskExists(p: string): boolean {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
  /** The path is taken: a file in the tree, or anything on disk at that path (a directory counts). */
  taken(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    return this.diskExists(p);
  }
}

/** Record that `from` was moved to `to` (transitively: a file moved twice reports its first path). */
function recordMove(tree: Tree, from: string, to: string): void {
  const origin = tree.movedFrom.get(from) ?? from;
  tree.movedFrom.delete(from);
  if (origin === to) tree.movedFrom.delete(to);
  else tree.movedFrom.set(to, origin);
}

// ---- Files: the line model of SPEC.md section 3 ----

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

// ---- Matching lines: SPEC.md section 5 ----

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where `pat` occurs in `lines` at `tier`. Occurrences may overlap. */
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  const pk = pat.map((l) => tierKey(l, tier));
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== pk[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `pat` occurs at least once, or -1. With `strict` only tier 0 is tried. */
function firstTier(lines: string[], pat: string[], strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(lines, pat, t).length > 0) return t;
  }
  return -1;
}

const leading = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** One body line of a hunk or chunk: context, old, new, or a `\` (no-newline) marker. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

function oldLinesOf(body: BodyItem[]): string[] {
  return body.filter((it) => it.kind === 'ctx' || it.kind === 'old').map((it) => it.text);
}

/** Whether a `\` line follows the body's last context or `+` line (SPEC.md section 6). */
function noEolAfterLast(body: BodyItem[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'bs';
}

/**
 * The new lines a hunk or chunk writes: context lines are the file's own matched lines,
 * `+` lines are written as they are, re-indented at tier 2 (SPEC.md section 5).
 */
function buildNew(body: BodyItem[], fileLines: string[], at: number, tier: number, oLines: string[]): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const p = oLines.length > 0 ? leading(oLines[0]!) : '';
  const f = at < fileLines.length ? leading(fileLines[at]!) : '';
  for (const it of body) {
    if (it.kind === 'ctx') {
      out.push(fileLines[at + oIdx] ?? '');
      oIdx++;
    } else if (it.kind === 'old') {
      oIdx++;
    } else if (it.kind === 'new') {
      let s = it.text;
      if (tier === 2 && oLines.length > 0 && s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.taken(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
      tree.movedFrom.delete(p);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type Edit = (tree: Tree) => void;

// ---- Unified diffs: SPEC.md section 6 ----

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  hasDash: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseHdrPath(s: string): string {
  const tab = s.indexOf('\t');
  return (tab >= 0 ? s.slice(0, tab) : s).trim();
}

function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${idx + 1}`);
  return Number(m[1]);
}

/** Scan a hunk body starting at `start`; returns the index of the first line after it. */
function parseHunkBody(lines: string[], start: number, hunk: Hunk): number {
  let j = start;
  const body: BodyItem[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  hunk.body = body;
  return j;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let inHeader = false;
  const fresh = (): UniSection => ({
    oldPath: null,
    newPath: null,
    hasDash: false,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const close = (): void => {
    if (sec !== null) sections.push(sec);
    sec = null;
  };
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      close();
      sec = fresh();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (sec === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec = fresh();
        inHeader = true;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        const next = lines[i + 1] ?? '';
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.oldPath = stripPrefix(parseHdrPath(line.slice(4)));
        sec.newPath = stripPrefix(parseHdrPath(next.slice(4)));
        sec.hasDash = true;
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        sec.deletedFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const hunk: Hunk = { a: parseHunkHeader(line, i), body: [] };
        inHeader = false;
        i = parseHunkBody(lines, i + 1, hunk);
        sec.hunks.push(hunk);
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk: Hunk = { a: parseHunkHeader(line, i), body: [] };
      i = parseHunkBody(lines, i + 1, hunk);
      sec.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      close();
      sec = fresh();
      inHeader = true;
      continue;
    }
    i++;
  }
  close();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = (sec.hasDash ? sec.oldPath : (sec.renameFrom ?? sec.diffOld)) ?? '';
  const newP = (sec.hasDash ? sec.newPath : (sec.renameTo ?? sec.diffNew)) ?? '';
  const isCreate = oldP === '/dev/null' || sec.newFile;
  const isDelete = !isCreate && (newP === '/dev/null' || sec.deletedFile);
  if (isCreate) {
    return (tree) => {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.taken(newP)) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusNoEol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const it = h.body[k]!;
          if (it.kind === 'new') {
            plus.push(it.text);
            lastPlusNoEol = h.body[k + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
      tree.movedFrom.delete(newP);
    };
  }
  if (isDelete) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      tree.movedFrom.delete(oldP);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.taken(newP)) throw new Fail('exists', newP);
      const model = parseFile(before);
      applyUnifiedHunks(model, sec.hunks, strict, oldP);
      tree.now.set(newP, serializeFile(model));
      tree.now.set(oldP, null);
      recordMove(tree, oldP, newP);
    };
  }
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const model = parseFile(before);
    applyUnifiedHunks(model, sec.hunks, strict, oldP);
    tree.now.set(oldP, serializeFile(model));
  };
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyUnifiedHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const oLines = oldLinesOf(h.body);
    if (oLines.length === 0) {
      const adds = h.body.filter((it) => it.kind === 'new').map((it) => it.text);
      const pos = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...adds);
      if (atEnd) model.final = !noEolAfterLast(h.body);
      d += adds.length;
      continue;
    }
    const tier = firstTier(model.lines, oLines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occs = occurrences(model.lines, oLines, tier);
    const target = h.a - 1 + d;
    let best = occs[0]!;
    for (const o of occs) {
      if (Math.abs(o - target) < Math.abs(best - target)) best = o;
    }
    const nWrite = buildNew(h.body, model.lines, best, tier, oLines);
    const runsToEnd = best + oLines.length === model.lines.length;
    model.lines.splice(best, oLines.length, ...nWrite);
    if (runsToEnd) model.final = !noEolAfterLast(h.body);
    d += nWrite.length - oLines.length;
  }
}

// ---- SEARCH/REPLACE blocks: SPEC.md section 7 ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.taken(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      tree.movedFrom.delete(path);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const tier = firstTier(model.lines, oldLines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occs = occurrences(model.lines, oldLines, tier);
    if (occs.length > 1) throw new Fail('ambiguous', path);
    const at = occs[0]!;
    const p = leading(oldLines[0]!);
    const f = leading(model.lines[at]!);
    const repl = newLines.map((s) => {
      if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) return f + s.slice(p.length);
      return s;
    });
    model.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, serializeFile(model));
  };
}

// ---- V4A patches: SPEC.md section 8 ----

interface VChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLine = i + 1;
    const start = i + 1;
    let j = start;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      j++;
    }
    const raw = lines.slice(start, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') addLines.push('');
        else if (l.startsWith('+')) addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${start + k + 1}`);
      }
      edits.push(vAddEdit(path, addLines));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${start + 1}`);
      edits.push(vDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenAny = false;
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        const ln = start + k + 1;
        if (!seenAny && l.startsWith('*** Move to: ')) {
          moveTo = l.slice('*** Move to: '.length).trim();
          seenAny = true;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          seenAny = true;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          cur = null;
          seenAny = true;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
              chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${ln}`);
            }
          }
          const bkind = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
          cur.body.push({ kind: bkind, text: l === '' ? '' : l.slice(1) });
          seenAny = true;
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function vAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.taken(path)) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
    tree.movedFrom.delete(path);
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
    tree.movedFrom.delete(path);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.taken(moveTo)) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    const maxTier = strict ? 0 : 2;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let found = -1;
        for (let t = 0; t <= maxTier && found < 0; t++) {
          for (let k = cursor; k < model.lines.length; k++) {
            if (tierKey(model.lines[k]!, t) === tierKey(ch.anchor, t)) {
              found = k;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const oLines = oldLinesOf(ch.body);
      if (oLines.length === 0) {
        const adds = ch.body.filter((it) => it.kind === 'new').map((it) => it.text);
        const pos = ch.eof ? model.lines.length : cursor;
        model.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
        continue;
      }
      let tier = -1;
      let at = -1;
      for (let t = 0; t <= maxTier; t++) {
        const occs = occurrences(model.lines, oLines, t).filter(
          (p) => p >= cursor && (!ch.eof || p + oLines.length === model.lines.length),
        );
        if (occs.length > 0) {
          tier = t;
          at = occs[0]!;
          break;
        }
      }
      if (at < 0) throw new Fail('no-match', path);
      const nWrite = buildNew(ch.body, model.lines, at, tier, oLines);
      model.lines.splice(at, oLines.length, ...nWrite);
      cursor = at + nWrite.length;
    }
    const out = serializeFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      recordMove(tree, path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.movedFrom);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.movedFrom.clear();
      for (const [k, v] of beforeMoves) tree.movedFrom.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const origin = tree.movedFrom.get(p);
    if (origin !== undefined && now !== null && was === null && tree.original(origin) !== null) {
      const oldNow = tree.now.has(origin) ? tree.now.get(origin)! : tree.original(origin);
      if (oldNow === null) {
        rows.push({ key: p, line: `R ${origin} -> ${p}` });
        continue;
      }
    }
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const rFroms = new Set(rows.filter((r) => r.line.startsWith('R ')).map((r) => r.line.slice(2, r.line.indexOf(' -> '))));
  const finalRows = rows.filter((r) => !(r.line.startsWith('D ') && rFroms.has(r.line.slice(2))));
  finalRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...finalRows.map((r) => r.line), `ok: ${finalRows.length} ${finalRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
