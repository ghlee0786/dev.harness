'use strict';
// 자원 장부 — 작업 하나가 git 밖에 만드는 것(임시 폴더 · compose 컨테이너/네트워크/볼륨/이미지 · 시험 데이터 구역)을 정하고, 끝나면 회수한다.
//   [2026-10-20 PRD R1 · 사용자 원칙 "시험 뒤 쓰레기 데이터를 정리한다"] 다중 에이전트에서는 쓰레기가 에이전트 수만큼 는다 — 정리는 전제다.
//   이름이 작업마다 고유하므로(harness-<id> · harness_<id>) 사용자의 것을 건드릴 일이 없다. docker 가 없거나 꺼져 있으면 그 부분은 건너뛴다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const WT_RE = /^(.*?)[\\/]\.harness-worktrees[\\/](t-\d{8}-\d{6}-[0-9a-f]{4})(?:-\d+)?(?=[\\/]|$)/;
// OS 임시 폴더 — 작업 환경의 TEMP 를 바꾸므로, 그 환경 안에서 하네스를 다시 불러도 겹겹이 들어가지 않게 바탕을 물려준다.
const baseTmp = () => process.env.HARNESS_TMP_BASE || os.tmpdir();

function repoKey(root) {
  const real = (() => { try { return fs.realpathSync.native(root); } catch { return path.resolve(root); } })();
  const name = path.basename(real).replace(/[^\w.-]+/g, '_').slice(0, 24) || 'repo';
  return `${name}-${crypto.createHash('sha1').update(real.toLowerCase()).digest('hex').slice(0, 8)}`;
}
const tmpDirFor = (root, id) => path.join(baseTmp(), 'harness', repoKey(root), id);
// DB · 큐 · 버킷 이름에 그대로 쓸 수 있게 — 소문자 · 숫자 · 밑줄
const dataNs = id => `harness_${String(id).replace(/^t-/, '').replace(/[^0-9a-z]+/gi, '_').toLowerCase()}`;
const composeProject = id => `harness-${id}`;

// 작업 worktree 안에서 도는 프로세스(작업자 · 하네스 검사)의 환경 — worktree 밖이면 빈 객체
function envFor(cwd) {
  const m = WT_RE.exec(String(cwd || ''));
  if (!m) return {};
  const id = m[2], dir = tmpDirFor(m[1], id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 못 만들면 TEMP 를 바꾸지 않는다 */ return { COMPOSE_PROJECT_NAME: composeProject(id), HARNESS_TASK_ID: id, HARNESS_DATA_NS: dataNs(id) }; }
  return { COMPOSE_PROJECT_NAME: composeProject(id), TEMP: dir, TMP: dir, TMPDIR: dir, HARNESS_TMP_BASE: baseTmp(), HARNESS_TASK_ID: id, HARNESS_DATA_NS: dataNs(id) };
}

// ── docker(compose) ─────────────────────────────────────────────────────────
const defaultRun = (cmd, args, timeoutMs) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs || 60000 });
  return { code: r.error ? null : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') + (r.error ? r.error.message : '') };
};
const ids = s => [...new Set(String(s || '').split(/\s+/).filter(Boolean))];
// docker 가 있는지는 프로세스마다 한 번만 본다(작업이 끝날 때마다 띄우지 않게). HARNESS_DOCKER_CLEANUP=off 면 보지 않는다.
let dockerSeen = null;
function dockerAvailable(run) {
  if (run !== defaultRun) return run('docker', ['version', '--format', '{{.Server.Version}}'], 15000).code === 0;
  if (process.env.HARNESS_DOCKER_CLEANUP === 'off') return false;
  if (dockerSeen === null) dockerSeen = run('docker', ['version', '--format', '{{.Server.Version}}'], 15000).code === 0;
  return dockerSeen;
}
// level 'runtime' — 컨테이너 · 네트워크(작업이 끝날 때). 'all' — + 볼륨 · 이미지(accept · cancel · gc 때).
function teardownCompose(id, level, run) {
  run = run || defaultRun;
  const res = { skipped: null, removed: {}, residue: [] };
  if (!dockerAvailable(run)) { res.skipped = 'docker not available'; return res; }
  const label = `label=com.docker.compose.project=${composeProject(id)}`;
  // compose 이름표가 붙은 것 + 이름이 harness-<id> 로 시작하는 단독 컨테이너(docker run --name $COMPOSE_PROJECT_NAME-pg) — 익명 볼륨(-v)까지.
  //   [2026-10-20 실측] 작업자가 시험용 postgres 를 docker run 으로 띄우고 두고 갔다(이름표 없음 → 이름표로만 고르던 정리가 놓쳤다).
  const kinds = [
    ['containers', ['ps', '-aq', '--filter', label], list => ['rm', '-f', '-v', ...list]],
    ['containers', ['ps', '-aq', '--filter', `name=^/?${composeProject(id)}`], list => ['rm', '-f', '-v', ...list]],
    ['networks', ['network', 'ls', '-q', '--filter', label], list => ['network', 'rm', ...list]],
    ...(level === 'all' ? [
      ['volumes', ['volume', 'ls', '-q', '--filter', label], list => ['volume', 'rm', '-f', ...list]],
      ['images', ['images', '-q', '--filter', `reference=${composeProject(id)}*`], list => ['rmi', '-f', ...list]],
    ] : []),
  ];
  for (const [kind, listArgs, rmArgs] of kinds) {
    const found = ids(run('docker', listArgs, 30000).out);
    if (!found.length) continue;
    run('docker', rmArgs(found), 120000);
    const left = ids(run('docker', listArgs, 30000).out);
    res.removed[kind] = (res.removed[kind] || 0) + found.length - left.length;
    for (const x of left) res.residue.push(`docker ${kind.replace(/s$/, '')} ${x}`);
  }
  return res;
}

// ── 프로젝트 정리 명령(cleanup_command) ──────────────────────────────────────
//   git 밖 공유 저장소(DB · 큐 · 버킷)에 남긴 시험 데이터는 하네스가 알 수 없다 — 프로젝트가 정한 명령에 데이터 구역 이름을 주고 돌린다.
function runCleanupCommand(root, id, o) {
  const K = require('./checks');
  const cmd = (o && o.command) != null ? o.command : K.yamlString(root, 'cleanup_command');
  if (!cmd) return null;
  const spec = K.spawnSpec(K.splitCommand(cmd));
  const env = { ...K.childEnv(), HARNESS_TASK_ID: id, HARNESS_DATA_NS: dataNs(id), COMPOSE_PROJECT_NAME: composeProject(id) };
  const r = spawnSync(spec.cmd, spec.args, { cwd: root, env, shell: spec.shell, encoding: 'utf8', windowsHide: true, timeout: (o && o.timeoutMs) || 5 * 60 * 1000 });
  return { command: cmd, ok: !r.error && r.status === 0, exit_code: r.error ? null : r.status, output: (String(r.stdout || '') + String(r.stderr || '')).slice(-1500) };
}

// ── 임시 폴더 ────────────────────────────────────────────────────────────────
function removeTmp(root, id) {
  const dir = tmpDirFor(root, id);
  if (!fs.existsSync(dir)) return { dir, removed: false, residue: [] };
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 아래에서 남은 것으로 본다 */ }
  if (fs.existsSync(dir)) return { dir, removed: false, residue: [`temp folder ${dir}`] };
  // 비었으면 위 폴더(저장소 키 · harness)도 — [2026-10-20 실측] 작업 폴더만 지워 빈 폴더가 저장소 · 테스트마다 쌓였다
  for (const up of [path.dirname(dir), path.dirname(path.dirname(dir))]) { try { fs.rmdirSync(up); } catch { break; } }
  return { dir, removed: true, residue: [] };
}

// ── 남은 프로세스 ────────────────────────────────────────────────────────────
//   [2026-10-20 실측] 끝난 작업의 작업자 세션이 띄운 Monitor(tail -f)가 하루 넘게 살아 있었다. 명령줄에 **그 작업의 worktree 경로**가 든 프로세스만 끝낸다
//   — 다른 작업 · 사용자의 프로세스는 건드리지 않는다. Claude Code 는 작업 폴더 경로의 글자 아닌 것을 '-' 로 바꿔 임시 폴더 이름에 쓴다
//   (…\claude\C--repo--harness-worktrees-<id>\…) — 그 꼴도 본다. HARNESS_PROC_CLEANUP=off 면 보지 않는다(테스트 러너).
//   작업이 시작된 뒤 생긴 프로세스만 · 사용자가 그 폴더를 연 편집기 · 탐색기는 빼고.
const IS_WIN = process.platform === 'win32';
const USER_APPS = /(^|[\\/"])(code|code - insiders|code-insiders|cursor|windsurf|devenv|rider64|rider|idea64|idea|pycharm64|explorer|finder)(\.exe)?["\s]/i;
// ps 의 etime([[dd-]hh:]mm:ss) → 초
const etimeSec = s => { const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim()); return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + +m[3] * 60 + +m[4]) : null; };
function defaultProcs() {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 };
  if (IS_WIN) {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString(\'o\') })`t$($_.CommandLine)" }'], opts);
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '').split(/\r?\n/).map(l => /^(\d+)\t(\d*)\t([^\t]*)\t(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: Number(m[1]), ppid: Number(m[2]) || 0, started: Date.parse(m[3]) || null, cmd: m[4] }));
  }
  // 좀비(Z — 끝났지만 부모가 아직 거두지 않음)는 뺀다: 끝낸 직후 다시 볼 때 남은 것으로 잘못 보이지 않게(CI Linux · macOS 실측)
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,stat=,etime=,args='], opts), now = Date.now();
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').split(/\r?\n/).map(l => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l)).filter(m => m && !/^Z/.test(m[3])).map(m => { const e = etimeSec(m[4]); return { pid: Number(m[1]), ppid: Number(m[2]), started: e == null ? null : now - e * 1000, cmd: m[5] }; });
}
// 끝난 작업자(모델 세션)의 남은 자손을 거둔다 — [2026-10-20 실측 · 평가] 작업자 세션이 띄운 bash 대기 루프(Windows 에 없는 pgrep 을 기다림)가
//   세션이 끝난 뒤에도 남아 worktree 를 현재 폴더로 붙들었다(명령줄에 경로가 없어 경로로는 못 잡는다).
//   Windows: 부모가 죽어도 자식의 ParentProcessId 는 남는다 — 작업자 pid 에서 부모-자식으로 따라간다(작업자가 시작된 뒤 생긴 것만 · pid 재사용 방지).
//   POSIX: 작업자는 자기 프로세스 그룹으로 띄운다(proc.spawnCapture detached) — 그룹째 끝낸 뒤, 부모-자식으로 남은 것도.
function reapDescendants(rootPid, sinceMs, o) {
  const res = { killed: [], residue: [] };
  if (!rootPid || (!(o && o.procs) && process.env.HARNESS_PROC_CLEANUP === 'off')) return res;
  const kill = (o && o.kill) || defaultKill;
  if (!IS_WIN && !(o && o.procs)) { try { process.kill(-rootPid, 'SIGKILL'); } catch { /* 그룹이 이미 없다 */ } }
  const list = (o && o.procs ? o.procs() : defaultProcs()) || [];
  const since = (sinceMs || 0) - 2000, tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of list) if (!tree.has(p.pid) && tree.has(p.ppid) && p.pid !== process.pid && (p.started == null || p.started >= since)) { tree.add(p.pid); grew = true; }
  }
  // Linux: 새 세션으로 나가(setsid) 그룹을 벗어나고 init 에 맡겨진 것도 — 환경의 HARNESS_TASK_ID(그 작업 고유)는 물려받는다. macOS 는 /proc 가 없어 그룹 · 부모 관계까지만.
  const taskId = o && o.taskId && /^t-\d{8}-\d{6}-[0-9a-f]{4}$/.test(o.taskId) ? o.taskId : null;
  if (taskId && !IS_WIN && !(o && o.procs)) {
    let pids = []; try { pids = fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)).map(Number); } catch { /* /proc 없음(macOS) */ }
    const byPid = new Map(list.map(p => [p.pid, p]));
    for (const pid of pids) {
      if (pid === process.pid || pid === process.ppid || tree.has(pid)) continue;
      let env = ''; try { env = fs.readFileSync(`/proc/${pid}/environ`, 'latin1'); } catch { continue; }
      const p = byPid.get(pid);
      if (env.split('\0').includes(`HARNESS_TASK_ID=${taskId}`) && (!p || p.started == null || p.started >= since)) tree.add(pid);
    }
  }
  const byPid = new Map(list.map(p => [p.pid, p]));
  for (const pid of tree) if (pid !== rootPid) { kill(pid); res.killed.push({ pid, cmd: String((byPid.get(pid) || {}).cmd || '').slice(0, 160) }); }
  return res;
}
function defaultKill(pid) {
  if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝남 */ } }
}
// → { killed: [{ pid, cmd }], residue: [] } — o.since: 작업 시작 시각(ms) · o.procs() · o.kill(pid): 테스트가 끼우는 가짜
function killStrays(id, o) {
  const res = { killed: [], residue: [] };
  if (!(o && o.procs) && process.env.HARNESS_PROC_CLEANUP === 'off') return res;
  const got = o && o.procs ? o.procs() : defaultProcs();
  if (!got) { res.residue.push('process list unavailable — leftover processes of this task were not checked'); return res; }
  const list = got;
  const mine = new RegExp(`harness-worktrees(?:[\\\\/]|-+)${String(id).replace(/[^\w-]/g, '')}(?![0-9A-Za-z])`, 'i');
  const since = o && o.since ? o.since - 60000 : null;   // 시계 오차 1분
  const hits = list.filter(p => p.pid !== process.pid && p.pid !== process.ppid && mine.test(p.cmd || '') && !USER_APPS.test(`${p.cmd} `)
    && (since == null || (p.started != null && p.started >= since)));
  for (const p of hits) { (o && o.kill ? o.kill : defaultKill)(p.pid); res.killed.push({ pid: p.pid, cmd: String(p.cmd).slice(0, 160) }); }
  if (hits.length) {
    if (!(o && o.procs)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);   // 끝나는 데 걸리는 잠깐
    const after = new Set(((o && o.procs ? o.procs() : defaultProcs()) || []).map(p => p.pid));
    for (const p of hits) if (after.has(p.pid)) res.residue.push(`process ${p.pid}: ${String(p.cmd).slice(0, 120)}`);
  }
  return res;
}

// 작업이 끝날 때(done · blocked · error · interrupted): 돌던 컨테이너 · 네트워크를 내리고 임시 폴더를 지운다(worktree 도 이때 지워진다).
//   볼륨 · 이미지 · 프로젝트 정리 명령은 accept · cancel · gc 때 — 끝난 작업을 확인하거나 이어 갈 수 있게.
function onTaskEnd(root, task, o) {
  const p = killStrays(task.id, { since: Date.parse(task.created_at) || null, ...(o || {}) });   // 먼저 — 남은 프로세스가 임시 폴더 · 컨테이너를 붙들고 있으면 지워지지 않는다
  const d = teardownCompose(task.id, 'runtime', o && o.run);
  const t = removeTmp(root, task.id);
  return record(task, { at: 'end', procs: p, docker: d, tmp: t, residue: [...p.residue, ...d.residue, ...t.residue] });
}
// 작업을 치울 때(accept · cancel · gc): 전부 회수한다.
function release(root, task, o) {
  const d = teardownCompose(task.id, 'all', o && o.run);
  const c = runCleanupCommand(root, task.id, o && o.cleanup);
  const t = removeTmp(root, task.id);
  const residue = [...d.residue, ...t.residue, ...(c && !c.ok ? [`cleanup_command failed (exit ${c.exit_code}): ${c.command}`] : [])];
  return record(task, { at: 'release', docker: d, cleanup: c, tmp: t, residue });
}
function record(task, r) {
  task.resources = { tmp: null, ...(task.resources || {}), compose_project: composeProject(task.id), data_ns: dataNs(task.id), [`${r.at}_at`]: new Date().toISOString(), residue: r.residue };
  if (r.tmp) task.resources.tmp = r.tmp.dir;
  return r;
}

module.exports = { envFor, tmpDirFor, dataNs, composeProject, repoKey, teardownCompose, killStrays, reapDescendants, listProcesses: defaultProcs, killProcess: defaultKill, runCleanupCommand, removeTmp, onTaskEnd, release, WT_RE };
