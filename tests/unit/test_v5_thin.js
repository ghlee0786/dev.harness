'use strict';
// thin 모드(기본) — 작업 전 기준선 · 린트 · 품질 되돌려 보내기 · 끝 검사 없이 끝낸다. 검사는 accept 가(나빠졌으면 막는다) · 미리 보기는 check <id>. 모델 호출 없음(가짜 러너).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const L = require('../../harness/lib/loop');
const S = require('../../harness/lib/state');
const R = makeReporter('thin 모드 — 끝 검사는 accept 때 · 회귀는 accept 가 막는다');

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
    // TH-01 — thin 은 끝 검사를 미룬다: 검사 0회 · 기준선 없음 · done · 보고에 "accept 때" 와 미리 보기 명령 · 지시문에 스스로 테스트
    const r1 = repo('r1', 1); let p1 = '';
    const t1 = await L.go({ ...quiet, root: r1, mode: 'thin', goal: '값을 2 로', run: async o => { p1 = o.prompt; setTo(o, 2); return ok(o); } });
    const k1 = S.readTask(r1, t1.id), checks1 = events(r1, t1.id).filter(e => e.event === 'checks').length;
    R.check('[TH-01] thin · 끝 검사 없이 done — 검사 0회 · 기준선 없음 · 미룬 표시 · 보고에 accept 때 · 지시문 "Test as you go" · "run when your work is accepted"', t1.status === 'done' && k1.mode === 'thin' && !k1.checks.baseline && checks1 === 0 && k1.checks.deferred === true && !k1.checks.last
      && /accept/.test(t1.report || '') && /check t-/.test(t1.report || '') && /Test as you go/.test(p1) && /when your work is accepted/.test(p1),
      JSON.stringify({ s: t1.status, m: k1.mode, c: checks1, d: k1.checks.deferred, why: k1.reason }));

    // TH-02 — 작업자가 검사를 깨뜨려도 작업 중에는 돌려보내지 않는다 — 한 턴 · done(검사는 accept 때)
    const r2 = repo('r2', 1); const msgs2 = [];
    const t2 = await L.go({ ...quiet, root: r2, mode: 'thin', goal: '값을 2 로', run: async o => { msgs2.push(o.prompt); setTo(o, 3); return ok(o); } });
    R.check('[TH-02] thin · 작업 중엔 검사도 돌려보내기도 없다 — 한 턴 · done · 검사 기록 없음', t2.status === 'done' && msgs2.length === 1 && !S.readTask(r2, t2.id).checks.last, JSON.stringify({ s: t2.status, n: msgs2.length }));

    // TH-03 — 원래 통과하던 검사를 깨뜨린 작업: accept 가 처음 재고, 기준선(통과)보다 나빠졌으니 막는다 · main 그대로
    const I = require('../../harness/lib/integrate');
    const r3 = repo('r3', 2); let n3 = 0;
    const t3 = await L.go({ ...quiet, root: r3, mode: 'thin', goal: '값을 바꿔라', run: async o => { n3++; setTo(o, 5 + n3); return ok(o); } });
    const main3 = git(r3, 'rev-parse', 'main');
    const a3 = await I.accept({ root: r3, id: t3.id, log: () => {} });
    const k3 = S.readTask(r3, t3.id);
    R.check('[TH-03] thin · 회귀는 accept 가 막는다 — 작업은 done(한 턴) · accept 거절(나빠짐) · 그때 기준선(통과) · main 그대로', t3.status === 'done' && n3 === 1 && a3.refused === true && /worse than before the task/.test(a3.reason) && k3.checks.baseline && k3.checks.baseline.ok === true && git(r3, 'rev-parse', 'main') === main3,
      JSON.stringify({ s: t3.status, n: n3, refused: a3.refused, why: String(a3.reason).slice(0, 160) }));

    // TH-04 — 원래부터 실패하던 검사(작업과 무관): accept 가 재고 기준선과 같은 실패 → 나빠지지 않음 → 합친다
    const r4 = repo('r4', 0); let n4 = 0;
    const t4 = await L.go({ ...quiet, root: r4, mode: 'thin', goal: 'README 를 더하라', run: async o => { n4++; write(path.join(o.cwd, 'README.md'), `# r ${n4}\n`); return ok(o); } });
    const a4 = await I.accept({ root: r4, id: t4.id, log: () => {} });
    const k4 = S.readTask(r4, t4.id);
    R.check('[TH-04] thin · 원래부터 빨간 검사 — accept 가 재고 기준선과 같으니 합친다(나빠지지 않음)', t4.status === 'done' && n4 === 1 && a4.status === 'accepted' && k4.checks.baseline && k4.checks.baseline.ok === false && fs.existsSync(path.join(r4, 'README.md')),
      JSON.stringify({ s: t4.status, n: n4, a: a4.status, why: String(a4.reason).slice(0, 160) }));

    // TH-08 — check <id>: 합치지 않고 지금 재서 기록 — 회귀면 check-failed · 그 뒤 accept 도 막는다 · CLI exit 1
    const r8 = repo('r8', 2);
    const t8 = await L.go({ ...quiet, root: r8, mode: 'thin', goal: '값을 바꿔라', run: async o => { setTo(o, 9); return ok(o); } });
    const c8 = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'harness', 'cli.js'), 'check', t8.id, '--root', r8], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const k8 = S.readTask(r8, t8.id);
    const a8 = await I.accept({ root: r8, id: t8.id, log: () => {} });
    R.check('[TH-08] check <id> — 지금 재서 기록(fail · 기준선 통과) · CLI exit 1 · 보고 "pilot <id> — CHECKS: fail" · 그 뒤 accept 거절', c8.status === 1 && /CHECKS: fail|검사: fail/.test(c8.stdout) && k8.checks.last && k8.checks.last.ok === false && k8.checks.verdict === 'fail' && a8.refused === true,
      JSON.stringify({ st: c8.status, out: c8.stdout.slice(0, 200), err: c8.stderr.slice(0, 200), v: k8.checks.verdict, a: a8.refused }));

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
    R.check('[TH-07] mode 가 없는 옛 작업 — thin 줄 없음 · "decides whether you are done"(full 판정) · thin 작업만 thin 지시', !/Test as you go/.test(pOld) && /decides whether you are done/.test(pOld) && /Test as you go/.test(pThin) && /when your work is accepted/.test(pThin));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
