'use strict';
// 사용량 한도 — 리셋 시각 읽기 · 기다릴지 판단 · 루프가 기다렸다 같은 세션으로 이어 가고 기다린 시간은 벽시계 상한에서 빼는지. 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const Q = require('../../harness/lib/quota');
const C = require('../../harness/lib/runner-claude');
const L = require('../../harness/lib/loop');
const S = require('../../harness/lib/state');
const R = makeReporter('사용량 한도 — 기다렸다 이어 가기');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-quota-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const MSG = "You've hit your session limit · resets 3:20am (Asia/Seoul)";

(async () => {
  try {
    // QT-01 — 판별 · 리셋 시각
    R.check('[QT-01] 구독 세션 · 주간 한도 문구를 한도로 판별한다(예전엔 충돌로 분류)', C.QUOTA.test(MSG) && C.QUOTA.test('weekly limit reached') && !C.QUOTA.test('TypeError: x is not a function'));
    const now = Date.UTC(2026, 9, 19, 17, 10);   // 서울 02:10
    R.check('[QT-01] "resets 3:20am (Asia/Seoul)" → 서울 시각 기준 70분 뒤 · 이미 지난 시각이면 다음 날', (Q.resetAt(MSG, now) - now) / 60000 === 70 && (Q.resetAt('resets 1:00am (Asia/Seoul)', now) - now) / 60000 === 24 * 60 - 70, String((Q.resetAt(MSG, now) - now) / 60000));
    R.check('[QT-01] "in 2 hours 5 minutes" · "after 90 seconds" · 시각이 없으면 null', Q.resetAt('try again in 2 hours 5 minutes', 0) === 125 * 60000 && Q.resetAt('retry after 90 seconds', 0) === 90000 && Q.resetAt('limit reached', 0) === null);
    // QT-02 — 기다릴지
    const p1 = Q.plan({}, MSG, {}, now), p2 = Q.plan({ quota_waited_ms: 5.5 * 3600000 }, MSG, {}, now), p3 = Q.plan({}, 'limit reached', {}, now), p4 = Q.plan({}, MSG, { off: true }, now), p5 = Q.plan({ quota_unparsed: 6 }, 'limit reached', {}, now);
    R.check('[QT-02] 리셋 + 1분 여유 · 총 대기 상한(6시간)을 넘으면 기다리지 않음 · 시각을 모르면 30분 · 꺼짐 · 모르는 한도가 계속되면 사람에게', p1.waitMs === 71 * 60000 && p1.parsed && p2 === null && p3.waitMs === Q.FALLBACK_MS && !p3.parsed && p4 === null && p5 === null, JSON.stringify({ p1, p2, p3, p4, p5 }));

    // QT-03 — 루프: 첫 호출이 한도 → 기다렸다(가짜 sleep) 같은 메시지로 다시 → done · 기록 · 벽시계 상한에서 대기 시간을 뺀다
    const d = path.join(base, 'r'); fs.mkdirSync(d, { recursive: true });
    git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@x'); git(d, 'config', 'commit.gpgsign', 'false');
    write(path.join(d, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\n```\n'); write(path.join(d, 'check.js'), "console.log('# pass 1\\n# fail 0')\n");
    git(d, 'add', '-A'); git(d, 'commit', '-qm', 'i');
    const prompts = [], slept = [];
    const run = async o => {
      prompts.push(o.prompt);
      if (prompts.length === 1) return { ok: false, is_error: true, error_kind: 'quota', error_message: "You've hit your session limit · try again in 2 hours", session_id: null, final_text: '', cost_usd: 0, permission_denials: [] };
      write(path.join(o.cwd, 'f.js'), '1\n');
      return { ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.01, permission_denials: [] };
    };
    // 벽시계 1분 상한 — 대기(가짜로 2시간)가 상한에서 빠지지 않으면 capped 가 된다
    const t = await L.go({ log: () => {}, root: d, goal: 'make f', run, wallMin: 1, sleep: async ms => { slept.push(ms); } });
    const task = S.readTask(d, t.id);
    const ev = S.readLog ? S.readLog(d, t.id) : [];
    R.check('[QT-03] 한도에 걸리면 리셋까지 기다렸다 같은 메시지로 다시 → done(interrupted 아님)', t.status === 'done' && prompts.length === 2 && prompts[1] === prompts[0] && slept.length === 1 && slept[0] > 60000, JSON.stringify({ status: t.status, reason: t.reason, prompts: prompts.length, slept }));
    R.check('[QT-03] 기다린 시간은 벽시계 상한에서 뺀다(1분 상한 · 대기는 그보다 길어도 capped 아님) · 작업 기록에 대기 횟수 · 시간 · 이벤트', task.quota_waits === 1 && task.quota_waited_ms === slept[0] && (!ev.length || ev.some(e => e.event === 'quota_wait' && e.parsed === true)), JSON.stringify({ waits: task.quota_waits, ms: task.quota_waited_ms, ev: ev.filter(e => e.event === 'quota_wait') }));
    // quota_wait: off — 지금처럼 interrupted
    write(path.join(d, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\nquota_wait: off\n```\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'off');
    const p2s = [];
    const t2 = await L.go({ log: () => {}, root: d, goal: 'make g', run: async o => { p2s.push(1); return { ok: false, is_error: true, error_kind: 'quota', error_message: MSG, session_id: null, final_text: '', cost_usd: 0, permission_denials: [] }; }, sleep: async () => { throw new Error('must not sleep'); } });
    R.check('[QT-03] quota_wait: off 면 기다리지 않고 interrupted(이어 가기는 resume)', t2.status === 'interrupted' && /usage limit/.test(t2.reason) && p2s.length === 1, JSON.stringify({ s: t2.status, r: t2.reason }));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
