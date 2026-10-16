'use strict';
// v5 status · gc — 주인 생존 · 겹침(두 작업이 같은 파일) · 메인 체크아웃 미커밋 변경의 주인 분류(세션 · 주인 없음)
//   · gc 는 깨끗한 worktree 만 지우고 더러운 것은 남긴다 · 죽은 잠금 해제 · --json.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const L = require('../../harness/lib/loop');
const St = require('../../harness/lib/status');
const R = makeReporter('v5 status · gc — 겹침 · 주인 · 정리');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-status-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
// 끝난 프로세스의 pid 는 부하가 크면 곧 재사용된다(Windows) — 어느 OS 에서도 배정되지 않는 큰 값(4의 배수).
const deadPid = () => 99999996;
const quiet = { log: () => {} };
const edits = files => async o => { for (const [f, t] of Object.entries(files)) write(path.join(o.cwd, f), t); return { session_id: o.newSessionId, cost_usd: 0.2 }; };
const goEdit = (root, files, goal) => L.go({ ...quiet, root, goal: goal || 'edit', run: edits(files) });

(async () => {
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    git(repo, ['config', 'user.name', 't']); git(repo, ['config', 'user.email', 't@example.invalid']); git(repo, ['config', 'commit.gpgsign', 'false']);
    for (const f of ['shared.txt', 'x.txt', 'y.txt', 'z.txt']) write(path.join(repo, f), f + '\n');
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'init']);

    // ── 겹침 ─────────────────────────────────────────────────────────
    const a = await goEdit(repo, { 'shared.txt': 'A\n', 'only-a.txt': 'a\n' }, 'task a');
    const b = await goEdit(repo, { 'shared.txt': 'B\n' }, 'task b');
    const c = await goEdit(repo, { 'z.txt': 'C\n' }, 'task c');
    R.check('[SS-00] 준비: 작업 3개 done', [a, b, c].every(t => t.status === 'done'), [a, b, c].map(t => t.status).join());
    const s1 = St.status({ root: repo });
    const ov = s1.overlaps.find(o => o.file === 'shared.txt');
    R.check('[SS-01] 겹침: 두 작업이 shared.txt 를 바꿈 → 경고(두 id)', !!ov && ov.tasks.slice().sort().join() === [a.id, b.id].sort().join(), JSON.stringify(s1.overlaps));
    R.check('[SS-01] 한 작업만 바꾼 파일은 겹침이 아니다(z.txt · only-a.txt)', s1.overlaps.length === 1, JSON.stringify(s1.overlaps));
    const ta = s1.tasks.find(t => t.id === a.id);
    R.check('[SS-01] 작업 목록: 상태 · 브랜치 · 바뀐 파일 수(.harness 제외) · 비용', ta && ta.status === 'done' && ta.branch === `harness/${a.id}` && ta.files_changed === 2 && ta.cost_usd === 0.2 && ta.branch_exists, JSON.stringify(ta));
    const txt = St.formatStatus(s1);
    R.check('[SS-01] 사람용 출력에 겹침 경고', /overlaps/.test(txt) && txt.includes(`! shared.txt — `), txt);
    R.check('[SS-09] 사람용 출력에 작업 전체의 누적 비용', /spent across 3 tasks: \$0\.60/.test(txt), txt.split('\n').filter(l => /spent/.test(l)).join(' | '));
    write(path.join(repo, 'AGENTS.md'), '```yaml\nreply_language: "Korean"\n```\n');
    const txtKo = St.formatStatus(St.status({ root: repo }));
    R.check('[SS-10] 저장소의 작업 언어가 Korean 이면 status 도 한국어', /^저장소: /m.test(txtKo) && /작업 \(3\)/.test(txtKo) && /누적 비용: 작업 3개 · \$0\.60/.test(txtKo) && /겹침/.test(txtKo), txtKo);
    fs.rmSync(path.join(repo, 'AGENTS.md'));

    // ── 주인 생존 ─────────────────────────────────────────────────────
    const tc = S.readTask(repo, c.id);
    tc.status = 'running'; tc.owner = { pid: deadPid(), host: os.hostname(), heartbeat_at: new Date(Date.now() - 90000).toISOString() };
    S.writeTask(repo, tc);
    const s2 = St.status({ root: repo });
    const tcs = s2.tasks.find(t => t.id === c.id);
    R.check('[SS-02] running 인데 주인 pid 가 죽음 → alive=false · stale · heartbeat 나이', tcs.owner.alive === false && tcs.stale === true && tcs.owner.heartbeat_age_s >= 89, JSON.stringify(tcs.owner));
    tc.owner = { pid: process.pid, host: os.hostname(), heartbeat_at: new Date().toISOString() };
    S.writeTask(repo, tc);
    const tcs2 = St.status({ root: repo }).tasks.find(t => t.id === c.id);
    R.check('[SS-02] 주인이 살아 있으면 alive=true · stale 아님', tcs2.owner.alive === true && tcs2.stale === false);
    R.check('[SS-02] 사람용 출력: 죽은 주인은 resume 안내', /OWNER DEAD/.test(St.formatStatus(s2)));
    tc.status = 'done'; S.writeTask(repo, tc);

    // ── 미커밋 변경의 주인 ───────────────────────────────────────────
    write(path.join(repo, 'x.txt'), 'edited by nobody we know\n');
    write(path.join(repo, 'y.txt'), 'edited by session s1\n');
    write(path.join(repo, 'new', 'fresh.txt'), 'new file by session s2\n');
    write(path.join(S.paths(repo).sessionsDir, 's1.json'), JSON.stringify({ session_id: 'session-one-1234', runtime: 'claude', files: ['y.txt', 'untouched.txt'], updated_at: new Date().toISOString() }));
    write(path.join(S.paths(repo).sessionsDir, 's2.json'), JSON.stringify({ session_id: 'session-two-5678', runtime: 'codex', files: ['new\\fresh.txt'], updated_at: new Date().toISOString() }));
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const s3 = St.status({ root: repo });
    const u = s3.uncommitted;
    const bySid = Object.fromEntries(u.by_session.map(x => [x.session_id, x.files.join()]));
    R.check('[SS-03] 세션이 기록한 파일은 그 세션으로 분류(경로 구분자 무관)', bySid['session-one-1234'] === 'y.txt' && bySid['session-two-5678'] === 'new/fresh.txt', JSON.stringify(u));
    R.check('[SS-03] 주인 없는 변경은 unowned 로 목록만', JSON.stringify(u.unowned) === '["x.txt"]', JSON.stringify(u.unowned));
    R.check('[SS-03] status 는 아무것도 커밋하거나 되돌리지 않는다', git(repo, ['rev-parse', 'HEAD']) === headBefore && read(path.join(repo, 'x.txt')) === 'edited by nobody we know\n' && git(repo, ['status', '--porcelain', '-uall']).split(/\r?\n/).length === 3);
    R.check('[SS-03] 사람용 출력: 세션별 · 주인 없음', /session session-/.test(St.formatStatus(s3)) && /no known owner .*: x\.txt/.test(St.formatStatus(s3)));

    // ── --json (CLI) ─────────────────────────────────────────────────
    const cli = spawnSync(process.execPath, [CLI, 'status', '--json', '--root', repo], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    let js = null; try { js = JSON.parse(cli.stdout); } catch { /* 없음 */ }
    R.check('[SS-04] CLI status --json: exit 0 · 파싱 가능 · 같은 내용', cli.status === 0 && js && js.tasks.length === 3 && js.overlaps.length === 1 && js.uncommitted.unowned[0] === 'x.txt', `${cli.status} ${cli.stderr.slice(-300)}`);

    // ── gc ───────────────────────────────────────────────────────────
    const Pa = S.taskPaths(repo, a.id), Pb = S.taskPaths(repo, b.id);
    git(repo, ['worktree', 'add', '-q', Pa.wt, `harness/${a.id}`]);
    git(repo, ['worktree', 'add', '-q', Pb.wt, `harness/${b.id}`]);
    write(path.join(Pa.wt, 'dirty.txt'), 'uncommitted work\n');
    write(path.join(S.lockDir(repo, 'task-dead'), 'owner.json'), JSON.stringify({ pid: deadPid(), host: os.hostname(), at: new Date().toISOString(), token: 'x' }));
    const liveLock = S.acquire(repo, 'merge');
    const g = St.gc({ root: repo });
    R.check('[SS-05] gc: 더러운 worktree 는 남긴다(파일도 그대로)', fs.existsSync(Pa.wt) && read(path.join(Pa.wt, 'dirty.txt')) === 'uncommitted work\n' && g.kept.some(k => k.id === a.id), JSON.stringify(g.kept));
    R.check('[SS-05] gc: 깨끗한 끝난 worktree 는 지운다', !fs.existsSync(Pb.wt) && g.removed.some(x => x.id === b.id) && !git(repo, ['worktree', 'list']).includes(b.id), JSON.stringify(g.removed));
    R.check('[SS-05] gc: 죽은 잠금은 해제 · 산 잠금은 그대로', g.locks_removed.includes('task-dead') && fs.existsSync(S.lockDir(repo, 'merge')), JSON.stringify(g.locks_removed));
    liveLock.release();
    const cliGc = spawnSync(process.execPath, [CLI, 'gc', '--json', '--root', repo], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    let gj = null; try { gj = JSON.parse(cliGc.stdout); } catch { /* 없음 */ }
    R.check('[SS-05] CLI gc --json: exit 0 · 더러운 worktree 는 여전히 남는다', cliGc.status === 0 && gj && gj.kept.some(k => k.id === a.id) && fs.existsSync(Pa.wt), `${cliGc.status} ${cliGc.stderr.slice(-300)}`);
    const sAfter = St.status({ root: repo });
    R.check('[SS-06] worktree 의 미커밋 변경도 그 작업의 바뀐 파일로 센다', sAfter.tasks.find(t => t.id === a.id).files_changed === 3);

    // ── [M4] gc 는 git 밖(무시된) 파일이 바뀐 worktree 를 지우지 않는다(.worktreeinclude 복사분은 제외) ─
    const g2 = path.join(base, 'gcrepo');
    fs.mkdirSync(g2);
    git(g2, ['init', '-q', '-b', 'main']);
    git(g2, ['config', 'core.autocrlf', 'false']);
    git(g2, ['config', 'user.name', 't']); git(g2, ['config', 'user.email', 't@example.invalid']); git(g2, ['config', 'commit.gpgsign', 'false']);
    write(path.join(g2, '.gitignore'), '.env\n*.log\n'); write(path.join(g2, '.worktreeinclude'), '.env\n'); write(path.join(g2, 'x.txt'), 'x\n');
    git(g2, ['add', '-A']); git(g2, ['commit', '-qm', 'init']);
    write(path.join(g2, '.env'), 'TOKEN=1\n');
    const d = await goEdit(g2, { 'd.txt': 'd\n' }, 'task d');
    const e = await goEdit(g2, { 'e.txt': 'e\n' }, 'task e');
    const f = await goEdit(g2, { 'f.txt': 'f\n' }, 'task f');
    R.check('[SS-07] 준비: 작업 3개 done', [d, e, f].every(t => t.status === 'done'), [d, e, f].map(t => `${t.status} ${t.reason}`).join(' | '));
    const wtOf = t => S.taskPaths(g2, t.id).wt;
    const G = require('../../harness/lib/git');
    for (const t of [d, e, f]) if (!fs.existsSync(wtOf(t))) { git(g2, ['worktree', 'add', '-q', wtOf(t), t.branch]); G.copyWorktreeInclude(g2, wtOf(t)); }
    write(path.join(wtOf(e), 'build.log'), 'artifact outside git\n');
    // [L3] f 는 accept/cancel 이 진행 중(task-<id> 잠금이 산 주인) · f 의 임시 revert worktree 는 merge 잠금 아래
    const tmpF = path.join(S.paths(g2).worktreesDir, `${f.id}-cancel-abcd`);
    git(g2, ['worktree', 'add', '-q', '--detach', tmpF, 'main']);
    const taskLockF = S.acquire(g2, `task-${f.id}`);
    const mergeLock = S.acquire(g2, 'merge');
    const gg = St.gc({ root: g2 });
    R.check('[SS-07][M4] .worktreeinclude 복사분(.env)만 있는 worktree 는 지운다', !fs.existsSync(wtOf(d)) && gg.removed.some(x => x.id === d.id), JSON.stringify(gg));
    R.check('[SS-07][M4] 무시된 파일(build.log)이 바뀐 worktree 는 남긴다 · 파일 그대로 · 이유에 파일 이름', fs.existsSync(wtOf(e)) && read(path.join(wtOf(e), 'build.log')) === 'artifact outside git\n' && gg.kept.some(k => k.id === e.id && /build\.log/.test(k.why)), JSON.stringify(gg.kept));
    R.check('[SS-08][L3] task-<id> 잠금이 산 주인에게 있으면 그 worktree 는 건너뛴다', fs.existsSync(wtOf(f)) && gg.kept.some(k => k.id === f.id && /lock/.test(k.why)), JSON.stringify(gg.kept));
    R.check('[SS-08][L3] 진행 중 통합의 임시 worktree(<id>-cancel-*)도 건너뛴다', fs.existsSync(tmpF) && gg.kept.some(k => k.worktree === tmpF && /lock/.test(k.why)), JSON.stringify(gg.kept));
    R.check('[SS-08][L3] gc 는 산 잠금을 풀지 않는다', fs.existsSync(S.lockDir(g2, 'merge')) && fs.existsSync(S.lockDir(g2, `task-${f.id}`)) && !gg.locks_removed.length, JSON.stringify(gg.locks_removed));
    mergeLock.release(); taskLockF.release();
    const gg2 = St.gc({ root: g2 });
    R.check('[SS-08][L3] 잠금이 풀리면 다음 gc 가 지운다(f · 임시 worktree) · e 는 여전히 남는다', !fs.existsSync(wtOf(f)) && !fs.existsSync(tmpF) && fs.existsSync(wtOf(e)), JSON.stringify(gg2));
    write(path.join(wtOf(e), 'dist.log', 'inner', 'a.bin'), 'x');   // 무시된 폴더(dist.log/) — 폴더째가 아니라 안의 파일로 보고
    const ignE = St.ignoredChanged(g2, wtOf(e), S.readTask(g2, e.id).worktree_include);
    R.check('[SS-07][M4] ignoredChanged: 무시된 폴더는 펼쳐 파일로 · .env 복사분은 빠진다', ignE.includes('build.log') && ignE.includes('dist.log/inner/a.bin') && !ignE.some(p => p.startsWith('.env')), JSON.stringify(ignE));
    const txtG = St.formatGc(gg);
    R.check('[SS-07][M4] 사람용 gc 출력에 남긴 이유', /build\.log/.test(txtG), txtG);

    // ── [2026-10-15 자동 이슈 #6] 세션이 끊긴 뒤 task.json 이 공백만 남아 status 에서 작업이 조용히 사라졌다 ──
    const tf = S.taskPaths(repo, c.id).taskFile;
    const tc6 = S.readTask(repo, c.id); tc6.reason = 'second write'; S.writeTask(repo, tc6);   // 앞선 판이 .bak 에 남는다
    fs.writeFileSync(tf, '   \n\n  ');
    const back = S.readTask(repo, c.id);
    R.check('[SS-11] task.json 이 깨지면 직전 판(.bak)으로 읽는다 — 작업이 사라지지 않는다', back && back.id === c.id && S.listTasks(repo).some(t => t.id === c.id), JSON.stringify(back && { id: back.id, status: back.status }));
    fs.writeFileSync(`${tf}.bak`, '');
    const s9 = St.status({ root: repo });
    const txt9 = St.formatStatus(s9);
    R.check('[SS-11] 둘 다 깨지면 status 가 "손상" 줄로 보이고 기록(log.jsonl)의 위치와 목표를 알려 준다', (s9.broken || []).some(x => x.id === c.id && /task c/.test(x.goal)) && new RegExp(`${c.id}.*(BROKEN|손상)`).test(txt9) && /log\.jsonl/.test(txt9), txt9);
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
  R.done();
})();
