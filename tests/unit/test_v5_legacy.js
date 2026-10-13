'use strict';
// cleanup-legacy — 옛 하네스 잔여물을 "잃을 것이 없을 때만" 지운다.
//   [2026-09-30 실측 · Python 서비스 저장소] 옛 worktree 21개 · 브랜치 14개 · .git/harness-v14 2.5GB. guard 훅은 branch -D 와 .git 아래
//   재귀 삭제를 막아 허락받은 정리를 할 길이 없었다. 이 명령은 내용이 현재 브랜치에 다 있고 · 깨끗하고 · git 밖 산출물이 없을 때만 지운다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const Lg = require('../../harness/lib/legacy.js');
const R = makeReporter('cleanup-legacy — 잃을 것이 없을 때만 지운다');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-legacy-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); return (r.stdout || '').trim(); };
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const commit = (cwd, file, text, msg) => { write(path.join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', msg); return git(cwd, 'rev-parse', 'HEAD'); };

try {
  const r = path.join(base, 'repo');
  fs.mkdirSync(r, { recursive: true });
  git(r, 'init', '-q', '-b', 'main'); git(r, 'config', 'user.name', 't'); git(r, 'config', 'user.email', 't@example.invalid'); git(r, 'config', 'commit.gpgsign', 'false'); git(r, 'config', 'core.autocrlf', 'false');
  commit(r, 'a.txt', 'a\n', 'init');
  const common = path.join(r, '.git');
  const wtIn = n => path.join(common, 'harness-v14', 'worktrees', n);

  // ① 반영된 옛 브랜치 + 깨끗한 worktree: 브랜치에서 커밋 → main 에 cherry-pick(패치 동등, 조상 아님)
  git(r, 'worktree', 'add', '-q', '-b', 'harness/w-1/IMPL', wtIn('applied'), 'main');
  const c1 = commit(wtIn('applied'), 'feat.txt', 'feat\n', 'feat');
  git(r, 'cherry-pick', c1);
  // ② 반영 안 된 옛 브랜치 + worktree
  git(r, 'worktree', 'add', '-q', '-b', 'harness/w-2/IMPL', wtIn('unapplied'), 'main');
  commit(wtIn('unapplied'), 'only-here.txt', 'x\n', 'not merged');
  // ③ 반영됐지만 worktree 에 미커밋 변경
  git(r, 'worktree', 'add', '-q', '-b', 'harness/w-3/IMPL', wtIn('dirty'), 'main');
  write(path.join(wtIn('dirty'), 'scratch.txt'), 'wip\n');
  // ④ worktree 없는 반영된 브랜치 · 반영 안 된 브랜치
  git(r, 'branch', 'harness/lean-core', 'main');
  git(r, 'branch', 'harness/w-4/KEEP', 'harness/w-2/IMPL');
  // ⑤ v5 브랜치는 대상이 아니다
  git(r, 'branch', 'harness/t-20260930-000000-abcd', 'main');
  // 옛 상태 파일
  write(path.join(common, 'harness-v14', 'coordinator.sqlite'), 'x'.repeat(2048));
  write(path.join(common, 'harness-v4', 'v4-1', 'state.json'), '{}');

  const before = { branches: git(r, 'branch', '--list', 'harness/*'), wts: git(r, 'worktree', 'list') };
  const dry = Lg.cleanup({ root: r });
  R.check('[LG-01] dry-run 은 아무것도 바꾸지 않는다', !dry.applied && git(r, 'branch', '--list', 'harness/*') === before.branches && git(r, 'worktree', 'list') === before.wts && fs.existsSync(path.join(common, 'harness-v4')));
  const wOf = (p, n) => p.worktrees.find(w => path.basename(w.path) === n), bOf = (p, n) => p.branches.find(b => b.name === n);
  R.check('[LG-02] 계획: 깨끗하고 내용이 반영된 worktree 만 remove', wOf(dry, 'applied').action === 'remove' && wOf(dry, 'unapplied').action === 'keep' && /NOT in main/.test(wOf(dry, 'unapplied').why) && wOf(dry, 'dirty').action === 'keep' && /uncommitted/.test(wOf(dry, 'dirty').why), JSON.stringify(dry.worktrees.map(w => [path.basename(w.path), w.action, w.why])));
  R.check('[LG-03] 계획: 반영된 브랜치만 delete · v5 브랜치(harness/t-…)는 목록에 없다', bOf(dry, 'harness/w-1/IMPL').action === 'delete' && bOf(dry, 'harness/lean-core').action === 'delete' && bOf(dry, 'harness/w-2/IMPL').action === 'keep' && bOf(dry, 'harness/w-4/KEEP').action === 'keep' && bOf(dry, 'harness/w-3/IMPL').action === 'keep' && !bOf(dry, 'harness/t-20260930-000000-abcd'), JSON.stringify(dry.branches.map(b => [b.name, b.action])));
  R.check('[LG-04] 계획: 남는 worktree 가 안에 있는 상태 폴더는 keep · 없는 폴더는 delete', dry.dirs.find(d => /harness-v14$/.test(d.dir)).action === 'keep' && dry.dirs.find(d => /harness-v4$/.test(d.dir)).action === 'delete', JSON.stringify(dry.dirs.map(d => [path.basename(d.dir), d.action])));

  const cli = spawnSync(process.execPath, [CLI, 'cleanup-legacy', '--apply', '--root', r], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const left = git(r, 'branch', '--list', 'harness/*').split(/\r?\n/).map(s => s.replace(/^[*+ ]+/, '').trim()).filter(Boolean).sort();
  R.check('[LG-05] --apply: 반영된 것만 사라지고 나머지는 그대로(CLI exit 0)', cli.status === 0 && JSON.stringify(left) === JSON.stringify(['harness/t-20260930-000000-abcd', 'harness/w-2/IMPL', 'harness/w-3/IMPL', 'harness/w-4/KEEP']) && !fs.existsSync(wtIn('applied')) && fs.existsSync(path.join(wtIn('unapplied'), 'only-here.txt')) && fs.existsSync(path.join(wtIn('dirty'), 'scratch.txt')), `${cli.status} ${left.join(',')} ${cli.stderr.slice(-200)}`);
  R.check('[LG-06] --apply: worktree 가 남은 harness-v14 는 그대로 · harness-v4 는 삭제', fs.existsSync(path.join(common, 'harness-v14', 'coordinator.sqlite')) && !fs.existsSync(path.join(common, 'harness-v4')));
  const rec = JSON.parse(fs.readFileSync(path.join(common, 'harness', 'legacy-pruned.json'), 'utf8'));
  R.check('[LG-07] 지운 브랜치의 이름과 sha 를 기록한다(되살릴 수 있다)', rec.length === 2 && rec.some(x => x.name === 'harness/w-1/IMPL' && x.sha === c1) && rec.every(x => x.merged_into === 'main'), JSON.stringify(rec));
  git(r, 'branch', 'harness/w-1/IMPL', c1);
  R.check('[LG-07] 기록의 sha 로 브랜치를 되살릴 수 있다', git(r, 'rev-parse', 'harness/w-1/IMPL') === c1);

  // 무시된 산출물이 있는 깨끗한 worktree 는 지우지 않는다(git 밖이라 잃는다) — 캐시는 예외
  git(r, 'worktree', 'add', '-q', '-b', 'harness/w-5/OUT', wtIn('artifact'), 'main');
  write(path.join(r, '.git', 'info', 'exclude'), 'out/\n__pycache__/\n');
  write(path.join(wtIn('artifact'), 'out', 'report.txt'), 'generated\n');
  git(r, 'worktree', 'add', '-q', '-b', 'harness/w-6/CACHE', wtIn('cache'), 'main');
  write(path.join(wtIn('cache'), 'pkg', '__pycache__', 'x.pyc'), 'b');
  const p2 = Lg.plan(r);
  R.check('[LG-08] git 밖 산출물이 있으면 keep · 캐시만 있으면 remove', wOf(p2, 'artifact').action === 'keep' && /outside git/.test(wOf(p2, 'artifact').why) && wOf(p2, 'cache').action === 'remove', JSON.stringify(p2.worktrees.map(w => [path.basename(w.path), w.action, w.why])));
  // ── --salvage: 조건에 안 맞는 것도 잃지 않게 옮겨 놓고 지운다 ──
  //   [2026-09-30 실측 · skill-set] 실패한 실행의 미커밋 작업 · 반영 안 된 커밋 · 옛 하네스 런타임 파일 때문에 worktree 14개가 남았다.
  write(path.join(r, '.git', 'info', 'exclude'), 'out/\n__pycache__/\n.claude/\n.env\n');
  write(path.join(wtIn('dirty'), '.claude', '.branch-x', 'pipeline-state.json'), '{}');   // 옛 하네스 런타임 파일(잡음)
  write(path.join(wtIn('dirty'), '.env'), 'SECRET=1\n');                                   // 비밀 — 커밋되지 않고 폴더로
  const noisy = Lg.plan(r);
  git(r, 'worktree', 'add', '-q', '-b', 'harness/w-7/NOISE', wtIn('noise'), 'main');
  write(path.join(wtIn('noise'), '.claude', 'install-logs', 'i.log'), 'log');
  R.check('[LG-10] 옛 하네스 런타임 파일(.claude/.branch-*, install-logs)만 있는 깨끗한 worktree 는 remove', wOf(Lg.plan(r), 'noise').action === 'remove', JSON.stringify(wOf(Lg.plan(r), 'noise')));
  const sp = Lg.plan(r, { salvage: true });
  R.check('[LG-11] --salvage 계획: 미커밋·반영 안 됨·git 밖 산출물은 keep 이 아니라 salvage', wOf(sp, 'dirty').action === 'salvage' && wOf(sp, 'unapplied').action === 'salvage' && wOf(sp, 'artifact').action === 'salvage' && bOf(sp, 'harness/w-4/KEEP').action === 'salvage' && wOf(noisy, 'dirty').action === 'keep', JSON.stringify(sp.worktrees.map(w => [path.basename(w.path), w.action])));
  const tipUnapplied = git(r, 'rev-parse', 'harness/w-2/IMPL');
  const sa = Lg.cleanup({ root: r, apply: true, salvage: true });
  const tags = git(r, 'tag', '-l', 'harness/salvage/*').split(/\r?\n/).filter(Boolean);
  const leftBranches = git(r, 'branch', '--list', 'harness/*').split(/\r?\n/).map(s => s.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
  R.check('[LG-12] --salvage --apply: 옛 worktree·브랜치·상태 폴더가 모두 사라진다(v5 브랜치만 남는다)', sa.ok && JSON.stringify(leftBranches) === JSON.stringify(['harness/t-20260930-000000-abcd']) && git(r, 'worktree', 'list').split(/\r?\n/).length === 1 && !fs.existsSync(path.join(common, 'harness-v14')), `${JSON.stringify(sa.errors)} ${leftBranches.join(',')} | ${git(r, 'worktree', 'list')}`);
  const dirtyTag = tags.find(t => /w-3-IMPL/.test(t));
  R.check('[LG-13] 미커밋 작업은 커밋돼 태그에서 되찾는다', !!dirtyTag && git(r, 'show', `${dirtyTag}:scratch.txt`) === 'wip', `${tags.join(',')} ${dirtyTag && git(r, 'show', `${dirtyTag}:scratch.txt`)}`);
  R.check('[LG-14] 반영 안 된 커밋은 태그에 남는다(브랜치 끝 그대로)', tags.some(t => git(r, 'rev-parse', t) === tipUnapplied) && tags.some(t => /w-4-KEEP/.test(t)), tags.join(','));
  const sdir = path.join(common, 'harness', 'legacy-salvage');
  R.check('[LG-15] git 밖 파일(무시된 산출물 · 비밀)은 salvage 폴더로 복사되고 커밋에는 없다', fs.readFileSync(path.join(sdir, 'harness-w-5-OUT', 'files', 'out', 'report.txt'), 'utf8') === 'generated\n' && fs.readFileSync(path.join(sdir, 'harness-w-3-IMPL', 'files', '.env'), 'utf8') === 'SECRET=1\n' && !/\.env/.test(git(r, 'ls-tree', '-r', '--name-only', dirtyTag)), fs.existsSync(sdir) ? fs.readdirSync(sdir).join(',') : 'no salvage dir');
  R.check('[LG-16] 잡음(옛 런타임 파일)은 salvage 폴더로 복사하지 않는다', !fs.existsSync(path.join(sdir, 'harness-w-3-IMPL', 'files', '.claude')));
  R.check('[LG-09] isLegacyBranch: harness/t-<id> 는 v5 · 그 밖의 harness/* 는 옛 것 · 다른 브랜치는 대상 아님', !Lg.isLegacyBranch('harness/t-20260930-103024-f679') && Lg.isLegacyBranch('harness/w-1/IMPL') && Lg.isLegacyBranch('harness/lean-core') && !Lg.isLegacyBranch('feature/harness-x'));
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ } }
R.done();
