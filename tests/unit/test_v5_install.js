'use strict';
// v5 설치기 — 기존 AGENTS.md · CLAUDE.md · .claude/settings.json(남의 훅) 보존 · 우리 것 추가 · 두 번째 설치는 무변경 ·
//   uninstall 은 원본을 바이트 그대로(우리가 만든 파일만 사라진다) · 전역 CODEX_HOME · HOME 은 건드리지 않는다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const R = makeReporter('v5 설치기 — install · uninstall · 멱등 · 바이트 복원');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-install-'));
const home = path.join(base, 'home');
const codexHome = path.join(home, '.codex');
fs.mkdirSync(codexHome, { recursive: true });
const GLOBAL_HOOKS = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo global"}]}]}}\n';
fs.writeFileSync(path.join(codexHome, 'hooks.json'), GLOBAL_HOOKS);
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
process.env.HOME = home; process.env.USERPROFILE = home; process.env.CODEX_HOME = codexHome;
const gitGlobal = path.join(base, 'gitconfig-global');
fs.writeFileSync(gitGlobal, '');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: gitGlobal, GIT_CONFIG_NOSYSTEM: '1' };
delete ENV.CLAUDE_PROJECT_DIR;

const SOURCE = path.join(__dirname, '..', '..', 'harness');
const { install, uninstall } = require('../../harness/lib/install.js');

function git(cwd, ...args) { return (spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV, windowsHide: true }).stdout || '').trim(); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function mkRepo(name) { const d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q', '-b', 'main'); return d; }
// 작업 트리 전부 + .git/info/exclude 의 바이트 스냅숏(.git 의 나머지는 제외).
function snap(root) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = path.relative(root, p).split(path.sep).join('/');
      if (r === '.git') continue;
      if (e.isDirectory()) { out[r + '/'] = 'dir'; walk(p); } else out[r] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(root);
  out['.git/info/exclude'] = fs.existsSync(path.join(root, '.git', 'info', 'exclude')) ? fs.readFileSync(path.join(root, '.git', 'info', 'exclude')).toString('base64') : null;
  return out;
}
const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]);
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const read = f => fs.readFileSync(f, 'utf8');

try {
  // ── 기존 파일이 있는 저장소 ───────────────────────────────────────
  const t1 = mkRepo('existing');
  const AGENTS0 = '# Proj\n\nexisting rules — keep me';                       // 끝 개행 없음
  const CLAUDE0 = '# Title\r\nbody line\r\n';                                   // CRLF
  const foreign = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/my-guard.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo bye', timeout: 5 }] }],
    },
    env: { FOO: '1' },
  };
  const SETTINGS0 = JSON.stringify(foreign, null, 4) + '\n';                  // 4칸 들여쓰기
  write(path.join(t1, 'AGENTS.md'), AGENTS0);
  write(path.join(t1, 'CLAUDE.md'), CLAUDE0);
  write(path.join(t1, '.claude', 'settings.json'), SETTINGS0);
  write(path.join(t1, 'src', 'app.js'), 'x\n');
  const s0 = snap(t1);

  const r1 = install({ target: t1, source: SOURCE });
  R.check('[install] 요약 {changed[], skipped[]}', Array.isArray(r1.changed) && Array.isArray(r1.skipped) && r1.changed.length > 0, JSON.stringify(r1).slice(0, 300));
  R.check('[install] harness/ 사본(hooks · lib · template · skill)', ['hooks/guard.js', 'hooks/track.js', 'hooks/stop.js', 'hooks/session-end.js', 'hooks/_common.js', 'lib/install.js', 'template/AGENTS.block.md', 'skill/SKILL.md']
    .every(f => fs.existsSync(path.join(t1, 'harness', ...f.split('/')))));
  R.check('[install] harness/ 사본은 원본과 바이트가 같다', read(path.join(t1, 'harness', 'hooks', 'guard.js')) === read(path.join(SOURCE, 'hooks', 'guard.js')));

  const agents = read(path.join(t1, 'AGENTS.md'));
  const blk = agents.slice(agents.indexOf('<!-- harness:begin -->'), agents.indexOf('<!-- harness:end -->') + '<!-- harness:end -->'.length);
  R.check('[install] AGENTS.md: 원래 내용 그대로 + 관리 블록', agents.startsWith(AGENTS0 + '\n\n<!-- harness:begin -->') && agents.endsWith('<!-- harness:end -->\n'), JSON.stringify(agents.slice(0, 120)));
  R.check('[install] 관리 블록 ≤ 40줄 · 핵심 규칙(go · accept · 자기 파일만 커밋 · BLOCKED)', blk.split('\n').length <= 40 && /node harness\/cli\.js go/.test(blk) && /accept <id>/.test(blk) && /자기가 고친 파일만/.test(blk) && /BLOCKED\.md/.test(blk), String(blk.split('\n').length));

  const claude = read(path.join(t1, 'CLAUDE.md'));
  R.check('[install] CLAUDE.md: 첫 제목 다음에 @AGENTS.md (CRLF 유지)', claude === '# Title\r\n\r\n@AGENTS.md\r\nbody line\r\n', JSON.stringify(claude));

  const settings = readJson(path.join(t1, '.claude', 'settings.json'));
  const cmds = ev => (settings.hooks[ev] || []).flatMap(g => g.hooks.map(h => h.command));
  R.check('[install] settings: 남의 키·훅 보존(permissions · env · my-guard · echo bye)',
    Object.keys(foreign.permissions).every(k => k === 'allow' ? foreign.permissions.allow.every(x => settings.permissions.allow.includes(x)) : JSON.stringify(settings.permissions[k]) === JSON.stringify(foreign.permissions[k])) &&
    settings.env.FOO === '1' && cmds('PreToolUse').includes('node scripts/my-guard.js') && cmds('Stop').includes('echo bye'), JSON.stringify(settings).slice(0, 400));
  // [2026-09-29 실측] 대화형 세션이 자기 파일을 묻지 않고 커밋할 수 있게 git 커밋·읽기만 허용한다(위험한 git 은 guard 가 막는다).
  R.check('[install] settings: git add/commit 과 읽기 전용 git 만 허용에 더한다(push·reset 은 없다)',
    ['Bash(git add:*)', 'Bash(git commit:*)', 'PowerShell(git commit:*)', 'Bash(git status:*)'].every(x => settings.permissions.allow.includes(x)) &&
    !settings.permissions.allow.some(x => /push|reset|rebase|merge|clean/.test(x)), JSON.stringify(settings.permissions));
  const expect = { PreToolUse: ['Bash|PowerShell', 'guard'], PostToolUse: ['Write|Edit|MultiEdit|NotebookEdit', 'track'], Stop: [undefined, 'stop'], SessionEnd: [undefined, 'session-end'] };
  R.check('[install] settings: 우리 훅 4종 · 매처 · node "${CLAUDE_PROJECT_DIR}/harness/hooks/<x>.js"', Object.entries(expect).every(([ev, [matcher, x]]) =>
    settings.hooks[ev].some(g => g.matcher === matcher && g.hooks.some(h => h.type === 'command' && h.command === `node "\${CLAUDE_PROJECT_DIR}/harness/hooks/${x}.js"`))), JSON.stringify(settings.hooks));
  R.check('[install] settings: 4칸 들여쓰기 유지', read(path.join(t1, '.claude', 'settings.json')).includes('\n    "permissions"'));

  const codex = readJson(path.join(t1, '.codex', 'hooks.json'));
  const absRoot = fs.realpathSync.native(t1).split(path.sep).join('/');   // 설치기는 실경로를 쓴다(심볼릭 링크 · 짧은 이름)
  R.check('[install] .codex/hooks.json(저장소): 4 이벤트 · --codex · commandWindows 는 설치 때 계산한 절대 경로',
    ['PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'].every(ev => codex.hooks[ev].some(g => g.hooks.some(h => /harness\/hooks\/[a-z-]+\.js" --codex$/.test(h.command) &&
      h.commandWindows.startsWith('node "' + absRoot + '/harness/hooks/') && /\/harness\/hooks\/[a-z-]+\.js" --codex$/.test(h.commandWindows)))) &&
    codex.hooks.PostToolUse[0].matcher.includes('apply_patch'), JSON.stringify(codex));
  R.check('[install] 요약에 Codex 신뢰(프로젝트 trust · /hooks 해시) 안내', r1.notes.some(n => /trust_level/.test(n) && /\/hooks/.test(n)));

  const skillSrc = read(path.join(SOURCE, 'skill', 'SKILL.md'));
  R.check('[install] 스킬 두 곳(.claude/skills · .agents/skills)에 같은 원본', read(path.join(t1, '.claude', 'skills', 'harness', 'SKILL.md')) === skillSrc && read(path.join(t1, '.agents', 'skills', 'harness', 'SKILL.md')) === skillSrc);
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skillSrc);
  const desc = fm && (/^description: (.+)$/m.exec(fm[1]) || [])[1];
  R.check('[install] 스킬 frontmatter: name harness · description ≤ 2문장', fm && /^name: harness$/m.test(fm[1]) && desc && desc.split(/[.。](?:\s|$)/).filter(s => s.trim()).length <= 2, fm && fm[1]);
  R.check('[install] .git/info/exclude 에 .harness-worktrees/', /^\.harness-worktrees\/$/m.test(read(path.join(t1, '.git', 'info', 'exclude'))));
  R.check('[install] 설치 결과가 git 에서 worktree 폴더를 숨긴다', (fs.mkdirSync(path.join(t1, '.harness-worktrees', 'x'), { recursive: true }), write(path.join(t1, '.harness-worktrees', 'x', 'f'), 'f'), !/harness-worktrees/.test(git(t1, 'status', '--porcelain', '--untracked-files=all'))));
  fs.rmSync(path.join(t1, '.harness-worktrees'), { recursive: true, force: true });

  // 설치된 명령이 그대로 돈다 — 설정 파일의 문자열을 셸로 실행해 git push 가 막히는지 본다.
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'e2e', cwd: t1, tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  const claudeCmd = settings.hooks.PreToolUse.find(g => g.matcher === 'Bash|PowerShell').hooks[0].command.replace('${CLAUDE_PROJECT_DIR}', t1);
  const e2e = spawnSync(claudeCmd, { shell: true, input: payload, encoding: 'utf8', cwd: t1, env: ENV, windowsHide: true, timeout: 30000 });
  R.check('[install/e2e] Claude 명령으로 설치된 guard 가 git push 를 deny', e2e.status === 0 && /"permissionDecision":"deny"/.test(e2e.stdout), e2e.stdout + e2e.stderr);
  const codexCmd = codex.hooks.PreToolUse[0].hooks[0][process.platform === 'win32' ? 'commandWindows' : 'command'];
  const e2x = spawnSync(codexCmd, { shell: true, input: payload, encoding: 'utf8', cwd: t1, env: ENV, windowsHide: true, timeout: 30000 });
  R.check('[install/e2e] Codex 명령(저장소 루트에서)으로도 deny', e2x.status === 0 && /"permissionDecision":"deny"/.test(e2x.stdout), e2x.stdout + e2x.stderr);

  // [리뷰 L10] Codex 는 명령을 세션 cwd 에서 돌린다 — 하위 폴더에서도 훅을 찾아야 한다(상대 경로면 무음 실패).
  fs.mkdirSync(path.join(t1, 'src', 'deep'), { recursive: true });
  const e2sub = spawnSync(codexCmd, { shell: true, input: payload, encoding: 'utf8', cwd: path.join(t1, 'src', 'deep'), env: ENV, windowsHide: true, timeout: 30000 });
  R.check('[L10/codex] 하위 폴더 cwd 에서도 Codex 명령이 guard 를 찾아 deny', e2sub.status === 0 && /"permissionDecision":"deny"/.test(e2sub.stdout), e2sub.stdout + e2sub.stderr);
  fs.rmSync(path.join(t1, 'src', 'deep'), { recursive: true, force: true });

  // 멱등
  const s1 = snap(t1);
  const d01 = diffKeys(s0, s1);
  R.check('[반증] 스냅숏은 설치가 바꾼 것을 본다(AGENTS · CLAUDE · settings · exclude · 새 파일)', ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.git/info/exclude', '.codex/hooks.json', 'harness/hooks/guard.js'].every(k => d01.includes(k)), JSON.stringify(d01.slice(0, 20)));
  const r2 = install({ target: t1, source: SOURCE });
  const s2 = snap(t1);
  R.check('[install] 두 번째 설치: changed 없음 · 모든 파일 바이트 그대로', r2.changed.length === 0 && diffKeys(s1, s2).length === 0, JSON.stringify(r2.changed) + ' ' + JSON.stringify(diffKeys(s1, s2)));

  // 이미 블록이 있으면 그 자리에서 바꾼다(블록 밖은 그대로)
  const t3 = mkRepo('reblock');
  write(path.join(t3, 'AGENTS.md'), 'intro\n\n<!-- harness:begin -->\nOLD RULES\n<!-- harness:end -->\n\noutro\n');
  install({ target: t3, source: SOURCE });
  const a3 = read(path.join(t3, 'AGENTS.md'));
  R.check('[install] 기존 관리 블록 교체 — 밖은 보존 · 옛 내용 사라짐 · 블록 하나', a3.startsWith('intro\n\n<!-- harness:begin -->\n') && a3.endsWith('<!-- harness:end -->\n\noutro\n') && !a3.includes('OLD RULES') && a3.split('<!-- harness:begin -->').length === 2, a3.slice(0, 80));

  // 깨진 settings.json 은 건드리지 않는다
  const t4 = mkRepo('broken');
  write(path.join(t4, '.claude', 'settings.json'), '{ not json');
  const r4 = install({ target: t4, source: SOURCE });
  R.check('[install] JSON 이 아닌 settings.json → skipped · 파일 그대로', read(path.join(t4, '.claude', 'settings.json')) === '{ not json' && r4.skipped.some(s => s.path === '.claude/settings.json'), JSON.stringify(r4.skipped));

  // dryRun
  const t5 = mkRepo('dry');
  const d0 = snap(t5);
  // cli.js 는 source 로 harness 를 담은 저장소 루트(harness/..)를 넘긴다 — 그 형태도 받는다.
  const r5 = install({ target: t5, source: path.dirname(SOURCE), dryRun: true });
  R.check('[install] dryRun: 바꿀 목록은 내고 파일은 그대로 (source = 저장소 루트 형태)', r5.ok === true && r5.changed.includes('AGENTS.md') && r5.changed.includes('.claude/settings.json') && r5.changed.includes('harness/hooks/guard.js') && diffKeys(d0, snap(t5)).length === 0 && /dry run/.test(r5.report));

  // uninstall — 원본 바이트 복원
  const u1 = uninstall({ target: t1 });
  const s3 = snap(t1);
  R.check('[uninstall] 작업 트리 전체가 설치 전과 바이트 그대로(AGENTS · CLAUDE · settings · exclude · 우리 파일 없음)', diffKeys(s0, s3).length === 0, JSON.stringify(diffKeys(s0, s3)));
  R.check('[uninstall] 요약 · 설치 기록 제거', u1.changed.length > 0 && !fs.existsSync(path.join(t1, '.git', 'harness', 'install.json')));

  // uninstall 은 그 사이 사용자가 더한 것을 지키고 우리 것만 걷는다
  const t6 = mkRepo('edited');
  write(path.join(t6, '.claude', 'settings.json'), SETTINGS0);
  install({ target: t6, source: SOURCE });
  const st6 = readJson(path.join(t6, '.claude', 'settings.json'));
  st6.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo later' }] });
  write(path.join(t6, '.claude', 'settings.json'), JSON.stringify(st6, null, 4) + '\n');
  uninstall({ target: t6 });
  const st6b = readJson(path.join(t6, '.claude', 'settings.json'));
  R.check('[uninstall] 설치 뒤 사용자가 더한 훅은 남고 우리 훅만 사라진다',
    !JSON.stringify(st6b).includes('harness/hooks') && JSON.stringify(st6b.hooks.Stop) === JSON.stringify([...foreign.hooks.Stop, { hooks: [{ type: 'command', command: 'echo later' }] }]) && !st6b.hooks.PostToolUse, JSON.stringify(st6b));

  // 빈 저장소 — 전부 우리가 만든 파일 → 전부 사라진다
  const t2 = mkRepo('fresh');
  const f0 = snap(t2);
  install({ target: t2, source: SOURCE });
  R.check('[install/fresh] AGENTS.md 는 블록만 · CLAUDE.md 는 템플릿(@AGENTS.md 첫 줄 · ≤ 20줄)',
    /^<!-- harness:begin -->\n[\s\S]+\n<!-- harness:end -->\n$/.test(read(path.join(t2, 'AGENTS.md'))) &&
    read(path.join(t2, 'CLAUDE.md')).split('\n')[0] === '@AGENTS.md' && read(path.join(t2, 'CLAUDE.md')).trimEnd().split('\n').length <= 20);
  const self = install({ target: t2, source: path.join(t2, 'harness') });
  R.check('[install] 대상이 원본이면 harness/ 복사를 건너뛴다(그리고 바꿀 것이 없다)', self.skipped.some(s => s.path === 'harness/') && self.changed.length === 0, JSON.stringify(self));
  uninstall({ target: t2 });
  R.check('[uninstall/fresh] 우리가 만든 파일·폴더가 모두 사라져 설치 전과 같다', diffKeys(f0, snap(t2)).length === 0, JSON.stringify(diffKeys(f0, snap(t2))));

  // [리뷰 L10] 저장소를 옮긴 뒤 다시 설치하면 옛 절대 경로 훅을 걷고 새 것 하나만 남긴다(멱등 유지).
  const t7 = mkRepo('moved');
  install({ target: t7, source: SOURCE });
  const cf7 = path.join(t7, '.codex', 'hooks.json');
  const c7 = readJson(cf7);
  for (const ev of Object.keys(c7.hooks)) for (const g of c7.hooks[ev]) for (const h of g.hooks) h.commandWindows = h.commandWindows.replace(/^node "[^"]*\/harness\/hooks\//, 'node "D:/old place/repo/harness/hooks/');
  write(cf7, JSON.stringify(c7, null, 2) + '\n');
  const r7 = install({ target: t7, source: SOURCE });
  const c7b = readJson(cf7);
  const t7abs = fs.realpathSync.native(t7).split(path.sep).join('/');
  // 사양 변경(2026-10-13): Stop 에 우리 훅이 둘(stop · lang)이다 — "이벤트마다 하나" 가 아니라 "설치기가 정한 수 그대로(옛 경로 사본 없이)".
  const want7 = require('../../harness/lib/install.js').codexHooks(t7);
  R.check('[L10/codex] 옮긴 저장소 재설치: 옛 경로 훅은 사라지고 이벤트마다 설치기가 정한 우리 훅만 · 새 절대 경로',
    r7.changed.includes('.codex/hooks.json') && Object.entries(c7b.hooks).every(([ev, gs]) => gs.length === 1 && gs[0].hooks.length === want7[ev][0].hooks.length && gs[0].hooks.every(h => h.commandWindows.startsWith('node "' + t7abs + '/'))), JSON.stringify(c7b).slice(0, 400));
  R.check('[L10/codex] 그 뒤 설치는 다시 바이트 그대로', install({ target: t7, source: SOURCE }).changed.length === 0);

  // [리뷰 M11] 경로에 harness/hooks/ 가 들어간 사용자 훅 · 설치 전부터 있던 allow 항목은 걷지 않는다.
  const t8 = mkRepo('userhooks');
  const userSettings = {
    permissions: { allow: ['Bash(git status:*)', 'Bash(npm test)', 'PowerShell(git commit:*)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node tools/harness/hooks/lint.js' }, { type: 'command', command: 'node "D:/elsewhere/harness/hooks/guard.js"' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node ./vendor/harness/hooks/stop.js --verbose' }] }],
    },
  };
  const US0 = JSON.stringify(userSettings, null, 2) + '\n';
  write(path.join(t8, '.claude', 'settings.json'), US0);
  const userCodex = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node my/harness/hooks/notify.js', commandWindows: 'node my\\harness\\hooks\\notify.js' }] }] } };
  const UC0 = JSON.stringify(userCodex, null, 2) + '\n';
  write(path.join(t8, '.codex', 'hooks.json'), UC0);
  install({ target: t8, source: SOURCE });
  const s8 = readJson(path.join(t8, '.claude', 'settings.json'));
  const s8cmds = Object.values(s8.hooks).flatMap(gs => gs.flatMap(g => g.hooks.map(h => h.command)));
  R.check('[M11] 설치: 사용자 훅(tools/harness/hooks/lint.js · 다른 경로의 guard.js · vendor/.../stop.js)은 남는다',
    ['node tools/harness/hooks/lint.js', 'node "D:/elsewhere/harness/hooks/guard.js"', 'node ./vendor/harness/hooks/stop.js --verbose'].every(c => s8cmds.includes(c)), JSON.stringify(s8cmds));
  R.check('[M11] 설치: 이미 있던 allow 는 제자리에 · 중복 없이 우리 것만 더한다',
    JSON.stringify(s8.permissions.allow.slice(0, 3)) === JSON.stringify(userSettings.permissions.allow) && s8.permissions.allow.filter(x => x === 'Bash(git status:*)').length === 1 && s8.permissions.allow.includes('Bash(git add:*)'), JSON.stringify(s8.permissions.allow));
  R.check('[M11] 두 번째 설치도 바이트 그대로', install({ target: t8, source: SOURCE }).changed.length === 0);
  uninstall({ target: t8 });
  R.check('[M11] uninstall: settings.json 이 설치 전과 바이트 그대로(사용자 훅 · 원래 allow 보존)', read(path.join(t8, '.claude', 'settings.json')) === US0, read(path.join(t8, '.claude', 'settings.json')));
  R.check('[M11] uninstall: .codex/hooks.json 의 사용자 훅도 그대로', read(path.join(t8, '.codex', 'hooks.json')) === UC0, read(path.join(t8, '.codex', 'hooks.json')));
  // 설치 뒤 사용자가 settings 를 고쳐 원본 복원이 안 되는 경우에도 원래 allow 는 남는다.
  write(path.join(t8, '.claude', 'settings.json'), US0);
  install({ target: t8, source: SOURCE });
  const s8c = readJson(path.join(t8, '.claude', 'settings.json'));
  s8c.env = { LATER: '1' };
  write(path.join(t8, '.claude', 'settings.json'), JSON.stringify(s8c, null, 2) + '\n');
  uninstall({ target: t8 });
  const s8d = readJson(path.join(t8, '.claude', 'settings.json'));
  R.check('[M11] uninstall(사용자가 그 사이 고침): 원래 있던 git status/commit allow 는 남고 우리가 더한 것만 사라진다',
    JSON.stringify(s8d.permissions.allow) === JSON.stringify(userSettings.permissions.allow) && s8d.env.LATER === '1', JSON.stringify(s8d));

  // [리뷰 M12] 우리 것이 아닌 harness/ 는 덮어쓰지 않는다 — 버전 마커가 없으면 중단, force 로만.
  R.check('[M12] 설치는 harness/.harness-version 마커를 남긴다', fs.existsSync(path.join(t7, 'harness', '.harness-version')));
  const t9 = mkRepo('foreign');
  write(path.join(t9, 'harness', 'README.md'), 'my own harness\n');
  write(path.join(t9, 'harness', 'hooks', 'guard.js'), '// mine\n');
  const f9 = snap(t9);
  let r9 = null, e9 = null;
  try { r9 = install({ target: t9, source: SOURCE }); } catch (e) { e9 = e; }
  R.check('[M12] 마커 없는 기존 harness/ → ok:false · 이유에 --force · 아무것도 쓰지 않음',
    !e9 && r9 && r9.ok === false && /--force/.test(r9.report) && diffKeys(f9, snap(t9)).length === 0 && !fs.existsSync(path.join(t9, '.git', 'harness', 'install.json')), (e9 ? String(e9) : JSON.stringify(r9)) + ' ' + JSON.stringify(diffKeys(f9, snap(t9))));
  const d9 = install({ target: t9, source: SOURCE, dryRun: true });
  R.check('[M12] dryRun 도 같은 거절을 보고한다', d9 && d9.ok === false, JSON.stringify(d9).slice(0, 200));
  const r9f = install({ target: t9, source: SOURCE, force: true });
  R.check('[M12] force 면 설치 · 마커가 생긴다', r9f.ok === true && fs.existsSync(path.join(t9, 'harness', '.harness-version')) && read(path.join(t9, 'harness', 'hooks', 'guard.js')) === read(path.join(SOURCE, 'hooks', 'guard.js')), JSON.stringify(r9f.changed.slice(0, 5)));
  R.check('[M12] 그 뒤(마커 있음)는 force 없이도 재설치 · 바이트 그대로', (() => { const r = install({ target: t9, source: SOURCE }); return r.ok === true && r.changed.length === 0; })());
  // 마커 없이 옛 설치 기록(install.json)만 있는 저장소도 우리 것이다(마커 도입 전 설치).
  fs.unlinkSync(path.join(t9, 'harness', '.harness-version'));
  const r9m = install({ target: t9, source: SOURCE });
  R.check('[M12] 설치 기록이 harness/ 를 가리키면 마커가 없어도 우리 것 — 설치하고 마커를 되살린다', r9m.ok === true && fs.existsSync(path.join(t9, 'harness', '.harness-version')), r9m.report);

  // [2026-09-30 실측 · Python 서비스 저장소] 다른 세션의 작업이 도는 중에 재설치해 harness/ 파일을 바꿨다 — 주인이 살아 있는 작업이 있으면 멈춘다.
  const t10 = mkRepo('t10');
  install({ target: t10, source: SOURCE });
  const taskDir = path.join(t10, '.git', 'harness', 'tasks', 't-20260930-000000-abcd');
  fs.mkdirSync(taskDir, { recursive: true });
  const taskJson = owner => fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id: 't-20260930-000000-abcd', status: 'running', owner }));
  taskJson({ pid: process.pid, host: os.hostname(), heartbeat_at: new Date().toISOString() });
  const cliBefore = read(path.join(t10, 'harness', 'cli.js'));
  fs.writeFileSync(path.join(t10, 'harness', 'cli.js'), cliBefore + '\n// local marker\n');
  const r10 = install({ target: t10, source: SOURCE });
  R.check('[RUN] 주인이 살아 있는 실행 중 작업이 있으면 harness/ 를 갈아 끼우지 않는다(ok:false · 이유에 작업 id)', r10.ok === false && /t-20260930-000000-abcd/.test(r10.report) && read(path.join(t10, 'harness', 'cli.js')).endsWith('// local marker\n'), r10.report);
  taskJson({ pid: 999999, host: os.hostname(), heartbeat_at: new Date().toISOString() });
  const r10b = install({ target: t10, source: SOURCE });
  R.check('[RUN] 주인이 죽은 작업은 막지 않는다', r10b.ok !== false && read(path.join(t10, 'harness', 'cli.js')) === cliBefore, r10b.report);

  R.check('[격리] 전역 CODEX_HOME/hooks.json 은 바이트 그대로 · 다른 파일 없음', read(path.join(codexHome, 'hooks.json')) === GLOBAL_HOOKS && fs.readdirSync(codexHome).length === 1);
  R.check('[격리] 가짜 HOME 에 .claude · .agents 가 생기지 않았다', !fs.existsSync(path.join(home, '.claude')) && !fs.existsSync(path.join(home, '.agents')));
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
finally {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 디렉터리 정리 실패는 결과와 무관 */ }
}
R.done();
