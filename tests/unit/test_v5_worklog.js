'use strict';
// 작업 장부(PRD R2) — 이미 한 일을 다시 하지 않고, 이전 작업의 결정 · 결과를 이어받아 그 뒤로 나아간다. 언어 무관(글자 3-gram). 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const W = require('../../harness/lib/worklog');
const L = require('../../harness/lib/loop');
const S = require('../../harness/lib/state');
const R = makeReporter('작업 장부 — 중복 감지 · 맥락 이어 주기');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-worklog-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
function repo() {
  const d = path.join(base, 'r'); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  write(path.join(d, 'AGENTS.md'), '# p\n\n```yaml\ntest_command: "node check.js"\n```\n'); write(path.join(d, 'check.js'), "console.log('# pass 1\\n# fail 0')\n");
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
const ok = o => ({ ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.01, permission_denials: [] });
const workDir = o => path.join(o.cwd, '.harness', /\.harness\/(t-[\w-]+)\//.exec(o.prompt)[1]);

(async () => {
  try {
    // WL-01 — 유사도: 표현만 다른 같은 요청 · 다른 요청 · 한국어 · 영어 · 코드 이름 섞임
    const same1 = W.similarity('이벤트 매핑을 다른 부대로 옮기면 옛 부대에도 알림을 보내라', '이벤트 매핑을 다른 부대로 옮길 때 옛 부대에도 알림을 보내라');
    const same2 = W.similarity('add retry to the HTTP client in shared/mcp_client.py', 'add retries to the http client (shared/mcp_client.py)');
    const diff1 = W.similarity('이벤트 매핑을 다른 부대로 옮기면 옛 부대에도 알림을 보내라', 'ROI 에 is_exclusion 칸을 추가해라');
    const diff2 = W.similarity('add retry to the HTTP client', 'refactor the logging module');
    R.check('[WL-01] 같은 요청(표현만 다름)은 "같은 목표" 기준 이상 · 다른 요청은 "관련" 기준 미만 — 한국어 · 영어 모두', same1 >= W.SAME && same2 >= W.SAME && diff1 < W.RELATED && diff2 < W.RELATED, JSON.stringify({ same1, same2, diff1, diff2 }));

    // WL-02 — 첫 작업: 결정 분기점을 남기고 끝남
    const r = repo();
    const goalA = '설정 저장 방식을 파일에서 데이터베이스로 바꾸고 기존 설정을 옮겨라';
    const t1 = await L.go({ ...quiet, root: r, goal: goalA, run: async o => {
      write(path.join(o.cwd, 'store.js'), 'module.exports = "db";\n');
      write(path.join(workDir(o), 'DECISIONS.md'), '## 1. 저장소 종류\n- options: SQLite, PostgreSQL\n- chosen: SQLite — 단일 PC 앱\n- why: 설치가 없다\n- effect: 바꾸려면 store.js\n');
      return ok(o);
    } });
    R.check('[WL-02] 첫 작업은 관련 이전 작업이 없다(지시문에 블록 없음)', t1.status === 'done' && !(S.readTask(r, t1.id).related || []).length, JSON.stringify(S.readTask(r, t1.id).related));

    // WL-03 — 같은 목표를 다시 보냄: 이전 작업을 알아보고 "다시 하지 말고 확인 · 이어 가라" + 결정 · 바꾼 파일이 맥락으로
    const prompts = [];
    const t2 = await L.go({ ...quiet, root: r, goal: '설정 저장 방식을 파일에서 데이터베이스로 바꾸고, 기존 설정도 옮겨라', run: async o => { prompts.push(o.prompt); return ok(o); } });
    const task2 = S.readTask(r, t2.id);
    const p2 = prompts[0] || '';
    R.check('[WL-03] 같은 목표의 이전 작업을 장부에서 찾는다(kind same · 상태 done)', (task2.related || []).some(x => x.id === t1.id && x.kind === 'same' && x.status === 'done'), JSON.stringify(task2.related));
    R.check('[WL-03] 지시문: 이전 작업 블록 · "처음부터 다시 하지 말고 확인 · 검증 뒤 남은 것만" · 그 작업의 결정(선택) · 바꾼 파일',
      /# Earlier work in this repository/.test(p2) && new RegExp(`This goal looks the same as ${t1.id}`).test(p2) && /Do not start over/.test(p2) && /decision: 저장소 종류 → SQLite/.test(p2) && /files changed: 1 \(store\.js\)/.test(p2), p2.slice(0, 1500));
    R.check('[WL-03] 보고 맨 위 주의에 같은 목표의 이전 작업을 적는다', /주의:.*같은 목표의 이전 작업이 있다/.test(t2.report), t2.report.split('\n').filter(l => /주의/.test(l)).join(' | '));

    // WL-04 — 무관한 작업에는 아무것도 붙지 않는다
    const p3 = [];
    const t3 = await L.go({ ...quiet, root: r, goal: '로그 화면의 글꼴 크기를 키워라', run: async o => { p3.push(o.prompt); return ok(o); } });
    R.check('[WL-04] 무관한 목표에는 이전 작업 블록이 없다', !(S.readTask(r, t3.id).related || []).length && !/Earlier work/.test(p3[0] || ''), JSON.stringify(S.readTask(r, t3.id).related));

    // WL-05 — 사용자가 덧붙인 지시(note)도 그 작업이 "무엇을 했나" 에 들어간다
    L.addNote(r, t3.id, '그리고 오류 로그는 빨간색으로 표시하고 경고는 노란색으로 표시해라');
    const t4task = { id: 't-20990101-000000-ffff', goal: '오류 로그는 빨간색으로, 경고는 노란색으로 표시해라' };
    const rel4 = W.related(r, t4task);
    R.check('[WL-05] 추가 지시(note)의 내용으로도 관련 작업을 찾는다', rel4.some(x => x.id === t3.id), JSON.stringify(rel4));

    // WL-06 — 지시문 블록의 크기 상한
    const big = { id: 'x', related: [{ id: t1.id, score: 0.9, status: 'done', kind: 'same' }, { id: t2.id, score: 0.9, status: 'done', kind: 'same' }, { id: t3.id, score: 0.5, status: 'done', kind: 'related' }] };
    const lines = W.promptLines(r, big);
    R.check('[WL-06] 지시문 블록은 상한(3,500자) 안', lines.join('\n').length <= 3600 && lines.length > 3, String(lines.join('\n').length));
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
