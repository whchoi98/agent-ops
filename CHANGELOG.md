# Changelog

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Unreleased

#### Added

- Local session import, full-text search, metadata and exports for Codex,
  Claude Code and Kiro CLI.
- Controlled CLI execution, queueing, live logs, cancellation and editable handoff.
- Responsive Korean interface, isolated demo mode and local SQLite storage.
- Explicit HTTPS proxy configuration for UI, API, fonts and SSE under a subpath.
- Example systemd service and contributor, setup and operating documentation.

#### Fixed

- Resolve UI assets and API requests relative to the configured proxy path.
- Accept the configured proxy origin while preserving local connection and
  cross-origin request guards.

<a id="korean"></a>
## 한국어

### Unreleased

#### 추가

- Codex, Claude Code, Kiro CLI의 로컬 이력 수집, 본문 검색, 메타데이터와 내보내기.
- CLI 실행 제어, 대기열, 실시간 로그, 취소와 편집 가능한 작업 인계.
- 반응형 한국어 화면, 격리된 데모 모드와 로컬 SQLite 저장소.
- 하위 경로의 화면·API·글꼴·SSE를 위한 명시적 HTTPS 프록시 설정.
- systemd 서비스 예제와 개발·설치·운영 문서.

#### 수정

- 설정한 프록시 경로를 기준으로 화면 파일과 API 요청 주소를 계산합니다.
- 로컬 연결과 교차 출처 보호를 유지하면서 설정한 프록시 출처를 허용합니다.
