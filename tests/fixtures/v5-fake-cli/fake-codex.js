'use strict';
// 가짜 codex — `codex exec --json` 의 JSONL 을 재생한다. 이벤트 모양은 Codex 조사 §5.2(소스 exec_events.rs · 문서 예시)를 따른다.
//   argv · stdin 을 FAKE_LOG 에 적는다. 실제 모델 턴은 돌리지 않는다.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'ok';
const LIMIT = 'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 30th, 2026 7:21 AM.';
const NEW_ID = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const emit = e => process.stdout.write(JSON.stringify(e) + '\n');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { stdin += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, cwd: process.cwd() }));
  const ri = argv.indexOf('resume');
  const tid = ri >= 0 ? argv[ri + 1] : NEW_ID;
  emit({ type: 'thread.started', thread_id: tid });
  emit({ type: 'turn.started' });
  switch (mode) {
    case 'ok':
      process.stdout.write('not json — a stray log line\n');
      emit({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
      emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'powershell -c node -e "console.log(1)"', aggregated_output: '', exit_code: null, status: 'in_progress' } });
      emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'powershell -c node -e "console.log(1)"', aggregated_output: '1\n', exit_code: 0, status: 'completed' } });
      emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'first message' } });
      emit({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 } });
      emit({ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: 'hello.txt', kind: 'add' }], status: 'completed' } });
      emit({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'final answer' } });
      // 스레드 누계 — 합산하면 25813+1050 이 된다. 마지막 값이 맞다.
      emit({ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 0, output_tokens: 122, reasoning_output_tokens: 0 } });
      process.exit(0); break;
    case 'quota': emit({ type: 'turn.failed', error: { message: LIMIT } }); process.exit(1); break;
    case 'fail': emit({ type: 'turn.failed', error: { message: 'sandbox refused the write' } }); process.exit(1); break;
    case 'error-only': emit({ type: 'error', message: 'unexpected status 401 Unauthorized' }); process.exit(1); break;
    case 'declined':
      emit({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'git commit -m x', aggregated_output: '', exit_code: null, status: 'declined' } });
      emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'could not commit' } });
      emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } });
      process.exit(0); break;
    case 'hang': {
      const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      if (process.env.FAKE_PIDS) fs.writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ self: process.pid, grand: g.pid }));
      setInterval(() => {}, 1000);
      break;
    }
    default: process.exit(9);
  }
});
