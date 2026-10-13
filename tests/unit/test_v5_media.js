'use strict';
// 첨부(멀티모달 입력) · 작업 언어.
//   [2026-10-08 사용자 지시] 대화창에 붙인 이미지가 작업자에게 전달되지 않았다 · 영상 · 음성도 받아야 한다 ·
//   작업자의 PLAN.md · BLOCKED.md · 보고가 가끔 영어로 바뀐다(언어 지시가 어디에도 없었다).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeReporter } = require('../run.js');
const S = require('../../harness/lib/state');
const L = require('../../harness/lib/loop');
const M = require('../../harness/lib/media');
const Pr = require('../../harness/lib/prompts');
const RX = require('../../harness/lib/runner-codex');
const R = makeReporter('첨부(이미지 · 영상 · 음성) · 작업 언어');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v5-media-'));
const CLI = path.resolve(__dirname, '..', '..', 'harness', 'cli.js');
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const git = (cwd, ...a) => (spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const quiet = { log: () => {} };
let seq = 0;
function repo(files) {
  const d = path.join(base, `r${++seq}`); fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@example.invalid'); git(d, 'config', 'commit.gpgsign', 'false');
  for (const [f, t] of Object.entries(files || { 'README.md': '# r\n' })) write(path.join(d, f), t);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init'); return d;
}
const fake = () => { const calls = []; const run = async o => { calls.push({ ...o, signal: undefined }); write(path.join(o.cwd, 'out.txt'), 'x\n'); return { ok: true, is_error: false, session_id: o.sessionId || o.newSessionId || 's', session_confirmed: true, final_text: '끝', cost_usd: 0, permission_denials: [] }; }; run.calls = calls; return run; };
// 1×1 PNG · 짧은 무음 WAV(ffmpeg 없이 만든다)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000105fe02fea70000000049454e44ae426082', 'hex');
function wav(file) {
  const n = 1600, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, b);
}

(async () => {
  try {
    R.check('[MD-01] 형식 분류: 이미지 · 영상 · 음성 · PDF · 오피스 · 텍스트', M.kindOf('a.PNG') === 'image' && M.kindOf('b.bmp') === 'image' && M.kindOf('c.mp4') === 'video' && M.kindOf('d.m4a') === 'audio'
      && M.kindOf('e.pdf') === 'pdf' && M.kindOf('f.docx') === 'office' && M.kindOf('g.md') === 'text' && M.kindOf('h.bin') === 'file');

    // ── 이미지 첨부 → 작업 기록 · 프롬프트 · 읽기 폴더 · 커밋되지 않음 ──
    const src = path.join(base, 'in', '화면 1.png'); fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, PNG);
    const r1 = repo(), f1 = fake();
    const g1 = await L.go({ ...quiet, root: r1, goal: '첨부한 화면처럼 고쳐 줘', run: f1, attach: [src] });
    const t1 = S.readTask(r1, g1.id), P1 = S.taskPaths(r1, g1.id);
    const att = (t1.attachments || [])[0] || {};
    R.check('[MD-02] 첨부는 작업 폴더(git 밖)에 복사되고 작업 기록에 남는다', att.kind === 'image' && fs.existsSync(att.file) && att.file.startsWith(P1.dir) && att.src === path.resolve(src), JSON.stringify(att));
    const p1 = f1.calls[0].prompt;
    R.check('[MD-03] 프롬프트가 첨부를 절대 경로로 알리고 먼저 보라고 한다 · 작업자는 그 폴더를 읽을 수 있다(--add-dir)',
      p1.includes(att.file) && /# Attachments/.test(p1) && (f1.calls[0].addDirs || []).some(d => G_same(d, path.dirname(att.file))), `${p1.slice(-700)} ${JSON.stringify(f1.calls[0].addDirs)}`);
    R.check('[MD-04] 첨부는 결과 브랜치에 커밋되지 않는다', !git(r1, 'ls-tree', '-r', '--name-only', g1.branch).includes('.png'), git(r1, 'ls-tree', '-r', '--name-only', g1.branch));
    R.check('[MD-05] 보고에 첨부가 보인다', /첨부: 1개/.test(g1.report) && /attachments/.test(g1.report), g1.report.split('\n').slice(0, 4).join(' | '));

    // ── 없는 첨부는 작업을 만들기 전에 거부 ──
    let e6 = null; const r6 = repo();
    try { await L.go({ ...quiet, root: r6, goal: 'x', run: fake(), attach: [path.join(base, 'nope.png')] }); } catch (e) { e6 = e; }
    R.check('[MD-06] 없는 첨부 → USAGE · 작업이 만들어지지 않는다', e6 && e6.code === 'USAGE' && /attachment not found/.test(e6.message) && S.listTasks(r6).length === 0, String(e6 && e6.message));

    // ── 음성: 전사기(가짜 명령)로 글이 붙는다 ──
    const fakeT = path.join(base, 'fake-transcribe.js');
    fs.writeFileSync(fakeT, "const fs=require('fs'),p=require('path');const [,,inp,out]=process.argv;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(p.join(out,'t.txt'),'전사: 안녕하세요 '+p.basename(inp));");
    const a1 = path.join(base, 'in', '회의.wav'); wav(a1);
    const prepA = M.prepare([a1], path.join(base, 'prepA'), { transcribe: `"${process.execPath}" "${fakeT}" "{in}" "{outdir}"` });
    const ta = prepA.items[0].transcript;
    R.check('[MD-07] 음성 → 전사기 결과(글)가 첨부에 붙고 INDEX.md 에 적힌다', !!ta && /안녕하세요/.test(fs.readFileSync(ta, 'utf8')) && fs.readFileSync(path.join(base, 'prepA', 'INDEX.md'), 'utf8').includes(ta), JSON.stringify(prepA.items[0]));
    const prepB = M.prepare([a1], path.join(base, 'prepB'), { transcribe: null, env: {} });
    const noT = !process.env.HARNESS_TRANSCRIBE && !M.transcriber({});
    R.check('[MD-08] 전사기가 없으면 원본만 붙이고 무엇을 못 했는지 적는다(조용히 넘어가지 않는다)', !noT || (prepB.items[0].transcript === null && prepB.items[0].notes.some(n => /전사기가 없다/.test(n))), JSON.stringify(prepB.items[0].notes));

    // ── 영상: ffmpeg 가 있으면 장면 이미지 + 소리 전사 · 없으면 그 사실을 적는다 ──
    const ff = M.tool('ffmpeg');
    const v1 = path.join(base, 'in', '재현.mp4');
    if (ff) spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-shortest', '-pix_fmt', 'yuv420p', v1], { windowsHide: true, timeout: 120000 });
    else write(v1, 'not really a video');
    const prepV = M.prepare([v1], path.join(base, 'prepV'), { transcribe: `"${process.execPath}" "${fakeT}" "{in}" "{outdir}"` });
    const iv = prepV.items[0];
    if (ff) R.check('[MD-09] 영상 → 장면 이미지 3장(5초마다 · 시각 표시) + 소리 전사', iv.frames.length === 3 && iv.frames.every(f => fs.existsSync(f.file) && /frame-\d\d-\d\dm\d\ds\.png$/.test(f.file)) && !!iv.transcript && iv.duration_s >= 11, JSON.stringify(iv));
    else R.check('[MD-09] (ffmpeg 없음) 영상은 원본만 붙고 "ffmpeg 가 없어" 를 적는다', iv.frames.length === 0 && iv.notes.some(n => /ffmpeg 가 없어/.test(n)), JSON.stringify(iv.notes));
    R.check('[MD-10] 모델이 이미지로 볼 파일 = 원본 이미지 + 장면 이미지', JSON.stringify(M.imagesOf([{ kind: 'image', name: 'a.png', file: 'A', frames: [] }, { kind: 'video', name: 'v.mp4', file: 'V', frames: [{ file: 'F1' }, { file: 'F2' }] }])) === '["A","F1","F2"]');

    // ── Codex: 이미지는 첫 호출에 -i 로 붙인다(이어 가기에는 붙이지 않는다) ──
    const ca = RX.buildArgs({ cwd: 'W', images: ['A.png', 'B.png'] });
    const cr = RX.buildArgs({ cwd: 'W', sessionId: 'S', images: ['A.png'] });
    const ia = ca.indexOf('-i');
    R.check('[MD-11] codex 첫 호출: -i A.png -i B.png · 프롬프트는 여전히 stdin(-) · 이어 가기에는 -i 없음',
      ia > 0 && ca[ia + 1] === 'A.png' && ca.filter(x => x === '-i').length === 2 && ca[ca.length - 1] === '-' && !cr.includes('-i'), JSON.stringify([ca, cr]));

    // ── 작업 언어 ──
    R.check('[MD-12] 한국어 목표 → 작업자 프롬프트와 시스템 지시가 한국어로 쓰라고 한다', /in Korean/.test(p1) && /in Korean/.test(f1.calls[0].systemAppend || ''), String(f1.calls[0].systemAppend));
    const r13 = repo({ 'AGENTS.md': '# p\n\n```yaml\nreply_language: "English"\n```\n' }), f13 = fake();
    await L.go({ ...quiet, root: r13, goal: '고쳐 줘', run: f13 });
    R.check('[MD-13] 프로젝트 블록 reply_language 가 이긴다', /in English/.test(f13.calls[0].prompt) && !/in Korean/.test(f13.calls[0].prompt));
    const f14 = fake(); await L.go({ ...quiet, root: repo(), goal: 'fix the bug', run: f14 });
    R.check('[MD-14] 언어 지정도 한글도 없으면 언어를 강요하지 않는다', !/Write .* in (Korean|English)/.test(f14.calls[0].prompt), f14.calls[0].prompt.slice(-400));

    // ── 한국어 작업의 보고는 세부 줄까지 한국어(2026-10-13 사용자 보고: 결과가 영어로 나온다) ──
    const rep = g1.report.split('\n');
    const enLabel = /^(why|branch|checks?|changed files|existing test files|outside git|spent|worktree|plan|accept|cancel|resume|attachments|spec documents)\b/;
    R.check('[MD-16] 한국어 목표 → 보고의 모든 줄이 한국어(영어 항목 이름 없음) · 명령 · 경로 · 숫자는 그대로',
      !rep.some(l => enLabel.test(l.trim())) && rep.some(l => /^이유: /.test(l)) && rep.some(l => /node harness\/cli\.js accept /.test(l)) && rep.some(l => /^브랜치: harness\//.test(l)), rep.join(' | '));
    R.check('[MD-16] 영어 목표의 보고는 그대로 영어(바뀌지 않는다)', /^why: /m.test((await L.go({ ...quiet, root: repo(), goal: 'fix it', run: fake() })).report));

    // ── 전사기 기본값: 전사 도구를 따로 두지 않아도 python 에 faster-whisper 가 있으면 쓴다 ──
    const hasFw = ['python', 'py', 'python3'].some(p => { try { return spawnSync(p, ['-c', 'import faster_whisper'], { windowsHide: true, timeout: 60000 }).status === 0; } catch { return false; } });
    const tr = M.transcriber({});
    const envT = !!process.env.HARNESS_TRANSCRIBE;
    R.check(`[MD-17] 전사기 자동 선택: faster-whisper ${hasFw ? '있음 → 하네스의 전사 스크립트' : '없음 → whisper CLI 가 없으면 null'}`,
      envT || (hasFw ? !!tr && tr.source === 'faster-whisper' && /transcribe_fw\.py/.test(tr.template) : !tr || tr.source === 'whisper'), JSON.stringify(tr));

    // ── CLI: --attach 는 여러 번 ──
    const r15 = repo();
    const c15 = spawnSync(process.execPath, [CLI, 'go', '두 장 보고 고쳐 줘', '--root', r15, '--attach', src, '--attach', a1], { encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: { ...process.env, HARNESS_RUNNER_MODULE: path.join(base, 'runner.js') } });
    fs.writeFileSync(path.join(base, 'runner.js'), '');   // (위 호출 뒤 내용은 쓰지 않는다 — 아래에서 다시 부른다)
    fs.writeFileSync(path.join(base, 'runner.js'), "exports.run=async o=>{require('fs').writeFileSync(require('path').join(o.cwd,'o.txt'),'x');return{ok:true,is_error:false,session_id:o.newSessionId||'s',session_confirmed:true,final_text:'끝',cost_usd:0,permission_denials:[]};};");
    const c15b = spawnSync(process.execPath, [CLI, 'go', '두 장 보고 고쳐 줘', '--root', r15, '--attach', src, '--attach', a1], { encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: { ...process.env, HARNESS_RUNNER_MODULE: path.join(base, 'runner.js') } });
    const t15 = S.listTasks(r15).map(t => S.readTask(r15, t.id || t)).filter(Boolean).find(t => (t.attachments || []).length === 2);
    R.check('[MD-15] CLI go --attach a --attach b → 첨부 2개', c15b.status === 0 && !!t15, `${c15.status} ${c15b.status} ${c15b.stderr.slice(-300)}`);
  } catch (e) { R.check('예외 없이 끝난다', false, String(e && e.stack || e).slice(0, 800)); }
  finally { try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 정리 실패는 결과와 무관 */ } }
  R.done();
})();

function G_same(a, b) { return require('../../harness/lib/git').samePath(a, b); }
