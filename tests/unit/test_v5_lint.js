'use strict';
// 린트 — 테스트 다음의 두 번째 결정적 검사(프로젝트 블록 lint_command).
//   [2026-10-13 사용자 지시 · 영상 "쓰레기 코드 없애는 법"] 지시문(“깔끔하게 짜라”)은 무시될 수 있지만 실패하는 린트 명령은 무시할 수 없다.
//   {files} 가 있으면 작업이 바꾼 파일만 린트한다(저장소의 옛 린트 빚과 상관없이) · 없으면 저장소 전체(작업 전부터 빨갛다면 경고만).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const L = require('../../harness/lib/loop');
const K = require('../../harness/lib/checks');
const R = makeReporter('린트 — lint_command · {files} · 기준선 · 보고');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-lint-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
// 린트: 인자로 받은 .js 파일(없으면 저장소의 모든 .js) 중 console.log 가 있으면 실패.
const LINT_JS = `const fs=require('fs'),p=require('path');let files=process.argv.slice(2);
if(!files.length){const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.name.startsWith('.')||e.name==='node_modules'?[]:e.isDirectory()?walk(p.join(d,e.name)):[p.join(d,e.name)]);files=walk('.');}
const bad=files.filter(f=>/\\.js$/.test(f)&&!/lint\\.js$|check\\.js$/.test(f)&&fs.existsSync(f)&&/console\\.log/.test(fs.readFileSync(f,'utf8')));
if(bad.length){for(const f of bad)console.log(f+': no-console — remove console.log');process.exit(1);}console.log('lint ok');`;
const CHECK_JS = "console.log('# pass 1\\n# fail 0')";
let seq = 0;
function repo(lintCmd, extra) {
  const d = path.join(base, `r${++seq}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  write(path.join(d, 'lint.js'), LINT_JS); write(path.join(d, 'check.js'), CHECK_JS);
  write(path.join(d, 'AGENTS.md'), `# p\n\n\`\`\`yaml\ntest_command: "node check.js"\n${lintCmd ? `lint_command: "${lintCmd}"\n` : ''}\`\`\`\n`);
  for (const [f, t] of Object.entries(extra || {})) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
const steps = list => { const calls = []; const run = async o => { const n = calls.length; calls.push({ ...o, signal: undefined }); await list[Math.min(n, list.length - 1)](o); return { ok: true, is_error: false, session_id: o.sessionId || o.newSessionId || 's', session_confirmed: true, final_text: 'done', cost_usd: 0.1, permission_denials: [] }; }; run.calls = calls; return run; };

(async () => {
  try {
    // LT-01 — 작업이 린트를 어기면 작업자에게 돌려보낸다 → 고치면 done
    const r1 = repo('node lint.js {files}');
    const f1 = steps([o => write(path.join(o.cwd, 'feat.js'), 'module.exports=()=>{console.log("x");return 1};\n'), o => write(path.join(o.cwd, 'feat.js'), 'module.exports=()=>1;\n')]);
    const g1 = await L.go({ ...quiet, root: r1, goal: 'add feat', run: f1 });
    R.check('[LT-01] 테스트는 통과해도 린트가 실패하면 작업자에게 린트 출력을 돌려보낸다 → 고치면 done', g1.status === 'done' && f1.calls.length === 2 && /no-console/.test(f1.calls[1].prompt) && /lint/i.test(f1.calls[1].prompt), `${g1.status} calls=${f1.calls.length} ${f1.calls[1] && f1.calls[1].prompt.slice(0, 300)}`);
    R.check('[LT-01] 보고에 린트 결과(통과)가 있다', /lint: PASS/.test(g1.report), g1.report);

    // LT-02 — {files}: 작업이 바꾼 파일만 — 저장소의 옛 린트 빚(old.js)은 막지 않는다
    const r2 = repo('node lint.js {files}', { 'old.js': 'console.log("legacy")\n' });
    const f2 = steps([o => write(path.join(o.cwd, 'clean.js'), 'module.exports=1;\n')]);
    const g2 = await L.go({ ...quiet, root: r2, goal: 'add clean', run: f2 });
    R.check('[LT-02] {files} 는 바뀐 파일만 린트한다 — 옛 빚이 있어도 done', g2.status === 'done' && f2.calls.length === 1, `${g2.status} ${g2.reason}`);

    // LT-03 — 저장소 전체 린트가 작업 전부터 빨갰으면 막지 않고 경고만
    const r3 = repo('node lint.js', { 'old.js': 'console.log("legacy")\n' });
    const f3 = steps([o => write(path.join(o.cwd, 'x.js'), 'module.exports=2;\n')]);
    const g3 = await L.go({ ...quiet, root: r3, goal: 'add x', run: f3 });
    R.check('[LT-03] 전체 린트가 작업 전부터 빨갛다 → 막지 않고(done) 보고에 "작업 전부터" 를 적는다', g3.status === 'done' && f3.calls.length === 1 && /lint: FAIL .*baseline/.test(g3.report), g3.report.split('\n').filter(l => /lint/.test(l)).join(' | '));

    // LT-04 — 같은 린트 실패가 두 번 연속이면 stalled
    const r4 = repo('node lint.js {files}');
    const bad = o => write(path.join(o.cwd, 'b.js'), 'console.log(1)\n');
    const g4 = await L.go({ ...quiet, root: r4, goal: 'add b', run: steps([bad, bad]) });
    R.check('[LT-04] 같은 린트 실패 두 번 → stalled', g4.status === 'stalled' && /lint/.test(g4.reason), `${g4.status} ${g4.reason}`);

    // LT-05 — 테스트가 없어도 린트는 판정한다
    const r5 = path.join(base, 'r5'); fs.mkdirSync(r5); git(r5, 'init', '-q', '-b', 'main'); git(r5, 'config', 'user.name', 't'); git(r5, 'config', 'user.email', 't@example.invalid'); git(r5, 'config', 'core.autocrlf', 'false');
    write(path.join(r5, 'lint.js'), LINT_JS); write(path.join(r5, 'AGENTS.md'), '# p\n\n```yaml\nlint_command: "node lint.js {files}"\n```\n'); git(r5, 'add', '-A'); git(r5, 'commit', '-qm', 'i');
    const f5 = steps([o => write(path.join(o.cwd, 'c.js'), 'console.log(2)\n'), o => write(path.join(o.cwd, 'c.js'), 'module.exports=2\n')]);
    const g5 = await L.go({ ...quiet, root: r5, goal: 'add c', run: f5 });
    R.check('[LT-05] 테스트 없이 린트만 있어도 린트로 돌려보낸다', g5.status === 'done' && f5.calls.length === 2, `${g5.status} ${f5.calls.length}`);

    // LT-06 — 프롬프트가 린트 명령을 알리고 · 작업자가 그 프로그램을 돌릴 수 있다
    R.check('[LT-06] 첫 프롬프트에 린트 명령 · 작업자 허용에 린트 프로그램', /node lint\.js/.test(f1.calls[0].prompt) && (f1.calls[0].allowCommands || []).includes('node'), f1.calls[0].prompt.slice(-600));

    // LT-07 — 한국어 작업의 보고
    const r7 = repo('node lint.js {files}');
    const g7 = await L.go({ ...quiet, root: r7, goal: '깨끗한 기능 추가', run: steps([o => write(path.join(o.cwd, 'k.js'), 'module.exports=3\n')]) });
    R.check('[LT-07] 한국어 보고에 "린트:" 줄', /^린트: 통과/m.test(g7.report), g7.report);

    // LT-08 — {files} 치환: 바뀐 파일이 없으면 린트를 돌리지 않는다 · 경로에 공백이 있어도 한 인자
    R.check('[LT-08] {files} 치환 — 공백 경로는 따옴표 · 빈 목록이면 null', K.lintArgv('node lint.js {files}', ['a b.js', 'c.js']).join('|') === 'node lint.js "a b.js" c.js' && K.lintArgv('node lint.js {files}', []) === null,
      JSON.stringify([K.lintArgv('node lint.js {files}', ['a b.js', 'c.js']), K.lintArgv('node lint.js {files}', [])]));

    // ── [2026-10-15 자동 이슈 #4] 같은 시험 DB 를 쓰는 작업 둘이 동시에 검사하면 서로 멈췄다 — serial_checks: true 면 프로젝트 단위로 하나씩 ──
    const rs = repo(null);
    const SLOW = `const fs=require('fs');fs.appendFileSync(process.argv[1]+'.log','start '+Date.now()+'\\n');setTimeout(()=>{fs.appendFileSync(process.argv[1]+'.log','end '+Date.now()+'\\n');console.log('# pass 1\\n# fail 0')},700)`;
    const spans = async (serialRoot, tag) => {
      const f = path.join(base, `slow-${tag}.js`); write(f, SLOW);
      await Promise.all([1, 2].map(() => K.runAll(rs, [['node', f]], { serialRoot })));
      const ev = fs.readFileSync(`${f}.log`, 'utf8').trim().split('\n').map(l => l.split(' ')).map(([k, t]) => ({ k, t: Number(t) })).sort((a, b) => a.t - b.t);
      return ev.map(e => e.k).join(',');
    };
    const serial = await spans(rs, 'on'), parallel = await spans(null, 'off');
    R.check('[SC-01] serialRoot 가 있으면 같은 프로젝트의 검사가 겹치지 않는다(start,end,start,end) · 없으면 겹친다', serial === 'start,end,start,end' && parallel === 'start,start,end,end', `${serial} | ${parallel}`);
    const rs2 = repo(null, { 'CLAUDE.md': '```yaml\nserial_checks: true\n```\n' });
    const ts2 = await L.go({ ...quiet, root: rs2, goal: 'x', run: async o => { write(path.join(o.cwd, 'f.txt'), 'x\n'); return { ok: true, session_id: 's', final_text: 'ok', cost_usd: 0, is_error: false, permission_denials: [] }; } });
    const ts1 = await L.go({ ...quiet, root: rs, goal: 'x', run: async o => { write(path.join(o.cwd, 'f.txt'), 'x\n'); return { ok: true, session_id: 's', final_text: 'ok', cost_usd: 0, is_error: false, permission_denials: [] }; } });
    R.check('[SC-02] 프로젝트 블록 serial_checks: true → 작업에 기록(resume · accept 도 같은 값) · 없으면 꺼짐', S.readTask(rs2, ts2.id).checks.serial === true && !S.readTask(rs, ts1.id).checks.serial, `${ts2.status} ${JSON.stringify(S.readTask(rs2, ts2.id).checks.serial)} ${JSON.stringify(S.readTask(rs, ts1.id).checks.serial)}`);

    // ── [2026-10-16 사용자 지시 · 영상 「쓰레기 코드 없애는 법」] 중복 코드 — 작업이 더한 코드가 있는 코드를 블록째 베꼈는가 ──
    const Dup = require('../../harness/lib/dup');
    const FN = ['function total(items) {', '  let sum = 0;', '  for (const it of items) {', '    if (!it || it.skip) continue;', '    const v = Number(it.price) * Number(it.qty || 1);', '    if (Number.isNaN(v)) throw new Error("bad item");', '    sum += v;', '  }', '  const tax = Math.round(sum * 0.1);', '  return sum + tax;', '}', ''].join('\n');
    const dupRepo = () => { const d = repo(null, { 'src/a.js': `${FN}module.exports = { total };\n` }); return d; };
    const commitIn = (d, files) => { for (const [f, t] of Object.entries(files)) write(path.join(d, f), t); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'work'); };
    {
      const d1 = dupRepo(), b1 = git(d1, 'rev-parse', 'HEAD');
      commitIn(d1, { 'src/b.js': `// copied\n${FN.replace('function total', 'function total2')}module.exports = { total2 };\n` });
      const f1 = Dup.find(d1, b1);
      R.check('[DU-01] 작업이 있는 함수를 그대로 베끼면(이름만 바꿔도 나머지 줄) 위치와 원본을 찾는다', f1.length === 1 && f1[0].file === 'src/b.js' && /src\/a\.js:\d+-\d+/.test(f1[0].other) && f1[0].lines >= 8, JSON.stringify(f1));
      const d2 = dupRepo(), b2 = git(d2, 'rev-parse', 'HEAD');
      commitIn(d2, { 'src/c.js': 'const { total } = require("./a");\nmodule.exports = items => total(items.filter(Boolean));\n' });
      R.check('[DU-02] 있는 함수를 불러 쓰면 중복이 아니다', Dup.find(d2, b2).length === 0);
      const d3 = repo(null), b3 = git(d3, 'rev-parse', 'HEAD');
      commitIn(d3, { 'src/n.js': `${FN}${FN.replace('function total', 'function again')}` });
      R.check('[DU-03] 새로 더한 코드 안에서 같은 블록을 두 번 쓴 것도 찾는다', Dup.find(d3, b3).length === 1, JSON.stringify(Dup.find(d3, b3)));
      const d4 = dupRepo(), b4 = git(d4, 'rev-parse', 'HEAD');
      commitIn(d4, { 'tests/a.test.js': FN, 'src/a.generated.js': FN });
      R.check('[DU-04] 테스트 · 생성 파일은 보지 않는다', Dup.find(d4, b4).length === 0, JSON.stringify(Dup.find(d4, b4)));
    }
    {
      // 루프: 베낀 첫 턴 → 하네스가 한 번 돌려보냄 → 둘째 턴에 재사용으로 고침 → done · 중복 없음
      const d5 = dupRepo();
      const f5 = fake5 => fake5;
      const calls5 = [];
      const run5 = async o => { calls5.push(o.prompt); if (calls5.length === 1) write(path.join(o.cwd, 'src/b.js'), `${FN.replace('function total', 'function total2')}module.exports = { total2 };\n`); else write(path.join(o.cwd, 'src/b.js'), 'const { total } = require("./a");\nmodule.exports = { total2: total };\n'); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; };
      const t5 = await L.go({ ...quiet, root: d5, goal: 'add total2', run: run5 });
      R.check('[DU-05] 루프: 중복을 만든 턴은 위치를 알려 한 번 돌려보내고, 고치면 done(보고에 중복 없음)', t5.status === 'done' && calls5.length === 2 && /duplicat/i.test(calls5[1]) && /src\/a\.js/.test(calls5[1]) && /duplicate code: none/.test(t5.report), `${t5.status} ${calls5.length} ${t5.report.slice(0, 400)}`);
      const d6 = dupRepo(); const calls6 = [];
      const run6 = async o => { calls6.push(o.prompt); write(path.join(o.cwd, 'src/b.js'), `${FN.replace('function total', 'function total2')}module.exports = { total2 };\n`); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; };
      const t6 = await L.go({ ...quiet, root: d6, goal: 'add total2', run: run6 });
      R.check('[DU-06] 돌려보내도 남으면 막지 않고(done · 정체 아님) 보고 맨 위 주의에 남긴다', t6.status === 'done' && calls6.length === 2 && /중복|duplicate/i.test(t6.report.split('\n').slice(0, 6).join('\n')), `${t6.status} ${calls6.length} ${t6.report.slice(0, 500)}`);
      const d7 = repo(null, { 'src/a.js': `${FN}module.exports = { total };\n`, 'CLAUDE.md': '```yaml\ndup_check: off\n```\n' }); const calls7 = [];
      const t7 = await L.go({ ...quiet, root: d7, goal: 'add total2', run: async o => { calls7.push(o.prompt); write(path.join(o.cwd, 'src/b.js'), FN.replace('function total', 'function total2')); return { ok: true, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.1, is_error: false, permission_denials: [] }; } });
      // [2026-10-17 적대적 검증] 커밋 전(추적되지 않은) 새 파일은 "더한 줄" 을 세지 못해 베낀 코드를 놓쳤다
      const d8 = repo(null, { 'src/a.js': `${FN}module.exports = { total };\n` }), b8 = git(d8, 'rev-parse', 'HEAD');
      write(path.join(d8, 'src', '새 파일.js'), FN.replace('function total', 'function untracked').replace(/\n/g, '\r\n'));
      R.check('[DU-08] 추적되지 않은 새 파일(한글 · 공백 이름 · CRLF)의 베낀 코드도 찾는다', Dup.find(d8, b8).length === 1, JSON.stringify(Dup.find(d8, b8)));
      R.check('[DU-07] dup_check: off 면 보지 않는다', t7.status === 'done' && calls7.length === 1, `${t7.status} ${calls7.length}`);
    }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
