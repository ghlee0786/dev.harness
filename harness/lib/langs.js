'use strict';
// 언어 팩(PRD R5) — 하네스가 언어에 따라 달라지는 것을 한곳에: 저장소 감지 · 테스트 명령 · 작업자에게 허용할 프로그램 ·
//   쓰레기 패턴(디버그 흔적 · 테스트 약화 · 안 쓰는 정의 · 주석) · 테스트 요약 읽기 · 빌드 비용.
//   [2026-10-20 사용자 지시] 특정 언어에 치우치지 않는다(Python · .NET · C++ · JS · Go …) — 공장 · 루프는 언어를 모르고, 언어의 차이는 여기에만 둔다.
//   새 언어 = 팩 하나를 더한다. 감지 순서가 곧 우선순위다(한 저장소에 여러 언어가 있으면 앞의 팩이 테스트 명령을 정한다).
const fs = require('node:fs'), path = require('node:path');
const IS_WIN = process.platform === 'win32';

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const readText = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
const NPM_DEFAULT_TEST = /no test specified/i;

// 공용 정의 패턴 — C# · Java · Kotlin 처럼 한정자 + 반환형 + 이름( 꼴
const CURLY_DEF = /^\s*(?:(?:public|private|protected|internal|static|async|virtual|sealed|abstract|partial|final|readonly|unsafe|extern|new)\s+)+(?!class\b|interface\b|struct\b|record\b|enum\b|override\b)[\w<>[\],.?]+(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)\s*\([^;]*$/;
const SLASH_COMMENT = /^\s*\/\/(?!\/)\s?(.*)$/;

const PACKS = [
  { id: 'node', exts: /\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte)$/i, cost: 'light', allow: ['node', 'npm', 'npx'],
    detect: names => names.includes('package.json'),
    test: root => {
      if (!exists(root, 'package.json')) return null;
      let pkg = null; try { pkg = JSON.parse(readText(root, 'package.json')); } catch { /* 깨진 package.json */ }
      const t = pkg && pkg.scripts && pkg.scripts.test;
      return typeof t === 'string' && t.trim() && !NPM_DEFAULT_TEST.test(t) ? { commands: [['npm', 'test']], from: 'package.json' } : null;
    },
    debug: [/\bconsole\.(log|debug|trace|dir)\s*\(|^\s*debugger\s*;?\s*$/],
    weaken: [/\b(it|test|describe|context|suite)\.(skip|only)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|expect\(true\)\.toBe\(true\)/],
    defs: [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
      /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/],
    comment: SLASH_COMMENT },
  { id: 'python', exts: /\.py$/i, cost: 'light', allow: ['python', 'py', 'pytest'],
    detect: names => ['pyproject.toml', 'pytest.ini', 'setup.py', 'requirements.txt', 'tox.ini'].some(n => names.includes(n)),
    test: root => exists(root, 'pytest.ini') || /^\s*\[tool\.pytest/m.test(readText(root, 'pyproject.toml')) || /^\s*\[(tool:)?pytest\]/m.test(readText(root, 'setup.cfg') + '\n' + readText(root, 'tox.ini'))
      ? { commands: [['python', '-m', 'pytest']], from: 'pytest' } : null,
    // 멈춘 테스트 떼어 내기(checks.isolateHangs) — 출력이 멈춘 자리의 테스트를 --deselect 로 뺀다. -q 출력이면 먼저 -v 로 다시 돌려 이름을 얻는다.
    //   병렬(-n · xdist)은 출력 순서가 달라 멈춘 테스트를 짚을 수 없다 — 건드리지 않는다.
    hang: {
      applies: argv => (/(^|[\\/])py\.?test(\.exe)?$/i.test(argv[0]) || (/(^|[\\/])(python[\d.]*|py)(\.exe)?$/i.test(argv[0]) && argv[1] === '-m' && argv[2] === 'pytest'))
        && !argv.some(a => /^(-n|--numprocesses|--dist)(=|$)|^-n\d/.test(a)),
      next: (argv, output) => {
        const lines = String(output || '').split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(Boolean), last = lines[lines.length - 1] || '';
        const id = /^(\S+\.py::\S+)$/.exec(last);
        if (id) return { argv: [...argv, '--deselect', id[1]], exclude: id[1] };
        if (/^\S+\.py [.FEsxX]*$/.test(last) && !argv.some(a => /^(-v+|--verbose)$/.test(a))) return { argv: [...argv, '-v'] };
        return null;
      } },
    debug: [/\bbreakpoint\(\)|\b(i?pdb)\.set_trace\(/],
    weaken: [/@pytest\.mark\.(skip|xfail)|\bpytest\.skip\(|^\s*assert\s+True\s*$/],
    defs: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, /^\s*class\s+([A-Za-z_]\w*)/],
    comment: /^\s*#(?![!#])\s?(.*)$/ },
  { id: 'dotnet', exts: /\.(cs|vb|fs)$/i, cost: 'heavy', allow: ['dotnet'],
    detect: names => names.some(n => /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(n)),
    test: (root, names) => { const f = names.find(n => /\.slnx?$/i.test(n)) || names.find(n => /\.(csproj|fsproj|vbproj)$/i.test(n)); return f ? { commands: [['dotnet', 'test']], from: f } : null; },
    debug: [/\bDebugger\.(Break|Launch)\(\)/],
    weaken: [/\[Ignore\b|\bSkip\s*=\s*"|Assert\.(True|IsTrue)\(\s*true\s*\)/],
    defs: [CURLY_DEF], comment: SLASH_COMMENT, commentByExt: { vb: /^\s*'\s?(.*)$/ } },
  { id: 'go', exts: /\.go$/i, cost: 'light', allow: ['go'],
    detect: names => names.includes('go.mod'),
    test: root => exists(root, 'go.mod') ? { commands: [['go', 'test', './...']], from: 'go.mod' } : null,
    debug: [/^\s*println\(|\bspew\.(Dump|Printf|Sdump)\(|\bpp\.Println\(|\bruntime\.Breakpoint\(\)/],
    weaken: [/\bt\.Skip(f|Now)?\(/],
    defs: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/],
    comment: SLASH_COMMENT },
  { id: 'rust', exts: /\.rs$/i, cost: 'heavy', allow: ['cargo'],
    detect: names => names.includes('Cargo.toml'),
    test: root => exists(root, 'Cargo.toml') ? { commands: [['cargo', 'test']], from: 'Cargo.toml' } : null,
    debug: [/\bdbg!\s*\(/],
    weaken: [/#\[ignore\b/],
    defs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/],
    comment: SLASH_COMMENT },
  { id: 'java', exts: /\.(java|kt|kts|scala|groovy)$/i, cost: 'heavy', allow: ['mvn', 'gradle', 'mvnw', 'gradlew'],
    detect: names => ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some(n => names.includes(n)),
    test: (root, names) => {
      if (names.includes('pom.xml')) return { commands: [names.includes(IS_WIN ? 'mvnw.cmd' : 'mvnw') ? [IS_WIN ? 'mvnw.cmd' : './mvnw', '-q', 'test'] : ['mvn', '-q', 'test']], from: 'pom.xml' };
      if (names.some(n => /^build\.gradle(\.kts)?$/.test(n))) return { commands: [names.includes(IS_WIN ? 'gradlew.bat' : 'gradlew') ? [IS_WIN ? 'gradlew.bat' : './gradlew', 'test'] : ['gradle', 'test']], from: names.find(n => /^build\.gradle/.test(n)) };
      return null;
    },
    debug: [/\.printStackTrace\(\s*\)|\bSystem\.(out|err)\.print(ln|f)?\(\s*"\s*(DEBUG|debug)/],
    weaken: [/@Disabled\b|@Ignore\b|\bassumeTrue\(\s*false\s*\)/],
    defs: [CURLY_DEF], comment: SLASH_COMMENT },
  { id: 'cpp', exts: /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|ipp|inl)$/i, cost: 'heavy', allow: ['cmake', 'ctest', 'make'],
    detect: names => names.includes('CMakeLists.txt') || names.includes('meson.build') || names.some(n => /^(GNU)?makefile$/i.test(n)),
    test: (root, names) => {
      // CMake: 테스트를 선언한 저장소만(enable_testing · add_test · gtest_discover_tests) — 하네스 전용 빌드 폴더에 설정 · 빌드 · ctest
      if (names.includes('CMakeLists.txt') && /\b(enable_testing|add_test|gtest_discover_tests|catch_discover_tests|doctest_discover_tests)\s*\(/i.test(readText(root, 'CMakeLists.txt')))
        return { commands: [['cmake -S . -B .harness-build && cmake --build .harness-build && ctest --test-dir .harness-build --output-on-failure']], from: 'CMakeLists.txt' };
      if (names.includes('meson.build')) return { commands: [['meson setup .harness-build --reconfigure && meson test -C .harness-build']], from: 'meson.build' };
      const mk = names.find(n => /^(GNU)?makefile$/i.test(n));
      if (mk && /^(test|check)\s*:/m.test(readText(root, mk))) return { commands: [['make', /^test\s*:/m.test(readText(root, mk)) ? 'test' : 'check']], from: mk };
      return null;
    },
    debug: [/\bstd::(cout|cerr)\s*<<\s*"\s*(DEBUG|debug)|\b(f?printf)\(\s*(stderr\s*,\s*)?"\s*(DEBUG|debug)|\b__debugbreak\(\)|\bDebugBreak\(\)|\braise\(\s*SIGTRAP\s*\)/],
    weaken: [/\bGTEST_SKIP\(|\b(TEST|TEST_F|TEST_P)\s*\(\s*\w+\s*,\s*DISABLED_|\bdoctest::skip\(|\bSKIP\(\s*"/],
    defs: [],   // 헤더 · 매크로 · 링크 단위 때문에 글자 검색으로는 "안 쓰임" 을 믿을 수 없다 — C/C++ 는 컴파일러 경고(-Wunused)에 맡긴다
    comment: SLASH_COMMENT },
  // 감지 · 테스트 명령은 없고 쓰레기 패턴만(정의 · 주석) — Swift · Dart · PHP 등
  { id: 'curly-misc', exts: /\.(swift|dart|php)$/i, cost: 'light', allow: [], detect: () => false, test: () => null, debug: [], weaken: [], defs: [CURLY_DEF], comment: SLASH_COMMENT },
];

const listRoot = root => { try { return fs.readdirSync(root); } catch { return []; } };
const byId = new Map(PACKS.map(p => [p.id, p]));
function detect(root) { const names = listRoot(root); return PACKS.filter(p => p.detect(names)).map(p => p.id); }
// 저장소에서 찾은 테스트 명령 — 팩 순서대로 처음 것
function testCommand(root) {
  const names = listRoot(root);
  for (const p of PACKS) { const t = p.test(root, names); if (t) return { ...t, pack: p.id }; }
  return null;
}
const packOf = file => PACKS.find(p => p.exts.test(file)) || null;
// 이 검사 명령(argv)의 멈춘 테스트를 떼어 낼 줄 아는 팩 — 셸 문자열(argv 길이 1 · 공백)은 고칠 수 없으니 없음
const hangFor = argv => (Array.isArray(argv) && argv.length && !(argv.length === 1 && /\s/.test(argv[0])) ? (PACKS.find(p => p.hang && p.hang.applies(argv)) || {}).hang || null : null);
const allowFor = ids => [...new Set(ids.flatMap(id => (byId.get(id) || { allow: [] }).allow))];
const debugFor = file => (packOf(file) || { debug: [] }).debug;
const defsFor = file => (packOf(file) || { defs: [] }).defs;
const WEAKEN = new RegExp(PACKS.flatMap(p => p.weaken.map(r => r.source)).join('|'));
function commentOf(file, line) {
  const p = packOf(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  let re = p && p.commentByExt && p.commentByExt[ext] ? p.commentByExt[ext] : p && p.comment;
  if (!re) {   // 팩이 없는 스크립트 · 설정 언어
    if (/\.(rb|sh|ps1|ya?ml|toml)$/i.test(file)) re = /^\s*#(?![!#])\s?(.*)$/; else if (/\.(sql|lua)$/i.test(file)) re = /^\s*--\s?(.*)$/; else return null;
  }
  const c = re.exec(line); return c ? c[1] : null;
}

// 테스트 요약 — 하네스 공용 형식 다음으로 언어별 러너(cargo · go · ctest · maven/surefire)
function parseSummary(s) {
  const cargo = [...s.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return { found: true, pass: cargo.reduce((a, m) => a + Number(m[1]), 0), fail: cargo.reduce((a, m) => a + Number(m[2]), 0) };
  const ctest = [...s.matchAll(/(\d+)% tests passed, (\d+) tests? failed out of (\d+)/g)].pop();
  if (ctest) return { found: true, pass: Number(ctest[3]) - Number(ctest[2]), fail: Number(ctest[2]) };
  const mvn = [...s.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)\s*$/gm)].pop();
  if (mvn) { const run = Number(mvn[1]), f = Number(mvn[2]) + Number(mvn[3]); return { found: true, pass: run - f - Number(mvn[4]), fail: f }; }
  const goOk = [...s.matchAll(/^ok\s+\S+/gm)].length, goFail = [...s.matchAll(/^(FAIL\s+\S+\s+[\d.]+s|--- FAIL:)/gm)].length;
  if (goOk || goFail) return { found: true, pass: goOk, fail: goFail };
  return null;
}

module.exports = { PACKS, detect, testCommand, packOf, hangFor, allowFor, debugFor, defsFor, commentOf, WEAKEN, parseSummary, byId };
