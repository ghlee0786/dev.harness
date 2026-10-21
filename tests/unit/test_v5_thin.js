'use strict';
// thin 모드(기본) — 작업 전 기준선 · 린트 · 품질 되돌려 보내기 없이, 끝난 뒤 검사 한 번을 기록만 한다(돌려보내지 않음 · 나빠지면 failed). 모델 호출 없음(가짜 러너).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const L = require('../../harness/lib/loop');
const S = require('../../harness/lib/state');
const R = makeReporter('thin 모드 — 끝난 뒤 검사 한 번 · 기록만');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-thin-'));
process.env.HARNESS_HOME = path.join(base, 'home');   // 사용자 판단 패턴이 지시문에 섞이지 않게
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
// 검사: src/app.js 가 내보내는 값이 2 면 통과. 원래 값(start)으로 시작 상태를 정한다. yaml 은 프로젝트 블록에 더할 줄.
function repo(name, start, yaml = '') {
  const d = path.join(base, name); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  write(path.join(d, 'AGENTS.md'), `# p\n\n\`\`\`yaml\ntest_command: "node check.js"\n${yaml}\`\`\`\n`);
  write(path.join(d, 'check.js'), "const v=require('./src/app.js');const ok=v===2;console.log('# pass '+(ok?1:0)+'\\n# fail '+(ok?0:1));process.exit(ok?0:1);\n");
  write(path.join(d, 'src', 'app.js'), `module.exports = ${start};\n`);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
const setTo = (o, v, extra = '') => write(path.join(o.cwd, 'src', 'app.js'), `${extra}module.exports = ${v};\n`);
const ok = o => ({ ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'done', cost_usd: 0.1, permission_denials: [] });
const events = (root, id) => { try { return fs.readFileSync(S.taskPaths(root, id).logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

(async () => {
  try {
    // TH-01 — 한 턴에 고치면 끝: 기준선은 재지 않고, 검사는 한 번, 지시문에 스스로 테스트하라는 줄
    const r1 = repo('r1', 1); let p1 = '';
    const t1 = await L.go({ ...quiet, root: r1, mode: 'thin', goal: '값을 2 로', run: async o => { p1 = o.prompt; setTo(o, 2); return ok(o); } });
    const k1 = S.readTask(r1, t1.id), checks1 = events(r1, t1.id).filter(e => e.event === 'checks').length;
    R.check('[TH-01] thin · 한 턴에 통과 — done · 기준선 없음 · 검사 1회 · 지시문에 "Test as you go" · 보고에 모드', t1.status === 'done' && k1.mode === 'thin' && !k1.checks.baseline && checks1 === 1 && /Test as you go/.test(p1) && /모드: thin|mode: thin/.test(t1.report || ''),
      JSON.stringify({ s: t1.status, m: k1.mode, b: !!k1.checks.baseline, c: checks1 }));

    // TH-02 — 검사가 실패해도 작업자에게 돌려보내지 않는다(검사는 기록용) — 한 턴으로 끝나고, 실패 출력이 담긴 두 번째 지시가 없다
    const r2 = repo('r2', 1); const msgs2 = [];
    const t2 = await L.go({ ...quiet, root: r2, mode: 'thin', goal: '값을 2 로', run: async o => { msgs2.push(o.prompt); setTo(o, 3); return ok(o); } });
    R.check('[TH-02] thin · 실패해도 돌려보내지 않는다 — 한 턴 · 검사 결과는 기록에', msgs2.length === 1 && S.readTask(r2, t2.id).checks.last && S.readTask(r2, t2.id).checks.last.ok === false, JSON.stringify({ s: t2.status, n: msgs2.length }));

    // TH-03 — 원래 통과하던 검사를 깨뜨리면: 그때만 기준선을 재고(모델 호출 없음) failed — accept 가 막는다
    const r3 = repo('r3', 2); let n3 = 0;
    const t3 = await L.go({ ...quiet, root: r3, mode: 'thin', goal: '값을 바꿔라', run: async o => { n3++; setTo(o, 5 + n3); return ok(o); } });
    const k3 = S.readTask(r3, t3.id);
    R.check('[TH-03] thin · 작업 전보다 나빠지면 failed — 한 턴 · 그때 기준선을 잰다(통과)', t3.status === 'failed' && n3 === 1 && k3.checks.baseline && k3.checks.baseline.ok === true && /worse than before the task/.test(t3.reason || k3.reason), JSON.stringify({ s: t3.status, n: n3, why: k3.reason }));

    // TH-04 — 원래부터 실패하던 검사(작업과 무관): 기준선이 같은 실패 → 나빠지지 않음 → done(한 턴 · 무관한 실패를 고치라고 돌려보내지 않는다)
    const r4 = repo('r4', 0); let n4 = 0;
    const t4 = await L.go({ ...quiet, root: r4, mode: 'thin', goal: 'README 를 더하라', run: async o => { n4++; write(path.join(o.cwd, 'README.md'), `# r ${n4}
`); return ok(o); } });
    const k4 = S.readTask(r4, t4.id);
    R.check('[TH-04] thin · 원래부터 빨간 검사 — 한 턴 · 기준선과 같으면 done(나빠지지 않음)', t4.status === 'done' && n4 === 1 && k4.checks.baseline && k4.checks.baseline.ok === false, JSON.stringify({ s: t4.status, n: n4, why: k4.reason }));

    // TH-05 — 품질 규칙(디버그 흔적)은 보고만 하고 돌려보내지 않는다
    const r5 = repo('r5', 1); let n5 = 0;
    const t5 = await L.go({ ...quiet, root: r5, mode: 'thin', goal: '값을 2 로', run: async o => { n5++; setTo(o, 2, "console.log('debug value');\n"); return ok(o); } });
    const k5 = S.readTask(r5, t5.id);
    R.check('[TH-05] thin · 품질 발견은 보고만 — 한 턴 · done · 기록에 남음 · 돌려보내지 않음', t5.status === 'done' && n5 === 1 && (k5.checks.quality.last || []).length >= 1 && !k5.checks.quality.sent, JSON.stringify({ s: t5.status, n: n5, q: (k5.checks.quality.last || []).length, sent: k5.checks.quality.sent }));

    // TH-06 — 모드 고르기: 기본은 thin · 프로젝트 블록 mode: full 이면 full · 모르는 값은 USAGE
    const r6 = repo('r6', 1, 'mode: full\n');
    const t6 = await L.go({ ...quiet, root: r6, goal: '값을 2 로', run: async o => { setTo(o, 2); return ok(o); } });
    const r7 = repo('r7', 1);
    const t7 = await L.go({ ...quiet, root: r7, goal: '값을 2 로', run: async o => { setTo(o, 2); return ok(o); } });
    let usage = null; try { await L.go({ ...quiet, root: r7, mode: 'shallow', goal: 'x', run: async o => ok(o) }); } catch (e) { usage = e.code; }
    R.check('[TH-06] 모드 — 지정 없으면 thin(기본) · yaml mode: full 이면 full · 모르는 값은 USAGE', S.readTask(r6, t6.id).mode === 'full' && S.readTask(r7, t7.id).mode === 'thin' && usage === 'USAGE',
      JSON.stringify({ a: S.readTask(r6, t6.id).mode, b: S.readTask(r7, t7.id).mode, usage }));
    // TH-07 — [2026-10-21 사용자 지시: 배포 때 기존 세션 작업의 맥락을 놓치지 않게] 갱신 전에 만들어진 작업(기록에 mode 없음)은 이어 가도 예전 방식(full) 그대로
    const Pr = require('../../harness/lib/prompts');
    const old = { id: 't-old', goal: 'g', checks: { source: 'repo', commands: [['node', 'check.js']] }, caps: { budget_usd: 1 }, spent: { cost_usd: 0 } };
    const pOld = Pr.taskPrompt(old, {}), pThin = Pr.taskPrompt({ ...old, mode: 'thin' }, {});
    R.check('[TH-07] mode 가 없는 옛 작업 — thin 줄 없음 · "decides whether you are done"(full 판정) · thin 작업만 thin 지시', !/Test as you go/.test(pOld) && /decides whether you are done/.test(pOld) && /Test as you go/.test(pThin) && /records the result/.test(pThin));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
