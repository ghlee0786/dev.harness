'use strict';
// 언어 팩(PRD R5) — 감지 · 테스트 명령 · 허용 프로그램 · 테스트 요약 · 쓰레기 패턴이 언어마다 같은 방식으로(C/C++ · Java · Go · Rust 포함). 모델 호출 없음.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const Lg = require('../../harness/lib/langs');
const K = require('../../harness/lib/checks');
const Q = require('../../harness/lib/quality');
const R = makeReporter('언어 팩 — 감지 · 명령 · 요약 · 쓰레기 패턴');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-langs-'));
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
let seq = 0;
const dir = files => { const d = path.join(base, `d${++seq}`); for (const [f, t] of Object.entries(files)) write(path.join(d, f), t); fs.mkdirSync(d, { recursive: true }); return d; };
const IS_WIN = process.platform === 'win32';

try {
  // LG-01 — 감지 · 테스트 명령 · 우선순위
  const cmd = files => { const t = Lg.testCommand(dir(files)); return t ? `${t.pack}:${t.commands.map(c => c.join(' ')).join(' ; ')}` : null; };
  const cases = [
    [{ 'package.json': '{"scripts":{"test":"node t.js"}}' }, 'node:npm test'],
    [{ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' }, null],
    [{ 'pytest.ini': '[pytest]\n' }, 'python:python -m pytest'],
    [{ 'App.sln': '' }, 'dotnet:dotnet test'],
    [{ 'go.mod': 'module x\n' }, 'go:go test ./...'],
    [{ 'Cargo.toml': '[package]\n' }, 'rust:cargo test'],
    [{ 'pom.xml': '<project/>' }, 'java:mvn -q test'],
    [{ 'build.gradle': '', [IS_WIN ? 'gradlew.bat' : 'gradlew']: '' }, `java:${IS_WIN ? 'gradlew.bat' : './gradlew'} test`],
    [{ 'CMakeLists.txt': 'project(x)\nenable_testing()\nadd_test(NAME a COMMAND a)\n' }, 'cpp:cmake -S . -B .harness-build && cmake --build .harness-build && ctest --test-dir .harness-build --output-on-failure'],
    [{ 'CMakeLists.txt': 'project(x)\n' }, null],
    [{ 'Makefile': 'all:\n\tcc x.c\ntest:\n\t./t\n' }, 'cpp:make test'],
    [{ 'package.json': '{"scripts":{"test":"jest"}}', 'CMakeLists.txt': 'enable_testing()\n' }, 'node:npm test'],
  ];
  const got = cases.map(([f, want]) => [want, cmd(f)]);
  R.check('[LG-01] 언어마다 테스트 명령(node · python · dotnet · go · rust · java(maven · gradle 래퍼) · c/c++(cmake+ctest · make)) · 테스트가 없으면 null · 순서가 우선순위', got.every(([w, g]) => w === g), JSON.stringify(got.filter(([w, g]) => w !== g)));
  R.check('[LG-01] checks.discover 가 언어 팩을 쓴다(c/c++ 는 셸 문자열 · 프로젝트 블록이 있으면 그것이 먼저)', K.discover(dir({ 'CMakeLists.txt': 'enable_testing()\n' })).commands[0][0].startsWith('cmake -S') && K.discover(dir({ 'go.mod': '', 'AGENTS.md': '```yaml\ntest_command: "go test ./pkg/..."\n```\n' })).commands[0].join(' ') === 'go test ./pkg/...');
  R.check('[LG-01] 저장소 종류 · 작업자 허용 프로그램(c/c++ → cmake · ctest · make · java → mvn · gradle)', JSON.stringify(K.repoKinds(dir({ 'CMakeLists.txt': '', 'pom.xml': '' }))) === JSON.stringify(['java', 'cpp']) && ['cmake', 'ctest', 'make', 'mvn'].every(p => K.allowCommands(dir({ 'CMakeLists.txt': '', 'pom.xml': '' }), { commands: [], source: 'detected' }).includes(p)));

  // LG-02 — 테스트 요약(언어별 러너)
  const ps = t => { const s = K.parseSummary(t); return `${s.found}:${s.pass}/${s.fail}`; };
  const sums = [
    [ps('running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored\n\ntest result: FAILED. 1 passed; 2 failed; 0 ignored\n'), 'true:4/2'],
    [ps('90% tests passed, 1 tests failed out of 10\n'), 'true:9/1'],
    [ps('[INFO] Results:\n[WARNING] Tests run: 12, Failures: 1, Errors: 1, Skipped: 2\n'), 'true:8/2'],
    [ps('ok  \tgithub.com/x/a\t0.01s\n--- FAIL: TestB (0.00s)\nFAIL\tgithub.com/x/b\t0.02s\nok  \tgithub.com/x/c\t0.01s\n'), 'true:2/2'],
    [ps('== 1 failed, 3 passed in 0.5s =='), 'true:3/1'],
  ];
  R.check('[LG-02] 요약 읽기: cargo(크레이트 합) · ctest · maven/surefire · go(패키지) · 기존 pytest 그대로', sums.every(([g, w]) => g === w), JSON.stringify(sums));

  // LG-03 — 쓰레기 패턴(새로 더한 줄만): 디버그 흔적 · 테스트 약화 · 억누르기 · 안 쓰는 정의 — go · rust · c++ · java
  const r = dir({ 'main.go': 'package main\n', 'src/lib.rs': 'pub fn a() {}\n', 'src/a.cpp': 'int a() { return 1; }\n', 'src/A.java': 'class A {}\n' });
  git(r, 'init', '-q', '-b', 'main'); git(r, 'config', 'user.name', 't'); git(r, 'config', 'user.email', 't@x'); git(r, 'config', 'commit.gpgsign', 'false'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'i');
  const b = git(r, 'rev-parse', 'HEAD');
  write(path.join(r, 'main.go'), 'package main\n\nfunc main() {\n\tprintln("here")\n\tx := 1 //nolint\n\t_ = x\n}\n\nfunc neverCalledGo() int { return 2 }\n');
  write(path.join(r, 'main_test.go'), 'package main\nimport "testing"\nfunc TestX(t *testing.T) { t.Skip("later") }\n');
  write(path.join(r, 'src/lib.rs'), 'pub fn a() { let v = dbg!(1); }\n#[allow(dead_code)]\nfn never_called_rs() {}\n');
  write(path.join(r, 'tests/it.rs'), '#[test]\n#[ignore]\nfn slow() {}\n');
  write(path.join(r, 'src/a.cpp'), '#include <iostream>\nint a() { std::cerr << "DEBUG a" << std::endl; return 1; } // NOLINT\n');
  write(path.join(r, 'tests/a_test.cpp'), 'TEST(Suite, DISABLED_Case) { GTEST_SKIP(); }\n');
  write(path.join(r, 'src/A.java'), 'class A {\n  void run() { try { } catch (Exception e) { e.printStackTrace(); } }\n}\n');
  write(path.join(r, 'tests/ATest.java'), 'class ATest {\n  @Disabled\n  void t() {}\n}\n');
  const f = Q.find(r, b);
  const has = (rule, file) => f.some(x => x.rule === rule && x.file === file);
  const want = [['debug', 'main.go'], ['debug', 'src/lib.rs'], ['debug', 'src/a.cpp'], ['debug', 'src/A.java'],
    ['test-weaken', 'main_test.go'], ['test-weaken', 'tests/it.rs'], ['test-weaken', 'tests/a_test.cpp'], ['test-weaken', 'tests/ATest.java'],
    ['suppress', 'main.go'], ['suppress', 'src/lib.rs'], ['suppress', 'src/a.cpp'], ['unused', 'main.go'], ['unused', 'src/lib.rs']];
  const miss = want.filter(([rl, fl]) => !has(rl, fl));
  R.check('[LG-03] go · rust · c++ · java 의 디버그 흔적 · 테스트 약화 · 억누르기 · (go · rust) 안 쓰는 정의를 잡는다', !miss.length, JSON.stringify({ miss, found: f.map(x => [x.rule, x.file, x.text.slice(0, 40)]) }));
  R.check('[LG-03] C/C++ 는 "안 쓰는 정의" 를 글자로 판단하지 않는다(헤더 · 매크로 — 컴파일러 경고에 맡김)', !f.some(x => x.rule === 'unused' && /\.cpp$/.test(x.file)));
  R.check('[LG-04] 팩 목록: 모든 팩이 같은 모양(감지 · 명령 · 패턴 · 비용)', Lg.PACKS.every(p => typeof p.detect === 'function' && typeof p.test === 'function' && p.exts instanceof RegExp && Array.isArray(p.debug) && Array.isArray(p.weaken) && Array.isArray(p.defs) && /^(light|heavy)$/.test(p.cost)) && Lg.PACKS.length >= 8);
} catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 900)); }
finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
R.done();
