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
  const kinds = [
    ['containers', ['ps', '-aq', '--filter', label], list => ['rm', '-f', ...list]],
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
    res.removed[kind] = found.length - left.length;
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

// 작업이 끝날 때(done · blocked · error · interrupted): 돌던 컨테이너 · 네트워크를 내리고 임시 폴더를 지운다(worktree 도 이때 지워진다).
//   볼륨 · 이미지 · 프로젝트 정리 명령은 accept · cancel · gc 때 — 끝난 작업을 확인하거나 이어 갈 수 있게.
function onTaskEnd(root, task, o) {
  const d = teardownCompose(task.id, 'runtime', o && o.run);
  const t = removeTmp(root, task.id);
  return record(task, { at: 'end', docker: d, tmp: t, residue: [...d.residue, ...t.residue] });
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

module.exports = { envFor, tmpDirFor, dataNs, composeProject, repoKey, teardownCompose, runCleanupCommand, removeTmp, onTaskEnd, release, WT_RE };
