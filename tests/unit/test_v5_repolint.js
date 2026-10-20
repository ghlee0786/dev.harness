'use strict';
// 저장소 린트(품질 규칙 repo-lint) — 저장소가 설정한 린터로 작업이 새로 만든 위반만 찾는다. 원래 있던 위반 · 고치지 않은 줄은 내지 않는다.
//   [2026-10-20 실측 · 평가 main1] 하네스 쪽이 ruff 위반을 맨 모델보다 7배 남겼다(대부분 E501 — 긴 한글 주석). 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const RL = require('../../harness/lib/repolint');
const Q = require('../../harness/lib/quality');
const Pr = require('../../harness/lib/prompts');
const R = makeReporter('저장소 린트 — 새로 생긴 위반만');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-repolint-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
let n = 0;
function repo(files) {
  const d = path.join(base, `r${n++}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  for (const [f, t] of Object.entries(files)) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return { dir: d, head: git(d, 'rev-parse', 'HEAD') };
}
// 가짜 린터 — 표준 입력의 줄 가운데 30자를 넘는 줄은 LEN, 'BAD' 가 든 줄은 BAD(ruff 의 JSON 모양으로)
const fake = path.join(base, 'fakelint.js');
write(fake, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=[];s.split(/\\r?\\n/).forEach((l,i)=>{if(l.length>30)o.push({code:'LEN',location:{row:i+1},message:'too long'});if(/BAD/.test(l))o.push({code:'BAD',location:{row:i+1},message:'bad'})});console.log(JSON.stringify(o))});\n");
const FAKE = { id: 'fake', exts: /\.py$/i, argv: () => [process.execPath, fake], parse: RL.LINTERS[0].parse };
const BROKEN = { id: 'broken', exts: /\.py$/i, argv: () => [process.execPath, '-e', 'process.exit(3)'], parse: RL.LINTERS[0].parse };
const longLine = 'x = "' + 'a'.repeat(40) + '"';

try {
  // RL-01 — 고친 파일: 원래 긴 줄(안 건드림)은 내지 않고, 새로 더한 긴 줄만 낸다
  const a = repo({ 'm.py': `${longLine}\nok = 1\n` });
  write(path.join(a.dir, 'm.py'), `${longLine}\nok = 1\n${longLine.replace('x', 'y')}\n`);
  const f1 = Q.find(a.dir, a.head, { repoLint: { linters: [FAKE] } }).filter(f => f.rule === 'repo-lint');
  R.check('[RL-01] 새로 더한 줄의 위반만 — 원래 있던 같은 규칙의 위반(1행)은 내지 않는다', f1.length === 1 && f1[0].file === 'm.py' && f1[0].line === 3 && /fake LEN/.test(f1[0].text), JSON.stringify(f1));

  // RL-02 — 규칙별 개수가 늘지 않았으면 더한 줄에 있어도 내지 않는다(긴 줄을 옮기기만 함) · 새 규칙(BAD)은 낸다
  const b = repo({ 'm.py': `${longLine}\nok = 1\n` });
  write(path.join(b.dir, 'm.py'), `ok = 1\n${longLine}\nz = 'BAD'\n`);
  const f2 = Q.find(b.dir, b.head, { repoLint: { linters: [FAKE] } }).filter(f => f.rule === 'repo-lint');
  R.check('[RL-02] 개수가 그대로인 규칙(옮긴 긴 줄)은 내지 않고 새 규칙(BAD)만', f2.length === 1 && /BAD/.test(f2[0].text) && f2[0].line === 3, JSON.stringify(f2));

  // RL-03 — 새 파일(추적 전): 위반 전부가 새것
  const c = repo({ 'keep.txt': 'x\n' });
  write(path.join(c.dir, 'pkg', 'new.py'), `${longLine}\nq = 'BAD'\n`);
  const f3 = Q.find(c.dir, c.head, { repoLint: { linters: [FAKE] } }).filter(f => f.rule === 'repo-lint');
  R.check('[RL-03] 새 파일은 위반 전부를 낸다(경로는 저장소 상대 · / 구분)', f3.length === 2 && f3.every(f => f.file === 'pkg/new.py'), JSON.stringify(f3));

  // RL-04 — 린터가 실패하면(출력을 못 읽음) 조용히 건너뛰고 다른 품질 규칙은 그대로
  write(path.join(c.dir, 'pkg', 'dbg.py'), 'breakpoint()\n');
  const f4 = Q.find(c.dir, c.head, { repoLint: { linters: [BROKEN] } });
  R.check('[RL-04] 린터 실패 → repo-lint 없음 · 다른 규칙(debug)은 남는다', !f4.some(f => f.rule === 'repo-lint') && f4.some(f => f.rule === 'debug'), JSON.stringify(f4.map(f => f.rule)));

  // RL-05 — quality_off: [repo-lint] 로 끈다 · 품질 규칙 목록 · 보고 이름에 있다
  const f5 = Q.find(a.dir, a.head, { off: ['repo-lint'], repoLint: { linters: [FAKE] } });
  R.check('[RL-05] quality_off 로 끄면 돌지 않는다 · RULES · LABEL_KO · LABEL_EN 에 있다', !f5.some(f => f.rule === 'repo-lint') && Q.RULES.includes('repo-lint') && !!Q.LABEL_KO['repo-lint'] && !!Q.LABEL_EN['repo-lint']);

  // RL-06 — 설정 감지: 저장소가 켠 린터만(ruff 설정 · eslint 설치+설정 · .clang-format · go.mod)
  const lin = id => RL.LINTERS.find(l => l.id === id);
  const p1 = repo({ 'pyproject.toml': '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 88\n' }).dir, p0 = repo({ 'pyproject.toml': '[project]\nname = "x"\n' }).dir;
  const e1 = repo({ 'node_modules/eslint/bin/eslint.js': '', 'eslint.config.js': 'module.exports = [];\n' }).dir, e0 = repo({ 'eslint.config.js': 'module.exports = [];\n' }).dir;
  const k1 = repo({ '.clang-format': 'BasedOnStyle: LLVM\n' }).dir;
  R.check('[RL-06] 설정 감지 — ruff([tool.ruff]) · eslint(설치와 설정 둘 다) · clang-format(.clang-format) — 설정 없으면 꺼짐',
    lin('ruff').configured(p1) && !lin('ruff').configured(p0) && lin('eslint').configured(e1) && !lin('eslint').configured(e0) && lin('clang-format').configured(k1) && !lin('clang-format').configured(p1));

  // RL-07 — 작업자 안내: 켜진 린터가 있을 때만 · 품질 검사를 끄면 없다
  const t = { id: 't-x', goal: 'g', worktree: a.dir, checks: { commands: [], quality: { on: true, off: [] } } };
  const RLp = RL.promptLine;
  RL.promptLine = () => 'The repository configures fake: …';
  const on = Pr.taskPrompt(t, {}), off = Pr.taskPrompt({ ...t, checks: { commands: [], quality: { on: true, off: ['repo-lint'] } } }, {});
  RL.promptLine = RLp;
  R.check('[RL-07] 작업 프롬프트에 저장소 린터 안내 — quality_off: [repo-lint] 면 없다', /configures fake/.test(on) && !/configures fake/.test(off));
  R.check('[RL-07b] 린터가 없으면 안내 줄도 없다', RL.promptLine(a.dir, { linters: [] }) === null && /line length/.test(RL.promptLine(a.dir, { linters: [FAKE] })));

  // RL-08 — 실제 ruff(있을 때): 긴 한글 주석은 글자당 두 칸 — 88칸 설정에서 50자 한글 주석이 E501
  const ruff = spawnSync('ruff', ['--version'], { windowsHide: true });
  if (!ruff.error && ruff.status === 0) {
    const r = repo({ 'pyproject.toml': '[tool.ruff]\nline-length = 88\n\n[tool.ruff.lint]\nselect = ["E", "F"]\n', 'app.py': 'x = 1\n' });   // E501 은 ruff 기본 규칙이 아니다 — 평가 저장소처럼 켠다
    write(path.join(r.dir, 'app.py'), `x = 1\n# ${'가'.repeat(50)}\n`);
    const f8 = Q.find(r.dir, r.head, {}).filter(f => f.rule === 'repo-lint');
    R.check('[RL-08] 실제 ruff — 50자 한글 주석(100칸)이 E501 로 잡힌다', f8.some(f => /ruff E501/.test(f.text) && f.line === 2), JSON.stringify(f8));
  } else console.log('  ℹ [RL-08] ruff 가 설치되지 않은 환경 — 실제 ruff 경로는 재지 않았다(가짜 린터 RL-01~05 가 비교 논리를 덮는다)');
} finally {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
R.done();
