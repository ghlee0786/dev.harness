'use strict';
// push · stop — 버그 2026-10-01(Python 서비스 저장소) 두 건의 공식 경로.
//   push: guard 가 에이전트의 git push 를 무조건 막는데 AGENTS.md 는 "명시한 뒤에만" 이라 적었다 → 좁힌 하네스 명령으로 허락의 길.
//   stop: 실행 중 작업을 멈출 공식 방법이 없어 셸을 죽였고, 작업이 OWNER DEAD 로 남았다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const Push = require('../../harness/lib/push.js'), Stop = require('../../harness/lib/stop.js');
const S = require('../../harness/lib/state'), I = require('../../harness/lib/integrate');
const R = makeReporter('push · stop — 허락의 길과 멈추는 길');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-pushstop-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const cfg = d => { git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false'); git(d, 'config', 'core.autocrlf', 'false'); };

(async () => {
  try {
    // ── push ──
    const bare = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    const a = path.join(base, 'a');
    git(base, 'clone', '-q', bare, a); cfg(a);
    write(path.join(a, 'x.txt'), '1\n'); git(a, 'add', '-A'); git(a, 'commit', '-qm', 'one'); git(a, 'push', '-q', '-u', 'origin', 'main');
    write(path.join(a, 'x.txt'), '2\n'); git(a, 'commit', '-qam', 'two');
    const dry = Push.push({ root: a, dryRun: true });
    R.check('[PS-01] dry-run: 올릴 커밋을 보여 주고 원격은 그대로', dry.ok && dry.dryRun && dry.ahead === 1 && dry.remote === 'origin' && git(bare, 'rev-parse', 'main') !== git(a, 'rev-parse', 'main'), JSON.stringify(dry).slice(0, 200));
    const cli = spawnSync(process.execPath, [CLI, 'push', '--root', a], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    R.check('[PS-02] CLI push: 빨리감기면 올린다(원격 = 로컬) · exit 0', cli.status === 0 && git(bare, 'rev-parse', 'main') === git(a, 'rev-parse', 'main') && /PUSHED/.test(cli.stdout), `${cli.status} ${cli.stdout} ${cli.stderr}`);
    const nothing = Push.push({ root: a });
    R.check('[PS-03] 올릴 것이 없으면 아무것도 하지 않는다', nothing.ok && !nothing.pushed && /nothing to push/.test(nothing.reason));
    // 원격이 앞서면(다른 클론이 먼저 올림) 강제로 덮지 않고 거부
    const b = path.join(base, 'b');
    git(base, 'clone', '-q', bare, b); cfg(b);
    write(path.join(b, 'y.txt'), 'b\n'); git(b, 'add', '-A'); git(b, 'commit', '-qm', 'from b'); git(b, 'push', '-q', 'origin', 'main');
    write(path.join(a, 'x.txt'), '3\n'); git(a, 'commit', '-qam', 'three');
    const behind = Push.push({ root: a });
    const remoteNow = git(bare, 'rev-parse', 'main');
    R.check('[PS-04] 원격이 앞서면 거부(강제 push 없음) · 원격 그대로', behind.refused && /not a fast-forward/.test(behind.reason) && remoteNow === git(b, 'rev-parse', 'main'), behind.reason);
    git(a, 'branch', 'harness/t-20261001-000000-abcd');
    let e1 = null; try { Push.push({ root: a, branch: 'harness/t-20261001-000000-abcd' }); } catch (e) { e1 = e; }
    R.check('[PS-05] 결과 브랜치(harness/*)는 올리지 않는다(USAGE)', e1 && e1.code === 'USAGE' && /accept it/.test(e1.message), e1 && e1.message);
    const guard = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'harness', 'hooks', 'guard.js')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: a, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }), encoding: 'utf8', windowsHide: true });
    R.check('[PS-06] guard 는 git push 를 막고 이유에 `node harness/cli.js push` 를 안내한다', /deny/.test(guard.stdout) && /harness\/cli\.js push/.test(guard.stdout), guard.stdout.slice(0, 300));
    const guardOk = spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'harness', 'hooks', 'guard.js')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: a, tool_name: 'Bash', tool_input: { command: 'node harness/cli.js push origin main' } }), encoding: 'utf8', windowsHide: true });
    R.check('[PS-06] guard 는 하네스 push 명령은 통과시킨다(사람의 승인은 Claude Code 권한 프롬프트가 받는다)', !/deny/.test(guardOk.stdout), guardOk.stdout);
    const authOut = Push.format({ ok: false, remote: 'gitea', branch: 'main', reason: 'would push 1 commit(s)', fetchError: "remote: Failed to authenticate user\nfatal: Authentication failed for 'http://h/r.git/'" });
    const plainOut = Push.format({ ok: false, remote: 'gitea', branch: 'main', reason: 'git push failed: fatal: unable to access: Could not resolve host' });
    R.check('[PS-07] 인증 실패면 자기 터미널에서 자격을 저장하라고 안내한다 · 다른 실패에는 안내하지 않는다', /hint: authentication to gitea failed — run `git fetch gitea`/.test(authOut) && !/hint:/.test(plainOut), authOut + '\n--\n' + plainOut);

    // ── stop ──
    const r = path.join(base, 'repo');
    fs.mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); cfg(r);
    write(path.join(r, 'a.txt'), 'a\n'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'init');
    const id = 't-20261001-000001-beef', P = S.taskPaths(r, id);
    git(r, 'worktree', 'add', '-q', '-b', P.branch, P.wt, 'main');
    write(path.join(P.wt, 'wip.txt'), 'half done\n');
    const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    await new Promise(res => setTimeout(res, 300));
    S.writeTask(r, S.newTask({ id, goal: 'g', runtime: 'claude', model: 'opus', base_branch: 'main', base_commit: git(r, 'rev-parse', 'HEAD'), branch: P.branch, worktree: P.wt,
      owner: { pid: owner.pid, host: os.hostname(), heartbeat_at: new Date().toISOString() }, caps: { budget_usd: 1, wall_min: 10, max_continuations: 1 } }));
    const t0 = S.readTask(r, id); t0.status = 'running'; S.writeTask(r, t0);
    const refusedCancel = await I.cancel({ log: () => {}, root: r, id });
    R.check('[ST-01] 주인이 살아 있으면 cancel 은 거부하고 stop 을 안내한다', refusedCancel.refused && /harness\/cli\.js stop/.test(refusedCancel.reason), refusedCancel.reason);
    const st = spawnSync(process.execPath, [CLI, 'stop', id, '--root', r], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const t1 = S.readTask(r, id);
    R.check('[ST-02] stop: 주인 프로세스 트리를 끝내고 interrupted 로 · exit 0', st.status === 0 && !S.pidAlive(owner.pid) && t1.status === 'interrupted' && !t1.owner, `${st.status} ${st.stdout} ${st.stderr}`);
    R.check('[ST-03] stop: 진행 중 작업을 결과 브랜치에 커밋한다(메인 브랜치는 그대로)', /wip\.txt/.test(git(r, 'show', '--name-only', '--format=', P.branch)) && git(r, 'log', '-1', '--format=%s', 'main') === 'init', git(r, 'log', '-2', '--format=%s', P.branch));
    const c2 = await I.cancel({ log: () => {}, root: r, id });
    R.check('[ST-04] stop 뒤 cancel 은 평소처럼 된다(작업물은 태그에)', c2.status === 'cancelled' && !fs.existsSync(P.wt) && !!git(r, 'tag', '-l', `harness/cancelled/${id}`), JSON.stringify({ s: c2.status, r: c2.reason }));

    // ── stop 은 작업자까지 끝낸다 — POSIX 에서 작업자(claude)는 detached(자기 프로세스 그룹)로 뜬다 ──
    //   [Linux 실측 2026-10-02] go 의 pid 만 죽이면 작업자는 살아남아 worktree 를 계속 고쳤다.
    const id5 = 't-20261001-000002-cafe', P5 = S.taskPaths(r, id5);
    git(r, 'worktree', 'add', '-q', '-b', P5.branch, P5.wt, 'main');
    const kidFile = path.join(base, 'kid.pid');
    const owner5 = spawn(process.execPath, ['-e', `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32',stdio:'ignore',windowsHide:true});require('fs').writeFileSync(${JSON.stringify(kidFile)},String(c.pid));setInterval(()=>{},1000)`], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 50 && !fs.existsSync(kidFile); i++) await new Promise(res => setTimeout(res, 100));
    const kid = Number(fs.readFileSync(kidFile, 'utf8'));
    S.writeTask(r, { ...S.newTask({ id: id5, goal: 'g', runtime: 'claude', model: 'opus', base_branch: 'main', base_commit: git(r, 'rev-parse', 'HEAD'), branch: P5.branch, worktree: P5.wt,
      owner: { pid: owner5.pid, host: os.hostname(), heartbeat_at: new Date().toISOString() }, caps: { budget_usd: 1, wall_min: 10, max_continuations: 1 } }), status: 'running' });
    const st5 = spawnSync(process.execPath, [CLI, 'stop', id5, '--root', r], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    let kidAlive = S.pidAlive(kid);
    for (let i = 0; i < 20 && kidAlive; i++) { await new Promise(res => setTimeout(res, 200)); kidAlive = S.pidAlive(kid); }
    R.check('[ST-05] stop 은 주인의 자손(따로 그룹을 만든 작업자 포함)까지 끝낸다', st5.status === 0 && !kidAlive, `${st5.status} kid ${kid} alive=${kidAlive} ${st5.stdout}`);
    if (kidAlive) { try { process.kill(kid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }
    try { owner.kill(); } catch { /* 이미 끝남 */ }
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 무시 */ } }
  R.done();
})();
