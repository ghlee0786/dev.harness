'use strict';
// v5 관리 문서 — doc new · list · status · index · check · history · restore · go --doc · accept 연결 · 설치기 .gitignore(--track-docs).
//   문서는 사용자가 요청할 때만 만든다. 모델은 부르지 않는다(가짜 러너). 모든 저장소는 임시 디렉터리에 있다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const R = makeReporter('v5 관리 문서 — doc · go --doc · accept 연결 · --track-docs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-docs-'));
// 사용자 전역 git 설정(전역 excludes 등)이 check-ignore 판정에 섞이지 않게.
const gitGlobal = path.join(base, 'gitconfig-global');
fs.writeFileSync(gitGlobal, '');
process.env.GIT_CONFIG_GLOBAL = gitGlobal;

const S = require('../../harness/lib/state');
const L = require('../../harness/lib/loop');
const I = require('../../harness/lib/integrate');
let D = null;
try { D = require('../../harness/lib/docs'); } catch (e) { R.check('[DOC-00] harness/lib/docs.js 를 불러온다', false, e.message); R.done(); }
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const SOURCE = path.join(__dirname, '..', '..', 'harness');

const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (cwd, args) => (spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const gitCode = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).status;
const ignored = (cwd, p) => gitCode(cwd, ['check-ignore', '-q', p]) === 0;
let seq = 0;
function mkRepo(files) {
  const dir = path.join(base, `r${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'user.email', 't@example.invalid']); git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [f, t] of Object.entries({ 'README.md': '# r\n', ...(files || {}) })) write(path.join(dir, f), t);
  git(dir, ['add', '-A']); git(dir, ['commit', '-qm', 'init']);
  return dir;
}
const cli = (cwd, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: process.env });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
const cliJson = (cwd, args) => { const r = cli(cwd, [...args, '--json']); try { return { ...r, json: JSON.parse(r.out) }; } catch { return { ...r, json: null }; } };
const fm = (root, rel) => D.readDoc(root, rel).data;
const today = D.today();
const quiet = { log: () => {} };
const CHECK_JS = `const fs=require('fs');if(fs.existsSync('feature.txt')){console.log('# pass 1\\n# fail 0');process.exit(0);}console.log('# pass 0\\n# fail 1');process.exit(1);`;
function fake() {
  const calls = [];
  const run = async o => {
    calls.push({ ...o, signal: undefined });
    const id = path.basename(o.cwd);
    write(path.join(o.cwd, 'feature.txt'), 'feature\n');
    write(path.join(o.cwd, '.harness', id, 'PLAN.md'), '# plan\n');
    return { ok: true, session_id: o.sessionId || o.newSessionId || 's', final_text: 'Done.', cost_usd: 0.1, is_error: false, error_kind: null, permission_denials: [] };
  };
  run.calls = calls;
  return run;
}

(async () => {
  try {
    // ── new ─────────────────────────────────────────────────────────
    const r1 = mkRepo();
    const l0 = cli(r1, ['doc', 'list']);
    R.check('[DOC-01] 아무것도 자동으로 만들지 않는다 — 빈 저장소의 doc list 는 docs/ 를 만들지 않는다', l0.code === 0 && !fs.existsSync(path.join(r1, 'docs')), l0.err);
    const n1 = cliJson(r1, ['doc', 'new', 'prd', '결제 흐름 개선: v2!']);
    const p1 = `docs/prds/${today}-결제-흐름-개선-v2.md`;
    R.check('[DOC-01] prd → docs/prds/<날짜>-<슬러그>.md (한글 유지 · 기호 → - · 끝 - 제거)', n1.code === 0 && n1.json && n1.json.path === p1 && fs.existsSync(path.join(r1, p1)), `${n1.code} ${n1.out} ${n1.err}`);
    const f1 = fm(r1, p1);
    R.check('[DOC-01] front matter: kind · title · status draft · created/updated 오늘 · tasks [] · supersedes 빈 값', f1.kind === 'prd' && f1.title === '결제 흐름 개선: v2!' && f1.status === 'draft' && f1.created === today && f1.updated === today
      && Array.isArray(f1.tasks) && f1.tasks.length === 0 && !f1.supersedes && !f1.superseded_by && f1.with === undefined && f1.direction === undefined, JSON.stringify(f1));
    const t1 = read(path.join(r1, p1));
    R.check('[DOC-01] 파일은 --- 로 시작하고 prd 골격(배경 · 목표 · 요구사항 · 범위 밖 · 완료 기준 · 열린 질문)', t1.startsWith('---\nkind: prd\n') && ['배경', '목표', '요구사항', '범위 밖', '완료 기준', '열린 질문'].every(h => t1.includes(`## ${h}\n`)), t1);
    const n1b = cliJson(r1, ['doc', 'new', 'prds', '결제 흐름 개선: v2!']);
    const n1c = cliJson(r1, ['doc', 'new', 'prd', '결제 흐름 개선: v2!']);
    R.check('[DOC-01] 같은 이름이면 -2 · -3 (복수 별칭 prds 도 받는다)', n1b.json && n1b.json.path === p1.replace(/\.md$/, '-2.md') && n1c.json && n1c.json.path === p1.replace(/\.md$/, '-3.md'), `${n1b.out} ${n1c.out}`);
    const longSlug = D.slugify('가'.repeat(30) + ' ' + 'x'.repeat(50));
    R.check('[DOC-01] 슬러그 최대 60자 · 끝 - 없음 · 영문 소문자', longSlug.length <= 60 && !longSlug.endsWith('-') && D.slugify('Hello World__API') === 'hello-world-api' && D.slugify('!!!') === 'untitled', longSlug);
    const n2 = cliJson(r1, ['doc', 'new', 'coordinations', 'API 게이트웨이 인증 합의', '--with', 'api-gw', '--direction', 'incoming']);
    const p2 = n2.json && n2.json.path;
    const f2 = p2 ? fm(r1, p2) : {};
    R.check('[DOC-01] coordination → docs/coordinations/ · with · direction · 골격(상대 · 요청 · 응답 · 합의 · 기한)', n2.code === 0 && /^docs\/coordinations\//.test(p2) && f2.kind === 'coordination' && f2.with === 'api-gw' && f2.direction === 'incoming'
      && ['상대', '요청', '응답', '합의', '기한'].every(h => read(path.join(r1, p2)).includes(`## ${h}\n`)), `${n2.out} ${n2.err} ${JSON.stringify(f2)}`);
    const n2b = cliJson(r1, ['doc', 'new', 'coordination', '회신 요청']);
    R.check('[DOC-01] coordination direction 기본 outgoing', n2b.json && fm(r1, n2b.json.path).direction === 'outgoing');
    const n3 = cliJson(r1, ['doc', 'new', 'design', '로그인 화면 와이어프레임']);
    const p3 = n3.json && n3.json.path;
    R.check('[DOC-01] design → docs/designs/ · 골격(목적 · 화면·흐름 · 첨부 · 결정)', n3.code === 0 && /^docs\/designs\//.test(p3) && fm(r1, p3).kind === 'design'
      && ['목적', '화면·흐름', '첨부', '결정'].every(h => read(path.join(r1, p3)).includes(`## ${h}\n`)), n3.out + n3.err);
    const src = path.join(base, 'draft.md');
    write(src, '---\nold: front\n---\n# 이미 쓴 초안\n\n본문 그대로.\n');
    const n4 = cliJson(r1, ['doc', 'new', 'prd', '초안 가져오기', '--from-file', src]);
    const t4 = n4.json ? read(path.join(r1, n4.json.path)) : '';
    R.check('[DOC-01] --from-file: 본문은 그 파일(기존 front matter 는 떼고) · 우리 front matter 를 앞에', n4.code === 0 && t4.endsWith('\n---\n# 이미 쓴 초안\n\n본문 그대로.\n') && !t4.includes('old: front') && fm(r1, n4.json.path).title === '초안 가져오기', t4);
    const bad1 = cli(r1, ['doc', 'new', 'memo', 'x']);
    const bad2 = cli(r1, ['doc', 'new', 'prd', 'x', '--with', 'other']);
    const bad3 = cli(r1, ['doc', 'new', 'coordination', 'x', '--direction', 'sideways']);
    const bad4 = cli(r1, ['doc', 'new', 'prd']);
    R.check('[DOC-01] 사용법 오류는 exit 2(모르는 종류 · prd 에 --with · 잘못된 direction · 제목 없음)', bad1.code === 2 && bad2.code === 2 && bad3.code === 2 && bad4.code === 2, [bad1, bad2, bad3, bad4].map(x => x.code).join(','));

    // ── list ────────────────────────────────────────────────────────
    const ls = cli(r1, ['doc', 'list']);
    R.check('[DOC-02] list: 경로 · 종류 · 상태 · 갱신 · 제목 · 협업은 상대/방향', ls.code === 0 && ls.out.includes(p1) && ls.out.includes(p2) && ls.out.includes(p3) && /draft/.test(ls.out) && ls.out.includes(today) && ls.out.includes('결제 흐름 개선: v2!')
      && /api-gw/.test(ls.out) && /incoming/.test(ls.out), ls.out);
    const lsPrd = cliJson(r1, ['doc', 'list', 'prd']);
    R.check('[DOC-02] list prd --json: prd 만 · 필드(path kind status updated title)', Array.isArray(lsPrd.json) && lsPrd.json.length === 4 && lsPrd.json.every(x => x.kind === 'prd' && x.path && x.status && x.updated && x.title), lsPrd.out);
    const lsCo = cliJson(r1, ['doc', 'list', 'coordinations']);
    R.check('[DOC-02] list coordinations --json: with · direction', Array.isArray(lsCo.json) && lsCo.json.length === 2 && lsCo.json.some(x => x.with === 'api-gw' && x.direction === 'incoming'), lsCo.out);

    // ── status ──────────────────────────────────────────────────────
    const abs1 = path.join(r1, p1);
    fs.writeFileSync(abs1, read(abs1).replace(`updated: ${today}`, 'updated: 2000-01-02').replace(`created: ${today}`, 'created: 2000-01-01'));
    const st1 = cli(r1, ['doc', 'status', p1, 'active']);
    R.check('[DOC-03] status active → status · updated 오늘(본문은 그대로)', st1.code === 0 && fm(r1, p1).status === 'active' && fm(r1, p1).updated === today && fm(r1, p1).created === '2000-01-01' && read(abs1).includes('## 열린 질문'), st1.out + st1.err);
    const p1b = n1b.json.path;
    const before1b = read(path.join(r1, p1b));
    const st2 = cli(r1, ['doc', 'status', p1b, 'superseded']);
    R.check('[DOC-03] superseded 는 --by 없이는 거부 · 파일 그대로', st2.code !== 0 && read(path.join(r1, p1b)) === before1b && /--by/.test(st2.err + st2.out), `${st2.code} ${st2.err}`);
    const st3 = cli(r1, ['doc', 'status', p1b, 'superseded', '--by', p1]);
    R.check('[DOC-03] superseded --by: 여기 superseded_by · 저쪽 supersedes', st3.code === 0 && fm(r1, p1b).status === 'superseded' && fm(r1, p1b).superseded_by === p1 && fm(r1, p1).supersedes === p1b, st3.out + st3.err + JSON.stringify(fm(r1, p1)));
    const st4 = cli(r1, ['doc', 'status', p1, 'finished']);
    const st5 = cli(r1, ['doc', 'status', 'docs/prds/nope.md', 'done']);
    R.check('[DOC-03] 잘못된 상태 → exit 2 · 없는 문서 → exit 1', st4.code === 2 && st5.code === 1, `${st4.code} ${st5.code}`);

    // ── index ───────────────────────────────────────────────────────
    const readme = path.join(r1, 'docs', 'README.md');
    const idx0 = read(readme) || '';
    R.check('[DOC-04] new · status 가 색인을 자동으로 만든다(docs/README.md 관리 블록)', idx0.includes('<!-- harness:docs:begin -->') && idx0.includes('<!-- harness:docs:end -->') && idx0.includes(p1.slice('docs/'.length)) && idx0.includes(p3.slice('docs/'.length)), idx0);
    const prdSec = idx0.slice(idx0.indexOf('prds/'), idx0.indexOf('coordinations/'));
    // 행 = 첫 칸의 링크가 그 문서인 줄(대체 화살표 링크가 있는 다른 행과 헷갈리지 않게).
    const rowOf = rel => idx0.split('\n').find(l => l.startsWith(`| [`) && l.includes(`](${rel.slice(5)}) |`) && l.indexOf(`](${rel.slice(5)})`) === l.indexOf('](')
      || l.startsWith('| ~~[') && l.indexOf(`](${rel.slice(5)})~~`) === l.indexOf('](')) || '';
    const posOf = rel => prdSec.indexOf(rowOf(rel));
    R.check('[DOC-04] 최신이 먼저(2000-01-01 에 만든 문서가 prd 표의 마지막) · superseded 행 표시(~~ · → 대체 문서)', !!rowOf(p1) && posOf(p1) > posOf(p1b) && posOf(p1) > posOf(n4.json.path) && posOf(p1b) > posOf(n4.json.path)
      && rowOf(p1b).includes('~~') && /superseded/.test(rowOf(p1b)) && rowOf(p1b).includes(p1.slice(5)) && !rowOf(p1).includes('~~'), idx0);
    const OUT_BEFORE = '# 우리 문서\r\n\r\n사람이 쓴 소개 — 그대로 남아야 한다.\r\n\r\n';
    const OUT_AFTER = '\r\n\r\n## 부록\r\n끝.\r\n';
    const blockOf = t => t.slice(t.indexOf('<!-- harness:docs:begin -->'), t.indexOf('<!-- harness:docs:end -->') + '<!-- harness:docs:end -->'.length);
    fs.writeFileSync(readme, OUT_BEFORE + '<!-- harness:docs:begin -->\r\nstale\r\n<!-- harness:docs:end -->' + OUT_AFTER);
    const ix = cli(r1, ['doc', 'index']);
    const idx1 = read(readme);
    R.check('[DOC-04] index: 블록만 다시 쓰고 밖의 내용은 바이트 그대로', ix.code === 0 && idx1.startsWith(OUT_BEFORE + '<!-- harness:docs:begin -->') && idx1.endsWith('<!-- harness:docs:end -->' + OUT_AFTER) && !idx1.includes('stale') && blockOf(idx1).includes(p1.slice(5)), JSON.stringify(idx1.slice(0, 200)));
    const ix2 = cli(r1, ['doc', 'index']);
    R.check('[DOC-04] index 두 번째는 무변경', ix2.code === 0 && read(readme) === idx1);

    // ── check ───────────────────────────────────────────────────────
    const ck0 = cliJson(r1, ['doc', 'check']);
    R.check('[DOC-05] 깨끗한 트리 → check exit 0 · 문제 0', ck0.code === 0 && ck0.json && ck0.json.ok === true && ck0.json.problems.length === 0, ck0.out + ck0.err);
    const ckText = cli(r1, ['doc', 'check']);
    R.check('[DOC-05] check 는 문서가 git 추적인지 로컬 전용(이력 보관)인지 말한다', ckText.code === 0 && /git 추적|로컬 전용/.test(ckText.out) && /docs-history/.test(ckText.out), ckText.out);
    const expectProblem = (label, mutate, undo, pathRe, textRe) => {
      mutate();
      const c = cliJson(r1, ['doc', 'check']);
      const hit = c.json && c.json.problems.find(p => pathRe.test(p.path) && (!textRe || textRe.test(p.problem)));
      R.check(`[DOC-05] check 가 잡는다: ${label}`, c.code === 1 && !!hit, `${c.code} ${c.out}`);
      undo();
    };
    const raw = path.join(r1, 'docs', 'prds', 'raw.md');
    // [2026-09-30 실측 · Python 서비스 저장소] 옛 문서 94개 — front matter 없는 기존 문서는 오류가 아니라 '관리 밖'이다.
    write(raw, '# 그냥 메모\n\n본문 그대로\n');
    const ckU = cliJson(r1, ['doc', 'check']);
    R.check('[DOC-12] front matter 없는 기존 문서는 문제가 아니라 관리 밖(unmanaged)', ckU.code === 0 && ckU.json.ok && ckU.json.unmanaged.includes('docs/prds/raw.md'), ckU.out);
    R.check('[DOC-12] 관리 밖 문서는 색인에 들어가지 않는다(색인이 낡지 않는다)', !/raw\.md/.test(read(readme)) && ckU.json.problems.length === 0, read(readme).slice(0, 200));
    const ad = cli(r1, ['doc', 'adopt', 'docs/prds/raw.md', '--status', 'done']);
    const adopted = read(raw);
    R.check('[DOC-13] adopt: 폴더로 종류 · 첫 제목으로 제목 · 본문은 그대로 · 색인에 들어간다', ad.code === 0 && /^---\r?\nkind: prd\r?\ntitle: 그냥 메모\r?\nstatus: done/.test(adopted) && adopted.endsWith('# 그냥 메모\n\n본문 그대로\n') && /raw\.md/.test(read(readme)), ad.out + ad.err + adopted.slice(0, 200));
    const hist = cliJson(r1, ['doc', 'history', 'docs/prds/raw.md']);
    R.check('[DOC-13] adopt 는 바꾸기 전 판을 이력에 남긴다', hist.json && hist.json.length === 1, hist.out);
    const ad2 = cli(r1, ['doc', 'adopt', 'docs/prds/raw.md']);
    R.check('[DOC-13] 이미 관리 중이면 adopt 는 거부(exit 2)', ad2.code === 2, ad2.out + ad2.err);
    fs.unlinkSync(raw); cli(r1, ['doc', 'index']);
    expectProblem('닫히지 않은 front matter', () => write(raw, '---\nkind: prd\n# 깨진 머리\n'), () => fs.unlinkSync(raw), /docs\/prds\/raw\.md$/, /front matter/);
    const pd = path.join(r1, p3), t3 = read(pd);
    expectProblem('잘못된 status', () => fs.writeFileSync(pd, t3.replace('status: draft', 'status: wip')), () => fs.writeFileSync(pd, t3), /designs\//, /status/);
    expectProblem('잘못된 날짜', () => fs.writeFileSync(pd, t3.replace(`created: ${today}`, 'created: 2026-13-45')), () => fs.writeFileSync(pd, t3), /designs\//, /created/);
    expectProblem('kind 와 폴더 불일치', () => fs.writeFileSync(pd, t3.replace('kind: design', 'kind: prd')), () => fs.writeFileSync(pd, t3), /designs\//, /kind/);
    const p1c = n1c.json.path, pc = path.join(r1, p1c), tc = read(pc);
    expectProblem('supersede 링크 깨짐(없는 문서)', () => fs.writeFileSync(pc, tc.replace('status: draft', 'status: superseded').replace('superseded_by:', 'superseded_by: docs/prds/missing.md')), () => fs.writeFileSync(pc, tc), new RegExp(p1c.replace(/[.]/g, '\\.')), /missing\.md/);
    expectProblem('supersede 한쪽만', () => fs.writeFileSync(pc, tc.replace('supersedes:', `supersedes: ${n4.json.path}`)), () => fs.writeFileSync(pc, tc), /docs\/prds\//, /supersede/);
    const idxGood = read(readme);
    expectProblem('색인이 낡음', () => fs.writeFileSync(readme, idxGood.replace(/\| draft \|/, '| active |')), () => fs.writeFileSync(readme, idxGood), /docs\/README\.md$/, /index|색인/);
    const orphan = path.join(r1, 'docs', 'designs', 'orphan.png');
    expectProblem('링크되지 않은 디자인 첨부', () => write(orphan, 'PNG'), () => fs.unlinkSync(orphan), /docs\/designs\/orphan\.png$/, /링크|link/);
    // 링크된 첨부는 문제가 아니고 색인에 그 문서 아래 나열된다.
    write(path.join(r1, 'docs', 'designs', 'shots', 'login.png'), 'PNG');
    fs.writeFileSync(pd, t3.replace('## 첨부\n', '## 첨부\n\n![로그인](./shots/login.png)\n'));
    cli(r1, ['doc', 'index']);
    const ck1 = cliJson(r1, ['doc', 'check']);
    R.check('[DOC-05] 링크된 첨부는 통과 · 색인의 그 디자인 행에 나열', ck1.code === 0 && read(readme).includes('designs/shots/login.png'), ck1.out);

    // ── history · restore ───────────────────────────────────────────
    const h0 = cliJson(r1, ['doc', 'history', p1]);
    const hdir = path.join(S.paths(r1).harnessDir, 'docs-history', p1.split('/').join('__'));
    R.check('[DOC-06] status 가 바꾸기 전 판을 <common>/harness/docs-history/<경로 __>/<시각>.md 로 남겼다', h0.code === 0 && Array.isArray(h0.json) && h0.json.length >= 2 && fs.existsSync(hdir)
      && h0.json.every(v => /^\d{8}-\d{6}(-\d+)?$/.test(v.version)), `${h0.out} ${h0.err}`);
    const firstVer = h0.json[0].version;
    const oldText = read(path.join(hdir, `${firstVer}.md`));
    R.check('[DOC-06] 첫 판은 status 를 바꾸기 전 내용(draft · 2000-01-02)', /status: draft/.test(oldText) && /updated: 2000-01-02/.test(oldText), oldText);
    const cur = read(abs1);
    const rs = cli(r1, ['doc', 'restore', p1, firstVer]);
    const h1 = cliJson(r1, ['doc', 'history', p1]);
    R.check('[DOC-06] restore: 그 판으로 되돌리고 현재 판은 새 이력으로 보관', rs.code === 0 && read(abs1) === oldText && h1.json.length === h0.json.length + 1 && read(path.join(hdir, `${h1.json[h1.json.length - 1].version}.md`)) === cur, rs.out + rs.err);
    const rsBad = cli(r1, ['doc', 'restore', p1, '../../../evil']);
    const rsNone = cli(r1, ['doc', 'restore', p1, '19990101-000000']);
    R.check('[DOC-06] 잘못된 판 이름은 exit 2 · 없는 판은 exit 1', rsBad.code === 2 && rsNone.code === 1, `${rsBad.code} ${rsNone.code}`);
    cli(r1, ['doc', 'restore', p1, h1.json[h1.json.length - 1].version]);   // 원래대로

    // ── go --doc ────────────────────────────────────────────────────
    const P = require('../../harness/cli.js').parse(['go', 'x', '--doc', 'a.md', '--doc=b.md']);
    R.check('[DOC-07] CLI: --doc 는 여러 번', JSON.stringify(P.docs) === '["a.md","b.md"]', JSON.stringify(P.docs));
    const r2 = mkRepo({ 'check.js': CHECK_JS, '.gitignore': 'docs/\n' });
    const d2 = D.newDoc({ root: r2, kind: 'prd', title: '기능 명세' });
    const run2 = fake();
    const g2 = await L.go({ ...quiet, root: r2, goal: 'add the feature', checks: ['node check.js'], docs: [d2.path], run: run2 });
    const task2 = S.readTask(r2, g2.id);
    const absDoc2 = path.join(fs.realpathSync.native(r2), ...d2.path.split('/'));   // 하네스는 실경로로 알린다(macOS /var → /private/var · Windows 짧은 이름)
    const pr2 = run2.calls[0].prompt;
    R.check('[DOC-07] go --doc: done · task.docs 기록', g2.status === 'done' && Array.isArray(task2.docs) && task2.docs.length === 1 && task2.docs[0] === d2.path, `${g2.status} ${g2.reason} ${JSON.stringify(task2.docs)}`);
    R.check('[DOC-07] 프롬프트: 메인 체크아웃의 절대 경로 · 명세 · 복사하지 말 것 · 목표가 말하지 않으면 고치지 말 것', pr2.includes(absDoc2) && path.isAbsolute(absDoc2) && /specification/i.test(pr2) && /do not copy/i.test(pr2) && /do not edit/i.test(pr2), pr2);
    R.check('[DOC-07] 보고에 연결된 문서', g2.report.includes(d2.path), g2.report);
    let threw = null;
    try { await L.go({ ...quiet, root: r2, goal: 'x', docs: ['docs/prds/none.md'], run: fake() }); } catch (e) { threw = e; }
    R.check('[DOC-07] 없는 --doc 는 USAGE 로 거부(작업을 만들지 않는다)', threw && threw.code === 'USAGE' && /none\.md/.test(threw.message), threw && threw.message);

    // ── accept 연결 — 무시된 docs(로컬 전용) ─────────────────────────────
    const acc2 = await I.accept({ ...quiet, root: r2, id: g2.id });
    const f2a = fm(r2, d2.path);
    const head2 = git(r2, ['log', '-1', '--format=%s', 'main']);
    R.check('[DOC-08] accept(무시된 문서): tasks 에 id · updated · 커밋하지 않음 · 보고에 로컬 전용', acc2.status === 'accepted' && f2a.tasks.includes(g2.id) && f2a.updated === today && head2.startsWith('harness: accept') && /local|로컬/.test(acc2.report), `${acc2.status} ${head2} ${acc2.report}`);
    R.check('[DOC-08] accept 연결 전 판이 이력에 남는다', D.history(r2, d2.path).length >= 1);

    // ── accept 연결 — 추적되는 docs → 그 문서(와 README)만 커밋 ─────────────
    const r3 = mkRepo({ 'check.js': CHECK_JS, 'b.txt': 'bee\n' });
    const d3 = D.newDoc({ root: r3, kind: 'design', title: '화면 설계' });
    git(r3, ['add', '--', 'docs']); git(r3, ['commit', '-qm', 'docs']);
    const g3 = await L.go({ ...quiet, root: r3, goal: 'add the feature', checks: ['node check.js'], docs: [path.join(r3, d3.path)], run: fake() });
    write(path.join(r3, 'b.txt'), 'my unrelated edit\n');
    // 사용자의 미커밋 변경(작업과 무관) — 문서 커밋에 섞이면 안 된다. (스테이지된 변경은 git merge 자체가 거부하므로 작업 트리 변경으로.)
    const acc3 = await I.accept({ ...quiet, root: r3, id: g3.id });
    const last3 = git(r3, ['log', '-1', '--format=%s', 'main']);
    const files3 = git(r3, ['-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'main']).split(/\r?\n/).filter(Boolean).sort();
    R.check('[DOC-08] accept(추적 문서): "docs: link <id>" 커밋 · 그 문서와 docs/README.md 만', acc3.status === 'accepted' && last3 === `docs: link ${g3.id}` && JSON.stringify(files3) === JSON.stringify(['docs/README.md', d3.path].sort()), `${acc3.status} ${acc3.reason} ${last3} ${files3}`);
    R.check('[DOC-08] 커밋된 문서에 task id · 사용자 변경(b.txt)은 커밋되지 않고 그대로 남음', git(r3, ['show', `main:${d3.path}`]).includes(g3.id) && git(r3, ['status', '--porcelain']) === 'M b.txt' && read(path.join(r3, 'b.txt')) === 'my unrelated edit\n' && git(r3, ['rev-parse', 'main^']) === git(r3, ['rev-parse', `harness/merged/${g3.id}`]), git(r3, ['status', '--porcelain']));

    // ── 설치기: .gitignore ──────────────────────────────────────────
    const { install, uninstall } = require('../../harness/lib/install.js');
    const P2 = require('../../harness/cli.js').parse(['install', '--track-docs']);
    R.check('[DOC-09] CLI: install --track-docs', P2['track-docs'] === true);
    const GI_DIR = 'node_modules/\ndocs/\n';
    const i1 = mkRepo({ '.gitignore': GI_DIR });
    const r_i1 = install({ target: i1, source: SOURCE });
    R.check('[DOC-09] 기본 설치는 .gitignore 를 바꾸지 않는다(바이트 그대로)', read(path.join(i1, '.gitignore')) === GI_DIR && ignored(i1, 'docs/prds/x.md'), r_i1.report);
    R.check('[DOC-09] 기본 설치 보고: 무시하는 줄(.gitignore:2 docs/)을 이름으로 · --track-docs 안내', /\.gitignore:2/.test(r_i1.report) && /docs\//.test(r_i1.report) && /--track-docs/.test(r_i1.report), r_i1.report);
    const r_i1b = install({ target: i1, source: SOURCE, trackDocs: true });
    const gi1 = read(path.join(i1, '.gitignore'));
    R.check('[DOC-09] --track-docs(docs/ 저장소): 블록 추가 · 사용자 줄은 그대로 · 관리 폴더와 README 는 추적 가능 · 나머지는 계속 무시', gi1.startsWith(GI_DIR) && gi1.includes('# harness:docs-begin') && gi1.includes('# harness:docs-end')
      && ['docs/prds/x.md', 'docs/coordinations/x.md', 'docs/designs/x.md', 'docs/designs/a.png', 'docs/README.md'].every(p => !ignored(i1, p)) && ignored(i1, 'docs/other.md') && ignored(i1, 'docs/sub/y.md'), gi1);
    R.check('[DOC-09] --track-docs 보고: docs/ 줄이 폴더 자체를 제외한다는 주의(!docs/ 로 다시 연다)', /\.gitignore:2/.test(r_i1b.report) && /!docs\//.test(r_i1b.report), r_i1b.report);
    const again = install({ target: i1, source: SOURCE, trackDocs: true });
    R.check('[DOC-09] --track-docs 재설치는 .gitignore 무변경', read(path.join(i1, '.gitignore')) === gi1 && !again.changed.includes('.gitignore'), JSON.stringify(again.changed));
    uninstall({ target: i1 });
    R.check('[DOC-09] uninstall 은 블록만 걷는다 — .gitignore 바이트 그대로', read(path.join(i1, '.gitignore')) === GI_DIR, JSON.stringify(read(path.join(i1, '.gitignore'))));
    for (const pat of ['docs/*', 'docs/**']) {
      const gi = `dist/\n${pat}\n`;
      const i2 = mkRepo({ '.gitignore': gi });
      install({ target: i2, source: SOURCE, trackDocs: true });
      const g = read(path.join(i2, '.gitignore'));
      R.check(`[DOC-09] --track-docs(${pat}): 관리 폴더 · README 추적 가능 · 나머지 무시 · 폴더를 다시 열 필요 없음(!docs/ 없음)`,
        ['docs/prds/x.md', 'docs/coordinations/x.md', 'docs/designs/a.png', 'docs/README.md'].every(p => !ignored(i2, p)) && ignored(i2, 'docs/other.md') && !/^!docs\/$/m.test(g), g);
      uninstall({ target: i2 });
      R.check(`[DOC-09] uninstall(${pat}) 바이트 그대로`, read(path.join(i2, '.gitignore')) === gi);
    }
    const i3 = mkRepo();
    const r_i3 = install({ target: i3, source: SOURCE, trackDocs: true });
    R.check('[DOC-09] 무시되는 것이 없으면 --track-docs 도 .gitignore 를 만들지 않는다', !fs.existsSync(path.join(i3, '.gitignore')), r_i3.report);
  } catch (e) {
    R.check('예외 없이 끝난다', false, e && e.stack);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows 잠금 */ }
    R.done();
  }
})();
