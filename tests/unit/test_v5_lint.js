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
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
