# ADR 0001: Local data and explicit CLI execution

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

Status: implemented. Recorded: 2026-09-25.

### Context

my-agent-ops combines local histories from Codex, Claude Code and Kiro CLI with
explicitly requested work. Native history, installed CLI capabilities and account
authentication are different sources of evidence.

### Decision

Keep application state in local SQLite and open native history read-only.
Separate parsers from the process runner. Import, search, extension inspection
and command preview do not start model inference. Running an assistant requires
an enabled project and an explicit run request; cancel only owned processes.

Listen on `127.0.0.1`. Remote browser access uses an authenticated local proxy
with an explicit HTTPS public URL, or an SSH tunnel. Host/Origin and mutation
header checks remain in force. The browser receives the selected history over
the application's API; this is not an account synchronization or billing API.

Keep credentials with each CLI. Report only recorded usage and configuration
evidence. A discovered extension is not proof of invocation, and an installed
CLI is not proof of successful login.

### Consequences and evidence

The server's machine determines which files and CLIs are available. A Mac
installation reads Mac history; an EC2 installation reads EC2 history. Original
records and user-entered text remain unchanged by Korean/English UI translation.
The application does not implement public-account login or multi-user tenancy.

Code pointers: `server/access.ts`, `server/providers/`, `server/runner.ts`,
`server/commands.ts`, `server/extensions/`, `src/i18n/`.

See [architecture](../architecture.md), [operations](../operations.md), and
[API contracts](../api.md).

<a id="korean"></a>
## 한국어

상태: 구현됨. 기록일: 2026-09-25.

### 배경

my-agent-ops는 Codex, Claude Code, Kiro CLI의 로컬 이력과 사용자가 요청한 작업을
연결합니다. 원본 이력, 설치된 CLI의 기능, 계정 인증은 서로 다른 근거입니다.

### 결정

앱 상태는 로컬 SQLite에 보관하고 원본 이력은 읽기 전용으로 엽니다. 파서와
실행 관리자를 분리합니다. 수집·검색·확장 조회·명령 미리보기는 모델 추론을
시작하지 않습니다. 실제 실행에는 실행을 허용한 프로젝트와 명시적인 요청이
필요하며, 앱이 소유한 프로세스만 취소합니다.

리스너는 `127.0.0.1`을 사용합니다. 원격 브라우저에서는 HTTPS 공개 URL을 명시한
인증된 로컬 프록시나 SSH 터널을 사용하고 Host·Origin·변경 헤더 검사를 유지합니다.
브라우저는 앱 API를 통해 선택한 이력을 받습니다. 계정 동기화나 청구 API를
사용하는 구조는 아닙니다.

인증은 각 CLI가 관리합니다. 기록된 사용량과 설정 근거만 표시하며, 확장 발견을
실제 호출로, CLI 설치를 로그인 성공으로 해석하지 않습니다.

### 영향과 근거

파일과 CLI의 기준은 서버가 실행되는 머신입니다. Mac 설치는 Mac 이력을,
EC2 설치는 EC2 이력을 읽습니다. 한/영 UI 전환은 원본 기록과 사용자 입력을
번역하지 않습니다. 앱 자체의 공개 계정 로그인과 다중 사용자 테넌시는 구현하지
않습니다.

코드 위치: `server/access.ts`, `server/providers/`, `server/runner.ts`,
`server/commands.ts`, `server/extensions/`, `src/i18n/`.

[아키텍처](../architecture.md), [운영](../operations.md), [API 계약](../api.md)을
함께 참고하세요.
