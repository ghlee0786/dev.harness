'use strict';
// 사용량 한도 — 걸리면 리셋 시각까지 기다렸다가 같은 세션으로 이어 간다(무인 작업 · 공장).
//   [2026-10-20 평가 실측] 구독의 세션 한도("You've hit your session limit · resets 3:20am (Asia/Seoul)")에 걸리자 하네스가 충돌로 분류해
//   재시도하다 error 로 끝났다 — 한 시간 동안 시작한 작업 60여 개가 아무것도 못 하고 실패했다. 사람이 없는 동안에도 기다렸다 이어 가야 한다.
//   기다린 시간은 벽시계 상한에서 빼고(작업이 한도 때문에 capped 되지 않게), 한 작업의 총 대기는 상한(기본 6시간)까지.
//   끄기: 프로젝트 블록 quota_wait: off · 상한: quota_wait_max_min: <분>.

const FALLBACK_MS = 30 * 60 * 1000, MARGIN_MS = 60 * 1000;

function minutesInTz(now, tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    return Number(p.find(x => x.type === 'hour').value) * 60 + Number(p.find(x => x.type === 'minute').value);
  } catch { const d = new Date(now); return d.getHours() * 60 + d.getMinutes(); }
}

// 한도 메시지 → 다시 시도할 시각(ms). 읽을 수 없으면 null.
//   "resets 3:20am (Asia/Seoul)" · "resets at 3pm" · "resets 15:00" · "try again in 2 hours 5 minutes" · "retry after 120 seconds"
function resetAt(text, now) {
  now = now == null ? Date.now() : now;
  const s = String(text || '');
  let m = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC)\))?/i.exec(s);
  if (m && (m[2] || m[3])) {
    let h = Number(m[1]); const mi = Number(m[2] || 0), ap = (m[3] || '').toLowerCase();
    if (h > 23 || mi > 59) return null;
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    let delta = h * 60 + mi - minutesInTz(now, m[4]);
    if (delta <= 0) delta += 24 * 60;
    return now + delta * 60000;
  }
  m = /\b(?:in|after)\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?|s)?)?)?/i.exec(s);
  if (m && (m[1] || m[2] || m[3])) return now + ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
  return null;
}

// 기다릴지 · 얼마나 — null 이면 기다리지 않는다(꺼짐 · 상한을 넘음 · 읽지 못한 한도가 반복됨)
function plan(task, text, o, now) {
  now = now == null ? Date.now() : now;
  o = o || {};
  if (o.off) return null;
  const maxMs = (o.maxMin != null ? Number(o.maxMin) : 360) * 60000;
  const waited = Number(task.quota_waited_ms || 0);
  const at = resetAt(text, now);
  if (at == null && Number(task.quota_unparsed || 0) >= 6) return null;   // 읽지 못한 한도가 계속되면(3시간) 사람에게 넘긴다
  const waitMs = at != null ? Math.max(MARGIN_MS, at - now + MARGIN_MS) : FALLBACK_MS;
  if (waited + waitMs > maxMs) return null;
  return { waitMs, until: now + waitMs, parsed: at != null };
}

module.exports = { resetAt, plan, minutesInTz, FALLBACK_MS };
