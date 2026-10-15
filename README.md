# dev.harness

Claude Code · Codex 용 개발 하네스. **판정이 아니라 안전** — 모델이 일을 끝까지 하게 두고, 하네스는 격리 · git 안전망 · 저장소의 결정적 검사(테스트 · 린트)로만 끝을 판정한다.

- 의존성 0 · Node ≥ 20 · CommonJS · Windows · Linux · macOS
- 작업마다 자기 worktree · 브랜치(`harness/<id>`) — 사용자 브랜치는 받아들일(accept) 때까지 그대로
- 완료는 저장소에 원래 있는 테스트(+ 린트)의 종료 코드로만. 모델이 쓴 검사로 모델을 판정하지 않는다
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
| `go "<요청>"` | 자기 worktree 에서 끝까지 실행하고 보고서를 낸다 — `--goal-file` · `--check "<명령>"` · `--attach <파일>` · `--doc <문서>` · `--allow "<규칙>"` · `--runtime claude\|codex` · `--detach`(셸과 분리해 띄우고 id 를 바로 돌려준다) |
| `wait <id>` | 작업이 끝날 때까지 기다려 보고를 낸다 — 에이전트 셸의 시간 상한에 걸려도 작업은 계속된다(`--detach` 와 함께) |
| `status` · `stop <id>` · `resume <id>` | 현황(누적 비용 · 겹침 · 주인 없는 변경) · 멈춤(진행분 커밋) · 이어 가기 |
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
| 판정 | 저장소 테스트의 종료 코드와 작업 전 기준선 비교(나빠지지 않음). 실패하면 **한 번 더 돌려** 불안정한 검사는 작업자에게 돌려보내지 않는다 |
| 린트 | `lint_command` — 테스트 다음의 두 번째 결정적 검사. `{files}` 는 작업이 바꾼 파일만 |
| 보고 | 요약 · 다음 할 일 · 주의 · 검사 결과 · **변경 규모(+추가/-삭제 줄 · 새 파일)** · 비용 · 시간 |
| 끝까지 | 같은 세션 이어 가기 · 질문 대신 결정 기록 · 막히면 BLOCKED.md · `resume --allow` 로 이어 감 |
| 멀티모달 | `--attach` — 이미지 · PDF 는 그대로, 영상은 장면 이미지 + 전사, 음성은 전사(ffmpeg · faster-whisper 가 있으면 자동) |
| 의존 | `.worktreeinclude`(git 밖 파일) · 서브모듈 · 저장소 밖 형제 폴더(`worktree_links`) |
| 언어 | 한국어로 물으면 대화형 답이 영어로 끝나지 않게 되돌리고, 한국어 작업은 보고 전체가 한국어 |
| 단순성 | 작업자는 목표에 필요한 최소한만 — 요청 밖 기능 · 한 번 쓰는 추상화 금지, 표준 라이브러리 우선, 바꾼 줄은 모두 요청으로 이어짐 |

## 프로젝트 설정

`AGENTS.md`(또는 `CLAUDE.md`)의 yaml 블록:

```yaml
test_command: "npm test"                 # 완료 판정 — 없으면 package.json · pytest · *.sln … 을 찾는다
lint_command: "npx eslint {files}"       # 두 번째 판정 — {files} 는 작업이 바꾼 파일
check_timeout_min: 20                    # 검사 상한(기본 15분)
rerun_failed: on                         # 실패한 검사 재실행(off 로 끈다)
serial_checks: true                      # 검사를 프로젝트 단위로 하나씩(공유 시험 DB · 포트 — 기본은 동시)
reply_language: "Korean"                 # 작업자의 기록 · 보고 언어(목표에 한글이 있으면 기본 Korean)
worker_allow: ["Bash(docker build:*)"]   # 무인 작업자에게 더 허용할 명령(git 쓰기 · 셸은 거부)
worktree_links: ["../SiblingRepo"]       # 저장소 밖 형제 폴더를 참조하는 빌드
outside_git_ok: ["data/*.db"]            # worktree 를 붙잡지 않는 런타임 부산물
transcribe_command: "whisper \"{in}\" --output_dir \"{outdir}\""   # 전사기(없으면 faster-whisper · whisper 자동)
bug_report: on                           # 하네스 보고 자동 발행(off 로 끈다)
auto_update: on                          # 최신 릴리스 자동 갱신(off 로 끈다)
```

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
| 단위 테스트(모델 호출 없음 · 임시 저장소) | 15개 파일 · CI 에서 Windows · Ubuntu · macOS × Node 20 · 22. 심볼릭 링크 임시 폴더(macOS) · Windows 짧은 이름(8.3) 경로에서도 |
| 실제 프로젝트 적용 | Python 서비스 · .NET 라이브러리 · .NET 앱 · 웹 서비스 · 3D 도구 저장소 5곳(무인 작업 수십 건 · accept 까지) |
| 하네스 vs 하네스 없이(Opus · 숨은 검사) | 같은 날 같은 조건, 목표 5개 — **하네스 15/15 · 하네스 없이 10/10** · 시간 26.9분 대 50.4분 · 비용 $7.04 대 $17.20 · Codex 4/4 |
| 단순성 규칙 전후(Opus · 목표 5개 × 2회) | 숨은 검사 **10/10 → 10/10** · 추가한 코드 **7,012 → 5,576줄(−20.5%)** · 모든 목표에서 줄었다(−12 ~ −36%) · 시간 −8% · 비용 −6% |
| 멀티모달 실측 | 글자가 든 이미지 · 영상을 Claude · Codex 모두 정확히 읽음 |

### 분야별 점수 (자체 평가 · 근거는 위 측정)

| 안전성 | 판정 정직성 | 코드 품질 유도 | 효율 · 비용 | 하네스 자체 단순성 | 멀티세션 | 이식성 | 검증 근거 | 사용성 | 완주 자율성 | 성숙도 | **평균** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 92 | 91 | 80 | 90 | 76 | 84 | 90 | 88 | 85 | 86 | 68 | **≈ 85** |

가장 낮은 두 분야는 성숙도(공개 직후 — 실사용 · 이슈가 쌓여야 오른다)와 하네스 자체의 단순성(기능이 늘었다)이다.

## 개발

```bash
node tests/run.js                      # 전체(모델 호출 없음 · 각 테스트는 자기 임시 디렉터리에서)
node tests/unit/test_v5_loop.js        # 하나만
```

고치기 전에 그 결함으로 빨개지는 테스트를 먼저 만든다. 자세한 기여 기준은 [CONTRIBUTING.md](CONTRIBUTING.md).

## 라이선스

[MIT](LICENSE)
