'use strict';
// update — 배포된 릴리스(GitHub Releases)로 설치된 하네스를 갈아 끼운다(CD 의 받는 쪽). 가짜 GitHub(이 PC 안)로만.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { makeReporter } = require('../run.js');
const U = require('../../harness/lib/update');
const R = makeReporter('update — 릴리스 비교 · 내려받기 · 설치');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-update-'));
const SRC = path.resolve(__dirname, '..', '..', 'harness');
const CLI = path.join(SRC, 'cli.js');
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const copyDir = (s, d) => { fs.mkdirSync(d, { recursive: true }); for (const e of fs.readdirSync(s, { withFileTypes: true })) { const a = path.join(s, e.name), b = path.join(d, e.name); if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b); } };
const cli = (args, env) => new Promise(res => { const c = spawn(process.execPath, [CLI, ...args], { env, windowsHide: true }); let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; }); c.on('close', code => res({ code, out })); });

(async () => {
  try {
    R.check('[UP-01] 판 비교: 숫자 · v 접두 · dev 는 언제나 낡았다', U.newer('v5.1.0', 'dev') && U.newer('5.2.0', '5.1.9') && !U.newer('v5.1.0', '5.1.0') && !U.newer('5.0.9', '5.1.0') && U.newer('5.10.0', '5.9.0'));

    // 릴리스 묶음: 지금 하네스 + VERSION 9.9.9
    const pkg = path.join(base, 'pkg'); copyDir(SRC, path.join(pkg, 'harness'));
    fs.writeFileSync(path.join(pkg, 'harness', 'VERSION'), '9.9.9\n');
    const t = spawnSync('tar', ['-czf', 'harness-9.9.9.tar.gz', 'harness'], { cwd: pkg, encoding: 'utf8', windowsHide: true });
    const tgz = fs.readFileSync(path.join(pkg, 'harness-9.9.9.tar.gz'));
    let latest = 'v9.9.9';
    const srv = http.createServer((req, res) => {
      if (req.url === '/repos/o/r/releases/latest') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ tag_name: latest, assets: [{ name: 'harness-9.9.9.tar.gz', browser_download_url: `http://127.0.0.1:${srv.address().port}/dl/harness-9.9.9.tar.gz` }] })); }
      if (req.url === '/dl/harness-9.9.9.tar.gz') { res.setHeader('content-type', 'application/octet-stream'); return res.end(tgz); }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const env = { ...process.env, HARNESS_GITHUB_API: `http://127.0.0.1:${srv.address().port}`, HARNESS_UPDATE_REPO: 'o/r', HARNESS_BUG_REPORT: 'off' };

    // 설치된 저장소(판 dev)
    const repo = path.join(base, 'app'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'user.email', 't@example.invalid');
    fs.writeFileSync(path.join(repo, 'README.md'), '# a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'i');
    spawnSync(process.execPath, [CLI, 'install', '--root', repo], { encoding: 'utf8', windowsHide: true, env });
    const v0 = fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim();
    const d1 = await cli(['update', '--dry-run', '--root', repo], env);
    R.check('[UP-02] update --dry-run: 새 판이 있다고만 알리고 바꾸지 않는다', t.status === 0 && v0 === 'dev' && /새 판이 있다 — 지금 dev → 9\.9\.9/.test(d1.out) && fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim() === 'dev', `${t.stderr} ${d1.out}`);
    const u1 = await cli(['update', '--root', repo], env);
    R.check('[UP-03] update: 릴리스를 내려받아 설치 — harness/VERSION 9.9.9 · 관리 블록 그대로', u1.code === 0 && fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim() === '9.9.9' && /harness:begin/.test(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')), u1.out.slice(-400));
    const u2 = await cli(['update', '--root', repo], env);
    R.check('[UP-04] 이미 최신이면 아무것도 하지 않는다', u2.code === 0 && /최신이다/.test(u2.out), u2.out);
    // 실행 중인 작업이 있으면 install 이 거부 → update 도 바꾸지 않는다
    latest = 'v10.0.0';
    const S = require('../../harness/lib/state');
    const id = 't-20261013-000000-abcd';
    S.writeTask(repo, { ...S.newTask({ id, goal: 'g', runtime: 'claude', model: 'opus', base_branch: 'main', base_commit: git(repo, 'rev-parse', 'HEAD'), branch: `harness/${id}`, worktree: path.join(repo, '.harness-worktrees', id), owner: S.ownerRecord(), caps: { budget_usd: 1, wall_min: 1, max_continuations: 1 } }), status: 'running' });
    const u3 = await cli(['update', '--root', repo], env);
    R.check('[UP-05] 실행 중인 작업이 있으면 갈아 끼우지 않는다(install 이 거부)', u3.code !== 0 && fs.readFileSync(path.join(repo, 'harness', 'VERSION'), 'utf8').trim() === '9.9.9' && /설치하지 않았다/.test(u3.out), u3.out.slice(0, 400));
    srv.close();
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();
