'use strict';
// 검증 라인(PRD R6) — 공장이 합친 통합 브랜치를 여러 시험 에이전트가 나눠 시험한다.
//   [2026-10-20 사용자 지시] 시나리오 · 경계 · 회귀 같은 시험을 한 에이전트가 아니라 여러 에이전트에게 나눠 맡긴다 — 엉키지 않게.
//   1) 시험 설계 에이전트(읽기 전용)가 시험 차터(사명 · 범위 · 판정 기준)를 낸다.
//   2) 차터 하나 = 시험 작업 하나(통합 브랜치에서 · 제품 코드는 소유하지 못한다 — .harness-qa/ 만) → .harness/<id>/FINDINGS.json
//   3) 같은 결함은 묶고(작업 장부의 유사도), 다른 에이전트가 처음부터 다시 해 본다(독립 재현) — 재현된 것만 결함이다.
//   4) 결함 = 수정 카드(회귀 시험 포함) → 공장의 같은 합류 대기열.
//   5) 파도: 이번 파도의 확인된 새 결함 수 ÷ 시험 에이전트 수가 기준(0.2) 이상이면 결함 주변으로 다음 파도, 아니면 멈춘다(결함은 몰려 있다).
const crypto = require('node:crypto');
const S = require('./state'), G = require('./git'), W = require('./worklog');

const DEFAULTS = { testAgents: 4, waves: 2, continueYield: 0.2, testBudgetUsd: 6, reproBudgetUsd: 3, maxFixes: 6 };
const QA_OWNS = ['.harness-qa/**'];   // 시험 · 재현 작업이 쓸 수 있는 유일한 곳(제품 코드는 읽기만)
const REL = 'your task folder (.harness/<your task id>/, next to your PLAN.md)';

function parseJson(text) {
  const s = String(text || ''), a = s.search(/[[{]/), b = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}

function strategistPrompt(run, diffNames, n, focus) {
  return ['You are the TEST STRATEGIST of a software factory. Other agents implemented the request below and their work is merged in this checkout.',
    'Read the code and decide how to test it. Do not change any files.', '', '# Request', run.request, '',
    ...(run.plan && run.plan.contracts ? ['# Contracts', run.plan.contracts, ''] : []),
    '# Files changed by the work', diffNames.slice(0, 80).join('\n') || '(none listed)', '',
    ...(focus.length ? ['# Focus', `Confirmed defects were found here — test the neighbourhood harder (defects cluster): ${focus.join('; ')}`, ''] : []),
    `Write at most ${n} test charters. Each charter is one tester's independent mission; together they must cover different behaviour (no two charters testing the same thing).`,
    'Mix kinds by risk: scenario (end-to-end user flows), boundary (edge values, invalid input, errors), regression (existing behaviour still works), compat (interfaces, data, migrations), concurrency, security.',
    '"oracle" is how the tester decides pass/fail — refer to the request\'s requirements or contracts, not to your guesses.',
    'Reply with ONLY one JSON object: {"charters":[{"id":"q1","kind":"scenario","mission":"<what to test and how>","area":["<paths most involved>"],"oracle":"<expected behaviour>","risk":3}]}'].join('\n');
}
function testerGoal(run, ch, rel) {
  return [`You are a TESTER (charter ${ch.id}, ${ch.kind}). Test the code in this checkout; do not change the product code — you can only write under .harness-qa/ and $TEMP.`,
    `Mission: ${ch.mission}`, `Area: ${(ch.area || []).join(', ') || '(any)'}`, `Oracle (pass/fail): ${ch.oracle || 'the request and its contracts'}`, '',
    `Overall request that was implemented: ${String(run.request).slice(0, 1500)}`, '',
    'Run things for real (the program, its API, its tests, small scripts under .harness-qa/) instead of only reading code. Use $HARNESS_DATA_NS to name any data you create outside the checkout.',
    `When done, write FINDINGS.json in ${rel} — a JSON array, empty if you found nothing:`,
    '[{"title":"<one line>","severity":"high|medium|low","area":"<path>","repro":"<exact steps or commands>","expected":"<per the oracle>","actual":"<what happened>","evidence":"<output excerpt>"}]',
    'Report only real, reproducible problems against the oracle — not style opinions. Then end your turn.'].join('\n');
}
function reproGoal(run, finding, rel) {
  return ['You are a REPRODUCER. Another tester reported the problem below. Independently try to reproduce it on the code in this checkout — do not trust the report, run it yourself.',
    'Do not change the product code — you can only write under .harness-qa/ and $TEMP.', '',
    `Title: ${finding.title}`, `Area: ${finding.area || ''}`, `Steps: ${finding.repro || ''}`, `Expected: ${finding.expected || ''}`, `Reported actual: ${finding.actual || ''}`, '',
    `Write REPRO.json in ${rel}: {"reproduced": true|false, "how": "<what you ran>", "observed": "<what you saw>"}. Then end your turn.`].join('\n');
}

// 작업 브랜치에 커밋된 .harness/<id>/<파일>(JSON)
function readTaskJson(root, taskId, name) {
  const t = S.readTask(root, taskId);
  if (!t) return null;
  for (const ref of [t.head, t.branch].filter(Boolean)) {
    const r = G.git(root, ['show', `${ref}:.harness/${taskId}/${name}`], { allowFail: true });
    if (r.ok) return parseJson(r.out);
  }
  return null;
}

async function qaTask(c, h, goal, label, budgetUsd) {
  const { root, run, o } = c;
  let res;
  try { res = await require('./loop').go({ root, goal, base: c.branch, owns: QA_OWNS, run: o.run, runtime: o.runtime, model: o.model, budgetUsd, log: () => {}, factory: { run: run.id, card: label } }); }
  catch (e) { res = { status: 'error', reason: e.message }; }
  if (res.id) { run.verify.task_ids.push(res.id); h.save(); }
  return res;
}

async function run(c, h) {
  const { root, run: fr, o } = c;
  const v0 = { ...DEFAULTS, ...Object.fromEntries(Object.entries({ testAgents: o.testAgents, waves: o.waves, continueYield: o.continueYield, testBudgetUsd: o.testBudgetUsd, reproBudgetUsd: o.reproBudgetUsd, maxFixes: o.maxFixes }).filter(([, x]) => x != null)) };
  fr.verify = fr.verify || { waves: [], findings: [], task_ids: [], cost_usd: 0 };
  const V = fr.verify;
  const focus = [];
  for (let wave = 1; wave <= v0.waves; wave++) {
    if (h.spent() >= o.budgetUsd) { V.stopped = `budget $${o.budgetUsd} reached`; break; }
    // 1) 시험 설계 — 통합 브랜치의 분리 worktree 에서(읽기 전용 권한)
    const wt = `${c.intWt}-qa${wave}`;
    G.git(root, ['worktree', 'add', '--detach', '-f', wt, c.branch], { retryLock: true });
    let charters = [];
    try {
      const diff = G.diffNames(root, fr.base_commit, c.branch).filter(f => !f.startsWith('.harness/'));
      const r = await o.run({ runtime: o.runtime || 'claude', cwd: wt, prompt: strategistPrompt(fr, diff, v0.testAgents, focus), newSessionId: crypto.randomUUID(), model: o.model || ((o.runtime || 'claude') === 'claude' ? 'opus' : null),
        budgetUsd: 3, timeoutMs: 20 * 60 * 1000, allowCommands: [], allowRules: [], workerPermissions: 'strict', systemAppend: '' });
      V.cost_usd += Number(r && r.cost_usd) || 0;
      const p = parseJson(r && r.final_text);
      charters = (p && Array.isArray(p.charters) ? p.charters : []).filter(x => x && typeof x.mission === 'string' && x.mission.trim()).slice(0, v0.testAgents)
        .map((x, i) => ({ id: `w${wave}-${String(x.id || `q${i + 1}`).replace(/[^\w-]/g, '').slice(0, 20) || `q${i + 1}`}`, kind: String(x.kind || 'scenario').slice(0, 20), mission: x.mission, area: Array.isArray(x.area) ? x.area.map(String).slice(0, 8) : [], oracle: String(x.oracle || ''), risk: x.risk || null }));
    } finally { G.removeWorktree(root, wt); G.removeEmptyDir(wt); }   // Windows 는 등록만 지우고 빈 폴더를 남길 때가 있다
    const W1 = { wave, charters: charters.map(x => ({ id: x.id, kind: x.kind, mission: x.mission.slice(0, 200) })), testers: charters.length, found: 0, unique_new: 0, confirmed: 0 };
    V.waves.push(W1); h.save();
    h.event({ event: 'verify_wave', wave, charters: charters.length });
    c.log(`[pilot] factory ${fr.id} — verify wave ${wave}: ${charters.length} testers`);
    if (!charters.length) break;
    // 2) 시험 — 차터마다 시험 작업(동시 상한 = 공장의 jobs)
    const results = await pool(charters, o.jobs, async ch => {
      const res = await qaTask(c, h, testerGoal(fr, ch, REL), ch.id, v0.testBudgetUsd);
      const items = res && res.id ? readTaskJson(root, res.id, 'FINDINGS.json') : null;
      return { ch, task: res && res.id, findings: Array.isArray(items) ? items.filter(x => x && x.title) : [] };
    });
    // 3) 묶기 — 이미 본 결함(이전 파도 포함)과 같은 것은 중복
    const fresh = [];
    for (const r of results) for (const f of r.findings) {
      W1.found++;
      const key = `${f.title} ${f.area || ''}`;
      const dup = [...V.findings, ...fresh].find(x => W.similarity(key, `${x.title} ${x.area || ''}`) >= 0.6);
      if (dup) { dup.reports = (dup.reports || 1) + 1; continue; }
      fresh.push({ id: `f${V.findings.length + fresh.length + 1}`, wave, charter: r.ch.id, tester_task: r.task, title: String(f.title).slice(0, 200), severity: f.severity || 'medium', area: String(f.area || '').slice(0, 200),
        repro: String(f.repro || '').slice(0, 2000), expected: String(f.expected || '').slice(0, 500), actual: String(f.actual || '').slice(0, 500), evidence: String(f.evidence || '').slice(0, 1000), reports: 1, status: 'reported' });
    }
    W1.unique_new = fresh.length;
    // 4) 독립 재현 — 다른 에이전트가 처음부터
    await pool(fresh, o.jobs, async f => {
      const res = await qaTask(c, h, reproGoal(fr, f, REL), `repro-${f.id}`, v0.reproBudgetUsd);
      const rp = res && res.id ? readTaskJson(root, res.id, 'REPRO.json') : null;
      f.repro_task = res && res.id; f.status = rp && rp.reproduced === true ? 'confirmed' : 'not_reproduced'; f.observed = rp ? String(rp.observed || '').slice(0, 500) : null;
    });
    V.findings.push(...fresh);
    const confirmed = fresh.filter(f => f.status === 'confirmed');
    W1.confirmed = confirmed.length; h.save();
    h.event({ event: 'verify_findings', wave, found: W1.found, unique_new: fresh.length, confirmed: confirmed.length });
    // 5) 수정 카드 → 같은 합류 대기열
    const fixes = confirmed.slice(0, Math.max(0, v0.maxFixes - fr.cards.filter(k => k.fix_of).length));
    for (const f of fixes) {
      const owners = fr.cards.filter(k => !k.fix_of && (k.owns || []).some(g => f.area && (f.area.startsWith(String(g).split('*')[0].replace(/\/$/, '')) || String(g).startsWith(f.area))));
      const owns = [...new Set([...owners.flatMap(k => k.owns), ...(f.area ? [f.area] : [])])];
      if (!owns.length) { f.status = 'confirmed_unowned'; continue; }
      const card = { id: `fix-${f.id}`, title: `fix: ${f.title}`.slice(0, 80), fix_of: f.id, owns, depends_on: [], risk: f.severity === 'high' ? 4 : 2, status: 'pending', attempts: 0,
        goal: [`Fix this confirmed defect (found by a tester and independently reproduced):`, `Title: ${f.title}`, `Area: ${f.area}`, `Steps: ${f.repro}`, `Expected: ${f.expected}`, `Actual: ${f.actual}`, '',
          'Add a regression test that fails before your fix and passes after it, then fix the cause (not the symptom).'].join('\n') };
      fr.cards.push(card); f.fix_card = card.id;
    }
    h.save();
    if (fixes.length) { fr.stage = 'fix'; await h.schedule(); fr.stage = 'verify'; }
    for (const f of fixes) { const k = fr.cards.find(x => x.id === f.fix_card); if (k && k.status === 'merged') f.status = 'fixed'; }
    for (const f of confirmed) focus.push(`${f.area}: ${f.title}`);
    W1.yield = charters.length ? Math.round((confirmed.length / charters.length) * 100) / 100 : 0;
    h.save();
    if (W1.yield < v0.continueYield) { V.stop_reason = `wave ${wave} yield ${W1.yield} < ${v0.continueYield} — testing stops (no new defects worth another wave)`; break; }
  }
  if (!V.stop_reason && !V.stopped) V.stop_reason = `ran ${V.waves.length} wave(s)`;
  h.save();
}

function reportLines(run, ko) {
  const V = run.verify; if (!V) return [];
  const by = st => V.findings.filter(x => x.status === st).length;
  const L = [`${ko ? '검증 라인' : 'verification'}: ${ko ? '파도' : 'waves'} ${V.waves.length} · ${ko ? '시험 에이전트' : 'testers'} ${V.waves.reduce((a, w) => a + w.testers, 0)} · ${ko ? '보고' : 'reports'} ${V.waves.reduce((a, w) => a + w.found, 0)} · ${ko ? '고유' : 'unique'} ${V.findings.length} · ${ko ? '재현됨' : 'reproduced'} ${V.findings.filter(x => ['confirmed', 'fixed', 'confirmed_unowned'].includes(x.status)).length} (${ko ? '고침' : 'fixed'} ${by('fixed')}) · ${ko ? '재현 안 됨' : 'not reproduced'} ${by('not_reproduced')}${V.stop_reason ? ` — ${V.stop_reason}` : ''}`];
  for (const f of V.findings.slice(0, 20)) L.push(`  ${f.id} ${f.status.toUpperCase()} [${f.severity}] ${f.title}${f.area ? ` (${f.area})` : ''}${f.reports > 1 ? ` ×${f.reports}` : ''}${f.fix_card ? ` → ${f.fix_card}` : ''}`);
  return L;
}

module.exports = { run, reportLines, strategistPrompt, testerGoal, reproGoal, parseJson, DEFAULTS, QA_OWNS };
