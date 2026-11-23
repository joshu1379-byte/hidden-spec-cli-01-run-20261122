// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md are the kit starter's (MIT); sections 5 to 8
// (three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches) and
// the move (`R`) output lines are written here.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: [string, string][] = [];
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
}

type Edit = (tree: Tree) => void;

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

// ---- SPEC.md section 5: matching lines, and section 3: a file's lines ----

interface Split {
  br: string;
  lines: string[];
  fin: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { br, lines, fin };
}

function joinFile(f: Split): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.fin ? f.br : '');
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O matches lines at one tier. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions; null when none. */
function findOcc(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The lines N writes in place of O matched at `pos`: a context line is written as the
 * file's own matched line; at tier 2 every other line is re-indented from O's first
 * line's leading whitespace to the file's first matched line's.
 * nCtx[j] says N[j] is a context line; nO[j] is its index in O (or -1).
 */
function buildReplacement(fileLines: string[], pos: number, O: string[], N: string[], nCtx: boolean[], nO: number[], tier: number): string[] {
  const out: string[] = [];
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(fileLines[pos]!);
    P = leadingWs(O[0]!);
  }
  for (let j = 0; j < N.length; j++) {
    if (nCtx[j]!) {
      out.push(fileLines[pos + nO[j]!]!);
    } else {
      let line = N[j]!;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) line = F + line.slice(P.length);
      out.push(line);
    }
  }
  return out;
}

// ---- SPEC.md section 9: JSON edits (starter) ----

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
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
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

// ---- SPEC.md section 6: unified diffs ----

interface Hunk {
  A: number;
  o: string[];
  n: string[];
  nCtx: boolean[];
  nO: number[];
  /** A `\` line follows the hunk's last context or `+` line. */
  bsAfterLastOut: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  bsAfterLastPlus: boolean;
}

interface Section {
  oldP: string | null;
  newP: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

/** The path of a `--- `/`+++ ` line: after the four characters, up to the first tab, spaces removed. */
function diffPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunkBody(body: string[]): Hunk {
  // Filled in by the caller: A is set after.
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  const nO: number[] = [];
  for (const l of body) {
    if (l.startsWith(' ') || l === '') {
      const t = l === '' ? '' : l.slice(1);
      nCtx.push(true);
      nO.push(o.length);
      o.push(t);
      n.push(t);
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      nCtx.push(false);
      nO.push(-1);
      n.push(l.slice(1));
    }
    // `\` lines carry no text of their own.
  }
  let bsAfterLastOut = false;
  let bsAfterLastPlus = false;
  for (let i = body.length - 1; i >= 0; i--) {
    const l = body[i]!;
    if (l.startsWith(' ') || l === '' || l.startsWith('+')) {
      bsAfterLastOut = i + 1 < body.length && body[i + 1]!.startsWith('\\');
      break;
    }
  }
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.startsWith('+')) {
      bsAfterLastPlus = i + 1 < body.length && body[i + 1]!.startsWith('\\');
      break;
    }
  }
  return { A: 0, o, n, nCtx, nO, bsAfterLastOut, bsAfterLastPlus };
}

/** Apply a section's hunks in order to a file's text; Fail on the first hunk that fails. */
function applyHunks(content: string, hunks: Hunk[], path: string, strict: boolean): string {
  const f = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(Math.max(h.A + d, 0), f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...h.n);
      if (atEnd) f.fin = !h.bsAfterLastOut;
      d += h.n.length;
      continue;
    }
    const found = findOcc(f.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length === f.lines.length;
    const rep = buildReplacement(f.lines, best, h.o, h.n, h.nCtx, h.nO, found.tier);
    f.lines.splice(best, h.o.length, ...rep);
    if (atEnd) f.fin = !h.bsAfterLastOut;
    d += h.n.length - h.o.length;
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: m[1]!, newP: m[2]!, createFlag: false, delFlag: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldP = stripAB(diffPath(l));
        cur.newP = stripAB(diffPath(lines[i + 1]!));
      } else {
        cur = { oldP: stripAB(diffPath(l)), newP: stripAB(diffPath(lines[i + 1]!)), createFlag: false, delFlag: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { A: Number(m[1]), o: [], n: [], nCtx: [], nO: [], bsAfterLastOut: false, bsAfterLastPlus: false };
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const parsed = parseHunkBody(body);
      hunk.o = parsed.o;
      hunk.n = parsed.n;
      hunk.nCtx = parsed.nCtx;
      hunk.nO = parsed.nO;
      hunk.bsAfterLastOut = parsed.bsAfterLastOut;
      hunk.bsAfterLastPlus = parsed.bsAfterLastPlus;
      cur.hunks.push(hunk);
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) cur.newP = stripAB(diffPath(l));
      else if (l.startsWith('rename from ')) cur.oldP = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.newP = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.createFlag = true;
      else if (l.startsWith('deleted file mode')) cur.delFlag = true;
      // index, old/new mode, similarity/dissimilarity index, Index: and any other line: ignored.
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree: Tree): void => {
    const isCreate = sec.oldP === null || sec.createFlag;
    const isDelete = !isCreate && (sec.newP === null || sec.delFlag);
    if (isCreate) {
      const p = sec.newP;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (let k = 0; k < h.n.length; k++) {
          if (!h.nCtx[k]) plus.push(h.n[k]!);
        }
      }
      // A created file ends with a line break unless a `\` line follows its last `+` line.
      let fin = true;
      for (const h of sec.hunks) {
        if (h.n.some((_, k) => !h.nCtx[k])) fin = !h.bsAfterLastPlus;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = sec.oldP;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldP!;
    const newP = sec.newP!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (oldP !== newP && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(before, sec.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    tree.now.set(oldP, applyHunks(before, sec.hunks, oldP, strict));
  });
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${sLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${sLine}`);
    let p: string | null = null;
    for (let q = i - 1; q >= prevEnd; q--) {
      const t = lines[q]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      p = t.trim();
      break;
    }
    if (p === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sLine}`);
      p = prevPath;
    }
    blocks.push({ path: p, oldLines: lines.slice(i + 1, j), newLines: lines.slice(j + 1, k) });
    prevPath = p;
    prevEnd = k + 1;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = splitFile(cur);
    const found = findOcc(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const rep = buildReplacement(f.lines, pos, b.oldLines, b.newLines, b.newLines.map(() => false), b.newLines.map(() => -1), found.tier);
    f.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinFile(f));
  });
}

// ---- SPEC.md section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  nCtx: boolean[];
  nO: number[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface VSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    moveTo: string | null;
    addLines: string[];
    chunks: VChunk[];
  }
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secNo = i + 1;
    // Collect this section's raw lines (with numbers) up to the next section or End Patch.
    const raw: { t: string; n: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const t = lines[j]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      raw.push({ t, n: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    const sec: VSection = { kind, path, lineNo: secNo, moveTo: null, addLines: [], chunks: [] };
    if (kind === 'add') {
      for (const r of raw) {
        if (r.t.startsWith('+')) sec.addLines.push(r.t.slice(1));
        else if (r.t === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.n}`);
      }
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
    } else {
      let at = 0;
      if (raw.length > 0 && raw[0]!.t.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.t.slice('*** Move to: '.length).trim();
        at = 1;
      }
      let cur: VChunk | null = null;
      const open = (): VChunk => {
        const c: VChunk = { anchor: null, eof: false, o: [], n: [], nCtx: [], nO: [] };
        sec.chunks.push(c);
        return c;
      };
      for (; at < raw.length; at++) {
        const r = raw[at]!;
        if (r.t.startsWith('@@')) {
          cur = open();
          const a = r.t.slice(2).trim();
          cur.anchor = a === '' ? null : a;
        } else if (r.t === '*** End of File') {
          if (cur !== null) cur.eof = true;
          cur = null;
        } else if (r.t.startsWith(' ') || r.t === '' || r.t.startsWith('-') || r.t.startsWith('+')) {
          if (cur === null) cur = open();
          if (r.t.startsWith(' ') || r.t === '') {
            const t = r.t === '' ? '' : r.t.slice(1);
            cur.nCtx.push(true);
            cur.nO.push(cur.o.length);
            cur.o.push(t);
            cur.n.push(t);
          } else if (r.t.startsWith('-')) {
            cur.o.push(r.t.slice(1));
          } else {
            cur.nCtx.push(false);
            cur.nO.push(-1);
            cur.n.push(r.t.slice(1));
          }
        } else {
          throw new Exit2(`error: parse ${r.n}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${secNo}`);
    }
    sections.push(sec);
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let p = cursor; p < f.lines.length; p++) {
            if (normLine(f.lines[p]!, t) === normLine(ch.anchor, t)) {
              foundAt = p;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...ch.n);
        cursor = pos + ch.n.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const occ = occurrences(f.lines, ch.o, t).filter((p) => p >= cursor && (!ch.eof || p + ch.o.length === f.lines.length));
        if (occ.length > 0) {
          found = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const rep = buildReplacement(f.lines, found.pos, ch.o, ch.n, ch.nCtx, ch.nO, found.tier);
      f.lines.splice(found.pos, ch.o.length, ...rep);
      cursor = found.pos + rep.length;
    }
    const out = joinFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
      return;
    }
    tree.now.set(sec.path, out);
  });
}

// ---- SPEC.md sections 1, 2 and 10: invocation, output, order and atomicity ----

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per path whose state changed, in byte order of the paths; a move that
  // succeeded replaces its pair's `D` and `A` lines and sorts by its new path.
  const rows: { key: string; text: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
