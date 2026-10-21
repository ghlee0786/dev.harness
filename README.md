# dev.harness

Claude Code · Codex 용 개발 하네스. **판정이 아니라 안전** — 모델이 일을 끝까지 하게 두고, 하네스는 격리 · git 안전망 · 정리를 맡고 저장소의 결정적 검사(테스트)를 끝에 한 번 돌려 기록한다.

**v6 — thin 이 기본.** 작업자는 맨 모델처럼 스스로 계획(PLAN.md) · 테스트 · 기록하고, 하네스는 끼어들지 않는다(작업 전 기준선 · 실패 되돌려 보내기 · 린트/품질 되돌려 보내기 없음). 평가(같은 과제 · 같은 시간대 짝 비교)에서 하네스가 일하는 방식에 끼어들수록 정확도는 그대로이고 시간만 4~10배 들었다. 예전 방식은 `--mode full`(또는 yaml `mode: full`).

- 의존성 0 · Node ≥ 20 · CommonJS · Windows · Linux · macOS
- 작업마다 자기 worktree · 브랜치(`harness/<id>`) — 사용자 브랜치는 받아들일(accept) 때까지 그대로
- 완료는 저장소에 원래 있는 테스트의 종료 코드로만 기록한다. 모델이 쓴 검사로 모델을 판정하지 않는다
- 되돌리기는 git(revert)로 — reset · 강제 push · stash 없음
- 사람이 읽는 출력은 사용자의 언어로(한국어 작업은 보고 전체가 한국어)

## 설치 · 갱신

```bash
git clone https://github.com/ghlee0786/dev.harness
node dev.harness/harness/cli.js install --root <내 저장소>
```

`<내 저장소>` 에 `harness/` 사본 · `AGENTS.md` 관리 블록 · `CLAUDE.md` 의 `@AGENTS.md` · Claude Code / Codex 훅 · `harness` 스킬이 들어간다.
**자동 갱신** — 하네스를 쓰는 시점(대화형 세션에서 말할 때 · 하네스 명령)에 하루 한 번 최신 릴리스를 확인하고, 새 판이 있으면 백그라운드로 설치한다. 실행 중인 작업이 있으면 다음으로 미루고, 하네스 파일을 git 에 넣어 둔 저장소는 갱신이 바꾼 하네스 파일만 따로 커밋한다(사용자의 미커밋 변경은 그대로). 손으로는 `node harness/cli.js update`(`--dry-run` 은 비교만). 걷어 내기는 `install --uninstall`.

## 명령

| 명령 | 하는 일 |
|---|---|
| `go "<요청>"` | 자기 worktree 에서 끝까지 실행하고 보고서를 낸다 — `--mode thin\|full`(기본 thin) · `--goal-file` · `--check "<명령>"` · `--attach <파일>` · `--doc <문서>` · `--allow "<규칙>"` · `--runtime claude\|codex` · `--detach`(셸과 분리해 띄우고 id 를 바로 돌려준다) |
| `factory "<요청>"` | **다중 에이전트 공장** — 계획 에이전트가 요청을 카드(쓰기 소유 경로 · 의존 · 계약)로 나누고, 카드마다 하네스 작업이 병렬로 돌고, 통합 브랜치 `harness/factory/<id>` 에 하나씩 합친다(매번 검사 · 실패하면 revert 하고 다시). 카드 작업자는 thin. `--verify` 를 주면 그다음 **검증 라인**: 시험 차터를 여러 시험 에이전트에게 나눠 주고, 다른 에이전트가 독립 재현한 결함만 수정 카드로(기본 끔 — 모델이 찾고 모델이 확인하는 단계라 효과를 보이기 전까지). `--jobs N` · `--budget-usd N` · `--verify` · `--test-agents N` · `--waves N` · `factory status\|wait\|stop\|accept <id>` |
| `wait <id>` | 작업이 끝날 때까지 기다려 보고를 낸다. `go` · `resume` 은 늘 셸과 분리된 프로세스에서 돌므로 부른 셸이 시간 상한으로 죽어도 작업은 계속되고, `wait` 로 보고를 다시 받는다 |
| `status` · `stop <id>` · `resume <id>` | 현황(누적 비용 · 겹침 · 주인 없는 변경 · 손상된 작업 기록) · 멈춤(진행분 커밋) · 이어 가기 |
| `note <id> ("<지시>" \| --file <파일>)` · `resume <id> --note …` | 도는 · 끝난 작업에 요구를 덧붙인다 — 도는 작업은 다음 턴에(끝나려던 참이면 한 턴 더), 멈춘 · 끝난 작업은 resume 때 전달 |
| `go … --owns "<glob>"` | **쓰기 소유권** — 그 작업이 바꿀 수 있는 경로만(반복 가능). guard 가 밖의 쓰기 · 삭제 · 이동을 셸과 Edit/Write 모두에서 막는다 — 여러 작업이 한 저장소를 동시에 고쳐도 엉키지 않게 |
| `accept <id>` · `cancel <id>` · `restore <id>` | 받아들이기(`--no-ff` 병합 · 사용자가 말한 뒤에만 · 테스트와 린트를 다시 본다) · 취소(revert) · 되살리기 |
| `push [<remote>] [<branch>]` · `push [<remote>] --tag <이름>` | 빨리감기 push · 릴리스 태그 push(덮어쓰지 않는다) — 사용자가 명시한 뒤에만 |
| `doc new <prd\|coordination\|design> "<제목>"` | 요청할 때만 만드는 관리 문서 |
| `report --kind <bug\|intent\|improve> --title … --body …` | 하네스 보고(아래) |
| `update [--dry-run]` · `version` · `gc` · `cleanup-legacy` | 갱신 · 판 · 끝난 작업 정리 · 이전 하네스 잔여물 정리 |

## 무엇을 해 주나

| 기능 | 내용 |
|---|---|
| 격리 | 작업마다 worktree · 브랜치. 무인 작업자는 push 경로가 막히고 이 저장소의 브랜치 · 태그를 바꾸지 못한다(git `reference-transaction` 훅) |
| git 안전 | 대화형 세션의 `git push` · `reset --hard` · `clean -f` · `rebase` · 직접 `merge` · `stash` · 별칭 · `python -c`/`node -e` 로 감싼 git 쓰기를 막는다 |
| 판정 | thin(기본): 작업이 끝난 뒤 저장소 테스트를 **한 번** 돌려 기록한다 — 통과면 done, 실패면 그때만(모델 호출 없이) 작업 전 기준선을 재서 원래부터 실패면 done(나빠지지 않음) · 나빠졌으면 failed(`accept` 가 막는다). 작업자에게 돌려보내지 않는다. full: 작업 전 기준선 · 실패하면 작업자에게 돌려보내 반복. 둘 다 실패한 검사는 한 번 더 돌려 불안정한 것을 가린다 |
| 린트(정책) | 아래 **린트 정책** — 하네스 내장 품질 규칙 10가지(저장소가 설정한 린터의 새 위반 포함) + 프로젝트의 `lint_command`. thin 은 보고만 하고(`lint_command` 는 작업자에게 직접 돌리라고 알린다), full 은 돌려보낸다 |
| 작업자 권한 | 기본 `open` — 명령을 막지 않는다. 막는 것은 git 쓰기 · push(git 수준) · worktree 밖 삭제 · 쓰기(guard)뿐. worktree 밖 읽기 · `Monitor` 는 된다. `git -C` · `stash` · `config` 는 읽기 형태만. `worker_permissions: strict` 면 예전 허용 목록 |
| 보고 | 요약 · 다음 할 일 · 주의 · 검사 결과 · **변경 규모(+추가/-삭제 줄 · 새 파일)** · 비용 · 시간 |
| 끝까지 | 시작 때도 도중에도 묻지 않는다 — 결과를 바꾸는 갈림길은 지시에 맞고 바꾸기 쉬운 쪽을 골라 계속하고, 완성 뒤 보고에 **결정 분기점(분기점 · 고른 것 · 이유 · 결과)** 으로 정리한다. 같은 세션 이어 가기 · 막히면 BLOCKED.md · `resume --allow` 로 이어 감 |
| 멀티모달 | `--attach` — 이미지 · PDF 는 그대로, 영상은 장면 이미지 + 전사, 음성은 전사(ffmpeg · faster-whisper 가 있으면 자동) |
| 의존 | `.worktreeinclude`(git 밖 파일) · 서브모듈 · 저장소 밖 형제 폴더(`worktree_links`) |
| 언어 | 한국어로 물으면 대화형 답이 영어로 끝나지 않게 되돌리고, 한국어 작업은 보고 전체가 한국어 |
| 다중 에이전트 | `factory` — 계획(프로그램이 형식 · 의존 순환 · 소유 겹침을 검사하고 겹치면 직렬화) → 병렬 제작(카드 = thin 작업 · 소유 경로) → 합류 대기열(main 은 손대지 않음 · 합칠 때마다 통합 기준선보다 나빠지지 않는지 검사 · 기준선은 카드와 동시에 잰다) → (`--verify` 일 때) 검증 라인 → 받아들이기는 사용자가 말한 뒤 |
| 쓰레기 0 | **자원 장부** — 작업마다 전용 임시 폴더(TEMP · TMP · TMPDIR) · 데이터 구역(`HARNESS_DATA_NS`) · compose 이름(`harness-<id>`). 끝나면 그 작업이 남긴 프로세스(명령줄에 그 작업 worktree 경로 · 편집기 제외) · 컨테이너(compose 이름표 또는 이름이 `harness-<id>` 로 시작 · 익명 볼륨까지) · 임시 폴더를, accept · cancel · gc 때 볼륨 · 이미지 · `cleanup_command` 까지 회수 · 남은 것은 보고. 고르는 기준은 작업마다 고유한 표식뿐 — 다른 작업 · 사용자의 것은 건드리지 않는다 |
| 중복 0 · 맥락 | **작업 장부** — 새 작업을 이전 작업과 비교(언어 무관 유사도)해, 같은 일이 이미 끝났으면 "처음부터 다시 하지 말고 확인 · 검증 뒤 남은 것만", 비슷하면 그 결정 · 결과 · 바꾼 파일을 맥락으로 준다 |
| 언어 중립 | **언어 팩** — node · python · dotnet · go · rust · java(maven · gradle) · c/c++(cmake+ctest · meson · make): 감지 · 테스트 명령 · 요약 · 쓰레기 패턴이 같은 방식으로 |
| 멈춘 테스트 | 출력이 5분 멈춘 테스트 실행(pytest)은 상한(15분)까지 기다리지 않고 끊고, 멈춘 테스트를 `--deselect` 로 빼고 기준선을 다시 잰다 — 뺀 테스트는 보고서에 남긴다(장치 · 네트워크를 기다리는 테스트 하나 때문에 검사 전체를 잃지 않게) |
| 수치 | `metrics [--roots "a;b"]` — 작업 기록(지난 작업 포함)에서 비용 · 시간 · 계획(PLAN 완료율 · 결정) · 시험(추가 · 테스트 수 변화 · 회귀) · 품질 규칙(처음 · 끝) · 찌꺼기 · 거부된 명령 · 공장(카드 · 에이전트 수 · 시험 발견)을 계산해 프로젝트별로 비교. ISO/IEC 25010 · 25023 품질 특성과 대리 지표를 함께 보인다 · 이 PC 안에서만 읽는다 |
| 한도 | 모델 사용량 한도(세션 · 주간)에 걸리면 리셋 시각까지 기다렸다 같은 세션으로 이어 간다(기다린 시간은 벽시계 상한에서 뺀다 · 최대 6시간) |
| 단순성 | 저장소 관례를 먼저 따르고(비슷한 변경이 어디에 어떻게 들어갔는지 · 있는 도우미 재사용), 그 안에서 목표에 필요한 최소한만 — 요청 밖 기능 · 한 번 쓰는 추상화 금지 |
| 판단 패턴 | `profile --build` — 이 PC 의 대화 기록 · 작업 기록에서 사용자가 갈림길에서 고른 것(추천안 · 범위 · 지시 유형)을 세어 `~/.harness/profile.json` 에 둔다. 작업자는 묻지 않고 그 패턴으로 고르고 DECISIONS.md 에 따른 패턴을 적는다(목표가 늘 우선) · 이 PC 밖으로 보내지 않는다 |

## 프로젝트 설정

`AGENTS.md`(또는 `CLAUDE.md`)의 yaml 블록:

```yaml
test_command: "npm test"                 # 완료 판정 — 없으면 package.json · pytest · *.sln … 을 찾는다
mode: thin                               # thin(기본): 끝에 검사 한 번 · 기록만 / full: 작업 전 기준선 · 실패 · 린트 · 품질 되돌려 보내기
lint_command: "npx eslint {files}"       # 두 번째 판정 — {files} 는 작업이 바꾼 파일
check_timeout_min: 20                    # 검사 상한(기본 15분)
rerun_failed: on                         # 실패한 검사 재실행(off 로 끈다)
serial_checks: true                      # 검사를 프로젝트 단위로 하나씩(공유 시험 DB · 포트 — 기본은 동시)
dup_check: on                            # 중복 코드 검사(off 로 끈다) · dup_min_lines: 8
quality: on                              # 하네스 내장 품질 규칙(off 로 전부 끈다) · quality_off: ["todo", "unused"] 로 규칙별
worker_permissions: open                 # 작업자 명령을 막지 않는다(strict: 예전 허용 목록)
reply_language: "Korean"                 # 작업자의 기록 · 보고 언어(목표에 한글이 있으면 기본 Korean)
worker_allow: ["Bash(docker build:*)"]   # strict 일 때 무인 작업자에게 더 허용할 명령(git 쓰기 · 셸은 거부)
worktree_links: ["../SiblingRepo"]       # 저장소 밖 형제 폴더를 참조하는 빌드
outside_git_ok: ["data/*.db"]            # worktree 를 붙잡지 않는 런타임 부산물
transcribe_command: "whisper \"{in}\" --output_dir \"{outdir}\""   # 전사기(없으면 faster-whisper · whisper 자동)
bug_report: on                           # 하네스 보고 자동 발행(off 로 끈다)
auto_update: on                          # 최신 릴리스 자동 갱신(off 로 끈다)
cleanup_command: "python scripts/drop_test_data.py"   # 작업을 치울 때 git 밖 시험 데이터 정리(HARNESS_DATA_NS · HARNESS_TASK_ID 를 받는다)
quota_wait: on                           # 사용량 한도면 리셋까지 기다렸다 이어 감(off: 바로 interrupted) · quota_wait_max_min: 360
```

## 린트 정책

AI 가 흔히 남기는 군더더기를 종류별 규칙으로 잡는다. **작업이 새로 더한 줄만** 본다(기존 코드의 옛 흔적으로 막히지 않는다).

| 규칙 | 잡는 것 | 고치는 방법(작업자에게 주는 지시) |
|---|---|---|
| 중복(`dup`) | 있는 코드를 블록째 베낌(공백 빼고 8줄 이상) | 있는 것을 부르거나 공통 함수로 빼고 사본을 지운다 |
| 쓰이지 않는 새 정의(`unused`) | 새로 만든 함수 · 메서드 · 클래스를 어디서도(XAML · 설정 포함) 부르지 않음 — 데코레이터 · 어트리뷰트가 붙은 정의(`@router.get` · `[HttpGet]`)는 프레임워크가 부르므로 제외 | 지운다 — 외부에 공개하는 API 면 DECISIONS.md 에 적는다 |
| 디버그 흔적(`debug`) | `console.log` · `debugger` · `breakpoint()` · `pdb.set_trace()` · `Debugger.Break()` | 지운다 |
| 남긴 할 일(`todo`) | 새 `TODO` · `FIXME` · `XXX` · `HACK` | 지금 끝내거나, 범위 밖이면 DECISIONS.md 에 |
| 주석 처리된 코드(`commented`) | 코드처럼 보이는 주석 3줄 이상(문서 주석은 제외) | 지운다(git 이 이력을 가진다) |
| 검사 억누르기(`suppress`) | `eslint-disable` · `@ts-ignore` · `# noqa` · `# type: ignore` · `#pragma warning disable` · `SuppressMessage` · `NoWarn` — 사유를 단 것(`# noqa: BLE001 — 이유` · `-- 이유` · `Justification=`)과 테스트 파일의 것은 제외 | 경고의 원인을 고친다 |
| 테스트 약화(`test-weaken`) | `.skip` · `.only` · `xit` · `@pytest.mark.skip` · `[Ignore]` · `Skip=` · `assert True` | 테스트를 통과시킨다 |
| 하드코딩(`hardcoded`) | 개인 경로(`C:\Users\…` · `/home/…`) · 비밀 키 모양(`ghp_` · `AKIA` · `sk-` · 개인 키) | 설정 · 환경 변수 · 저장소 상대 경로 |
| 형식만 바뀐 파일(`format-only`) | 공백 · 들여쓰기만 바뀐 파일(범위 밖 재정렬) | 되돌린다 |
| 저장소 린트(`repo-lint`) | 저장소가 설정해 둔 린터(ruff · eslint · gofmt · clang-format)로 잰 **이번 변경이 새로 만든 위반** — 작업 전 내용과 비교해 늘어난 규칙의 위반 중 더한 줄의 것만(원래 있던 위반은 내지 않음). 린터가 없으면 건너뜀 | 그 규칙대로 고친다(긴 줄 · 주석은 감싼다 — 한글은 두 칸) · 규칙을 끄지 않는다 |

- **처리**: thin(기본)은 걸린 것을 보고서에만 남긴다. full 은 테스트(와 `lint_command`)가 통과한 뒤, 걸린 것을 **한 메시지로 모아 작업자에게 한 번만** 돌려보낸다. 고치지 않고 남겨도 막지 않고 보고서 맨 위 `주의:` 에 규칙별로 남긴다 — 멈춤을 늘리지 않는다. 의도한 것이면 작업자가 DECISIONS.md 에 이유를 적는다.
- **언어별 린터**: `lint_command`(예: `ruff check {files}` · `npx eslint {files}` · `dotnet format … --include {files}`)는 그대로 돈다 — `{files}` 면 바꾼 파일만 보고 실패하면 막는다. `{files}` 가 없고 작업 전부터 빨간 저장소 전체 린트는 보고만 한다.
- **끄기**: `quality: off`(전부) · `quality_off: ["todo", "unused"]`(규칙별) · `dup_check: off`(중복).

## 하네스 보고 — 자동 이슈

하네스가 오류로 멈추거나, 의도와 다르게 행동하거나, 더 나은 방향이 보이면 이 저장소에 이슈가 **자동으로** 올라간다. 사용자는 개입하지 않아도 되고 건의만 하면 된다(세션에 말하면 `report --kind improve` 로 올린다).

- **하네스 동작만** 올라간다 — 프로젝트 코드 · 이름 · 경로 · 작업 내용은 넣지 않고, 남은 경로 · 사용자 · 호스트 · 메일 · 프로젝트 이름(저장소 폴더 · 원격 · git 사용자)은 자동으로 가린다. 기준은 [CONTRIBUTING.md](CONTRIBUTING.md).
- 인증은 그 PC 의 GitHub 로그인을 쓴다: `HARNESS_GITHUB_TOKEN` · `GH_TOKEN` · `gh auth login` · git 자격 증명 관리자(계정이 여럿이면 차례로, `HARNESS_GITHUB_USER` 우선). 없으면 쌓아 두고 `report` 가 미리 채운 이슈 링크를 보여 준다.
- 같은 결함은 서명으로 묶여 재발 댓글이 된다 · 하루 새 이슈 5건 상한 · 설치된 사본에서만 켜진다 · `bug_report: off` / `HARNESS_BUG_REPORT=off` 로 끈다.

## CI/CD

| 워크플로 | 언제 | 하는 일 |
|---|---|---|
| `ci.yml` | push · PR | Windows · Ubuntu · macOS × Node 20 · 22 에서 `node tests/run.js` |
| `release.yml` | `v*` 태그 | 3개 OS 테스트 → `harness/VERSION` 기록 → `harness-<판>.tar.gz` · `.zip` · `SHA256SUMS` 를 GitHub Release 로 |
| `issue-triage.yml` | 이슈 열림 | `[auto]` 이슈에 `auto-report` · 종류(bug · intent · improve) 라벨 |
| `self-hosted.yml` | 수동 실행 | 자체 러너(라벨 `self-hosted`)에서 같은 테스트 |

- 릴리스: `git tag v5.1.0` → `node harness/cli.js push origin --tag v5.1.0`(같은 이름 태그는 덮어쓰지 않는다) → 사용하는 저장소에서 `node harness/cli.js update`.
- 자체 러너: 저장소 Settings → Actions → Runners → New self-hosted runner 의 안내대로 등록.

## 검증

| 항목 | 결과 |
|---|---|
| 단위 테스트(모델 호출 없음 · 임시 저장소) | 16개 파일 · 943건 · CI 에서 Windows · Ubuntu · macOS × Node 20 · 22. 심볼릭 링크 임시 폴더(macOS) · Windows 짧은 이름(8.3) 경로에서도 |
| 실제 프로젝트 적용 | Python 서비스 · .NET 라이브러리 · .NET 앱 · 웹 서비스 · 3D 도구 등 저장소 7곳 · 무인 작업 200건 이상 · v5.6.0 이후 25건은 첫 실행 done 25/25 · 멈춤 0 · 사용자 브랜치 손상 0건 |
| 현장 결함 → 자동 이슈 → 수정 | 자동 이슈 18건(처음 3일 16건 · 대부분 Windows 의 worktree 수명 → 그 뒤 3일 2건) — 모두 재현 테스트를 먼저 만들고 고쳐 닫음 |
| 하네스 vs 하네스 없이(Opus · 숨은 검사) | 같은 날 같은 조건, 목표 5개 — **하네스 15/15 · 하네스 없이 10/10** · 시간 26.9분 대 50.4분 · 비용 $7.04 대 $17.20 · Codex 4/4 |
| 단순성 규칙 전후(Opus · 목표 5개 × 2회) | 숨은 검사 **10/10 → 10/10** · 추가한 코드 **7,012 → 5,576줄(−20.5%)** · 모든 목표에서 줄었다(−12 ~ −36%) · 시간 −8% · 비용 −6% |
| 멀티모달 실측 | 글자가 든 이미지 · 영상을 Claude · Codex 모두 정확히 읽음 |

### 분야별 점수 (자체 평가 · 적대적 재평가 2026-10-19 · 현장 기록 우선)

| 안전성 | 판정 정직성 | 코드 품질 유도 | 효율 · 비용 | 하네스 자체 단순성 | 멀티세션 | 이식성 | 검증 근거 | 사용성 | 완주 자율성 | 성숙도 | **평균** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 89 | 89 | 79 | 81 | 70 | 83 | 87 | 87 | 86 | 91 | 69 | **≈ 83** |

v5.6.0(작업자 명령을 막지 않는 open 권한) 이후 현장 작업 25건이 모두 첫 실행에서 끝났고 멈춘 작업은 0건이다 — 완주 자율성 · 멀티세션이 올랐다. 대신 하네스 스스로의 간섭이 드러났다: 셸 호출의 4.6% 를 막았는데 대부분 정당한 명령(같은 명령의 변수 · 임시 폴더 · docker 읽기 · worktree 밖 읽기)이었고, 첫 판 품질 규칙은 재현한 16건이 모두 오탐(FastAPI 라우트 · 사유를 단 `noqa`)이었다. v5.8.0 에서 고쳐 같은 기록으로 다시 재면 거부 135 → 16건(남은 것의 대부분은 막아야 맞는 것) · 품질 오탐 16 → 0. 내린 것은 단순성(guard 가 셸 해석을 더 하게 됐다)과 코드 품질 유도(규칙의 참 양성은 아직 현장에서 못 봤다). 통제 평가(하네스 vs 없음)는 10-13 뒤로 다시 돌리지 않았다.

## 개발

```bash
node tests/run.js                      # 전체(모델 호출 없음 · 각 테스트는 자기 임시 디렉터리에서)
node tests/unit/test_v5_loop.js        # 하나만
```

고치기 전에 그 결함으로 빨개지는 테스트를 먼저 만든다. 자세한 기여 기준은 [CONTRIBUTING.md](CONTRIBUTING.md).

## 라이선스

[MIT](LICENSE)
