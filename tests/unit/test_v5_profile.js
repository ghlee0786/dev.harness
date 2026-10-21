'use strict';
// 사용자 판단 패턴(profile) — 대화 기록 · 하네스 작업에서 선택 · 지시를 세어 규칙으로 만들고, 작업 지시의 갈림길 규칙에 붙인다. 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const R = makeReporter('사용자 판단 패턴 — 정량화 · 규칙 · 작업 지시');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-profile-'));
process.env.HARNESS_HOME = path.join(base, 'home');   // 사용자의 ~/.harness 를 쓰지 않는다
const P = require('../../harness/lib/profile');
const Pr = require('../../harness/lib/prompts');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const say = (text, ep = 'claude-vscode', cwd = 'C:\\work\\app') => ({ type: 'user', entrypoint: ep, cwd, timestamp: '2026-10-20T00:00:00Z', message: { role: 'user', content: text } });
const ask = (question, labels, chosen) => ({ type: 'user', entrypoint: 'claude-vscode', timestamp: '2026-10-20T00:00:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'answered' }] },
  toolUseResult: { questions: [{ question, header: 'h', options: labels.map(label => ({ label, description: '' })), multiSelect: false }], answers: { [question]: chosen } } });

const tr = path.join(base, 'projects');
const rows = [];
// 선택 질문 6개: 추천안 5 · 선택지 밖 1
for (let i = 0; i < 5; i++) rows.push(ask(`질문 ${i}?`, ['A안 (추천)', 'B안'], 'A안 (추천)'));
rows.push(ask('질문 5?', ['A안 (추천)', 'B안'], '둘 다 하고 로그도 남겨'));
// 지시: autonomy 11 · 비용은 반대 방향 11 대 1
for (let i = 0; i < 11; i++) rows.push(say(`묻지 말고 끝까지 진행해라 ${i}`));
for (let i = 0; i < 11; i++) rows.push(say(`비용 신경 쓰지 말고 완벽하게 해라 ${i}`));
rows.push(say('비용을 줄여라'));
// 사람이 친 말이 아닌 것: 붙여 넣은 긴 명세 · 코드 블록 · 목록 줄
rows.push(say('명세:\n' + '병렬로 묻지 말고 끝까지 처리한다. '.repeat(80)));
rows.push(say('```\n묻지 말고 끝까지\n```'));
rows.push(say('- 묻지 말고 끝까지 진행 (목록 줄)'));
write(path.join(tr, 'proj-a', 's1.jsonl'), jsonl(rows));
// 헤드리스 작업자(sdk-cli) · 평가 작업 공간 세션은 세지 않는다
write(path.join(tr, 'proj-a', 's2.jsonl'), jsonl(Array.from({ length: 20 }, () => say('병렬로 동시에 돌려라', 'sdk-cli'))));
write(path.join(tr, 'proj-b', 's3.jsonl'), jsonl(Array.from({ length: 20 }, () => say('병렬로 동시에 돌려라', 'claude-vscode', 'C:\\repo\\.harness-worktrees\\t-1'))));

// 하네스 작업 기록 10개: 받아들임 8 · 취소 1 · 도중 추가 지시 2
const root = path.join(base, 'repo');
for (let i = 0; i < 10; i++) write(path.join(root, '.git', 'harness', 'tasks', `t-${i}`, 'task.json'), JSON.stringify({ id: `t-${i}`, status: i < 8 ? 'accepted' : i === 8 ? 'cancelled' : 'done', notes_delivered: i < 2 ? 1 : 0 }));

try {
  const p = P.build({ transcripts: tr, roots: [root] });
  R.check('[PF-01] 대화형 세션만 센다 — 헤드리스(sdk-cli) · worktree 세션 제외', p.sources.sessions === 1 && p.directives.parallel.n === 0, JSON.stringify({ s: p.sources.sessions, par: p.directives.parallel.n }));
  const fr = p.rules.find(r => r.key === 'follow-recommended');
  R.check('[PF-02] 선택 질문 — 6개 · 추천안 5/6 → 추천안 규칙(83%) · 선택지 밖 1', p.asks.length === 6 && fr && /83%/.test(fr.text) && p.asks.filter(a => a.custom).length === 1, JSON.stringify(p.rules.map(r => r.key)));
  R.check('[PF-03] 붙여 넣은 명세 · 코드 블록 · 목록 줄은 지시가 아니다 — autonomy 는 친 말 11회만', p.directives.autonomy.n === 11, String(p.directives.autonomy.n));
  R.check('[PF-04] 방향이 반대인 지시가 더 많으면 반대 규칙 — "비용 신경 쓰지 말고" 11 대 1 → cost-relaxed', p.rules.some(r => r.key === 'cost-relaxed') && !p.rules.some(r => r.key === 'cost'), JSON.stringify(p.directives.cost));
  const acc = p.rules.find(r => r.key === 'acceptance');
  R.check('[PF-05] 하네스 작업 — 받아들임 80% · 취소 10% · 도중 추가 지시 20%', acc && /80%/.test(acc.text) && /10%/.test(acc.text) && /20%/.test(acc.text), acc && acc.text);
  R.check('[PF-06] 10회 미만 지시는 규칙이 되지 않는다(우연한 낱말 일치)', !p.rules.some(r => r.key === 'parallel' || r.key === 'cleanup'));
  const ord = P.rules({ asks: [], tasks: { n: 0 }, directives: { verify: { n: 10, examples: ['v'] }, broad: { n: 30, examples: ['b'] }, record: { n: 20, examples: ['r'] } } }).map(r => r.key).join(',');
  R.check('[PF-06b] 지시 규칙은 횟수가 많은 순서(작업 지시에는 앞 10개만 들어간다)', ord === 'broad,record,verify', ord);

  // 작업 지시 — 저장 전에는 판단 패턴 줄이 없고, 저장 뒤에는 갈림길 규칙 아래 붙는다(예시 원문은 넣지 않는다)
  const t = { id: 't-x', goal: 'g', checks: { source: 'none', commands: [] }, caps: { budget_usd: 1 }, spent: { cost_usd: 0 } };
  const before = Pr.taskPrompt(t, {});
  P.save(p);
  const after = Pr.taskPrompt(t, {});
  R.check('[PF-07] 작업 지시 — 저장 전엔 없음 · 저장 뒤 "How this user decides" 와 규칙 키 · 예시 원문 없음 · 목표가 우선',
    !/How this user decides/.test(before) && /How this user decides/.test(after) && /\[follow-recommended\]/.test(after) && /\[autonomy\]/.test(after) && !/예: "/.test(after) && /goal always wins/.test(after), after.split('\n').filter(l => /decides|\[/.test(l)).join(' | ').slice(0, 400));

  // CLI — profile --build 는 HARNESS_HOME 에 저장하고 요약을 보인다 · profile 은 저장된 것을 보인다
  fs.rmSync(P.profileFile());
  const cli = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'harness', 'cli.js'), ...a], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, HARNESS_HOME: process.env.HARNESS_HOME } });
  const none = cli('profile', '--root', root);
  const b = cli('profile', '--build', '--transcripts', tr, '--roots', root, '--root', root);
  const shown = cli('profile', '--json', '--root', root);
  let j = null; try { j = JSON.parse(shown.stdout); } catch { /* 아래 단언이 잡는다 */ }
  R.check('[PF-08] CLI profile — 없을 때 안내 · --build 저장 · --json 규칙', none.status === 0 && /아직 없습니다/.test(none.stdout) && b.status === 0 && /추천안 83%/.test(b.stdout) && fs.existsSync(P.profileFile()) && j && j.rules.some(r => r.key === 'autonomy'),
    `${none.status} ${b.status} ${b.stderr.slice(0, 200)} ${shown.stdout.slice(0, 120)}`);
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
R.done();
