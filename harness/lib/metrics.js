'use strict';
// 작업 수치(성적) — 하네스가 이미 남기는 기록(task.json · log.jsonl · 결과 브랜치의 PLAN.md · 공장 run.json)에서 작업마다 같은 모양의 수치를 계산한다.
//   [2026-10-20 사용자 요청] 설치된 프로젝트들에서 작업의 비용 · 에이전트 효율 · 계획성 · 시나리오 시험 · 찌꺼기 정리 · 린트/클린 코드 · 품질(GS 인증 관점)을
//   수치로 뽑아 프로젝트 사이를 비교 · 분석할 수 있게. 판정은 기록에서 결정적으로 계산한다(모델이 매기지 않는다) — 지난 작업까지 소급된다.
//   밖으로 보내지 않는다: 각 프로젝트의 .git/harness 를 읽어 이 PC 에서만 모은다.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCHEMA = 1;
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readLog = f => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const total = b => (b ? num(b.pass) + num(b.fail) : null);
const HARNESS_PATH = /^\.harness\//;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|[._-](test|spec)s?\.[a-z]+$|Tests?\.[a-z]+$|_test\.go$/i;

function commonDir(root) { const out = git(root, ['rev-parse', '--git-common-dir']); return out ? path.resolve(root, out.trim()) : path.join(root, '.git'); }

// PLAN.md 의 체크 항목 — 결과 브랜치(없으면 마지막 커밋)에서 읽는다(worktree 는 지워졌을 수 있다)
function planOf(root, t) {
  const rel = `.harness/${t.id}/PLAN.md`;
  const refs = [t.branch, ...(t.commits || []).slice().reverse(), t.head].filter(Boolean);
  for (const ref of refs) {
    const text = git(root, ['show', `${ref}:${rel}`]);
    if (text == null) continue;
    const items = [...text.matchAll(/^\s*[-*]\s+\[( |x|X)\]/gm)];
    return { found: true, items: items.length, done: items.filter(m => /x/i.test(m[1])).length };
  }
  return { found: false, items: 0, done: 0 };
}

// 사유를 종류로(보고서에서 묶어 보려고)
function reasonKind(t) {
  const r = String(t.reason || '');
  if (t.status === 'done' || t.status === 'accepted') return 'done';
  if (/limit|quota|한도/i.test(r)) return 'quota';
  if (/timed out|timeout|cap|상한/i.test(r) || t.status === 'capped') return 'cap';
  if (/same .* twice|stalled/i.test(r) || t.status === 'stalled') return 'stalled';
  if (t.status === 'blocked') return 'blocked';
  if (t.status === 'cancelled') return 'cancelled';
  return t.status || 'unknown';
}

// → 작업 하나의 수치(같은 모양 · SCHEMA)
function taskMetrics(root, t, o) {
  const ev = o && o.events ? o.events : [];
  const ch = t.checks || {};
  const q = (ch.quality && ch.quality.last) || [];
  const byRule = {};
  for (const f of q) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  const dupLeft = ((ch.dup && ch.dup.last) || []).length;
  const qualitySent = !!((ch.quality && ch.quality.sent) || (ch.dup && ch.dup.sent));
  const qualityEv = ev.filter(e => e.event === 'quality');
  const firstQ = qualityEv[0] ? (num(qualityEv[0].dup) + Object.values(qualityEv[0].rules || {}).reduce((a, b) => a + num(b), 0)) : null;
  const diff = t.diff || {};
  const lines = num(diff.insertions) + num(diff.deletions);
  const testsAdded = (t.tests_added || []).filter(f => !HARNESS_PATH.test(f) && TEST_PATH.test(f));
  const testsModified = (t.tests_modified || []).filter(f => !HARNESS_PATH.test(f));
  const bt = total(ch.baseline), ft = total(ch.last);
  const plan = o && o.plan === false ? { found: false, items: 0, done: 0 } : planOf(root, t);
  // 측정 전 판(자원 장부 · 품질 규칙이 없던 작업)은 0 이 아니라 null — 요약은 잰 작업만으로 계산하고 몇 개인지 적는다
  const residue = t.resources && Array.isArray(t.resources.residue) ? t.resources.residue.length : null;
  const qMeasured = qualityEv.length > 0;
  const og = t.outside_git || {};
  const spent = t.spent || {};
  return {
    schema: SCHEMA, project: path.basename(path.resolve(root)), id: t.id, created_at: t.created_at || null, updated_at: t.updated_at || null,
    status: t.status, outcome: reasonKind(t), accepted: !!(t.accepted_at || t.status === 'accepted'), factory: t.factory || null,
    runtime: t.runtime || null, model: t.model || null, language: t.language || null,
    // 비용 · 효율
    cost_usd: Math.round(num(spent.cost_usd) * 1000) / 1000, tokens: num(spent.tokens), wall_min: Math.round(num(spent.wall_ms) / 600) / 100,
    turns: num(t.turns), continuations: num(spent.continuations), cost_per_100_lines: lines ? Math.round(num(spent.cost_usd) / lines * 100 * 100) / 100 : null,
    // 변경 규모
    files_changed: num(t.files_changed), insertions: num(diff.insertions), deletions: num(diff.deletions), added_files: num(diff.added_files),
    // 계획성
    plan_found: plan.found, plan_items: plan.items, plan_done: plan.done, plan_done_ratio: plan.items ? Math.round(plan.done / plan.items * 100) / 100 : null,
    decisions: (t.decisions || []).length, notes: num(t.notes_delivered),
    // 시험
    tests_added: testsAdded.length, tests_modified: testsModified.length, checks_source: ch.source || null,
    baseline_total: bt, baseline_fail: ch.baseline ? num(ch.baseline.fail) : null, final_total: ft, final_fail: ch.last ? num(ch.last.fail) : null,
    test_count_delta: bt != null && ft != null ? ft - bt : null, verdict: ch.verdict || null, checks_dropped: (ch.dropped || []).length, tests_hung: (ch.hung || []).length,
    // 린트 · 클린 코드(품질 규칙) — 처음 발견 수(돌려보내기 전) · 끝에 남은 수
    quality_measured: qMeasured, quality_first: qMeasured ? firstQ : null, quality_left: qMeasured ? q.length + dupLeft : null, quality_sent_back: qualitySent, quality_rules: byRule, dup_left: dupLeft, repo_lint_left: byRule['repo-lint'] || 0,
    // 찌꺼기 정리
    residue, untracked_left: (og.untracked_left || []).length, ignored_changed: (og.ignored_changed || []).length,
    debug_left: byRule.debug || 0, todo_left: byRule.todo || 0, commented_left: byRule.commented || 0,
    // 안전
    denied: (t.denied || []).length, checks_modified: (t.checks_modified || []).length, test_weaken_left: byRule['test-weaken'] || 0, hardcoded_left: byRule.hardcoded || 0,
  };
}

// → 공장 실행 하나의 수치
function factoryMetrics(root, run) {
  const cards = run.cards || [];
  const V = run.verify || {};
  const waves = V.waves || [];
  const startedAt = Date.parse(run.created_at), endedAt = Date.parse(run.finished_at || run.updated_at);
  const wallMin = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? (endedAt - startedAt) / 60000 : null;
  return {
    schema: SCHEMA, project: path.basename(path.resolve(root)), id: run.id, created_at: run.created_at || null, status: run.status, jobs: num(run.jobs),
    cost_usd: Math.round(num(run.spent_usd) * 1000) / 1000, plan_cost_usd: num(run.plan_cost_usd), verify_cost_usd: num(V.cost_usd), wall_min: wallMin == null ? null : Math.round(wallMin * 100) / 100,
    cards: cards.length, cards_merged: cards.filter(c => c.status === 'merged').length, cards_failed: cards.filter(c => /fail|error|blocked/.test(String(c.status))).length,
    first_try_merges: cards.filter(c => c.status === 'merged' && num(c.attempts) <= 1).length, serialized: (run.serialized || []).length,
    agents: 1 + cards.reduce((a, c) => a + ((c.task_ids || []).length || 1), 0) + waves.length + waves.reduce((a, w) => a + num(w.testers || (w.charters || []).length), 0) + (V.task_ids || []).length,
    waves: waves.length, charters: waves.reduce((a, w) => a + (w.charters || []).length, 0), found: waves.reduce((a, w) => a + num(w.found), 0),
    confirmed: waves.reduce((a, w) => a + num(w.confirmed), 0), fixes: (V.task_ids || []).length, last_yield: waves.length ? num(waves[waves.length - 1].yield) : null, stop_reason: V.stop_reason || null,
  };
}

// 저장소 하나의 모든 작업 · 공장 실행
function collect(root, o) {
  const h = path.join(commonDir(root), 'harness');
  const tasksDir = path.join(h, 'tasks'), factDir = path.join(h, 'factory');
  const since = o && o.since ? Date.parse(o.since) : null;
  const tasks = [], factories = [];
  let names = []; try { names = fs.readdirSync(tasksDir); } catch { /* 하네스 작업이 없다 */ }
  for (const n of names) {
    const t = readJson(path.join(tasksDir, n, 'task.json')); if (!t || !t.id) continue;
    if (since && Date.parse(t.created_at) < since) continue;
    tasks.push(taskMetrics(root, t, { events: readLog(path.join(tasksDir, n, 'log.jsonl')), plan: o && o.plan }));
  }
  let fn = []; try { fn = fs.readdirSync(factDir).filter(x => /^f-\d{8}-\d{6}-[0-9a-f]{4}$/.test(x)); } catch { /* 공장 실행이 없다 */ }
  for (const n of fn) {
    const run = readJson(path.join(factDir, n, 'run.json')); if (!run) continue;
    if (since && Date.parse(run.created_at) < since) continue;
    factories.push(factoryMetrics(root, run));
  }
  tasks.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return { root: path.resolve(root), project: path.basename(path.resolve(root)), tasks, factories };
}

// ── 요약 ────────────────────────────────────────────────────────────────
const median = xs => { const s = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = xs => { const s = xs.filter(x => x != null && Number.isFinite(x)); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const rate = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : null);
function summarize(c) {
  const T = c.tasks, ended = T.filter(t => t.status !== 'running');
  const QM = T.filter(t => t.quality_measured), RM = ended.filter(t => t.residue != null);
  const sumLines = QM.reduce((a, t) => a + t.insertions, 0);
  return {
    project: c.project, tasks: T.length, factories: c.factories.length,
    done_rate: rate(ended, t => t.outcome === 'done'), accepted_rate: rate(ended, t => t.accepted),
    cost_total: Math.round(T.reduce((a, t) => a + t.cost_usd, 0) * 100) / 100, cost_median: median(T.map(t => t.cost_usd)), wall_median_min: median(T.map(t => t.wall_min)),
    turns_mean: mean(T.map(t => t.turns)), continuation_rate: rate(ended, t => t.continuations > 0),
    plan_rate: rate(ended, t => t.plan_found), plan_done_mean: mean(T.map(t => t.plan_done_ratio)), decisions_mean: mean(T.map(t => t.decisions)),
    tests_added_mean: mean(T.map(t => t.tests_added)), test_growth_rate: rate(ended.filter(t => t.test_count_delta != null), t => t.test_count_delta > 0),
    regressions: ended.filter(t => t.baseline_fail != null && t.final_fail != null && t.final_fail > t.baseline_fail).length,
    quality_measured: QM.length, quality_first_per_kloc: sumLines ? Math.round(QM.reduce((a, t) => a + num(t.quality_first), 0) / sumLines * 1000 * 100) / 100 : null,
    quality_left_per_kloc: sumLines ? Math.round(QM.reduce((a, t) => a + num(t.quality_left), 0) / sumLines * 1000 * 100) / 100 : null,
    quality_sent_back_rate: rate(QM, t => t.quality_sent_back),
    residue_measured: RM.length, residue_rate: rate(RM, t => t.residue > 0), untracked_left_rate: rate(ended, t => t.untracked_left > 0),
    denied_total: T.reduce((a, t) => a + t.denied, 0), checks_modified_total: T.reduce((a, t) => a + t.checks_modified, 0),
  };
}

// ISO/IEC 25010 · 25023(GS 인증의 평가 모델) 품질 특성 → 하네스가 코드 · 작업 기록에서 잴 수 있는 대리 지표. 인증 시험(제품 · 문서)을 대신하지 않는다.
const GS_MAP = [
  ['기능 적합성', '검사 통과(verdict) · 회귀(작업 전보다 실패가 는 작업) · 완료율'],
  ['신뢰성', '회귀 수 · 멈춘 테스트 · 같은 실패 반복(stalled)'],
  ['보안성', '하드코딩(비밀 · 개인 경로) · 검사 억누르기 · 거부된 위험 명령'],
  ['유지보수성 — 분석성 · 수정성', '품질 규칙 발견(1천 줄당) · 저장소 린트 새 위반 · 중복 · 쓰이지 않는 정의 · 주석 처리된 코드'],
  ['유지보수성 — 시험성', '추가한 테스트 · 테스트 수 증가 · 테스트 약화'],
  ['유지보수성 — 모듈성', '범위(바꾼 파일 수) · 공장 카드의 소유 경로 겹침(직렬화)'],
];

const pct = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
const n2 = x => (x == null ? '—' : (Math.round(x * 100) / 100).toString());
function toMarkdown(collections) {
  const S = collections.map(summarize);
  const L = ['# 하네스 작업 수치', '', `프로젝트 ${S.length}개 · 작업 ${S.reduce((a, s) => a + s.tasks, 0)}개 · 공장 실행 ${S.reduce((a, s) => a + s.factories, 0)}개`, ''];
  const row = (label, f) => `| ${label} | ${S.map(f).join(' | ')} |`;
  L.push(`| 지표 | ${S.map(s => s.project).join(' | ')} |`, `|---|${S.map(() => '---:').join('|')}|`,
    row('작업 수', s => s.tasks), row('완료율', s => pct(s.done_rate)), row('받아들인 비율', s => pct(s.accepted_rate)),
    row('비용 합(USD)', s => n2(s.cost_total)), row('작업당 비용 중앙값', s => n2(s.cost_median)), row('작업당 시간 중앙값(분)', s => n2(s.wall_median_min)),
    row('이어 가기가 필요했던 비율', s => pct(s.continuation_rate)), row('PLAN.md 를 남긴 비율', s => pct(s.plan_rate)), row('PLAN 항목 완료율(평균)', s => pct(s.plan_done_mean)),
    row('결정 기록(평균)', s => n2(s.decisions_mean)), row('추가한 테스트 파일(평균)', s => n2(s.tests_added_mean)), row('테스트 수가 늘어난 비율', s => pct(s.test_growth_rate)),
    row('회귀(작업 뒤 실패 증가)', s => s.regressions), row('품질 규칙을 잰 작업 수', s => s.quality_measured), row('품질 발견 · 처음(1천 줄당)', s => n2(s.quality_first_per_kloc)), row('품질 발견 · 끝에 남음(1천 줄당)', s => n2(s.quality_left_per_kloc)),
    row('품질 발견으로 돌려보낸 비율', s => pct(s.quality_sent_back_rate)), row('자원 장부로 잰 작업 수', s => s.residue_measured), row('찌꺼기 남은 작업 비율', s => pct(s.residue_rate)), row('추적 안 된 파일을 남긴 비율', s => pct(s.untracked_left_rate)),
    row('권한으로 거부된 명령(합)', s => s.denied_total), row('검사 정의를 바꾼 작업(합)', s => s.checks_modified_total));
  L.push('', '## 품질 특성(ISO/IEC 25010 · 25023 — GS 인증의 평가 모델)과 대리 지표', '', '| 특성 | 하네스가 재는 것 |', '|---|---|', ...GS_MAP.map(([a, b]) => `| ${a} | ${b} |`),
    '', 'GS 인증은 시험기관이 실행 제품과 문서를 시험한다. 위 수치는 그 준비 상태를 보는 대리 지표이며 인증 결과를 대신하지 않는다.');
  return L.join('\n') + '\n';
}

module.exports = { SCHEMA, taskMetrics, factoryMetrics, collect, summarize, toMarkdown, GS_MAP, planOf };
