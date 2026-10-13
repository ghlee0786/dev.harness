'use strict';
// 가짜 claude — 러너가 넘긴 argv · stdin · --settings 파일 내용 · 환경을 FAKE_LOG 에 적고, FAKE_MODE 에 맞는 결과를 낸다.
//   node fake-claude.js <claude 인자…>  (러너의 exePrefixArgs 로 이 스크립트 경로를 앞에 붙인다)
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'ok';
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
if (argv[0] === '--version') { process.stdout.write((process.env.FAKE_VERSION || '2.1.283') + ' (Claude Code)\n'); process.exit(0); }

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { stdin += d; });
process.stdin.on('end', () => {
  const settingsPath = val('--settings');
  let settings = null; try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* 없음 */ }
  if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, settingsPath, settings, cwd: process.cwd(),
    env: { CLAUDECODE: process.env.CLAUDECODE ?? null, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? null } }));
  const sid = val('--resume') || val('--session-id');
  const result = (extra) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sid,
    total_cost_usd: Number(process.env.FAKE_COST || 0.5), num_turns: 3, permission_denials: [],
    usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 5 }, ...(extra || {}) }) + '\n');
  switch (mode) {
    case 'ok': process.stdout.write('some noise before\n'); result(); process.exit(0); break;
    case 'denied': result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'git push origin main' } }] }); process.exit(0); break;
    case 'quota': result({ is_error: true, result: "You've hit your limit · resets 7pm (Asia/Seoul)" }); process.exit(1); break;
    case 'auth': process.stderr.write('Invalid API key · Please run /login\n'); process.exit(1); break;
    case 'model': result({ is_error: true, result: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' }); process.exit(1); break;
    case 'budget': result({ subtype: 'error_max_budget_usd', is_error: true, result: '' }); process.exit(1); break;
    case 'crash': process.stderr.write('TypeError: boom\n    at x (y.js:1:1)\n'); process.exit(3); break;
    case 'hang': {
      const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      if (process.env.FAKE_PIDS) fs.writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ self: process.pid, grand: g.pid }));
      setInterval(() => {}, 1000);
      break;
    }
    default: process.exit(9);
  }
});
