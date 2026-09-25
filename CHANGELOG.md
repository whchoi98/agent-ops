# Changelog

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Unreleased

#### Added

- Korean/English switch beside the theme control, browser language persistence
  and translated workspaces/dialogs with original content preserved.
- Explicit offline `optimize` command with a verified compressed backup,
  lossless search-document compression and unused-page reclamation.
- Assistant-specific skill/plugin/Power discovery, configured-state evidence,
  project filters, redacted source previews and local content analysis.
- Optional editable CLI analysis drafts through the existing explicit run flow.
- Official Kiro and Codex vendor icons bundled for local and proxy deployments.
- Installed/latest CLI version comparison with official sources, check times,
  update/channel states and explicit lookup failures.

- Local session import, full-text search, metadata and exports for Codex,
  Claude Code and Kiro CLI.
- Controlled CLI execution, queueing, live logs, cancellation and editable handoff.
- Responsive Korean interface, isolated demo mode and local SQLite storage.
- Explicit HTTPS proxy configuration for UI, API, fonts and SSE under a subpath.
- Example systemd service and contributor, setup and operating documentation.

#### Fixed

- Avoid retokenizing the entire old FTS corpus during offline prechecks; verify
  stored tables and rebuild derived postings from the preserved document bodies.
- Keep HTTP requests responsive during native import by running owned background
  synchronization with bounded output, cancellation and coalescing.
- Persist Kiro row fingerprints and update only changed messages/search content
  instead of rewriting entire unchanged conversations.
- Resolve UI assets and API requests relative to the configured proxy path.
- Accept the configured proxy origin while preserving local connection and
  cross-origin request guards.

<a id="korean"></a>
## 한국어

### Unreleased

#### 추가

- 테마 버튼 옆 한/영 전환, 브라우저 언어 저장과 원문을 보존하는 화면·대화창 번역.
- 검증한 압축 백업, 검색 본문 압축과 빈 페이지 회수를 제공하는 오프라인 `optimize` 명령.
- 어시스턴트별 스킬·플러그인·Power 조회, 상태 근거, 프로젝트 필터,
  마스킹된 원문·참조 파일과 로컬 내용 분석.
- 기존 실행 절차로 연결하는 편집 가능한 CLI 분석 프롬프트.
- 로컬·프록시 환경에서 사용하는 공식 Kiro·Codex 아이콘.
- 공식 출처·확인 시각·업데이트/채널 상태·조회 실패를 표시하는 현재/최신 CLI 버전 비교.

- Codex, Claude Code, Kiro CLI의 로컬 이력 수집, 본문 검색, 메타데이터와 내보내기.
- CLI 실행 제어, 대기열, 실시간 로그, 취소와 편집 가능한 작업 인계.
- 반응형 한국어 화면, 격리된 데모 모드와 로컬 SQLite 저장소.
- 하위 경로의 화면·API·글꼴·SSE를 위한 명시적 HTTPS 프록시 설정.
- systemd 서비스 예제와 개발·설치·운영 문서.

#### 수정

- 오프라인 사전 검사에서 기존 검색 본문 전체를 다시 토큰화하던 중복 작업을 줄이고,
  저장 테이블을 검사한 뒤 보존된 본문으로 검색 색인을 다시 만듭니다.
- 원본 수집을 별도 프로세스에서 실행해 동기화 중 서버 응답 정체를 줄입니다.
- Kiro 행별 지문을 저장하고 변경된 메시지·검색 본문만 갱신해 중복 쓰기를 줄입니다.
- 설정한 프록시 경로를 기준으로 화면 파일과 API 요청 주소를 계산합니다.
- 로컬 연결과 교차 출처 보호를 유지하면서 설정한 프록시 출처를 허용합니다.
