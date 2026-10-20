'use strict';
// 저장소 린트(품질 규칙 repo-lint) — 저장소가 설정해 둔 린터 · 포매터로, 작업이 바꾼 파일에서 **새로 생긴 위반만** 찾는다.
//   [2026-10-20 실측 · 평가 main1] 하네스 쪽(D)이 맨 모델(A)보다 ruff 위반을 7배 남겼다(28 대 4) — 34/38 이 E501(줄 길이).
//   저장소의 규칙(pyproject 의 line-length 등)을 작업자가 모른 채 긴 한글 주석을 썼다. 판정은 저장소 자신의 도구가 한다(모델이 쓴 검사가 아니다).
//   비교: 같은 파일의 작업 전 내용(git show base:파일)과 지금 내용을 같은 린터에 표준 입력으로 넣어 — 설정은 파일 경로로 찾는다 — 규칙별 개수가
//   늘어난 규칙의 위반 중 이번에 더한 줄에 있는 것만 낸다. 원래 있던 위반은 건드리지 않게 한다(범위 밖 수정을 부르지 않는다).
//   린터가 없거나(설치 · 설정) 실패하면 조용히 건너뛴다 — 없는 도구를 요구하지 않는다.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');

const readText = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
const has = (root, ...names) => names.some(n => fs.existsSync(path.join(root, n)));
const parseJson = s => { try { return JSON.parse(s || ''); } catch { return null; } };

// 린터 하나 = 이 저장소에서 켜졌는가(설정) · 무엇을 보는가(확장자) · 표준 입력으로 돌리는 명령 · 출력 → [{ code, line, message }](null 이면 실패)
const LINTERS = [
  { id: 'ruff', exts: /\.pyi?$/i,
    configured: root => has(root, 'ruff.toml', '.ruff.toml') || /^\s*\[tool\.ruff\b/m.test(readText(root, 'pyproject.toml')),
    argv: f => ['ruff', 'check', '--output-format', 'json', '--no-cache', '--exit-zero', '--stdin-filename', f, '-'],
    parse: r => { const j = parseJson(r.stdout); return Array.isArray(j) ? j.map(v => ({ code: v.code || 'syntax', line: (v.location || {}).row || 0, message: v.message })) : null; } },
  { id: 'eslint', exts: /\.(js|mjs|cjs|jsx|ts|tsx|vue)$/i,
    configured: root => has(root, 'node_modules/eslint/bin/eslint.js') && (has(root, 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml') || /"eslintConfig"\s*:/.test(readText(root, 'package.json'))),
    argv: f => [process.execPath, 'node_modules/eslint/bin/eslint.js', '--format', 'json', '--stdin', '--stdin-filename', f],
    parse: r => { const j = parseJson(r.stdout); return Array.isArray(j) ? j.flatMap(x => (x.messages || []).map(m => ({ code: m.ruleId || 'parse', line: m.line || 0, message: m.message }))) : null; } },
  { id: 'gofmt', exts: /\.go$/i,
    configured: root => has(root, 'go.mod'),
    argv: () => ['gofmt', '-l'],
    parse: r => r.status === 0 ? (r.stdout.trim() ? [{ code: 'gofmt', line: 0, message: 'not gofmt-formatted — run gofmt' }] : []) : null },
  { id: 'clang-format', exts: /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i,
    configured: root => has(root, '.clang-format', '_clang-format'),
    argv: f => ['clang-format', '--dry-run', `--assume-filename=${f}`],
    parse: r => r.error ? null : [...String(r.stderr || '').matchAll(/:(\d+):\d+: (?:warning|error): (.*?) \[-Wclang-format-violations\]/g)].map(m => ({ code: 'clang-format', line: Number(m[1]), message: m[2] })) },
];

const available = new Map();
function runs(argv0) {
  if (argv0 === process.execPath) return true;
  if (!available.has(argv0)) { const r = spawnSync(argv0, ['--version'], { windowsHide: true, timeout: 10000 }); available.set(argv0, !r.error && r.status === 0); }
  return available.get(argv0);
}
// 이 저장소에서 쓸 린터들 — o.linters 로 갈아 끼울 수 있다(테스트)
function linters(root, o) { return (o && o.linters) || LINTERS.filter(l => l.configured(root) && runs(l.argv('x')[0])); }

function lintText(root, l, file, text) {
  const argv = l.argv(file);
  const r = spawnSync(argv[0], argv.slice(1), { cwd: root, input: text, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return r.error && r.error.code === 'ETIMEDOUT' ? null : l.parse(r);
}

// → [{ rule: 'repo-lint', file, line, text }] — files: 바뀐 파일(저장소 상대) · added: 파일 → 더한 줄 번호 Set · baseText(file) → 작업 전 내용(없던 파일이면 null)
function find(root, files, added, baseText, o) {
  const ls = linters(root, o), out = [];
  if (!ls.length) return out;
  for (const f of files.slice(0, 30)) {
    const l = ls.find(x => x.exts.test(f)); if (!l) continue;
    let now; try { now = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const after = lintText(root, l, f, now); if (!after) continue;
    const old = baseText(f), before = old == null ? [] : lintText(root, l, f, old); if (!before) continue;
    const count = list => list.reduce((m, v) => m.set(v.code, (m.get(v.code) || 0) + 1), new Map());
    const cb = count(before), ca = count(after), lines = added.get(f);
    for (const v of after) {
      if (!(ca.get(v.code) > (cb.get(v.code) || 0))) continue;
      if (v.line && lines && !lines.has(v.line)) continue;   // 늘어난 규칙이라도 원래 있던 줄의 위반은 내지 않는다
      out.push({ rule: 'repo-lint', file: f, line: v.line, text: `${l.id} ${v.code}: ${String(v.message || '').slice(0, 100)}` });
    }
  }
  return out;
}

// 작업자 안내 한 줄 — 켜진 린터가 있을 때만
function promptLine(root, o) {
  const ls = linters(root, o);
  return ls.length ? `The repository configures ${ls.map(l => l.id).join(' · ')}: the harness lints the lines you add with it and sends new violations back — follow its rules (line length included; wide characters such as Korean count as two columns).` : null;
}

module.exports = { find, promptLine, linters, LINTERS };
