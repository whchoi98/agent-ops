# Contributing

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

Use a source checkout for development. The installed npm archive contains the
built application and public documentation. Read [AGENTS.md](AGENTS.md) for the
code map and invariants, and [onboarding](docs/onboarding.md) for installation.

### Work on a change

Start from a clean worktree or an isolated branch. Preserve unrelated edits and
existing changelog history. Use the project's npm scripts:

```bash
npm ci
npm run dev -- --demo
```

Demo data stays under `.data/demo` in this development workflow and cannot
execute coding assistants. Use synthetic fixtures for tests; importing native
history is a separate, explicit verification step.

### Validate and document

| Change | Verification |
|---|---|
| Application behavior | `npm run check`, plus the affected browser workflows |
| Browser behavior | `npm run test:e2e` after building; install Chromium with `npx playwright install chromium` if needed |
| Documentation | Check local links and code/command accuracy; run `git diff --check` |
| Packaged files or docs | Inspect `npm pack --dry-run --ignore-scripts --json`; verify links inside the resulting package |

Record performed checks and their limits in [verification](docs/verification.md).
The repository currently has no checked-in CI workflow; detecting test scripts
does not mean those tests have run. Mac-specific instructions must distinguish
implemented path support from actual Mac runtime verification.

Update affected documents, the [documentation index](docs/README.md), and both
language sections of Unreleased in [CHANGELOG.md](CHANGELOG.md). Preserve an
existing document's language; keep English and Korean facts equivalent in
bilingual documents. New architecture decisions belong in
[decisions](docs/decisions/README.md), operational procedures in
[runbooks](docs/runbooks/README.md), and code navigation in
[reference](docs/reference/INDEX.md).

### Prepare Git changes

Review `git status`, stage only intended paths, and inspect `git diff --cached`
and `git diff --cached --check`. Exclude databases, native transcripts, local
configuration, credentials, dependencies, exports and generated artifacts.
Keep screenshots limited to demo data.

A commit or pull request should explain the behavior changed, why it changed,
the checks actually run, and remaining limits. Use the existing remote and
requested branch; commit/push only within the authorized task. Repository
documentation maintenance does not install hooks or restart a running service.

<a id="korean"></a>
## 한국어

개발에는 소스 체크아웃을 사용합니다. npm 설치 패키지에는 빌드된 앱과 공개
문서가 들어 있습니다. 코드 위치와 유지할 규칙은 [AGENTS.md](AGENTS.md),
설치는 [온보딩](docs/onboarding.md)을 참고하세요.

### 변경 작업

정리된 작업 디렉터리나 별도 브랜치에서 시작합니다. 관련 없는 수정과 기존 변경
기록을 보존하고 프로젝트에 선언된 npm 명령을 사용하세요.

```bash
npm ci
npm run dev -- --demo
```

이 개발 방식의 데모 데이터는 `.data/demo`에 저장되며 코딩 어시스턴트를 실행할
수 없습니다. 테스트에는 합성 자료를 사용하고, 실제 이력 수집 검증은 별도의
명시적인 작업으로 진행합니다.

### 검증과 문서

| 변경 | 검증 |
|---|---|
| 애플리케이션 동작 | `npm run check`와 영향을 받는 브라우저 동선 |
| 브라우저 동작 | 빌드 후 `npm run test:e2e`; 필요하면 `npx playwright install chromium`으로 Chromium 설치 |
| 문서 | 로컬 링크와 코드·명령의 정확성 확인, `git diff --check` 실행 |
| 패키지 파일·문서 | `npm pack --dry-run --ignore-scripts --json` 내용과 생성 패키지 내부 링크 확인 |

수행한 검사와 한계는 [검증 기록](docs/verification.md)에 남깁니다. 현재 저장소에는
커밋된 CI 워크플로가 없습니다. 테스트 명령의 존재를 테스트 실행 결과로 해석하지
마세요. Mac 안내에서는 경로 지원 구현과 Mac 실기기 검증을 구분합니다.

관련 문서, [문서 색인](docs/README.md), [CHANGELOG.md](CHANGELOG.md)의 Unreleased
영문·한글 항목을 갱신합니다. 기존 문서의 언어는 보존하고, 이중 언어 문서의
사실은 일치시킵니다. 설계 결정은 [결정 기록](docs/decisions/README.md), 운영 절차는
[런북](docs/runbooks/README.md), 코드 탐색은 [참조 색인](docs/reference/INDEX.md)에
연결합니다.

### Git 준비

`git status`를 확인하고 필요한 파일만 스테이징한 뒤 `git diff --cached`와
`git diff --cached --check`를 검토합니다. DB, 원본 대화, 로컬 설정, 인증 정보,
의존성, 내보내기와 생성 산출물은 제외하고 스크린샷에는 데모 데이터만 사용합니다.

커밋이나 PR에는 변경한 동작과 이유, 실제 검사 결과, 남은 한계를 적습니다.
기존 원격 저장소와 요청된 브랜치를 사용하며 승인된 작업 범위에서 커밋·푸시합니다.
프로젝트 문서 정리는 훅 설치나 운영 서비스 재시작을 수행하는 작업이 아닙니다.
