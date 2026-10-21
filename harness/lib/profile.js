'use strict';
// 사용자 판단 패턴(profile) — 이 사용자가 갈림길에서 실제로 어떻게 판단했는지를 기록에서 모아 정량화하고, 작업자가 "자동으로 판단" 할 때 그 패턴을 따르게 한다.
//   [2026-10-21 사용자 요청] "어떤 요청이 왔을 때 사용자가 어떤 판단을 했는지 유형 · 패턴을 정량화해, 자동으로 판단하라고 하면 내 판단 패턴으로 판단해 끝까지 완료하게."
//   출처(이 PC 안에서만 읽는다 · 밖으로 보내지 않는다):
//     1) 대화 기록(~/.claude/projects/**/*.jsonl)의 선택 질문 — 질문 · 선택지 · 추천안 · 실제 선택
//     2) 대화 기록의 사용자 지시 문장 — 진행 · 정리 · 병렬 · 범위 · 검증 · 속도 · 정직 · 안전 · 기록 · 비용 …
//     3) 하네스 작업 기록 — 받아들임 · 취소 · 도중 추가 지시
//   결과는 ~/.harness/profile.json(사용자 수준). 원문은 짧은 발췌만 남긴다. 판정은 규칙(정규식 · 횟수)으로 — 모델이 매기지 않는다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const home = () => process.env.HARNESS_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.harness');
const profileFile = () => path.join(home(), 'profile.json');
const RECOMMENDED = /\((recommended|권고|권장|추천)\)|\b(recommended)\b/i;
const BROAD = /(둘 다|모두|전체|전부|최대한|다 해|모든|all\b|both\b|full\b|everything)/i;
const NARROW = /(최소|일단|보류|나중에|만 하|only\b|minimal|skip|건너뛰)/i;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// 사용자 지시의 유형 — 문장 하나가 여러 유형에 걸칠 수 있다. 규칙 문장은 그 유형이 충분히 자주(횟수) 나오면 만든다.
const DIRECTIVES = [
  { key: 'autonomy', re: /(묻지 말고|묻지 않고|끝까지|멈추지|중단하지|계속 진행|자동으로 판단|알아서|스스로 판단)/, rule: '갈림길에서 묻지 않는다 — 사용자 패턴으로 골라 끝까지 간다(되돌릴 수 없는 일만 예외)' },
  { key: 'cleanup', re: /(찌꺼기|쓰레기|가비지|지워|삭제해|남기지 마|꼭 정리|무조건.{0,8}정리|다 끝나면.{0,10}정리)/, rule: '작업 · 시험이 만든 것(임시 파일 · 컨테이너 · 프로세스 · 데이터)은 끝나면 반드시 정리한다 — 남의 것은 건드리지 않는다' },
  { key: 'parallel', re: /(병렬|동시에|에이전트.{0,10}(많이|최대|여러))/, rule: '서로 독립적인 일은 나눠 동시에 돌린다' },
  { key: 'broad', re: /(전체|전부|모두|최대한|빠짐없이|전수|끝까지 다)/, rule: '범위는 넓게 — 요청과 이어진 일은 빠짐없이 끝낸다(새 기능을 지어내지는 않는다)' },
  { key: 'verify', re: /(검증|확인해|테스트해|시나리오|신뢰|증명)/, rule: '결과는 실제로 돌려 확인하고 근거(명령 · 결과)를 남긴다' },
  { key: 'speed', re: /(빠르게|빨리|속도|오래 걸|느려|시간이 너무)/, rule: '같은 결과면 빠른 쪽을 고른다 — 불필요한 대기 · 반복을 줄인다' },
  { key: 'honesty', re: /(솔직|정확히|낙관|과장|사실대로|근거)/, rule: '수치 · 결론은 근거와 함께, 한계는 그대로 적는다(낙관 금지)' },
  { key: 'korean', re: /(한글로|한국어로|한글 ?답)/, rule: '사람이 읽는 것은 한국어로 쓴다' },
  { key: 'safety', re: /(남의 거|남의 것|건드리지 마|지우지 말|승인 없이|push.{0,6}(하지|말)|되돌릴 수 없)/, rule: '되돌릴 수 없는 일 · 남의 것은 승인 없이 하지 않는다' },
  { key: 'record', re: /(기록|로그|주석|남겨|컨텍스트)/, rule: '다음 세션이 이어 갈 수 있게 계획 · 결정 · 검증 · 남은 일을 줄이지 않고 남긴다' },
  { key: 'cost', re: /(비용|예산|\$\s?\d)/, rule: '비용을 의식한다 — 같은 결과면 싼 쪽, 큰 지출은 상한 안에서',
    // 방향이 반대인 지시("비용 신경 쓰지 말고 끝까지") — 더 많이 나온 쪽의 규칙을 쓴다. 인증 "토큰" 과 헷갈려 토큰은 세지 않는다.
    neg: /(비용|예산|돈).{0,8}(신경 ?(쓰지|안)|상관 ?없|아끼지|걱정 ?(하지|말|없)|무시)/, negRule: '완성도가 비용보다 먼저다 — 상한 안에서는 비용을 아끼느라 일을 줄이지 않는다' },
  { key: 'reuse', re: /(기존|재사용|있는 거|중복|관례)/, rule: '새로 만들기 전에 기존 코드 · 관례를 찾아 쓴다(중복 금지)' },
];

function* jsonlFiles(dir, depth) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) yield* jsonlFiles(p, depth - 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}
const userText = j => {
  if (j.type !== 'user' || j.isMeta || j.isSidechain) return null;
  const c = j.message && j.message.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
  if (!t || /^\s*</.test(t) || /session is being continued|\[SYSTEM NOTIFICATION|Caveat:|<command-name>/.test(t)) return null;
  // 사람이 친 말만 — 붙여 넣은 명세 · 작업 지시문(긴 글 · 코드 블록)은 사용자의 판단이 아니라 재료다
  if (t.length > 1500 || t.includes('```')) return null;
  return t;
};
// 붙여 넣은 목록 · 코드 · 표 줄은 지시가 아니다
const typedLine = s => !/^[-+*#|>`\d]|`/.test(s);

// 대화 기록 → 선택 질문 · 지시 문장
function fromTranscripts(dir, o) {
  const asks = [], directives = {}, seen = new Set(); let sessions = 0, userMsgs = 0;
  for (const D of DIRECTIVES) directives[D.key] = { n: 0, examples: [], neg: 0, neg_examples: [] };
  const since = o && o.since ? Date.parse(o.since) : 0;
  for (const f of jsonlFiles(dir, 2)) {
    let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // 헤드리스 세션(sdk-cli)은 하네스 · 평가가 띄운 작업자다 — 그 "사용자 메시지" 는 요청문이지 사용자가 친 말이 아니다. 대화형(VS Code · CLI · 데스크톱)만 센다.
    const ep = (/"entrypoint":"([^"]+)"/.exec(text) || [])[1] || '';
    if (/^sdk/.test(ep)) continue;
    // 하네스 worktree · 임시 폴더(평가 작업 공간)에서 열린 세션도 작업자다
    const cwd = ((/"cwd":"([^"]+)"/.exec(text) || [])[1] || '').replace(/\\\\/g, '/');
    if (/\.harness-worktrees\/|\/Temp\/|^\/tmp\//i.test(cwd)) continue;
    sessions++;
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (since && j.timestamp && Date.parse(j.timestamp) < since) continue;
      const r = j.toolUseResult;
      if (r && Array.isArray(r.questions) && r.answers && typeof r.answers === 'object' && !r.answers.type) {
        for (const q of r.questions) {
          const chosen = r.answers[q.question]; if (chosen == null) continue;
          const key = `${q.question}|${chosen}`; if (seen.has(key)) continue; seen.add(key);
          const labels = (q.options || []).map(x => x.label);
          const rec = labels.find(l => RECOMMENDED.test(l)) || null;
          const picked = labels.filter(l => String(chosen).split(/,\s*/).includes(l));
          asks.push({ at: j.timestamp || null, header: clip(q.header, 20), question: clip(q.question, 100), chosen: clip(chosen, 100),
            recommended: !!rec && picked.includes(rec), had_recommended: !!rec, custom: !picked.length, multi: picked.length > 1,
            broad: BROAD.test(chosen), narrow: NARROW.test(chosen), first: picked.length === 1 && labels[0] === picked[0] });
        }
        continue;
      }
      const t = userText(j); if (!t) continue;
      userMsgs++;
      for (const s of t.split(/(?<=[.!?。]|다\.|요\.)\s+|\n+/).map(x => x.trim()).filter(x => x.length >= 4 && x.length <= 300 && typedLine(x))) {
        for (const D of DIRECTIVES) {
          if (!D.re.test(s)) continue;
          const d = directives[D.key];
          if (D.neg && D.neg.test(s)) { d.neg++; if (d.neg_examples.length < 3) d.neg_examples.push(clip(s, 90)); }
          else { d.n++; if (d.examples.length < 3) d.examples.push(clip(s, 90)); }
        }
      }
    }
  }
  return { sessions, userMsgs, asks, directives };
}

// 하네스 작업 기록 → 받아들임 · 취소 · 도중 추가 지시
function fromTasks(roots) {
  const out = { n: 0, accepted: 0, cancelled: 0, with_notes: 0, decisions: 0 };
  for (const root of roots || []) {
    const dir = path.join(root, '.git', 'harness', 'tasks');
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      let t; try { t = JSON.parse(fs.readFileSync(path.join(dir, n, 'task.json'), 'utf8')); } catch { continue; }
      out.n++;
      if (t.accepted_at || t.status === 'accepted') out.accepted++;
      if (t.status === 'cancelled') out.cancelled++;
      if (t.notes_delivered) out.with_notes++;
      out.decisions += (t.decisions || []).length;
    }
  }
  return out;
}

const pct = x => `${Math.round(x * 100)}%`;
// 정량 → 규칙(근거 횟수와 함께). 표본이 작으면 만들지 않는다.
function rules(p) {
  const R = [], A = p.asks;
  const withRec = A.filter(a => a.had_recommended);
  if (withRec.length >= 5) {
    const r = withRec.filter(a => a.recommended).length / withRec.length;
    if (r >= 0.6) R.push({ key: 'follow-recommended', text: `선택지가 갈리면 가장 무난한 추천안을 고른다 — 사용자는 추천안을 ${pct(r)} 골랐다(${withRec.length}회)`, weight: r });
    else if (r <= 0.4) R.push({ key: 'not-recommended', text: `추천안을 그대로 따르지 않는 편 — 추천안 선택 ${pct(r)}(${withRec.length}회). 갈림길에서는 아래 유형 규칙을 우선한다`, weight: 1 - r });
  }
  if (A.length >= 5) {
    const custom = A.filter(a => a.custom).length / A.length;
    if (custom >= 0.25) R.push({ key: 'adds-conditions', text: `선택지 밖의 조건을 자주 붙인다(${pct(custom)} · ${A.length}회) — 선택지를 고를 때도 요청 원문의 조건을 우선한다`, weight: custom });
    const broad = A.filter(a => a.broad || a.multi).length / A.length, narrow = A.filter(a => a.narrow).length / A.length;
    if (broad >= 0.2 && broad > narrow) R.push({ key: 'broad', text: `범위가 갈리면 넓은 쪽(전체 · 둘 다)을 고른다 — ${pct(broad)} 대 좁은 쪽 ${pct(narrow)}(${A.length}회)`, weight: broad });
  }
  const total = d => d.n + (d.neg || 0);
  // 10회 미만은 우연한 낱말 일치와 구별되지 않는다
  const top = Object.entries(p.directives).filter(([, d]) => total(d) >= 10).sort((a, b) => total(b[1]) - total(a[1]));
  for (const [k, d] of top) {
    const D = DIRECTIVES.find(x => x.key === k);
    if (D.neg && (d.neg || 0) > d.n) R.push({ key: `${k}-relaxed`, text: `${D.negRule} (지시 ${d.neg}회 대 반대 ${d.n}회 · 예: "${d.neg_examples[0]}")`, weight: d.neg });
    else R.push({ key: k, text: `${D.rule} (지시 ${d.n}회${d.neg ? ` 대 반대 ${d.neg}회` : ''} · 예: "${d.examples[0]}")`, weight: d.n });
  }
  if (p.tasks.n >= 10) R.push({ key: 'acceptance', text: `하네스 작업 ${p.tasks.n}개 중 받아들임 ${pct(p.tasks.accepted / p.tasks.n)} · 취소 ${pct(p.tasks.cancelled / p.tasks.n)} · 도중 추가 지시 ${pct(p.tasks.with_notes / p.tasks.n)}`, weight: 0, info: true });
  return R;
}

// o: { transcripts: 대화 기록 폴더(기본 ~/.claude/projects), roots: 하네스 저장소들, since } → profile
function build(o) {
  const dir = (o && o.transcripts) || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude', 'projects');
  const t = fromTranscripts(dir, o);
  const p = { schema: 1, built_at: new Date().toISOString(), sources: { sessions: t.sessions, user_messages: t.userMsgs, questions: t.asks.length }, asks: t.asks, directives: t.directives, tasks: fromTasks(o && o.roots) };
  p.rules = rules(p);
  return p;
}
function save(p) { fs.mkdirSync(home(), { recursive: true }); fs.writeFileSync(profileFile(), JSON.stringify(p, null, 2)); return profileFile(); }
function load() { try { return JSON.parse(fs.readFileSync(profileFile(), 'utf8')); } catch { return null; } }

// 작업 지시에 넣는 블록 — 규칙이 없으면 빈 배열
// 예시 문장은 넣지 않는다 — 사용자 원문 발췌는 프롬프트를 늘리고 작업과 무관한 내용을 끌어온다. 규칙 문장과 횟수만.
function promptLines(p) {
  p = p || load();
  const use = ((p && p.rules) || []).filter(x => !x.info).slice(0, 10);
  if (!use.length) return [];
  return ['', `# How this user decides (learned from ${p.sources.questions} answered choices and ${p.sources.user_messages} messages in past sessions)`,
    'When a fork comes up and the goal does not settle it, decide the way this user has decided before — do not stop to ask. The goal always wins over these patterns. In DECISIONS.md, name the pattern you followed (e.g. "pattern: broad").',
    ...use.map(x => `- [${x.key}] ${x.text.replace(/ · 예: ".*"\)$/, ')')}`)];
}

function format(p) {
  const L = [`판단 패턴 — 세션 ${p.sources.sessions}개 · 사용자 메시지 ${p.sources.user_messages}개 · 선택 질문 ${p.sources.questions}개 · 하네스 작업 ${p.tasks.n}개`, ''];
  const A = p.asks, withRec = A.filter(a => a.had_recommended);
  if (A.length) L.push(`선택 질문: 추천안 ${withRec.length ? pct(withRec.filter(a => a.recommended).length / withRec.length) : '—'} · 넓은 쪽 ${pct(A.filter(a => a.broad || a.multi).length / A.length)} · 좁은 쪽 ${pct(A.filter(a => a.narrow).length / A.length)} · 선택지 밖 ${pct(A.filter(a => a.custom).length / A.length)}`, '');
  L.push('지시 유형(횟수):', ...Object.entries(p.directives).sort((a, b) => b[1].n - a[1].n).map(([k, d]) => `  ${k.padEnd(10)} ${String(d.n).padStart(4)}${d.neg ? ` (반대 ${d.neg})` : ''}  ${d.examples[0] || ''}`), '', '규칙:', ...p.rules.map(r => `  - [${r.key}] ${r.text}`));
  return L.join('\n') + '\n';
}

module.exports = { build, save, load, promptLines, format, rules, DIRECTIVES, profileFile, fromTranscripts };
