'use strict';
// 작업 장부 — 이 저장소에서 이미 한 일 · 하고 있는 일 · 버린 일을 찾아, 새 작업이 처음부터 다시 하지 않고 그 뒤로 이어 가게 한다.
//   [2026-10-20 PRD R2 · 사용자 원칙 "시킨 일을 중복하지 않고, 준 맥락을 바탕으로 확인 · 검증해 그 뒤로 발전해 나간다"]
//   언어 무관: 문장 부호 · 공백을 하나로 접은 뒤 글자 3-gram 코사인 유사도 — 한국어 · 영어 · 코드 이름이 섞인 목표에도 같은 방식.
//   판정이 아니라 맥락이다: 하네스는 막지 않는다 — 작업자에게 이전 작업을 알려 확인 · 이어 가게 하고, 보고에 남긴다.
const S = require('./state');

const SAME = 0.82, RELATED = 0.3, MAX_RELATED = 4, MAX_CHARS = 3500;

const norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
function grams(s) {
  const t = norm(s).replace(/ /g, '_'), m = new Map();
  if (t && t.length < 3) m.set(t, 1);
  for (let i = 0; i + 3 <= t.length; i++) { const g = t.slice(i, i + 3); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
function similarity(a, b) {
  const x = grams(a), y = grams(b);
  let dot = 0, nx = 0, ny = 0;
  for (const [k, v] of x) { nx += v * v; const w = y.get(k); if (w) dot += v * w; }
  for (const v of y.values()) ny += v * v;
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}

// 작업의 "무엇을 하라고 했나" — 목표 + 사용자가 덧붙인 지시(note)
function intentOf(root, t) {
  let notes = [];
  try { notes = require('./loop').allNotes ? require('./loop').allNotes(root, t.id) : []; } catch { /* 없음 */ }
  return [t.goal, ...notes.map(n => n.text)].join('\n');
}

// → [{ id, score, status, kind: 'same' | 'related' }] (점수 높은 순, 최대 MAX_RELATED)
function related(root, task) {
  const out = [];
  for (const t of S.listTasks(root)) {
    if (!t || t.id === task.id) continue;
    // 같은 공장 실행의 형제 카드는 이전 작업이 아니다(공통 맥락을 나눠 가져 비슷해 보인다 — 서로의 일은 계약 · 소유 경로가 나눈다)
    if (t.factory && task.factory && t.factory.run === task.factory.run) continue;
    const score = similarity(task.goal, intentOf(root, t));
    if (score >= RELATED) out.push({ id: t.id, score: Math.round(score * 100) / 100, status: t.status, kind: score >= SAME ? 'same' : 'related' });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_RELATED);
}

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const DONE = new Set(['accepted', 'done']);
// 이전 작업 하나의 요약 — 결과 · 결정 분기점(선택한 것) · 바꾼 파일
function summary(root, ref) {
  const t = S.readTask(root, ref.id);
  if (!t) return null;
  const head = `- ${t.id} (${t.status}${t.merge_commit ? `, merged as ${String(t.merge_commit).slice(0, 10)}` : ''}, ${Math.round(ref.score * 100)}% similar): ${clip(t.goal, 220)}`;
  const lines = [head];
  if (t.reason) lines.push(`  result: ${clip(t.reason, 200)}`);
  for (const d of (t.decisions || []).slice(0, 4)) {
    const chosen = (d.body || []).find(l => /^-?\s*chosen\s*:/i.test(l));
    lines.push(`  decision: ${clip(d.title, 140)}${chosen ? ` → ${clip(chosen.replace(/^-?\s*chosen\s*:\s*/i, ''), 140)}` : ''}`);
  }
  try {
    const G = require('./git');
    const to = t.head || (G.branchExists(root, t.branch) ? t.branch : null);
    if (t.base_commit && to) {
      const files = G.diffNames(root, t.base_commit, to).filter(f => !f.startsWith('.harness/'));
      if (files.length) lines.push(`  files changed: ${files.length} (${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''})`);
    }
  } catch { /* 브랜치가 사라졌으면 생략 */ }
  return lines;
}

// 작업자 지시문 블록 — 관련 작업이 없으면 빈 배열
function promptLines(root, task) {
  const refs = task.related || [];
  if (!refs.length || !root) return [];
  const L = ['# Earlier work in this repository',
    'The harness found earlier tasks with a similar goal. Build on them: do not redo finished work and do not undo their decisions unless this goal requires it.'];
  for (const r of refs) { const s = summary(root, r); if (s) L.push(...s); }
  const same = refs.find(r => r.kind === 'same' && DONE.has(r.status));
  if (same) L.push(`This goal looks the same as ${same.id}, which is already ${same.status}. Do not start over: first check whether what it asks for already exists in this worktree and verify it (run or inspect it), then do only what is still missing or wrong. Write what you found in DECISIONS.md.`);
  const live = refs.filter(r => r.status === 'running');
  if (live.length) L.push(`${live.map(r => r.id).join(', ')} with a similar goal ${live.length > 1 ? 'are' : 'is'} running right now in another worktree — stay within this goal and avoid changing the same files where you can.`);
  let text = L.join('\n');
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS - 1) + '…';
  return [...text.split('\n'), ''];
}

// 보고의 주의 한 줄 — 없으면 null
function reportWarning(task, ko) {
  const refs = task.related || [];
  const same = refs.filter(r => r.kind === 'same'), live = refs.filter(r => r.status === 'running');
  if (!same.length && !live.length) return null;
  const parts = [];
  if (same.length) parts.push(ko ? `같은 목표의 이전 작업이 있다(${same.map(r => `${r.id} ${r.status}`).join(', ')}) — 다시 하지 않고 확인 · 이어 가도록 지시했다` : `an earlier task has the same goal (${same.map(r => `${r.id} ${r.status}`).join(', ')}) — the worker was told to verify and continue from it, not redo it`);
  if (live.length) parts.push(ko ? `비슷한 작업이 동시에 돌고 있었다(${live.map(r => r.id).join(', ')}) — 겹치는 변경이 있는지 보세요` : `a similar task was running at the same time (${live.map(r => r.id).join(', ')}) — check for overlapping changes`);
  return parts.join(' · ');
}

module.exports = { related, similarity, promptLines, reportWarning, SAME, RELATED };
