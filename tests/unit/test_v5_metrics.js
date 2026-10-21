'use strict';
// 작업 수치 — 작업 기록에서 비용 · 계획 · 시험 · 품질 · 찌꺼기 · 안전 수치를 결정적으로 계산하고, 저장소 여러 개를 모아 비교한다. 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const M = require('../../harness/lib/metrics');
const L = require('../../harness/lib/loop');
const R = makeReporter('작업 수치 — 비용 · 계획 · 시험 · 품질 · 찌꺼기');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-metrics-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {}, mode: 'full', eagerBaseline: true };   // 기준선 수치(MT-03) · 품질 되돌려 보내기(MT-04)는 full 모드에서만
const ok = o => ({ ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'done', cost_usd: 0.5, permission_denials: [] });
function repo(name) {
  const d = path.join(base, name); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  write(path.join(d, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\n```\n');
  write(path.join(d, 'check.js'), "const fs=require('fs');const n=fs.readdirSync('test').length;console.log('# pass '+n+'\\n# fail 0');\n");
  write(path.join(d, 'test', 'a.test.js'), '// a\n'); write(path.join(d, 'src', 'app.js'), 'module.exports = 1;\n');
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
const workDir = o => path.join(o.cwd, '.harness', /\.harness\/(t-[\w-]+)\//.exec(o.prompt)[1]);

(async () => {
  try {
    const r = repo('r1');
    // 작업 1: 계획 4항목 중 3 완료 · 테스트 파일 추가 · 디버그 흔적(품질 규칙이 잡는다) · 하네스 로그 파일은 테스트가 아니다
    const t1 = await L.go({ ...quiet, root: r, goal: '가격 계산 기능을 더하라', run: async o => {
      const w = workDir(o);
      write(path.join(w, 'PLAN.md'), '# 계획\n- [x] 설계\n- [x] 구현\n- [x] 시험\n- [ ] 문서\n');
      write(path.join(w, 'logs', 'r1-App.Tests.txt'), 'log\n');
      write(path.join(o.cwd, 'test', 'price.test.js'), '// price\n');
      write(path.join(o.cwd, 'src', 'price.js'), "function price(x) {\n  console.log('debug', x);\n  return x * 2;\n}\nmodule.exports = { price };\n");
      return ok(o);
    } });
    const c = M.collect(r, {});
    const m1 = c.tasks.find(t => t.id === t1.id);
    R.check('[MT-01] 작업 하나의 수치 — 모양(schema) · 비용 · 턴 · 결과', m1 && m1.schema === M.SCHEMA && m1.cost_usd > 0 && m1.turns >= 1 && ['done'].includes(m1.outcome) && m1.project === 'r1', JSON.stringify(m1 && { s: m1.status, o: m1.outcome, c: m1.cost_usd, t: m1.turns }));
    R.check('[MT-02] 계획성 — 결과 브랜치의 PLAN.md 에서 항목 4 · 완료 3 (worktree 가 지워져도)', m1.plan_found && m1.plan_items === 4 && m1.plan_done === 3 && m1.plan_done_ratio === 0.75, JSON.stringify({ f: m1.plan_found, i: m1.plan_items, d: m1.plan_done }));
    R.check('[MT-03] 시험 — 추가한 테스트 1(하네스 로그 …Tests.txt 는 빼고) · 테스트 수 1 → 2', m1.tests_added === 1 && m1.baseline_total === 1 && m1.final_total === 2 && m1.test_count_delta === 1, JSON.stringify({ a: m1.tests_added, b: m1.baseline_total, f: m1.final_total }));
    R.check('[MT-04] 품질 — 처음 발견(디버그 흔적)을 세고 · 돌려보냈다고 적는다 · 잰 작업으로 표시', m1.quality_measured && m1.quality_first >= 1 && m1.quality_sent_back === true, JSON.stringify({ m: m1.quality_measured, q: m1.quality_first, s: m1.quality_sent_back, r: m1.quality_rules }));
    R.check('[MT-05] 찌꺼기 — 자원 장부가 남은 것 0 · 추적 안 된 파일 0', m1.residue === 0 && m1.untracked_left === 0, JSON.stringify({ r: m1.residue, u: m1.untracked_left }));
    R.check('[MT-06] 하네스 본체: 하네스 로그 파일은 추가한 테스트가 아니다(task.tests_added)', !(require('../../harness/lib/state').readTask(r, t1.id).tests_added || []).some(f => f.startsWith('.harness/')));

    // MT-07 — 측정 전 판의 기록(품질 규칙 · 자원 장부 없음)은 0 이 아니라 null · 요약은 잰 작업만으로
    const legacy = { id: 't-20260101-000000-aaaa', status: 'done', reason: '', created_at: '2026-01-01T00:00:00Z', spent: { cost_usd: 3, wall_ms: 60000, tokens: 10 }, turns: 1, diff: { insertions: 1000, deletions: 0 }, checks: { baseline: { pass: 5, fail: 0 }, last: { pass: 5, fail: 1 } } };
    const ml = M.taskMetrics(r, legacy, { plan: false });
    const sum = M.summarize({ project: 'x', tasks: [ml, m1], factories: [] });
    R.check('[MT-07] 측정 전 기록 — 품질 · 찌꺼기는 null · 요약의 1천 줄당 품질은 잰 작업(1개)만으로 · 회귀 1(실패 0 → 1)',
      ml.quality_first === null && ml.residue === null && sum.quality_measured === 1 && sum.residue_measured === 1 && sum.regressions === 1, JSON.stringify({ q: ml.quality_first, r: ml.residue, qm: sum.quality_measured, rm: sum.residue_measured, reg: sum.regressions }));

    // MT-08 — 공장 실행 수치(run.json 모양)
    const run = { id: 'f-20261020-000000-abcd', status: 'done', jobs: 3, spent_usd: 4.5, plan_cost_usd: 0.4, created_at: '2026-10-20T00:00:00Z', finished_at: '2026-10-20T00:30:00Z',
      cards: [{ id: 'c1', status: 'merged', attempts: 1, task_ids: ['t1'] }, { id: 'c2', status: 'merged', attempts: 2, task_ids: ['t2', 't3'] }, { id: 'c3', status: 'failed', attempts: 2, task_ids: ['t4'] }],
      serialized: ['c2'], verify: { cost_usd: 1.2, task_ids: ['t9'], stop_reason: 'yield', waves: [{ wave: 1, charters: [1, 2, 3], testers: 3, found: 4, confirmed: 2, yield: 0.5 }, { wave: 2, charters: [1, 2], testers: 2, found: 1, confirmed: 0, yield: 0 }] } };
    const fm = M.factoryMetrics(r, run);
    R.check('[MT-08] 공장 — 카드 3(합류 2 · 실패 1 · 첫 시도 합류 1) · 시험 차터 5 · 발견 5 · 확인 2 · 수정 1 · 시간 30분 · 에이전트 수',
      fm.cards === 3 && fm.cards_merged === 2 && fm.cards_failed === 1 && fm.first_try_merges === 1 && fm.charters === 5 && fm.found === 5 && fm.confirmed === 2 && fm.fixes === 1 && fm.wall_min === 30 && fm.agents === 1 + 4 + 2 + 5 + 1,
      JSON.stringify(fm));

    // MT-09 — CLI: 여러 저장소를 모아 표 · JSONL
    const r2 = repo('r2');
    const out = path.join(base, 'm.jsonl');
    const cli = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'harness', 'cli.js'), 'metrics', '--roots', `${r};${r2}`, '--jsonl', out], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
    R.check('[MT-09] CLI metrics --roots a;b — 표(두 저장소 열) · JSONL(작업마다 한 줄 · kind task) · GS 품질 특성 표', cli.status === 0 && /\| 지표 \| r1 \| r2 \|/.test(cli.stdout) && lines.length === 1 && lines[0].kind === 'task' && /유지보수성/.test(cli.stdout), `${cli.status} ${cli.stderr.slice(0, 200)} ${lines.length}`);
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
