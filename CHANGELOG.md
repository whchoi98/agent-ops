# Changelog

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

---

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-09-26

### Added

- Add work items with paginated list/board views, priorities, due dates, session/context links and version-checked run preparation, while leaving completion to the operator.
- Add parameterized templates with literal substitution, explicit input/apply steps and bounded revision preview and restoration.
- Add reusable context packs with immutable message excerpts, source provenance, editable notes, local prompt compilation and redacted Markdown/JSON exports.
- Add saved session views with local-calendar relative periods and pinning, plus command-palette shortcuts for views, work items, projects and templates.

### Changed

- Refresh productivity metadata and template lists separately from the archive while preserving open drafts and requiring a new command preview after preparation changes.

## [1.3.0] - 2026-09-25

### Added

- Add recorded Kiro credits with distinct zero, unknown and partial coverage in summaries, analytics, comparisons, sorting and exports.
- Add interval, workbench-idle and manual import controls with per-import time budgets, reusable cancellation and cached attempt status.
- Add explicit workbench release checks with validated GitHub metadata and copyable npm/Git update instructions, without automatic installation or restart.

### Changed

- Schedule automatic imports after completion and defer idle-mode imports while workbench CLI jobs are queued or running.
- Re-import only Kiro records for credit backfill and avoid inflating or rebuilding unchanged search content when only usage changes.
- Refresh the archive once at import termination while streaming lightweight sync status separately.

## [1.2.1] - 2026-09-25

### Fixed

- Recognize Codex App installed as `ChatGPT.app` when its bundle identifier is `com.openai.codex`, while retaining `Codex.app` discovery.

## [1.2.0] - 2026-09-25

### Added

- Add CPU/RSS monitoring for the server and owned sync, run and MCP work, with bounded in-memory trends and pausable browser polling.
- Add a metadata-only storage breakdown for DB, WAL/SHM, backups and other app-data files alongside filesystem free space.
- Add an MCP inventory with client-specific declarations, source provenance, redacted configuration and local diagnostics.
- Add an explicit MCP preview/check/cancel flow for bounded initialization and metadata listing without tool invocation.
- Add cached server-host macOS version, build and path information for Codex App, Claude Desktop and Kiro IDE, with explicit unsupported-host status and separate CLI information.
- Display the `my-agent-ops` title in the sidebar, browser tabs and interface copy.
- Include contributor/editor guidance, macOS onboarding, architecture decisions, operations runbooks and an implementation reference index in the installation archive.
- Add a Korean/English switch beside the theme control, persisting language choice and translating workspaces/dialogs while preserving original content.
- Add an offline `optimize` command that verifies a compressed backup, losslessly compresses search documents and reclaims unused pages.
- Add assistant/project-scoped skill, plugin and Power discovery with activation evidence, redacted source/reference previews and local content analysis.
- Add editable CLI analysis drafts through the existing explicit run flow.
- Bundle official Kiro and Codex icons for local and proxy deployments.
- Add installed/latest CLI version comparison with official sources, check times, update/channel states and explicit lookup failures.
- Add read-only native history import for Codex, Claude Code and Kiro CLI.
- Add full-text conversation search with session filters and pagination.
- Add session metadata editing for notes, tags and bookmarks.
- Add JSON, Markdown and standalone HTML session exports with common secret patterns redacted.
- Add controlled CLI execution with a queue, command previews, live logs and owned-process cancellation.
- Add editable handoff prompts for transferring session context between assistants.
- Add a responsive interface for desktop and mobile navigation.
- Add an isolated demo mode with sample data and assistant execution disabled.
- Store imported history and workbench state in local SQLite.
- Add explicit HTTPS proxy configuration for UI, API, fonts and SSE under an authenticated subpath.
- Provide an example systemd service for persistent local operation.

### Fixed

- Avoid a redundant full-corpus search pass during offline `optimize`, while verifying stored tables and rebuilding the search index from preserved document bodies.
- Keep HTTP requests responsive during native import with bounded, cancellable background synchronization and coalesced requests.
- Reduce repeat Kiro import writes by persisting row fingerprints and updating only changed messages and search content.
- Resolve UI assets and API requests relative to the configured proxy path.
- Accept the configured proxy origin while preserving local connection and cross-origin request guards.

[Unreleased]: https://github.com/whchoi98/agent-ops/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/whchoi98/agent-ops/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/whchoi98/agent-ops/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/whchoi98/agent-ops/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/whchoi98/agent-ops/releases/tag/v1.2.0

---

<a id="korean"></a>

# 한국어

이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.
이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 기반으로 하며,
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

## [Unreleased]

## [1.4.0] - 2026-09-26

### Added

- 페이지별 목록과 보드, 우선순위, 기한, 세션과 컨텍스트 연결, 버전을 검사하는 실행 준비를 갖추고 사용자가 완료 여부를 정하는 작업센터 추가.
- 문자열 치환, 명시적인 입력과 적용, 보관량을 제한한 개정 미리보기와 복원을 지원하는 변수형 템플릿 추가.
- 변경되지 않는 메시지 인용과 출처, 편집 가능한 메모, 로컬 프롬프트 조합, 마스킹된 Markdown/JSON 내보내기를 갖춘 컨텍스트 묶음 추가.
- 현지 날짜 기준 상대 기간과 고정을 지원하는 저장 검색, 검색과 작업, 프로젝트, 템플릿을 여는 명령 팔레트 바로가기 추가.

### Changed

- 전체 이력과 별도로 생산성 메타데이터와 템플릿 목록을 갱신하고 열린 초안을 유지하며 실행 준비 내용이 바뀌면 새 명령 미리보기를 요구하도록 변경.

## [1.3.0] - 2026-09-25

### Added

- Kiro credit을 요약, 분석, 비교, 정렬과 내보내기에 표시하며 기록된 0, 미확인, 부분 기록을 구분하는 기능 추가.
- 주기, 앱 작업 유휴, 수동 수집 제어와 수집별 시간 제한, 재사용 가능한 중단, 캐시된 시도 상태 추가.
- 자동 설치나 재시작 없이 앱 릴리스를 직접 확인하고 검증된 GitHub 메타데이터와 복사 가능한 npm/Git 명령을 제공하는 안내 추가.

### Changed

- 수집 완료 후 다음 자동 수집을 예약하고 앱의 CLI 작업이 대기 또는 실행 중이면 유휴 모드 수집을 미루도록 변경.
- credit 보충 수집은 Kiro 기록만 다시 읽고 사용량만 바뀌면 기존 검색 본문의 압축 해제와 재구축을 건너뛰도록 변경.
- 작은 동기화 상태를 별도로 전송하고 수집 종료 시 한 번만 이력을 새로고침하도록 변경.

## [1.2.1] - 2026-09-25

### Fixed

- 번들 식별자가 `com.openai.codex`인 `ChatGPT.app`을 Codex App으로 인식하고 기존 `Codex.app` 경로도 계속 조회하도록 수정.

## [1.2.0] - 2026-09-25

### Added

<a id="추가"></a>

- 서버와 소유 동기화, 실행, MCP 작업의 CPU, RSS, 보관량을 제한한 메모리 추이와 브라우저 조회 일시정지를 제공하는 자원 모니터링 추가.
- DB, WAL/SHM, 백업과 기타 앱 데이터 파일을 메타데이터만으로 집계하고 파일시스템 여유 공간을 함께 표시하는 저장 공간 구분 추가.
- 클라이언트별 선언, 출처 정보, 마스킹된 설정과 로컬 진단을 담은 MCP 목록 추가.
- 도구 호출 없이 초기화, 메타데이터 목록을 제한된 범위에서 확인하는 명시적 MCP 미리보기, 점검, 취소 절차 추가.
- CLI 정보와 구분한 서버 호스트의 Codex App, Claude Desktop, Kiro IDE macOS 버전, 빌드, 경로 캐시와 명시적 미지원 호스트 상태 표시 추가.
- 사이드바, 브라우저 탭과 화면 문구에 `my-agent-ops` 제목 적용.
- 기여, 편집 지침, macOS 온보딩, 설계 결정, 운영 런북과 구현 참조 색인을 설치 압축 파일에 포함.
- 테마 버튼 옆 한/영 전환 추가(언어 선택 저장, 원문 보존, 화면, 대화창 번역).
- 압축 백업을 검증하고 검색 본문을 무손실로 압축한 뒤 빈 페이지를 회수하는 오프라인 `optimize` 명령 추가.
- 에이전트, 프로젝트별 스킬, 플러그인, Power 조회, 활성화 근거, 마스킹된 원문, 참조 파일 미리보기와 로컬 내용 분석 추가.
- 기존 명시적 실행 절차로 연결하는 편집 가능한 CLI 분석 초안 추가.
- 로컬, 프록시 배포에서 사용하는 공식 Kiro, Codex 아이콘 포함.
- 공식 출처, 확인 시각, 업데이트, 채널 상태와 조회 실패를 표시하는 CLI 현재, 최신 버전 비교 추가.
- Codex, Claude Code, Kiro CLI의 읽기 전용 원본 이력 수집 추가.
- 세션 필터와 페이지 탐색을 포함한 대화 본문 검색 추가.
- 메모, 태그, 북마크를 수정하는 세션 메타데이터 편집 추가.
- 일반적인 비밀 패턴을 마스킹하는 JSON, Markdown, 독립 HTML 세션 내보내기 추가.
- 대기열, 명령 미리보기, 실시간 로그와 소유 프로세스 취소를 갖춘 CLI 실행 제어 추가.
- 에이전트 사이에 세션 맥락을 전달하는 편집 가능한 작업 인계 프롬프트 추가.
- 데스크톱, 모바일 탐색을 지원하는 반응형 화면 추가.
- 샘플 데이터를 사용하고 에이전트 실행을 차단하는 격리된 데모 모드 추가.
- 가져온 이력과 앱 상태를 로컬 SQLite에 저장.
- 인증된 하위 경로의 화면, API, 글꼴, SSE에 적용할 명시적 HTTPS 프록시 설정 추가.
- 로컬에서 계속 실행할 수 있는 systemd 서비스 예제 제공.

### Fixed

<a id="수정"></a>

- 오프라인 `optimize`에서 검색 본문 전체를 중복 처리하던 작업을 줄이고 저장 테이블 검증 후 보존한 본문으로 검색 색인을 재구축하도록 수정.
- 범위를 제한한 취소 가능한 백그라운드 동기화와 요청 병합으로 원본 수집 중 HTTP 응답 정체 완화.
- Kiro 행별 지문을 저장하고 변경된 메시지, 검색 본문만 갱신해 반복 수집의 쓰기 감소.
- 설정한 프록시 경로를 기준으로 화면 파일과 API 요청 주소를 계산하도록 수정.
- 로컬 연결, 교차 출처 요청 보호를 유지하며 설정한 프록시 출처를 허용하도록 수정.

[Unreleased]: https://github.com/whchoi98/agent-ops/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/whchoi98/agent-ops/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/whchoi98/agent-ops/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/whchoi98/agent-ops/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/whchoi98/agent-ops/releases/tag/v1.2.0
