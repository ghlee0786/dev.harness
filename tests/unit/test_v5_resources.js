'use strict';
// 자원 장부(PRD R1) — 작업마다의 임시 폴더 · 데이터 구역 · compose 이름, 작업 끝 · accept · cancel · gc 때의 회수, 남은 것 보고.
//   docker 는 가짜 실행기로 명령 모양만 잰다(실제 컨테이너를 만들지 않는다). 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const Res = require('../../harness/lib/resources');
const P = require('../../harness/lib/proc');
const S = require('../../harness/lib/state');
const L = require('../../harness/lib/loop');
const I = require('../../harness/lib/integrate');
const St = require('../../harness/lib/status');
const R = makeReporter('자원 장부 — 임시 폴더 · 데이터 구역 · 회수 · 남은 것');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-res-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
const ID = 't-20261020-101010-abcd';
let seq = 0;
function repo(files) {
  const d = path.join(base, `r${++seq}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false');
  for (const [f, t] of Object.entries(files)) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
// 가짜 docker — 명령을 기록하고, 목록 응답은 표로 준다(rm 뒤에는 남은 것만)
function fakeDocker(state) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'version') return { code: state.up ? 0 : 1, out: state.up ? '27.0' : '', err: state.up ? '' : 'Cannot connect' };
    const kind = args[0] === 'ps' ? 'containers' : args[0] === 'images' ? 'images' : `${args[0]}s`;
    if (args[0] === 'ps' && args.some(a => /^name=/.test(a))) return { code: 0, out: (state.named || []).join('\n'), err: '' };   // 이름으로 고른 단독 컨테이너
    if (/^(ps|images)$/.test(args[0]) || args[1] === 'ls') return { code: 0, out: (state[kind] || []).join('\n'), err: '' };
    if (args[0] === 'rm' || args[0] === 'rmi' || args[1] === 'rm') { const k = args[0] === 'rm' ? 'containers' : args[0] === 'rmi' ? 'images' : `${args[0]}s`; state[k] = (state[k] || []).filter(x => !args.includes(x) || (state.stuck || []).includes(x)); if (k === 'containers') state.named = (state.named || []).filter(x => !args.includes(x) || (state.stuck || []).includes(x)); return { code: 0, out: '', err: '' }; }
    return { code: 0, out: '', err: '' };
  };
  return { run, calls };
}

(async () => {
  try {
    // RS-01 — 작업 worktree 의 환경: 작업마다의 임시 폴더 · 데이터 구역 · compose 이름. worktree 밖이면 아무것도 없다.
    const root = path.join(base, 'main');
    const wtSub = path.join(root, '.harness-worktrees', ID, 'src');
    const env = Res.envFor(wtSub), env2 = P.isolationEnv(wtSub);
    const dir = Res.tmpDirFor(root, ID);
    R.check('[RS-01] worktree 안: TEMP · TMP · TMPDIR = 작업의 임시 폴더(만들어 둔다) · COMPOSE_PROJECT_NAME · HARNESS_TASK_ID · HARNESS_DATA_NS',
      env.TEMP === dir && env.TMP === dir && env.TMPDIR === dir && fs.existsSync(dir) && env.COMPOSE_PROJECT_NAME === `harness-${ID}` && env.HARNESS_TASK_ID === ID && env.HARNESS_DATA_NS === 'harness_20261020_101010_abcd', JSON.stringify(env));
    R.check('[RS-01] proc.isolationEnv 는 자원 장부의 환경을 그대로 쓴다(작업자 · 하네스 검사 모두) · worktree 밖이면 빈 환경', JSON.stringify(env2) === JSON.stringify(env) && JSON.stringify(P.isolationEnv(root)) === '{}', JSON.stringify(env2));
    R.check('[RS-01] 임시 폴더는 저장소 밖(OS 임시 폴더 아래) — 저장소 · .git 안이 아니다', !path.resolve(dir).toLowerCase().startsWith(path.resolve(root).toLowerCase()) && dir.includes(`${path.sep}harness${path.sep}`), dir);
    R.check('[RS-01] 데이터 구역 이름은 DB · 큐 이름에 그대로 쓸 수 있다(소문자 · 숫자 · 밑줄)', /^[a-z0-9_]+$/.test(Res.dataNs(ID)) && Res.dataNs('t-20261020-101010-ABCD') === 'harness_20261020_101010_abcd');
    // 작업 환경 안에서 하네스를 다시 불러도(TEMP 가 이미 작업 폴더) 겹겹이 들어가지 않는다
    const keep = process.env.HARNESS_TMP_BASE; process.env.HARNESS_TMP_BASE = keep || os.tmpdir();   // 작업 환경이 물려주는 바탕(러너가 준 것이 있으면 그것)
    const keepT = process.env.TEMP; process.env.TEMP = dir;
    const nested = Res.tmpDirFor(root, ID);
    if (keep === undefined) delete process.env.HARNESS_TMP_BASE; else process.env.HARNESS_TMP_BASE = keep;
    if (keepT === undefined) delete process.env.TEMP; else process.env.TEMP = keepT;
    R.check('[RS-01] 작업 환경 안에서 다시 계산해도 같은 폴더(HARNESS_TMP_BASE 로 바탕을 물려준다)', nested === dir, nested);

    // RS-02 — docker: 작업 끝에는 컨테이너 · 네트워크, 치울 때는 + 볼륨 · 이미지. 이름표로만 고른다. 없으면 건너뛴다.
    const st = { up: true, containers: ['c1', 'c2'], networks: ['n1'], volumes: ['v1'], images: ['i1'] };
    const d1 = fakeDocker(st);
    const rt = Res.teardownCompose(ID, 'runtime', d1.run);
    const label = `label=com.docker.compose.project=harness-${ID}`;
    R.check('[RS-02] 작업 끝(runtime): 이 작업의 이름표가 붙은 컨테이너 · 네트워크만 지운다 — 볼륨 · 이미지는 그대로',
      d1.calls.includes(`docker ps -aq --filter ${label}`) && d1.calls.includes('docker rm -f -v c1 c2') && d1.calls.includes('docker network rm n1') && !d1.calls.some(c => /volume|rmi/.test(c)) && rt.removed.containers === 2 && st.volumes.length === 1, JSON.stringify({ calls: d1.calls, rt }));
    const d2 = fakeDocker(st);
    const all = Res.teardownCompose(ID, 'all', d2.run);
    R.check('[RS-02] 치울 때(all): 볼륨 · 이미지(harness-<id>*)까지', d2.calls.includes(`docker volume ls -q --filter ${label}`) && d2.calls.includes('docker volume rm -f v1') && d2.calls.includes(`docker images -q --filter reference=harness-${ID}*`) && d2.calls.includes('docker rmi -f i1') && all.residue.length === 0, JSON.stringify(d2.calls));
    const st5 = { up: true, containers: ['c1'], named: ['p1'] };
    const d5 = fakeDocker(st5), rn = Res.teardownCompose(ID, 'runtime', d5.run);
    R.check('[RS-02] 이름표 없이 docker run 으로 띄운 harness-<id>… 컨테이너도(이름 앞머리로 고른다) 익명 볼륨까지 지운다',
      d5.calls.includes(`docker ps -aq --filter name=^/?harness-${ID}`) && d5.calls.includes('docker rm -f -v p1') && rn.removed.containers === 2 && !st5.named.length, JSON.stringify({ calls: d5.calls, rn }));
    const st3 = { up: true, containers: ['c9'], stuck: ['c9'] };
    const r3 = Res.teardownCompose(ID, 'runtime', fakeDocker(st3).run);
    R.check('[RS-02] 지워지지 않은 것은 남은 것(residue)으로 보고한다', r3.residue.length === 1 && /docker container c9/.test(r3.residue[0]), JSON.stringify(r3));
    const d4 = fakeDocker({ up: false, containers: ['c1'] });
    const r4 = Res.teardownCompose(ID, 'all', d4.run);
    R.check('[RS-02] docker 가 없거나 꺼져 있으면 건너뛴다(오류가 아니다)', r4.skipped && d4.calls.length === 1 && r4.residue.length === 0, JSON.stringify({ r4, calls: d4.calls }));

    // RS-03 — 프로젝트 정리 명령(cleanup_command): 데이터 구역 이름을 받아 돈다 · 실패는 남은 것으로
    const out = path.join(base, 'cleanup-out.txt');
    const rc = repo({ 'AGENTS.md': '# p\n\n```yaml\ncleanup_command: "node cleanup.js"\n```\n', 'cleanup.js': `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.HARNESS_DATA_NS + ' ' + process.env.HARNESS_TASK_ID);\n` });
    const c1 = Res.runCleanupCommand(rc, ID);
    R.check('[RS-03] cleanup_command 는 HARNESS_DATA_NS · HARNESS_TASK_ID 를 받아 저장소 루트에서 돈다', c1 && c1.ok && fs.readFileSync(out, 'utf8') === `harness_20261020_101010_abcd ${ID}`, JSON.stringify(c1));
    R.check('[RS-03] cleanup_command 가 없으면 아무것도 하지 않는다', Res.runCleanupCommand(base, ID, {}) === null);
    const task = { id: ID }, dirC = Res.tmpDirFor(rc, ID);
    fs.mkdirSync(dirC, { recursive: true }); write(path.join(dirC, 'junk', 'a.bin'), 'x');
    const rel = Res.release(rc, task, { run: fakeDocker({ up: false }).run, cleanup: { command: 'node -e "process.exit(3)"' } });
    R.check('[RS-03] 치우기(release): 임시 폴더를 지우고 · 실패한 정리 명령은 남은 것으로 · 작업 기록에 회수 시각 · 이름들',
      !fs.existsSync(dirC) && rel.tmp.removed && rel.residue.some(x => /cleanup_command failed \(exit 3\)/.test(x)) && task.resources.release_at && task.resources.data_ns === 'harness_20261020_101010_abcd' && task.resources.compose_project === `harness-${ID}`, JSON.stringify({ rel, res: task.resources }));

    // RS-04 — 실제 작업으로: 하네스 검사가 작업의 임시 폴더에서 돌고, 작업이 끝나면 그 폴더가 사라진다 · gc 가 정리 명령을 돌린다
    const seen = path.join(base, 'seen.json'), cleaned = path.join(base, 'cleaned.txt');
    const CHECK = `const fs=require('fs'),p=require('path');fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({TEMP:process.env.TEMP,NS:process.env.HARNESS_DATA_NS}));fs.writeFileSync(p.join(process.env.TEMP,'garbage.log'),'x');console.log('# pass 1\\n# fail 0');\n`;
    const r5 = repo({ 'AGENTS.md': '# p\n\n```yaml\ntest_command: "node check.js"\ncleanup_command: "node cleanup.js"\n```\n', 'check.js': CHECK,
      'cleanup.js': `require('fs').writeFileSync(${JSON.stringify(cleaned)}, process.env.HARNESS_DATA_NS);\n` });
    const run5 = async o => { write(path.join(o.cwd, 'feat.js'), 'module.exports = 1;\n'); return { ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.01, permission_denials: [] }; };
    const t5 = await L.go({ ...quiet, root: r5, goal: 'add feat', run: run5 });
    let s5 = {}; try { s5 = JSON.parse(fs.readFileSync(seen, 'utf8')); } catch { /* 검사가 돌지 않았다 */ }
    const tmp5 = Res.tmpDirFor(r5, t5.id);
    R.check('[RS-04] 하네스 검사는 작업의 임시 폴더를 TEMP 로 · 데이터 구역 이름을 받는다', t5.status === 'done' && path.resolve(s5.TEMP || '') === path.resolve(tmp5) && s5.NS === Res.dataNs(t5.id), JSON.stringify({ status: t5.status, s5, tmp5 }));
    const task5 = S.readTask(r5, t5.id);
    R.check('[RS-04] 작업이 끝나면 임시 폴더(검사가 남긴 쓰레기 포함)가 사라지고 기록된다 · 비면 저장소 키 폴더도', !fs.existsSync(tmp5) && !fs.existsSync(path.dirname(tmp5)) && task5.resources && task5.resources.end_at && (task5.resources.residue || []).length === 0, JSON.stringify(task5.resources));
    const g5 = St.gc({ root: r5 });
    const task5b = S.readTask(r5, t5.id);
    R.check('[RS-04] gc: 끝난 작업을 한 번 회수한다 — 프로젝트 정리 명령이 그 작업의 데이터 구역으로 돈다', fs.existsSync(cleaned) && fs.readFileSync(cleaned, 'utf8') === Res.dataNs(t5.id) && task5b.resources.release_at && (g5.released || []).some(x => x.id === t5.id && x.cleanup === true), JSON.stringify({ released: g5.released, res: task5b.resources }));
    fs.rmSync(cleaned, { force: true });
    St.gc({ root: r5 });
    R.check('[RS-04] gc 를 다시 해도 같은 작업을 또 회수하지 않는다', !fs.existsSync(cleaned));

    // RS-05 — accept · cancel 도 회수한다
    const t6 = await L.go({ ...quiet, root: r5, goal: 'add feat 2', run: async o => { write(path.join(o.cwd, 'feat2.js'), 'module.exports = 2;\n'); return { ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.01, permission_denials: [] }; } });
    const acc = await I.accept({ ...quiet, root: r5, id: t6.id });
    R.check('[RS-05] accept 는 그 작업의 자원을 회수한다(정리 명령 포함)', acc.status === 'accepted' && S.readTask(r5, t6.id).resources.release_at && fs.readFileSync(cleaned, 'utf8') === Res.dataNs(t6.id), JSON.stringify({ status: acc.status, res: S.readTask(r5, t6.id).resources }));
    const t7 = await L.go({ ...quiet, root: r5, goal: 'add feat 3', run: async o => { write(path.join(o.cwd, 'feat3.js'), 'module.exports = 3;\n'); return { ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.01, permission_denials: [] }; } });
    const can = await I.cancel({ ...quiet, root: r5, id: t7.id });
    R.check('[RS-05] cancel 도 회수한다', can.status === 'cancelled' && S.readTask(r5, t7.id).resources.release_at && fs.readFileSync(cleaned, 'utf8') === Res.dataNs(t7.id), JSON.stringify({ status: can.status, res: S.readTask(r5, t7.id).resources }));
    // RS-07 — 쓰기 소유권(PRD R3): go --owns → 작업 기록 · 작업자 환경(HARNESS_OWNS) · 지시문 · 잘못된 경로 거부
    let envSeen = null, promptSeen = '';
    const t8 = await L.go({ ...quiet, root: r5, goal: 'billing only', owns: ['src/billing/**', 'tests/billing/**'], run: async o => { envSeen = P.isolationEnv(o.cwd); promptSeen = o.prompt; write(path.join(o.cwd, 'src', 'billing', 'b.js'), 'module.exports = 1;\n'); return { ok: true, is_error: false, session_id: o.newSessionId || o.sessionId, final_text: 'ok', cost_usd: 0.01, permission_denials: [] }; } });
    R.check('[RS-07] --owns: 작업 기록에 남고 · 작업자 환경에 HARNESS_OWNS(JSON) · 지시문에 소유 경로와 "밖은 DECISIONS.md 에"',
      t8.status === 'done' && JSON.stringify(S.readTask(r5, t8.id).owns) === JSON.stringify(['src/billing/**', 'tests/billing/**']) && envSeen && envSeen.HARNESS_OWNS === JSON.stringify(['src/billing/**', 'tests/billing/**']) && /You may change only these paths: `src\/billing\/\*\*`, `tests\/billing\/\*\*`/.test(promptSeen) && /DECISIONS\.md` what must change/.test(promptSeen),
      JSON.stringify({ status: t8.status, env: envSeen && envSeen.HARNESS_OWNS }));
    let bad = null; try { await L.go({ ...quiet, root: r5, goal: 'x', owns: ['../other/**'], run: async o => ({ ok: true, session_id: o.newSessionId }) }); } catch (e) { bad = e; }
    let bad2 = null; try { await L.go({ ...quiet, root: r5, goal: 'x', owns: ['C:/abs/**'], run: async o => ({ ok: true, session_id: o.newSessionId }) }); } catch (e) { bad2 = e; }
    R.check('[RS-07] --owns 는 저장소 안의 상대 경로만(.. · 절대 경로는 거부)', bad && bad.code === 'USAGE' && bad2 && bad2.code === 'USAGE', String(bad && bad.message));
    const op = require('../../harness/lib/policy').claudeSettings([], [], 'open');
    R.check('[RS-07] 작업자 설정: guard 훅이 Edit · Write · MultiEdit · NotebookEdit 도 거친다(소유 경로 강제)', /Edit\|Write\|MultiEdit\|NotebookEdit/.test(op.hooks.PreToolUse[0].matcher), op.hooks.PreToolUse[0].matcher);
    // RS-08 — 남은 프로세스: 이 작업 worktree 경로가 명령줄에 있고 작업 시작 뒤 생긴 것만 끝낸다(실제 프로세스) — 다른 작업 · 시작 전 · 편집기는 그대로
    const { spawn } = require('node:child_process');
    const PID8 = 't-20261020-121212-beef', OTHER = 't-20261020-121212-bee0';
    const wt8 = path.join(base, 'r8', '.harness-worktrees', PID8, 'x'), wt8o = path.join(base, 'r8', '.harness-worktrees', OTHER, 'x');
    const enc8 = `C--r8--harness-worktrees-${PID8}`;   // Claude Code 가 작업 폴더 경로로 만드는 임시 폴더 이름 꼴
    const keepAlive = 'setInterval(() => {}, 1e6)';
    const before = spawn(process.execPath, ['-e', keepAlive, wt8], { stdio: 'ignore', windowsHide: true });
    await new Promise(r => setTimeout(r, 1500));
    const since8 = Date.now();
    await new Promise(r => setTimeout(r, 1500));
    const mineA = spawn(process.execPath, ['-e', keepAlive, wt8], { stdio: 'ignore', windowsHide: true });
    const mineB = spawn(process.execPath, ['-e', keepAlive, path.join(base, enc8, 'tasks', 'b1.output')], { stdio: 'ignore', windowsHide: true });
    const other = spawn(process.execPath, ['-e', keepAlive, wt8o], { stdio: 'ignore', windowsHide: true });
    await new Promise(r => setTimeout(r, 1500));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const offEnv = process.env.HARNESS_PROC_CLEANUP; delete process.env.HARNESS_PROC_CLEANUP;   // 테스트 러너가 끈 것을 이 단언에서만 켠다
    const k8 = Res.killStrays(PID8, { since: since8 + 60000 });   // since 는 1분 여유를 빼고 쓰므로 +1분 = 정확히 since8
    if (offEnv !== undefined) process.env.HARNESS_PROC_CLEANUP = offEnv;
    await new Promise(r => setTimeout(r, 1500));
    const killedPids = k8.killed.map(x => x.pid).sort();
    R.check('[RS-08] 이 작업 worktree 경로(그대로 · Claude 임시 폴더 꼴)를 가진, 작업 시작 뒤의 프로세스만 끝낸다 — 다른 작업 · 시작 전 프로세스는 남는다',
      JSON.stringify(killedPids) === JSON.stringify([mineA.pid, mineB.pid].sort()) && !alive(mineA.pid) && !alive(mineB.pid) && alive(other.pid) && alive(before.pid) && !k8.residue.length,
      JSON.stringify({ killed: killedPids, want: [mineA.pid, mineB.pid], other: alive(other.pid), before: alive(before.pid), residue: k8.residue }));
    for (const c of [before, other]) { try { c.kill(); } catch { /* 이미 끝남 */ } }
    const fakeList = [{ pid: 11, started: Date.now(), cmd: `"C:\\Program Files\\Microsoft VS Code\\Code.exe" ${wt8}` }, { pid: 12, started: Date.now(), cmd: `tail -f ${wt8}/log` }];
    const killedFake = [];
    Res.killStrays(PID8, { since: Date.now() - 1000, procs: () => fakeList, kill: pid => killedFake.push(pid) });
    R.check('[RS-08] 사용자가 그 폴더를 연 편집기(Code 등)는 끝내지 않는다', JSON.stringify(killedFake) === '[12]', JSON.stringify(killedFake));

    // RS-10 — 작업자가 끝나면 남긴 자손을 거둔다(명령줄에 경로가 없어도) — 작업자 역할의 node 가 끝나지 않는 손자를 띄우고 먼저 끝난다
    const worker = path.join(base, 'worker10.js');
    write(worker, "const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', detached: true, windowsHide: true }); g.unref(); console.log('GRAND ' + g.pid);\n");
    const bystander = spawn(process.execPath, ['-e', keepAlive], { stdio: 'ignore', windowsHide: true });
    const off10 = process.env.HARNESS_PROC_CLEANUP; delete process.env.HARNESS_PROC_CLEANUP;
    const p10 = await P.spawnCapture({ exe: process.execPath, args: [worker], cwd: base, reapTree: true, timeoutMs: 60000 });
    if (off10 !== undefined) process.env.HARNESS_PROC_CLEANUP = off10;
    const grand = Number((/GRAND (\d+)/.exec(p10.stdout) || [])[1]);
    await new Promise(r => setTimeout(r, 1500));
    R.check('[RS-10] 작업자가 끝나면 남긴 손자(경로 없는 대기 루프 꼴)를 거둔다 · 무관한 프로세스는 그대로',
      grand > 0 && !alive(grand) && (p10.reaped || []).some(x => x.pid === grand) && alive(bystander.pid), JSON.stringify({ grand, alive: grand && alive(grand), reaped: p10.reaped, bystander: alive(bystander.pid) }));
    try { bystander.kill(); } catch { /* 이미 끝남 */ }
    if (grand && alive(grand)) { try { process.kill(grand); } catch { /* 이미 끝남 */ } }

    // RS-09 — CLI 는 할 일을 마치면 남은 핸들이 있어도 끝난다(분리된 go 가 done 뒤 24분 살아 있던 실측) — 새는 타이머를 미리 심어 재현
    const leak = path.join(base, 'leak.js'); write(leak, 'setInterval(() => {}, 1000);\n');
    const r9 = repo({ 'a.txt': 'x\n' }), t9 = Date.now();
    const cli9 = spawnSync(process.execPath, ['-r', leak, path.join(__dirname, '..', '..', 'harness', 'cli.js'), 'status', '--root', r9], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    R.check('[RS-09] 남은 핸들(타이머)이 있어도 CLI 는 일을 마치고 몇 초 안에 끝난다(종료 코드 유지)', !cli9.error && cli9.status === 0 && Date.now() - t9 < 25000, JSON.stringify({ err: cli9.error && cli9.error.code, status: cli9.status, ms: Date.now() - t9, out: (cli9.stdout || '').slice(0, 120) }));
    R.check('[RS-06] 작업자 지시문: 쓰레기를 남기지 않는 곳($TEMP · $HARNESS_DATA_NS)을 알려 준다', /\$HARNESS_DATA_NS/.test(require('../../harness/lib/prompts').AUTONOMY || '') || /\$HARNESS_DATA_NS/.test(JSON.stringify(require('../../harness/lib/prompts'))), 'AUTONOMY');
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
