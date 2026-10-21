'use strict';
// 사용 분석(insights) — 프로젝트의 하네스 작업 기록에서 "하네스가 일을 방해한 패턴" 을 규칙으로 찾아 개선 이슈로 올린다.
//   [2026-10-21 사용자 요청] "Thin 모드로 돌다가 발생하는 문제는 모두 issue 로 전달하고, 각 프로젝트의 사용 방식 · 정책 · 로그를 모아 하네스를 개선할 수 있게."
//   읽는 것: <git-common-dir>/harness/tasks/*/task.json · log.jsonl 만(가볍다 — 브랜치 · 코드는 읽지 않는다).
//   내보내는 것: 수치와 분류뿐 — 목표 문장 · 경로 · 코드 · 테스트 출력은 넣지 않는다. 거부된 명령은 첫 두 낱말만, 그것도 가린다(bugreport.sanitize).
//   올리는 길: bugreport.note(kind improve) → autoReport(같은 제목이면 재발 댓글 · 하루 5건 상한 · bug_report: off 면 끈다).
//   자동: update --auto(하루 한 번 백그라운드)가 부른다 — 7일에 한 번 분석하고, 같은 발견은 7일에 한 번만 다시 적는다. insights: off 로 끈다.
const fs = require('node:fs'), path = require('node:path');

const WEEK_MS = 7 * 24 * 3600 * 1000;
const pct = x => `${Math.round(x * 100)}%`;
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// 이유 문장 → 분류(문장 자체는 내보내지 않는다)
const REASON_KINDS = [
  ['pre-existing-failures', /(already fail|pre-?existing|unrelated|원래부터|이미 실패|무관한|기존 실패|baseline)/i],
  ['permission', /(permission|denied|not allowed|권한|거부)/i],
  ['environment', /(install|dependency|missing|not found|cannot find|module|sdk|환경|설치|없다)/i],
  ['spec-conflict', /(contradict|ambiguous|unclear|모순|불명확|명세)/i],
  ['wall-clock', /(wall clock|벽시계|시간 상한)/i],
  ['budget', /(budget|예산|tokens?)/i],
  ['regression', /(worse than before|나빠)/i],
];
const kindOf = r => { for (const [k, re] of REASON_KINDS) if (re.test(String(r || ''))) return k; return 'other'; };
const countBy = xs => xs.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
const fmtCounts = m => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');

function events(root, id) {
  try { return fs.readFileSync(require('./state').taskPaths(root, id).logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
// 끝 검사에 쓴 시간 — 턴이 끝난 기록(turn) 뒤 검사 기록(checks)까지
function checkMs(evs) {
  let total = 0, lastTurn = null;
  for (const e of evs) {
    if (e.event === 'turn') lastTurn = Date.parse(e.at);
    else if (e.event === 'checks' && lastTurn != null) { const d = Date.parse(e.at) - lastTurn; if (d > 0) total += d; lastTurn = null; }
  }
  return total;
}
// 거부된 명령의 머리(첫 두 낱말) — 가린다
function commandHead(d) {
  if (d && d.tool && d.tool !== 'Bash') return String(d.tool).slice(0, 40);   // 파일 · URL 도구는 도구 이름만(경로는 내보내지 않는다)
  const s = String((d && (d.command || d.tool_input && d.tool_input.command || d.input)) || d || '').trim().replace(/["'`]/g, '');
  // 경로 · 변수 · 프로젝트 이름이 섞이지 않게 — 앞의 VAR=값 은 버리고, 실행 파일은 이름만(경로면 <path>), 둘째 낱말은 옵션(-x · --xx) · 짧은 하위 명령만
  const toks = s.split(/\s+/).filter(Boolean); while (toks.length && /^[A-Za-z_][\w]*=/.test(toks[0])) toks.shift();
  if (!toks.length) return '';
  const exe = /[\\/]/.test(toks[0]) || /^[A-Za-z]:/.test(toks[0]) ? '<path>' : /^[A-Za-z][\w.+-]{0,30}$/.test(toks[0]) ? toks[0].replace(/\.(exe|cmd|bat)$/i, '') : '<cmd>';
  const sub = toks[1] && (/^--?[A-Za-z][\w-]{0,20}$/.test(toks[1]) || /^\/\/?[A-Za-z]{1,6}$/.test(toks[1]) || /^[a-z][a-z-]{0,15}$/.test(toks[1])) ? toks[1] : toks[1] ? '<arg>' : '';
  return `${exe}${sub ? ' ' + sub : ''}`;
}

// root → 작업마다 한 줄(분석에 쓰는 것만)
function rows(root, o) {
  const S = require('./state');
  const since = o && o.since ? Date.parse(o.since) : 0;
  return S.listTasks(root).filter(t => !since || Date.parse(t.created_at || 0) >= since).map(t => {
    const evs = events(root, t.id), wall = (t.spent && t.spent.wall_ms) || 0;
    return { id: t.id, mode: t.mode || 'full(<6)', status: t.status, reason_kind: kindOf(t.reason), runtime: t.runtime, wall_ms: wall,
      check_ms: checkMs(evs), turns: t.turns || 0, notes: t.notes_delivered || 0, quota_waits: t.quota_waits || 0,
      denied: (t.denied || []).map(commandHead).filter(Boolean), residue: ((t.outside_git && t.outside_git.untracked_left) || []).length,
      cancelled_after_done: t.status === 'cancelled' && evs.some(e => e.event === 'checks' && e.verdict === 'pass') };
  });
}

// 규칙 — 표본이 작으면 내지 않는다. key 는 바뀌지 않는 이름(같은 문제는 같은 이슈로 묶인다).
function findings(R) {
  const F = [], n = R.length;
  const thin = R.filter(r => r.mode === 'thin');
  const add = (key, title, detail, hint) => F.push({ key, title, detail, hint });
  const rate = (xs, f) => xs.length ? xs.filter(f).length / xs.length : 0;
  if (thin.length >= 3) {
    const bl = thin.filter(r => r.status === 'blocked');
    if (bl.length >= 2 && bl.length / thin.length >= 0.2) add('thin-blocked', 'thin 작업이 BLOCKED 로 끝나는 비율이 높다',
      `thin 작업 ${thin.length}개 중 BLOCKED ${bl.length}개(${pct(bl.length / thin.length)}) · 이유 분류: ${fmtCounts(countBy(bl.map(r => r.reason_kind)))}`,
      '이유 분류가 pre-existing-failures 면 작업자 지시(무관한 기존 실패는 보고만)를, environment 면 .worktreeinclude · 설치 안내를 본다');
    const fl = thin.filter(r => r.status === 'failed');
    if (fl.length >= 2 && fl.length / thin.length >= 0.2) add('thin-failed', 'thin 작업이 failed(작업 전보다 나빠짐 등)로 끝나는 비율이 높다',
      `thin 작업 ${thin.length}개 중 failed ${fl.length}개(${pct(fl.length / thin.length)}) · 이유 분류: ${fmtCounts(countBy(fl.map(r => r.reason_kind)))}`,
      '작업자가 끝내기 전에 관련 테스트를 돌렸는지(PLAN.md 근거) · 회귀 판정이 불안정한 검사 때문인지 본다');
  }
  const timed = R.filter(r => r.wall_ms > 60000 && r.check_ms > 0);
  if (timed.length >= 3) {
    const share = median(timed.map(r => r.check_ms / r.wall_ms));
    if (share >= 0.4) add('check-time-share', '끝 검사가 작업 시간의 큰 몫을 차지한다',
      `검사 시간이 잡힌 작업 ${timed.length}개 · 검사 몫 중앙값 ${pct(share)} · 검사 시간 중앙값 ${Math.round(median(timed.map(r => r.check_ms)) / 60000)}분`,
      'test_command 를 좁히거나(바뀐 영역만) check_timeout_min · serial_checks 를 본다 — 맨 모델은 이 시간을 쓰지 않는다');
  }
  // 거부된 명령 — 한 발견으로 묶는다(명령마다 이슈를 만들지 않게). 3개 작업 이상에서 거부된 머리만.
  const heads = Object.entries(countBy(R.flatMap(r => [...new Set(r.denied)]))).filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
  const withDenied = R.filter(r => r.denied.length).length;
  if (heads.length && withDenied >= 3) add('denied-commands', '작업자 명령이 반복해서 거부된다',
    `거부가 있었던 작업 ${withDenied}개(작업 ${n}개 중 ${pct(withDenied / n)}) · 자주 거부된 것(작업 수): ${heads.slice(0, 10).map(([h, c]) => `\`${h}\` ${c}`).join(' · ')}`,
    '정책이 맞는지(guard · worker_permissions · 도구 허용) 또는 작업자 지시가 그 명령을 피하게 해야 하는지 본다 — 거부 한 번이 작업자의 우회 · 재시도 턴이 된다');
  if (n >= 5) {
    const ca = R.filter(r => r.cancelled_after_done).length;
    if (ca / n >= 0.2 && ca >= 2) add('cancel-after-pass', '검사가 통과한 작업을 사용자가 자주 취소한다',
      `작업 ${n}개 중 ${ca}개(${pct(ca / n)}) — 검사는 통과했지만 받아들이지 않았다`, '검사가 잡지 못하는 요구(범위 · 관례 · 화면)가 있다는 뜻 — 작업자 지시 · 판단 패턴을 본다');
    const nt = rate(R, r => r.notes > 0);
    if (nt >= 0.3) add('mid-task-notes', '사용자가 작업 도중 지시를 자주 덧붙인다',
      `작업 ${n}개 중 ${pct(nt)}에 도중 지시가 있었다`, '목표 해석 · 갈림길 판단(판단 패턴)이 사용자 기대와 어긋나는지 본다');
  }
  const capped = R.filter(r => r.status === 'capped');
  if (capped.length >= 2) add('capped', '작업이 상한(시간 · 예산)에 걸려 끝난다',
    `작업 ${n}개 중 ${capped.length}개 · 분류: ${fmtCounts(countBy(capped.map(r => r.reason_kind)))}`, '상한 기본값 · 큰 작업을 factory 로 나누는 안내를 본다');
  const errs = R.filter(r => r.status === 'error');
  if (errs.length >= 2) add('task-errors', '작업이 error 로 끝난다',
    `작업 ${n}개 중 ${errs.length}개 · 분류: ${fmtCounts(countBy(errs.map(r => r.reason_kind)))}`, '하네스 결함 보고(bugs/)와 함께 본다');
  const res = R.filter(r => r.residue > 0);
  if (res.length >= 2) add('residue', '작업이 끝난 뒤 추적 안 된 파일이 남는다',
    `작업 ${n}개 중 ${res.length}개`, '자원 장부 · outside_git_ok · 작업자 지시(임시 파일은 $TEMP)를 본다');
  return F;
}

function analyze(root, o) {
  const R = rows(root, o);
  return { root, tasks: R.length, by_status: countBy(R.map(r => r.status)), by_mode: countBy(R.map(r => r.mode)), findings: findings(R) };
}

function format(a) {
  const L = [`사용 분석 — 작업 ${a.tasks}개 · 상태: ${fmtCounts(a.by_status) || '없음'} · 모드: ${fmtCounts(a.by_mode) || '없음'}`];
  if (!a.findings.length) L.push('발견: 없음(규칙에 걸린 패턴이 없다)');
  for (const f of a.findings) L.push(`- [${f.key}] ${f.title}`, `    ${f.detail}`, `    볼 곳: ${f.hint}`);
  return L.join('\n') + '\n';
}

// 발견 → 가린 개선 보고(note). 같은 key 는 7일에 한 번만 다시 적는다.
function stateFile(root) { return path.join(require('./state').paths(root).harnessDir, 'insights.json'); }
function readState(root) { try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return { noted: {} }; } }
function writeState(root, s) { try { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), JSON.stringify(s, null, 2)); } catch { /* 기록 실패는 무시 */ } }
function noteFindings(root, a, o) {
  const B = require('./bugreport'), st = readState(root), now = (o && o.now) || Date.now(), noted = [];
  st.noted = st.noted || {};
  for (const f of a.findings) {
    if (st.noted[f.key] && now - st.noted[f.key] < WEEK_MS) continue;
    B.note(root, 'improve', `[insights] ${f.title}`, [`사용 분석이 찾은 패턴(수치와 분류만 — 목표 · 경로 · 코드는 없다).`, '',
      `- 발견: ${f.detail}`, `- 표본: 작업 ${a.tasks}개 · 모드 ${fmtCounts(a.by_mode)}`, `- 볼 곳: ${f.hint}`].join('\n'));
    st.noted[f.key] = now; noted.push(f.key);
  }
  st.last_run = now; writeState(root, st);
  return noted;
}
function enabled(root) {
  const v = String(process.env.HARNESS_INSIGHTS || '').toLowerCase();
  if (/^(off|0|false|no)$/.test(v)) return false;
  try { if (/^(off|false|no)$/i.test(require('./checks').yamlString(root, 'insights') || '')) return false; } catch { /* 블록 없음 */ }
  return true;
}
// update --auto 가 부른다: 7일에 한 번 — 분석 · 적기 · 올리기(올리기는 bug_report 설정을 따른다)
async function auto(root, o) {
  if (!enabled(root)) return { skipped: 'disabled' };
  const st = readState(root), now = (o && o.now) || Date.now();
  if (st.last_run && now - st.last_run < WEEK_MS) return { skipped: 'recent' };
  const a = analyze(root, { since: new Date(now - 4 * WEEK_MS).toISOString() });
  const noted = noteFindings(root, a, o);
  const posted = noted.length ? await require('./bugreport').autoReport(root, o).catch(() => ({ posted: [] })) : { posted: [] };
  return { skipped: null, findings: a.findings.length, noted, posted: posted.posted || [] };
}

module.exports = { analyze, format, findings, rows, noteFindings, auto, enabled, kindOf, WEEK_MS };
