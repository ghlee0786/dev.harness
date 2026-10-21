'use strict';
// 사용 분석(insights) — 작업 기록에서 하네스가 일을 방해한 패턴을 규칙으로 찾고, 가린 개선 보고로 적는다. 모델 호출 · 네트워크 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const R = makeReporter('사용 분석 — 패턴 · 가리기 · 7일 간격');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-insights-'));
process.env.HARNESS_BUG_OFFLINE = '1'; process.env.HARNESS_BUG_REPORT = 'off';   // 실제 이슈를 올리지 않는다
const S = require('../../harness/lib/state');
const I = require('../../harness/lib/insights');
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
function repo(name) {
  const d = path.join(base, name); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(d, 'README.md'), '# r\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
let seq = 0;
// 작업 기록 하나: 턴이 끝난 뒤 검사까지 checkMin 분 · 거부 · 이유 · 모드
function task(root, f) {
  const id = `t-20261021-0000${String(seq++).padStart(2, '0')}-abcd`;
  const t = S.newTask({ id, goal: 'SECRET-GOAL 비밀 목표 문장', mode: f.mode, status: f.status, reason: f.reason || '', denied: f.denied || [],
    spent: { cost_usd: 1, tokens: 1000, continuations: 0, wall_ms: (f.wallMin || 10) * 60000 }, notes_delivered: f.notes || 0, created_at: '2026-10-21T00:00:00.000Z' });
  S.writeTask(root, t);
  const t0 = Date.parse('2026-10-21T01:00:00Z');
  const lf = S.taskPaths(root, id).logFile; fs.mkdirSync(path.dirname(lf), { recursive: true });
  fs.writeFileSync(lf, [{ at: new Date(t0).toISOString(), event: 'created', goal: 'SECRET-GOAL' }, { at: new Date(t0 + 60000).toISOString(), event: 'turn', n: 1 },
    { at: new Date(t0 + 60000 + (f.checkMin || 1) * 60000).toISOString(), event: 'checks', verdict: f.verdict || 'pass' }].map(x => JSON.stringify(x)).join('\n') + '\n');
  return id;
}

try {
  const r = repo('proj-secretname');
  // thin 5개: blocked 2(원래부터 실패) · failed 1 · done 2 — 끝 검사가 시간의 절반 이상
  task(r, { mode: 'thin', status: 'blocked', reason: 'the model reported the task cannot be done: 2 tests already fail before the change (unrelated)', wallMin: 10, checkMin: 6 });
  task(r, { mode: 'thin', status: 'blocked', reason: '원래부터 실패하던 무관한 테스트', wallMin: 10, checkMin: 6 });
  task(r, { mode: 'thin', status: 'failed', reason: 'the checks fail and are worse than before the task (1 failing)', wallMin: 10, checkMin: 6, verdict: 'fail' });
  task(r, { mode: 'thin', status: 'done', wallMin: 10, checkMin: 6, denied: [{ tool: 'Bash', command: 'C:\\work\\proj-secretname\\tool.exe --run' }, { tool: 'Bash', command: 'dotnet test C:\\work\\proj-secretname\\Y.csproj' }, { tool: 'PowerShell', command: '$x = 1' }] });
  task(r, { mode: 'thin', status: 'cancelled', wallMin: 10, checkMin: 6, notes: 1, denied: [{ tool: 'Bash', command: 'SECRET_VAR=1 dotnet test src/proj-secretname/X.csproj' }, { tool: 'PowerShell', command: 'Get-Item a' }] });
  task(r, { mode: 'thin', status: 'cancelled', wallMin: 10, checkMin: 6, notes: 1, denied: [{ tool: 'Bash', command: 'dotnet test' }, { tool: 'PowerShell', command: 'ls' }, { tool: 'Write', command: 'C:\\work\\proj-secretname\\a.cs' }] });

  const a = I.analyze(r, {});
  const key = k => a.findings.find(f => f.key === k);
  R.check('[IN-01] thin BLOCKED 비율 — 6개 중 2 · 이유 분류 pre-existing-failures (문장은 내보내지 않음)', key('thin-blocked') && /pre-existing-failures 2/.test(key('thin-blocked').detail) && !/무관한 테스트/.test(key('thin-blocked').detail), JSON.stringify(key('thin-blocked')));
  R.check('[IN-02] 끝 검사 몫 — 중앙값 60%(작업 10분 중 검사 6분)', key('check-time-share') && /60%/.test(key('check-time-share').detail), JSON.stringify(key('check-time-share')));
  const dn = key('denied-commands');
  R.check('[IN-03] 거부된 명령은 한 발견으로 묶고 머리만 — PowerShell 3 · dotnet test 3(앞의 VAR= · 뒤의 경로는 버림) · 1개 작업뿐인 <path> 는 빠짐', dn && /`PowerShell` 3/.test(dn.detail) && /`dotnet test` 3/.test(dn.detail) && !/<path>/.test(dn.detail), dn && dn.detail);
  const all = JSON.stringify(a.findings);   // 밖으로 나가는 것은 발견(수치 · 분류)뿐 — root 경로는 이 PC 안의 표에만
  R.check('[IN-04] 가리기 — 목표 문장 · 저장소 이름 · 경로 · 변수 값이 결과에 없다', !/SECRET|비밀|proj-secretname|C:\\\\work|SECRET_VAR/.test(all), all.slice(0, 300));
  R.check('[IN-05] 검사 통과 뒤 취소(2/6) · 도중 지시(2/6) 패턴', key('cancel-after-pass') && key('mid-task-notes'), JSON.stringify(a.findings.map(f => f.key)));

  // 적기 — bugs/ 에 improve 기록 · 같은 key 는 7일 안에 다시 적지 않는다 · 본문에도 목표 · 이름이 없다
  const noted1 = I.noteFindings(r, a, { now: Date.parse('2026-10-21T00:00:00Z') });
  const noted2 = I.noteFindings(r, a, { now: Date.parse('2026-10-23T00:00:00Z') });
  const noted3 = I.noteFindings(r, a, { now: Date.parse('2026-10-29T00:00:00Z') });
  const bugsDir = path.join(S.paths(r).harnessDir, 'bugs');
  const recs = fs.readdirSync(bugsDir).filter(f => f.endsWith('.json') && f !== 'reported.json').map(f => JSON.parse(fs.readFileSync(path.join(bugsDir, f), 'utf8')));
  R.check('[IN-06] 적기 — 발견마다 improve 기록 · 2일 뒤엔 다시 안 적고 8일 뒤엔 다시(재발 횟수 2)', noted1.length === a.findings.length && noted2.length === 0 && noted3.length === a.findings.length && recs.every(e => e.kind === 'improve' && e.count === 2),
    JSON.stringify({ n1: noted1.length, n2: noted2.length, n3: noted3.length, counts: recs.map(e => e.count) }));
  R.check('[IN-07] 기록 본문에도 목표 · 저장소 이름 · 경로가 없다', recs.every(e => !/SECRET|비밀|proj-secretname|C:\\work/.test(e.message + e.detail)), recs.map(e => e.detail).join(' | ').slice(0, 300));

  // 자동(update --auto) — insights: off 면 끈다 · 7일 안에 다시 돌지 않는다
  (async () => {
    const r2 = repo('proj2'); fs.writeFileSync(path.join(r2, 'AGENTS.md'), '```yaml\ninsights: off\n```\n');
    const off = await I.auto(r2, { now: Date.now() });
    const r3 = repo('proj3'); task(r3, { mode: 'thin', status: 'done' });
    const first = await I.auto(r3, { now: Date.parse('2026-10-21T00:00:00Z') }), again = await I.auto(r3, { now: Date.parse('2026-10-22T00:00:00Z') });
    R.check('[IN-08] 자동 — insights: off 면 끔 · 한 번 돈 뒤 7일 안에는 recent', off.skipped === 'disabled' && first.skipped === null && again.skipped === 'recent', JSON.stringify({ off, first, again }));
    // CLI — 표 · --json
    const cli = (...x) => spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'harness', 'cli.js'), ...x], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: process.env });
    const t = cli('insights', '--root', r), j = cli('insights', '--root', r, '--json');
    let jj = null; try { jj = JSON.parse(j.stdout); } catch { /* 아래 */ }
    R.check('[IN-09] CLI insights — 발견 목록 · --json 에 findings · exit 0', t.status === 0 && /\[denied-commands\]/.test(t.stdout) && jj && jj[0].findings.length === a.findings.length, `${t.status} ${t.stderr.slice(0, 200)}`);
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ }
    R.done();
  })().catch(e => { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); R.done(); });
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); R.done(); }
