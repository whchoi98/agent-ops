# Changelog

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

---

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The current [source manifest](package.json) declares `1.1.1`; the changes below remain unreleased.
No GitHub release or local tag baseline was found on 2026-09-25, so [Unreleased] links to the repository's comparison landing page.
After a tagged release exists, replace that link with a comparison from the actual release tag to `HEAD`.

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

[Unreleased]: https://github.com/whchoi98/agent-ops/compare

---

# 한국어

이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.
이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 기반으로 하며,
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

## [Unreleased]

<a id="korean"></a>

현재 [소스 매니페스트](package.json)의 버전은 `1.1.1`이며 아래 변경 사항은 미출시 상태입니다.
2026-09-25 확인 결과 GitHub 릴리스나 기준으로 삼을 로컬 태그가 없어 [Unreleased]는 저장소의 비교 시작 페이지에 연결합니다.
태그가 있는 릴리스를 만든 뒤 실제 릴리스 태그에서 `HEAD`까지 비교하는 링크로 바꿉니다.

### Added

<a id="추가"></a>

- 서버와 소유 동기화·실행·MCP 작업의 CPU·RSS, 보관량을 제한한 메모리 추이와 브라우저 조회 일시정지를 제공하는 자원 모니터링 추가.
- DB, WAL/SHM, 백업과 기타 앱 데이터 파일을 메타데이터만으로 집계하고 파일시스템 여유 공간을 함께 표시하는 저장 공간 구분 추가.
- 클라이언트별 선언, 출처 정보, 마스킹된 설정과 로컬 진단을 담은 MCP 목록 추가.
- 도구 호출 없이 초기화·메타데이터 목록을 제한된 범위에서 확인하는 명시적 MCP 미리보기·점검·취소 절차 추가.
- CLI 정보와 구분한 서버 호스트의 Codex App·Claude Desktop·Kiro IDE macOS 버전·빌드·경로 캐시와 명시적 미지원 호스트 상태 표시 추가.
- 사이드바·브라우저 탭과 화면 문구에 `my-agent-ops` 제목 적용.
- 기여·편집 지침, macOS 온보딩, 설계 결정, 운영 런북과 구현 참조 색인을 설치 압축 파일에 포함.
- 테마 버튼 옆 한/영 전환 추가(언어 선택 저장, 원문 보존, 화면·대화창 번역).
- 압축 백업을 검증하고 검색 본문을 무손실로 압축한 뒤 빈 페이지를 회수하는 오프라인 `optimize` 명령 추가.
- 에이전트·프로젝트별 스킬·플러그인·Power 조회, 활성화 근거, 마스킹된 원문·참조 파일 미리보기와 로컬 내용 분석 추가.
- 기존 명시적 실행 절차로 연결하는 편집 가능한 CLI 분석 초안 추가.
- 로컬·프록시 배포에서 사용하는 공식 Kiro·Codex 아이콘 포함.
- 공식 출처, 확인 시각, 업데이트·채널 상태와 조회 실패를 표시하는 CLI 현재·최신 버전 비교 추가.
- Codex, Claude Code, Kiro CLI의 읽기 전용 원본 이력 수집 추가.
- 세션 필터와 페이지 탐색을 포함한 대화 본문 검색 추가.
- 메모·태그·북마크를 수정하는 세션 메타데이터 편집 추가.
- 일반적인 비밀 패턴을 마스킹하는 JSON·Markdown·독립 HTML 세션 내보내기 추가.
- 대기열, 명령 미리보기, 실시간 로그와 소유 프로세스 취소를 갖춘 CLI 실행 제어 추가.
- 에이전트 사이에 세션 맥락을 전달하는 편집 가능한 작업 인계 프롬프트 추가.
- 데스크톱·모바일 탐색을 지원하는 반응형 화면 추가.
- 샘플 데이터를 사용하고 에이전트 실행을 차단하는 격리된 데모 모드 추가.
- 가져온 이력과 앱 상태를 로컬 SQLite에 저장.
- 인증된 하위 경로의 화면·API·글꼴·SSE에 적용할 명시적 HTTPS 프록시 설정 추가.
- 로컬에서 계속 실행할 수 있는 systemd 서비스 예제 제공.

### Fixed

<a id="수정"></a>

- 오프라인 `optimize`에서 검색 본문 전체를 중복 처리하던 작업을 줄이고 저장 테이블 검증 후 보존한 본문으로 검색 색인을 재구축하도록 수정.
- 범위를 제한한 취소 가능한 백그라운드 동기화와 요청 병합으로 원본 수집 중 HTTP 응답 정체 완화.
- Kiro 행별 지문을 저장하고 변경된 메시지·검색 본문만 갱신해 반복 수집의 쓰기 감소.
- 설정한 프록시 경로를 기준으로 화면 파일과 API 요청 주소를 계산하도록 수정.
- 로컬 연결·교차 출처 요청 보호를 유지하며 설정한 프록시 출처를 허용하도록 수정.

[Unreleased]: https://github.com/whchoi98/agent-ops/compare
