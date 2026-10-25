#!/usr/bin/env node
/**
 * comment-hygiene — blocks the docs-quality violation classes in code
 * comments before they land. Scans the current change set (working tree
 * vs HEAD: staged + unstaged + untracked), so it only ever judges what
 * is about to be committed. Pass --all to scan the whole repo instead.
 *
 * Regexes catch the gross classes; the semantic rules (what an interface
 * comment should and should not say) live in the skill named on failure.
 *
 * Exit code 1 on violation so the pre-commit gate fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_ALL = process.argv.includes('--all');

/** Comment-owning roots; everything else (docs, ADRs, assets) is exempt. */
const SCAN_DIRS = [
  'backend/src',
  'backend/app',
  'backend/queue',
  'backend/scripts',
  'backend/mock',
  'backend/smoke',
  'backend/test',
  'frontend/src',
  'infra/bin',
  'infra/config',
  'infra/lib',
  'lib/api',
  'lib/metrics',
  'load/src',
  'scripts/checks',
].map((d) => join(ROOT, d));

const isScannable = (path) =>
  /\.(tsx?|mjs)$/.test(path) &&
  !path.endsWith('.generated.ts') &&
  SCAN_DIRS.some((d) => path.startsWith(`${d}/`));

/**
 * The gross classes. A pattern fires only when designed to: word-boundary
 * anchors keep identifiers like `TurnSpec` and `specRow` out of scope.
 */
const PATTERNS = [
  { re: /\b(?:ticket|jira)\b[\s#:_-]*\d+/i, label: 'work-ticket reference' },
  {
    re: /\bspec\b[\s#:_-]*\d+|\b(?:from|per|citing) (?:the )?spec\b|\bspec (?:document|evidence)\b/i,
    label: 'spec reference',
  },
  { re: /\bADR\b[\s#:_-]*\d+|\bsee ADR\b/i, label: 'ADR reference' },
  { re: /\b[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.md\b/, label: 'documentation (.md) citation' },
  {
    re: /\b(?:Probed|Updated|Switched|Tried|Reverted)\s+2\d{3}[-/]\d{2}/,
    label: 'dated narration / history',
  },
  { re: /\b(?:Key|Scoring) concepts:/, label: 'vocabulary list (CONTEXT.md mirror)' },
  { re: /\bresearch[- ]doc(?:ument)?\b/i, label: 'research-doc reference' },
  { re: /\bverified through\b/, label: 'verification narration' },
];

/** Decode a porcelain status path: `R old -> new` keeps only the new one. */
const porcelainPath = (raw) => raw.split(' -> ').pop().replace(/^"|"$/g, '');

function changedFiles() {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const path = porcelainPath(line.slice(3));
    if (code.startsWith('D') || code === '??') {
      if (code.startsWith('D')) continue; // deleted — nothing to judge
    }
    files.push({ path: join(ROOT, path), untracked: code.trim() === '??' });
  }
  // Untracked directories arrive as `?? dir/` — enumerate them.
  return files.flatMap(({ path, untracked }) => {
    if (!untracked) return [{ path, untracked }];
    try {
      return execFileSync('git', ['ls-files', '--others', '--exclude-standard', path], {
        cwd: ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)
        .map((p) => ({ path: join(ROOT, p), untracked: true }));
    } catch {
      return [{ path, untracked }];
    }
  });
}

/** Line numbers added against HEAD: `git diff --numstat` is not enough, we need positions. */
function addedLineSet(path) {
  const out = execFileSync('git', ['diff', '-U0', 'HEAD', '--', path], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const added = new Set();
  for (const m of out.matchAll(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let n = start; n < start + count; n++) added.add(n);
  }
  return added;
}

const scriptKindOf = (fileName) => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
};

/**
 * Per-line comment fragments via the TypeScript lexer: comment trivia is
 * structurally whitespace + comments only, so TSX prose, template
 * literals, and regex literals can never leak into what we judge.
 */
function commentFragments(fileName, source) {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(fileName),
  );
  const pieces = [];
  // Leading trivia is shared by every ancestor of its token — scan each
  // start offset once.
  let lastTriviaFrom = -1;
  const scanTrivia = (from, to) => {
    if (from <= lastTriviaFrom) return;
    lastTriviaFrom = from;
    const trivia = source.slice(from, to);
    for (const m of trivia.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) {
      pieces.push({ pos: from + Number(m.index), text: m[0] });
    }
  };
  const walk = (node) => {
    scanTrivia(node.getFullStart(), node.getStart(file));
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(file, walk);
  scanTrivia(file.endOfFileToken.getFullStart(), file.endOfFileToken.getEnd());

  // Line number from absolute position: count newlines before it.
  return pieces.map(({ pos, text }) => ({
    lineno: 1 + source.slice(0, pos).split('\n').length - 1,
    text,
  }));
}

const audit = (fileName, text, judge) => {
  const hits = [];
  for (const { lineno, text: frag } of commentFragments(fileName, text)) {
    if (!judge(lineno)) continue;
    for (const { re, label } of PATTERNS) {
      const m = frag.match(re);
      // URLs legitimately end in .md — only the citation pattern skips them.
      if (m && label.includes('.md') && frag.slice(0, m.index).includes('://')) continue;
      if (m) hits.push({ lineno, label, snippet: m[0] });
    }
  }
  return hits;
};

const targets = (SCAN_ALL ? [] : changedFiles().filter((f) => isScannable(f.path))).concat(
  SCAN_ALL
    ? execFileSync('git', ['ls-files', ...SCAN_DIRS.map((d) => d.replace(`${ROOT}/`, ''))], {
        cwd: ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)
        .filter((p) => isScannable(join(ROOT, p)))
        .map((p) => ({ path: join(ROOT, p), untracked: false, whole: true }))
    : [],
);

let violations = 0;
const report = [];
for (const { path, untracked, whole } of targets) {
  if (!existsSync(path)) continue;
  const added = untracked || whole ? null : addedLineSet(path);
  const judge = added ? (n) => added.has(n) : () => true;
  for (const hit of audit(path, readFileSync(path, 'utf8'), judge)) {
    violations++;
    const rel = path.replace(`${ROOT}/`, '');
    const lineText = readFileSync(path, 'utf8').split('\n')[hit.lineno - 1] ?? '';
    report.push(`  ${rel}:${hit.lineno}  [${hit.label}]\n    ${lineText.trim()}`);
  }
}

if (violations > 0) {
  console.error(
    [
      `❌ comment-hygiene: ${violations} violation(s) in the current change`,
      '',
      ...report,
      '',
      '  Fix standard — load the docs-quality skill before rewriting:',
      '    .pi/agent/skills/docs-quality/SKILL.md',
      '  No ticket/spec/ADR references, no .md citations, no dated narration,',
      '  no vocabulary lists, no implementation leaks in interface comments.',
      '  Repo-wide audit: node scripts/checks/comment-hygiene.mjs --all',
    ].join('\n'),
  );
  process.exit(1);
}
console.log(`✅ comment-hygiene: ${targets.length} file(s) checked, no violations`);
