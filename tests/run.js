#!/usr/bin/env node
'use strict';
// tests/run.js — 하네스 v5 테스트 러너.
//   node tests/run.js [부분문자열 필터...]   tests/unit/*.js 를 **병렬로** 돌리고 파일마다 `결과: N PASS / M FAIL` 을 읽는다.
//   결과 줄이 없거나 시간 상한에 걸린 파일은 실패다(조용한 초록 금지). 옛 러너는 legacy/tests/run.js.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');

// 테스트 파일이 쓰는 보고기 — 이 모양과 마지막 줄 형식이 러너와의 계약이다.
function makeReporter(title) {
  let pass = 0, fail = 0;
  if (title) console.log('\n── ' + title + ' ──');
  const record = (ok, label, detail) => {
    if (ok) { pass++; console.log('  ✅ ' + label); return; }
    fail++;
    const d = detail === undefined || detail === null || detail === '' ? '' : ' — ' + String(detail).replace(/\s+/g, ' ').slice(0, 300);
    console.log('  ❌ ' + label + d);
  };
  return {
    test(name, fn) { try { fn(); record(true, name); } catch (e) { record(false, name, e && e.message); } },
    check(label, cond, detail) { record(!!cond, label, detail); },
    get pass() { return pass; },
    get fail() { return fail; },
    done() { console.log(`\n  결과: ${pass} PASS / ${fail} FAIL`); process.exit(fail > 0 ? 1 : 0); },
  };
}

const RESULT = /결과:\s*(\d+)\s*PASS\s*\/\s*(\d+)\s*FAIL/;

function runFile(file, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now(), env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // 작업이 끝날 때마다 docker 를 띄워 보지 않게(테스트의 작업은 컨테이너를 만들지 않는다) — 자원 장부의 docker 경로는 test_v5_resources 가 가짜 실행기로 잰다
    if (env.HARNESS_DOCKER_CLEANUP == null) env.HARNESS_DOCKER_CLEANUP = 'off';
    // 작업이 끝날 때마다 프로세스 목록을 뜨지 않게(작업마다 2초) — 남은 프로세스 정리는 test_v5_resources 가 실제 프로세스로 잰다
    if (env.HARNESS_PROC_CLEANUP == null) env.HARNESS_PROC_CLEANUP = 'off';
    // 작업마다의 임시 폴더(자원 장부)를 이 테스트 파일 전용 폴더 아래로 — 비정상 종료를 흉내 내는 테스트가 남긴 것까지 끝나면 통째로 지운다
    //   [2026-10-20] 테스트가 사용자의 OS 임시 폴더에 빈 폴더 1,098개와 작업 폴더 수십 개를 남겼다.
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-tmp-'));
    env.HARNESS_TMP_BASE = tmpBase;
    const child = spawn(process.execPath, [file], { cwd: path.resolve(__dirname, '..'), env, windowsHide: true });
    let out = '';
    const keep = d => { out += d; if (out.length > 2e6) out = out.slice(-1e6); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      try { fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* 다음 실행의 오래된 폴더 정리가 치운다 */ }
      const m = RESULT.exec(out.split(/\r?\n/).reverse().find(l => RESULT.test(l)) || '');
      resolve({ file, code, timedOut, ms: Date.now() - t0, pass: m ? +m[1] : 0, fail: m ? +m[2] : 0, found: !!m, out });
    });
  });
}

// 테스트가 중간에 끊기면(세션 종료 · 강제 종료) finally 의 정리가 돌지 않아 임시 폴더가 남는다 — 다음 실행이 치운다.
//   동시에 도는 다른 실행의 폴더를 지우지 않도록 6시간 넘은 것만.
const STALE_TMP_MS = 6 * 3600 * 1000;
function sweepStaleTmp(dir, now) {
  const d = dir || os.tmpdir(), gone = [];
  let names = []; try { names = fs.readdirSync(d); } catch { return gone; }
  for (const n of names) {
    if (!/^harness-(v5-[a-z]+|eval-test|test-tmp)-[A-Za-z0-9]{6}$/.test(n)) continue;
    const f = path.join(d, n);
    try { if ((now || Date.now()) - fs.statSync(f).mtimeMs < STALE_TMP_MS) continue; fs.rmSync(f, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); gone.push(n); } catch { /* 다음에 */ }
  }
  return gone;
}

async function main() {
  const swept = sweepStaleTmp();
  if (swept.length) console.log(`[tests] 끊긴 이전 실행의 임시 폴더 ${swept.length}개를 치웠다`);
  const filters = process.argv.slice(2).filter(a => !a.startsWith('--')).map(a => path.basename(a));
  const dir = path.join(__dirname, 'unit');
  let files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort();
  if (filters.length) files = files.filter(f => filters.some(x => f.includes(x)));
  const jobs = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
  const timeoutMs = Number(process.env.HARNESS_TEST_FILE_TIMEOUT_MS) || 600000;   // 실제 작업(.NET 빌드 등)이 함께 도는 PC 에서는 loop 테스트가 300초를 넘겼다
  console.log(`[tests] ${files.length}개 파일 · 동시 ${jobs} · 파일당 상한 ${Math.round(timeoutMs / 1000)}초`);
  const t0 = Date.now(), results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, async () => {
    while (next < files.length) {
      const f = files[next++];
      const r = await runFile(path.join(dir, f), timeoutMs);
      results.push(r);
      const ok = !r.timedOut && r.found && r.fail === 0 && r.code === 0;
      console.log(`  ${ok ? '✅' : '❌'} ${f}  ${r.found ? `${r.pass}/${r.pass + r.fail}` : '결과 줄 없음'}${r.timedOut ? ' · 상한 초과' : ''}${!r.timedOut && r.found && r.fail === 0 && r.code !== 0 ? ` · exit ${r.code}` : ''}  (${(r.ms / 1000).toFixed(1)}s)`);
    }
  }));
  const bad = results.filter(r => r.timedOut || !r.found || r.fail > 0 || r.code !== 0);
  for (const r of bad) {
    console.log(`\n── ${path.basename(r.file)} ──`);
    console.log(r.out.split(/\r?\n/).filter(l => /❌|Error|error|결과/.test(l)).slice(-30).join('\n'));
  }
  const pass = results.reduce((a, r) => a + r.pass, 0), fail = results.reduce((a, r) => a + r.fail, 0) + bad.filter(r => !r.found || r.timedOut).length;
  console.log(`\n[tests] 파일 ${results.length - bad.length}/${results.length} 통과 · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  console.log(`  결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(bad.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { makeReporter, sweepStaleTmp };
