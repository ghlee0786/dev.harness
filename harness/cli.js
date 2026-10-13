#!/usr/bin/env node
'use strict';
// 하네스 v5 CLI. 작업 1 = worktree 1 = 브랜치 1 = 세션 1. 사용자 브랜치는 accept 전까지 움직이지 않는다.
//   go/resume/accept/cancel/restore 의 마지막 줄은 기계용 `HARNESS_RESULT {json}`.
//   exit 0 은 done · accepted · cancelled · restored 일 때만. 사용법 오류는 2.
const fs = require('node:fs'), path = require('node:path');

const USAGE = `usage:
  node harness/cli.js go (--goal-file <path> | - | "<goal>") [--check "<cmd>"]... [--runtime claude|codex] [--model M] [--effort E]
                     [--budget-usd N] [--token-budget N] [--wall-min N] [--max-continuations N] [--base <branch>] [--root <repo>] [--init] [--doc <path>]... [--attach <file>]...
      --goal-file <path>: the goal verbatim from a UTF-8 file · "-": the goal from stdin (no shell quoting of the request)
      --init: create a git repository at --root if there is none (otherwise refused)
      --doc <path>: a managed document (docs/prds · docs/coordinations · docs/designs) the worker reads as the specification (repeatable)
      --attach <file>: give the worker a file with the goal — image · video (frames + transcript) · audio (transcript) · PDF · document (repeatable)
      --allow "<rule>": also let the unattended worker run this, e.g. --allow "Bash(docker build:*)" (repeatable; added to the project
                        block's worker_allow; Tool one of Bash|PowerShell|Read|Edit|Write|WebFetch; git writes · shells · Bash(*) are refused; no effect on Codex)
  node harness/cli.js resume <id> [--allow "<rule>"]... [--budget-usd N] [--token-budget N] [--wall-min N] [--max-continuations N] [--model M] [--effort E]
      caps are totals for the whole task (not additions): pass the new total, e.g. --budget-usd 40 after $20 was spent
      a blocked task resumes in the same session: its BLOCKED.md is kept as BLOCKED.<n>.md and the worker is told what you allowed
  node harness/cli.js status [--json]
  node harness/cli.js accept <id> [--into <branch>] [--force] [--budget-usd N]   (only after the user accepts the result; --force for tasks not 'done')
  node harness/cli.js cancel <id> [--skip-checks]
  node harness/cli.js restore <id> [--skip-checks]
  node harness/cli.js gc [--json]
  node harness/cli.js stop <id>                 (the way to stop a running task: ends its process tree, commits work in progress, status interrupted)
  node harness/cli.js push [<remote>] [<branch>] | push [<remote>] --tag <name> [--dry-run]   (only after the user explicitly asks; fast-forward only, never force, never harness/* branches)
  node harness/cli.js cleanup-legacy [--salvage] [--apply] [--json]   (leftovers of earlier harness versions; removes only what loses nothing — --salvage first keeps dirty/unmerged work at tags harness/salvage/* and copies files outside git; dry run unless --apply)
  node harness/cli.js install [--target <repo>] [--track-docs] | uninstall [--target <repo>]
      --track-docs: add a managed .gitignore block so docs/prds · docs/coordinations · docs/designs · docs/README.md are tracked by git
                    (default: .gitignore is left alone and the install report only says whether they are ignored)
  node harness/cli.js doc new <prd|coordination|design> "<title>" [--with <project>] [--direction outgoing|incoming] [--from-file <md>] [--json]
  node harness/cli.js doc list [kind] [--status draft|active|done|superseded] [--json]
  node harness/cli.js doc status <path> <draft|active|done|superseded> [--by <path>]   (superseded needs --by)
  node harness/cli.js doc index | doc check [--json] | doc history <path> [--json] | doc restore <path> <version>
  node harness/cli.js doc adopt <path> [--status draft|active|done] [--with <project>] [--direction outgoing|incoming]   (bring an existing doc under management)
      documents are created only when the user asks; nothing is generated automatically
  node harness/cli.js help
defaults: runtime claude · model opus · budget $20 · wall 120 min · max continuations 8 (with --runtime codex and no --model: Codex's own default model)`;

const VALUE = new Set(['--check', '--runtime', '--model', '--effort', '--budget-usd', '--token-budget', '--wall-min', '--max-continuations', '--root', '--into', '--base', '--target', '--check-timeout-min', '--goal-file',
  '--doc', '--with', '--direction', '--from-file', '--status', '--by', '--allow', '--attach', '--sent', '--repo', '--kind', '--title', '--body', '--body-file', '--tag']);
const FLAGS = new Set(['--auto', '--open', '--json', '--help', '-h', '--uninstall', '--dry-run', '--force', '--init', '--skip-checks', '--fresh-baseline', '--apply', '--salvage', '--track-docs']);

function parse(argv) {
  const o = { _: [], checks: [], docs: [], allow: [], attach: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) { o[a.replace(/^-+/, '')] = true; continue; }
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    const key = eq ? eq[1] : a;
    if (VALUE.has(key)) {
      let v;
      if (eq) v = eq[2]; else { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); v = argv[++i]; }
      if (key === '--check') o.checks.push(v); else if (key === '--doc') o.docs.push(v); else if (key === '--allow') o.allow.push(v); else if (key === '--attach') o.attach.push(v); else o[key.slice(2)] = v;
      continue;
    }
    if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    o._.push(a);
  }
  const num = (k, min, int) => {
    if (o[k] == null) return undefined;
    const v = Number(o[k]);
    if (!Number.isFinite(v) || !(v > min)) throw new Error(`--${k} must be a number > ${min}`);
    return int ? Math.floor(v) : v;
  };
  if (o.runtime && !['claude', 'codex'].includes(o.runtime)) throw new Error('--runtime must be claude or codex');
  return { ...o, budgetUsd: num('budget-usd', 0), tokenBudget: num('token-budget', 0, true), wallMin: num('wall-min', 0),
    maxContinuations: num('max-continuations', -1, true), checkTimeoutMs: o['check-timeout-min'] != null ? num('check-timeout-min', 0) * 60000 : undefined, freshBaseline: !!o['fresh-baseline'] };
}

const OK = new Set(['done', 'accepted', 'cancelled', 'restored']);
function resultLine(r) {
  const keep = ['id', 'status', 'reason', 'refused', 'branch', 'commit', 'base_branch', 'checks', 'cost_usd', 'unknown_cost_calls', 'tokens', 'continuations', 'wall_ms', 'files_changed',
    'tests_modified', 'checks_modified', 'secrets_excluded', 'commit_skipped', 'outside_git', 'worktree', 'merge_commit', 'revert_commit', 'task_status', 'docs'];
  const o = {};
  for (const k of keep) if (r[k] !== undefined) o[k] = r[k];
  return `HARNESS_RESULT ${JSON.stringify(o)}`;
}

async function main(argv, io) {
  const out = (io && io.out) || (s => process.stdout.write(s + '\n'));
  const err = (io && io.err) || (s => process.stderr.write(s + '\n'));
  let o;
  try { o = parse(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  const [cmd, ...rest] = o._;
  if (!cmd || cmd === 'help' || o.help || o.h) { out(USAGE); return cmd || o.help || o.h ? 0 : 2; }
  const root = o.root ? path.resolve(o.root) : process.cwd();
  const common = { root, log: err, run: io && io.run, checkTimeoutMs: o.checkTimeoutMs };
  // 자동 갱신 확인(설치된 사본 · 하루 한 번 · 별도 프로세스) — 갱신 · 설치 명령 자신은 빼고. 실패는 조용히.
  if (!['install', 'uninstall', 'update', 'version'].includes(cmd)) { try { require('./lib/autoupdate').maybe(root); } catch { /* 하네스를 멈추지 않는다 */ } }

  if (cmd === 'install' || cmd === 'uninstall') {
    let I;
    try { I = require('./lib/install'); }
    catch (e) { if (e.code === 'MODULE_NOT_FOUND' && /lib[\\/]install/.test(e.message)) { err('harness/lib/install.js is missing — install is not available in this copy'); return 1; } throw e; }
    const fn = cmd === 'uninstall' || o.uninstall ? I.uninstall : I.install;
    if (typeof fn !== 'function') { err(`harness/lib/install.js does not export ${cmd}`); return 1; }
    const r = await fn({ target: o.target ? path.resolve(o.target) : root, source: path.resolve(__dirname, '..'), dryRun: !!o['dry-run'], force: !!o.force, trackDocs: !!o['track-docs'], log: out });
    if (r && typeof r === 'object' && r.report) out(r.report);
    return r && r.ok === false ? 1 : 0;
  }
  if (cmd === 'doc') return docCommand(rest, o, root, out, err);
  if (cmd === 'push') {
    const Pu = require('./lib/push');
    try {
      const r = Pu.push({ root, remote: rest[0], branch: rest[1], tag: o.tag, dryRun: !!o['dry-run'] });
      out(o.json ? JSON.stringify(r, null, 2) : Pu.format(r));
      return r.ok ? 0 : 1;
    } catch (e) { err(`harness push: ${e.message}`); return e.code === 'USAGE' ? 2 : 1; }
  }
  if (cmd === 'report' || cmd === 'report-bug') {
    // 하네스 보고 — 동작 이상(bug) · 의도와 다른 행동(intent) · 더 나은 방향(improve). 내용은 하네스 동작만 · 가려서.
    //   report --kind <bug|intent|improve> --title "<한 줄>" [--body "<내용>" | --body-file <파일>] → 기록하고 자동으로 올린다(켜져 있고 로그인이 있으면).
    //   report(인자 없음) → 쌓인 것을 올리고, 못 올린 것은 가린 초안과 이슈 링크로 보여 준다. --open: 링크를 브라우저로 · --sent <서명>: 보냄 표시.
    const Bg = require('./lib/bugreport');
    try {
      if (o.sent) { Bg.markSent(root, o.sent, (Bg.collect(root, { all: true }).find(e => e.sig === o.sent) || {}).count); out(`보냄으로 표시: ${o.sent}`); return 0; }
      if (o.title) {
        const body = o['body-file'] ? fs.readFileSync(path.resolve(o['body-file']), 'utf8') : (o.body || '');
        const e = Bg.note(root, o.kind || 'bug', o.title, body);
        out(`기록했다: [${e.kind}] ${e.message} (서명 ${e.sig})`);
      }
      const a = await Bg.autoReport(root);
      for (const p of a.posted) out(`${p.action === 'comment' ? '재발 댓글을 달았다' : '이슈를 올렸다'}: ${p.url}`);
      if (a.skipped === 'no-auth') out('자동으로 올리지 못했다 — 이 PC 에 GitHub 로그인이 없다(한 번만: `gh auth login` 또는 환경 변수 HARNESS_GITHUB_TOKEN). 아래 링크로 올릴 수 있다.');
      if (a.skipped === 'disabled' && o.title) out('자동 발행이 꺼져 있다(원본 저장소이거나 bug_report: off · HARNESS_BUG_REPORT=off) — 아래 링크로 올릴 수 있다.');
      const list = Bg.collect(root);
      if (!list.length) { out('보고할 하네스 결함이 없다.'); return 0; }
      const repo = o.repo || process.env.HARNESS_BUG_REPO || Bg.DEFAULT_REPO;
      for (const e of list) {
        const d = Bg.draft(e, { repo, existing: await Bg.findExisting(e.sig, repo) });
        out([`── ${e.recurred ? '재발 · ' : ''}${d.title}`, d.existing ? `이미 같은 이슈가 있다(#${d.existing.number}) — 재발을 댓글로 알려 주세요: ${d.url}` : `이슈 링크(열어서 내용을 확인하고 제출): ${d.url}`, '', d.body, ''].join('\n'));
        if (o.open) Bg.openUrl(d.url);
      }
      out(`보낸 뒤: node harness/cli.js report-bug --sent <서명>  (다시 묻지 않는다 · 재발하면 다시 보인다)`);
      return 0;
    } catch (e) { err(`harness report-bug: ${e.message}`); return 1; }
  }
  if (cmd === 'update' || cmd === 'version') {
    // 배포된 최신 릴리스로 갈아 끼운다(--dry-run 은 비교만) · version 은 지금 판만.
    const U = require('./lib/update');
    if (cmd === 'version') { out(`harness ${U.currentVersion()}`); return 0; }
    try { const r = await U.update({ root, check: !!o['dry-run'], repo: o.repo, auto: !!o.auto }); out(r.report); return r.ok ? 0 : 1; }
    catch (e) { err(`harness update: ${e.message}`); return 1; }
  }
  if (cmd === 'stop') {
    const St = require('./lib/stop');
    try {
      if (!rest[0]) throw Object.assign(new Error('stop needs a task id'), { code: 'USAGE' });
      const r = await St.stop({ root, id: rest[0] });
      out(o.json ? JSON.stringify(r, null, 2) : St.format(r));
      return r.ok ? 0 : 1;
    } catch (e) { err(`harness stop: ${e.message}`); return e.code === 'USAGE' ? 2 : 1; }
  }
  if (cmd === 'cleanup-legacy') {
    const Lg = require('./lib/legacy');
    try {
      const r = Lg.cleanup({ root, apply: !!o.apply, salvage: !!o.salvage });
      out(o.json ? JSON.stringify(r, null, 2) : Lg.format(r));
      return r.ok ? 0 : 1;
    } catch (e) { err(`harness cleanup-legacy: ${e.message}`); return 1; }
  }
  if (cmd === 'status' || cmd === 'gc') {
    const St = require('./lib/status');
    try {
      const r = cmd === 'status' ? St.status(common) : St.gc(common);
      out(o.json ? JSON.stringify(r, null, 2) : (cmd === 'status' ? St.formatStatus(r) : St.formatGc(r)));
      return 0;
    } catch (e) { err(`harness ${cmd}: ${e.message}`); return 1; }
  }

  // task id 는 진입점에서 형식을 강제한다(L5) — `resume ..\..\x` 같은 경로가 상태 디렉터리 밖을 가리키지 않게.
  const needId = () => {
    const id = rest[0];
    if (!id) throw Object.assign(new Error(`${cmd} needs a task id`), { code: 'USAGE' });
    if (!require('./lib/state').validId(id)) throw Object.assign(new Error(`invalid task id: ${JSON.stringify(id).slice(0, 80)} (expected t-yyyymmdd-HHMMss-xxxx)`), { code: 'USAGE' });
    return id;
  };
  const caps = { budgetUsd: o.budgetUsd, tokenBudget: o.tokenBudget, wallMin: o.wallMin, maxContinuations: o.maxContinuations, model: o.model, effort: o.effort };
  let r;
  try {
    if (cmd === 'go') {
      // 목표 원문(L6): --goal-file <path> · `go -`(stdin) · 인자. 셸을 거친 인자는 따옴표·$()·백틱이 망가뜨릴 수 있다 — 스킬은 파일을 쓴다.
      const fromStdin = rest.length === 1 && rest[0] === '-';
      const sources = [o['goal-file'] != null, fromStdin, !fromStdin && rest.length > 0].filter(Boolean).length;
      if (sources > 1) { err(`go takes the goal from one place: --goal-file, "-" (stdin) or the arguments\n${USAGE}`); return 2; }
      let goal;
      try {
        if (o['goal-file'] != null) goal = fs.readFileSync(path.resolve(o['goal-file']), 'utf8');
        else if (fromStdin) goal = (io && typeof io.stdin === 'string') ? io.stdin : fs.readFileSync(0, 'utf8');
        else goal = rest.join(' ');
      } catch (e) { err(`cannot read the goal: ${e.message}`); return 2; }
      goal = String(goal).replace(/^\uFEFF/, '').trim();
      if (!goal) { err(`go needs a goal\n${USAGE}`); return 2; }
      // --doc 경로는 부른 곳(cwd) 기준 — 루프는 저장소 상대로 바꿔 기록한다.
      r = await require('./lib/loop').go({ ...common, ...caps, goal, checks: o.checks, runtime: o.runtime, base: o.base, init: !!o.init, docs: o.docs.map(p => path.resolve(p)), allow: o.allow, attach: o.attach.map(p => path.resolve(p)) });
    } else if (cmd === 'resume') r = await require('./lib/loop').resume({ ...common, ...caps, id: needId(), allow: o.allow });
    else if (cmd === 'accept') r = await require('./lib/integrate').accept({ ...common, id: needId(), into: o.into, budgetUsd: o.budgetUsd, force: !!o.force });
    else if (cmd === 'cancel') r = await require('./lib/integrate').cancel({ ...common, id: needId(), skipChecks: !!o['skip-checks'] });
    else if (cmd === 'restore') r = await require('./lib/integrate').restore({ ...common, id: needId(), skipChecks: !!o['skip-checks'] });
    else { err(`unknown command: ${cmd}\n${USAGE}`); return 2; }
  } catch (e) {
    if (e.code === 'USAGE') { err(`${e.message}\n${USAGE}`); return 2; }
    // 예기치 못한 예외 = 하네스 결함일 수 있다 — 가려서 기록하고 보고 방법을 알린다(없는 작업 · 잠금 같은 운영 오류는 빼고).
    const bug = !['UNKNOWN_TASK', 'LOCK_HELD'].includes(e.code) && require('./lib/bugreport').record(root, 'cli', e);
    r = { id: rest[0] || null, status: 'error', reason: `${e.code ? e.code + ': ' : ''}${e.message}`, report: `harness error: ${e.stack || e.message}${bug ? `\n하네스 결함으로 보입니다(서명 ${bug.sig}) — 내용을 확인하고 보고하려면: node harness/cli.js report-bug` : ''}` };
  }
  // 쌓인 하네스 보고를 자동으로 올린다(설치된 사본 · 로그인이 있을 때만 · 실패는 조용히).
  try { const a = await require('./lib/bugreport').autoReport(root); for (const p of a.posted) err(`[harness] 하네스 보고를 올렸다: ${p.url}`); } catch { /* 보고가 작업을 멈추지 않는다 */ }
  out(r.report || `harness ${r.id} — ${r.status}${r.reason ? ': ' + r.reason : ''}`);
  out(resultLine(r));
  return !r.refused && OK.has(r.status) ? 0 : 1;
}

// doc <sub> — 관리 문서(prd · coordination · design). 사용자가 요청할 때만 만든다. 사용법 오류 2 · 그 밖의 실패 1 · check 문제 1.
function docCommand(rest, o, root, out, err) {
  const D = require('./lib/docs');
  const [sub, ...args] = rest;
  // 경로 인자: 부른 곳 기준으로 있으면 그것, 아니면 저장소 루트 기준(docRel 이 푼다).
  const p = x => (x != null && fs.existsSync(path.resolve(x)) ? path.resolve(x) : x);
  const json = x => out(JSON.stringify(x, null, 2));
  try {
    if (sub === 'new') {
      const [kind, ...title] = args;
      if (!kind) throw Object.assign(new Error('doc new needs a kind and a title'), { code: 'USAGE' });
      const r = D.newDoc({ root, kind, title: title.join(' '), with: o.with, direction: o.direction, fromFile: o['from-file'] });
      if (o.json) json(r);
      else {
        out(`만들었다: ${r.path}`);
        out(r.tracking === 'git' ? '  git 이 추적한다 — 커밋은 직접 한다.' : r.tracking === 'ignored' ? `  git 이 무시하는 경로다 — 로컬 전용(바꿀 때마다 이전 판이 ${D.historyRoot(require('./lib/state').mainRoot(root))} 에 남는다).` : '  아직 git 에 없다(추적 안 됨) — 필요하면 직접 add · commit 한다.');
        if (r.index_changed) out(`  색인 갱신: ${D.INDEX_REL}`);
      }
      return 0;
    }
    if (sub === 'list') {
      const rows = D.list(root, { kind: args[0], status: o.status });
      out(o.json ? JSON.stringify(rows, null, 2) : D.formatList(rows));
      return 0;
    }
    if (sub === 'status') {
      if (args.length !== 2) throw Object.assign(new Error('doc status needs <path> <status>'), { code: 'USAGE' });
      const r = D.setStatus({ root, path: p(args[0]), status: args[1], by: o.by != null ? p(o.by) : undefined });
      if (o.json) json(r); else out(`${r.path}: ${r.from || '?'} → ${r.to}${r.by ? ` (대체: ${r.by})` : ''}${r.index_changed ? ` · 색인 갱신: ${D.INDEX_REL}` : ''}`);
      return 0;
    }
    if (sub === 'adopt') {
      if (args.length !== 1) throw Object.assign(new Error('doc adopt needs <path>'), { code: 'USAGE' });
      const r = D.adopt({ root, path: p(args[0]), status: o.status, with: o.with, direction: o.direction });
      if (o.json) json(r); else out(`관리에 넣었다: ${r.path} (${r.kind} · ${r.status} · ${r.title})${r.index_changed ? ` · 색인 갱신: ${D.INDEX_REL}` : ''}`);
      return 0;
    }
    if (sub === 'index') {
      const r = D.writeIndex(root);
      if (o.json) json(r); else out(r.changed ? `색인 갱신: ${r.path}` : `색인 그대로: ${r.path}`);
      return 0;
    }
    if (sub === 'check') {
      const r = D.check(root);
      out(o.json ? JSON.stringify(r, null, 2) : D.formatCheck(r));
      return r.ok ? 0 : 1;
    }
    if (sub === 'history') {
      if (args.length !== 1) throw Object.assign(new Error('doc history needs <path>'), { code: 'USAGE' });
      const r = D.history(root, p(args[0]));
      if (o.json) json(r);
      else out(r.length ? r.map(v => `${v.version}  ${v.bytes}B  ${v.at}`).join('\n') : '이력 없음');
      return 0;
    }
    if (sub === 'restore') {
      if (args.length !== 2) throw Object.assign(new Error('doc restore needs <path> <version>'), { code: 'USAGE' });
      const r = D.restore(root, p(args[0]), args[1]);
      if (o.json) json(r); else out(`복원: ${r.path} ← ${r.restored}${r.saved ? ` (바꾸기 전 판은 ${r.saved} 로 보관)` : ''}`);
      return 0;
    }
    err(`unknown doc command: ${sub || '(none)'}\n${USAGE}`);
    return 2;
  } catch (e) {
    if (e.code === 'USAGE') { err(`${e.message}\n${USAGE}`); return 2; }
    err(`harness doc ${sub}: ${e.message}`);
    return 1;
  }
}

module.exports = { main, parse, USAGE };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write((e && e.stack || String(e)) + '\n'); process.exitCode = 1; });
}
