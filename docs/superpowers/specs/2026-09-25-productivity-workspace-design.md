# Productivity workspace

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

### Objective and scope

Strengthen my-agent-ops for everyday productive use. The user redirected the
commercial-feature request toward user productivity. Deliver a connected work
item hub, parameterized templates, reusable context packs and saved session
views. Keep the existing local-host access model and explicit CLI execution.

This replaces the earlier operational-backup proposal before implementation.
An optional priority question offered this four-feature bundle as the default.
Multi-step automatic agent workflows remain a separate proposal, not part of
this release. Do not add automatic inference, telemetry, a new identity system
or a backup subsystem to this scope.

### Work item hub

- Add a Work items page with list/board views, text/project/status/priority
  filters, local-calendar due-date filters and an archived view.
- Store title, description, next action, optional project and due date,
  `todo`/`in_progress`/`blocked`/`done` status, `low`/`normal`/`high` priority,
  up to 20 session references, up to 5 context-pack references and the last
  linked run. Archive and delete only the work item, never source sessions/runs.
- Cap stored work items at 10,000, title at 200 characters and description and
  next action at 8,000 characters each. List at most 100 per request using
  indexed metadata. Default to 25; do not load them all into bootstrap.
- Require a positive integer version for edits/deletes. Reject stale writes
  with HTTP 409 and leave the existing record intact.
- Create a work item from a session without copying the entire transcript.
  Prepare a run from a work item, preserving links and allowing prompt review.
  Require a selected project and the current work-item version before launch.
- Persist the run and its work-item link/status transition in one transaction.
  Competing submissions from the same work-item version must not start two
  CLIs. Reject archived/completed work items until explicitly reopened.
- Never infer completion from a CLI's exit code. Show the last run outcome and
  let the user mark the work item done. Add a small open-work widget to Overview
  and work-item/project/template shortcuts to the existing command palette.

### Parameterized templates

- Extend the existing template with optional variable definitions and a revision.
  Plain legacy templates remain literal text, including braces, unless variable
  definitions are present.
- Support named `{{variable}}` placeholders with text, multiline or selection
  inputs, labels, hints, defaults and required fields. Allow at most 20 variables;
  names are ASCII identifiers of at most 40 characters and exclude prototype
  keys. Bound each value to 8,000 characters and rendered prompts to 64,000.
- Do not evaluate JavaScript, shell syntax or nested template expressions.
  Substitute values once as literal text. Detect missing, duplicate, unknown and
  invalid definitions/values before applying the result.
- Offer an explicit input/apply step from the template library and the run
  dialog. Keep the rendered prompt editable and invalidate command previews
  whenever inputs or the prompt change.
- Retain up to 20 revisions per template and 1,000 revisions overall. Show
  available history, preview an earlier revision and restore it as a new
  revision. New clients use optimistic revision checks; preserve old PATCH
  clients that omit the optional expected revision.
- Reuse existing template categories, assistant defaults and read/write policy.
  Template rendering and revision operations do not launch a CLI.

### Context packs

- Add a Context packs page for named, reusable collections of selected message
  excerpts and operator notes, with optional project and instructions.
- Capture excerpts from existing local sessions, with source session/message,
  assistant, title and capture time. Accept source IDs and a character range,
  not client-provided text pretending to be an original message.
- Preserve captured excerpts when their source changes. Keep source excerpts
  read-only; allow labels, operator notes, ordering and removal to change.
  Display unavailable sources without silently deleting saved excerpts.
- Cap packs at 200, items at 20 per pack, each excerpt/note at 8,000 characters
  and the total item text at 48,000 characters. Bound source-message processing
  to 8 MiB per capture and request only the selected source, not a whole session.
  Name/description/instructions limits are 200/500/8,000 characters.
- Require versions on mutations and leave records unchanged on stale/invalid
  requests. Paginated summaries contain metadata, not every captured body.
- Provide compile, copy, Markdown/JSON export and prepare-run actions. Compiled
  context contains explicit provenance and operator instructions, is redacted
  with the existing export rules, and is bounded to 64,000 characters. Refuse
  oversize output rather than silently dropping selected items.
- Support “Add to context pack” from the session reader and attachment while
  preparing a work item/run. Compilation is deterministic and local; make no
  claim that it is an AI summary or an exact token count.

### Saved session views and quick access

- Save the existing session search/filter/sort/page-size settings under a name.
  Exclude pagination offset. Support all-time, today, last 7 days, last 30 days
  and explicit date ranges; resolve relative ranges when opened in the browser's
  local calendar, including daylight-saving transitions.
- Store at most 50 views, with a 120-character name, pinned state, timestamps
  and a mutation version. Reject unknown filters and stale edits.
- Offer save/open/update/delete/pin actions from Sessions and show pinned views
  in the command palette. Applying a view preserves the existing URL query
  format, resets offset and uses the existing search API.
- Do not execute all saved searches in the background or calculate counts for
  every view. Store only filter metadata.

### Architecture and resource boundaries

Use the existing SQLite connection and small, indexed extension tables:
`productivity_work_items`, `productivity_context_packs`,
`productivity_saved_views` and template revision metadata. Keep native schema
version 4, fingerprints, messages, search documents, notes and bookmarks intact.
Initialization must not scan or rewrite the native corpus.

Register new APIs beneath `/api/productivity`, except compatible extensions to
the existing `/api/templates` endpoints. Reuse `retryWrite` for synchronous,
atomic mutations and existing Host, Origin, local-peer, proxy and mutation-header
guards. Use no new dependency. Validate all IDs, enums, dates, sizes and versions.
UI text is Korean/English; user content remains unchanged.

Emit a small `productivity-change` SSE event containing the affected entity.
New feature views refresh only their bounded data. Keep sync-state handling
cheap and avoid full archive refreshes for work-item/pack/view edits. Lazy-load
new pages, use the current visual components and support keyboard/mobile use.
Demo state has representative examples, persists separately and never launches
real agents or reads host history through new features.

### Verification and delivery

The inspected baseline is `e32f704`; 1,226 tests passed before changes.
Use the existing isolated worktree and serialize tests with
`/tmp/my-agent-ops-1.4-test.lock`, at most two test workers.

Verify validation, restart persistence, optimistic conflicts, caps, source
provenance, redaction, literal substitution, relative dates and transactional
run linking with synthetic data. Prove existing native rows/fingerprints and
annotations remain unchanged. Exercise the combined work-item-to-run flow,
template inputs/history, context selection/export and saved views in Chromium,
including English/Korean, mobile and proxy paths.

Run the full unit suite, type checks/build, relevant browser tests and an
isolated production-dependency installation archive. Review independently and
record actual results. Synchronize README, changelog, release version, tag and
archive through the existing authorized GitHub workflow; deploy only while
owned work is idle, with a runtime backup. Keep Unreleased until a release is
actually prepared, and derive its date from the publication window.

## 한국어

### 목표와 범위

my-agent-ops에서 일상 업무를 더 편하게 처리하도록 강화합니다. 사용자가
상용 기능 요청의 방향을 사용자 생산성으로 바꿨으므로 작업센터, 변수형
템플릿, 컨텍스트 묶음, 저장된 세션 검색을 연결해 구현합니다. 기존 로컬
접근 방식과 명시적인 CLI 실행 절차를 유지합니다.

구현 전 제안했던 운영 백업 기능은 이번 범위에서 제외합니다. 선택 질문의
기본안은 위 네 기능이며 단계별 자동 에이전트 작업 흐름은 별도 제안입니다.
자동 추론, 텔레메트리, 새 인증 체계와 백업 시스템은 추가하지 않습니다.

### 작업센터

- 목록과 보드, 검색, 프로젝트, 상태, 우선순위, 현지 날짜 기준 기한 필터와
  보관함을 제공합니다.
- 제목, 설명, 다음 할 일, 선택 프로젝트와 기한, 상태
  `todo`/`in_progress`/`blocked`/`done`, 우선순위 `low`/`normal`/`high`,
  세션 참조 최대 20개, 컨텍스트 묶음 참조 최대 5개와 마지막 실행을 저장합니다.
  작업을 보관하거나 삭제해도 원본 세션과 실행은 유지합니다.
- 작업은 최대 10,000개, 제목은 200자, 설명과 다음 할 일은 각각 8,000자로
  제한합니다. 요청당 최대 100개, 기본 25개를 조회하며 bootstrap에 전부
  추가하지 않습니다.
- 수정과 삭제에 양의 정수 버전을 요구합니다. 오래된 버전은 HTTP 409로
  거절하고 저장된 내용을 유지합니다.
- 세션에서 전체 대화를 복제하지 않고 작업을 만듭니다. 작업의 참조를 유지한
  실행 초안을 준비하며 실행 전 프로젝트, 작업 버전과 프롬프트를 확인합니다.
- 실행 저장과 작업 연결, 상태 전환을 한 트랜잭션으로 처리합니다. 같은 작업
  버전의 중복 요청으로 CLI를 두 번 시작하지 않습니다. 보관하거나 완료한
  작업은 다시 연 뒤 실행합니다.
- CLI 종료 코드로 업무 완료를 판단하지 않습니다. 마지막 실행 결과를 보여주고
  사용자가 완료 상태를 선택합니다. 개요에 진행할 작업을 표시하고 기존 빠른
  검색에 작업, 프로젝트와 템플릿 이동을 추가합니다.

### 변수형 템플릿

- 기존 템플릿에 선택 변수 정의와 개정 번호를 추가합니다. 변수 정의가 없는
  기존 템플릿은 중괄호를 포함해 원문 그대로 사용합니다.
- `{{variable}}`에 텍스트, 여러 줄, 선택 입력과 이름, 도움말, 기본값, 필수
  여부를 지원합니다. 변수는 최대 20개이며 이름은 40자 이하 ASCII 식별자를
  사용하고 prototype 관련 키를 제외합니다. 값은 각각 8,000자, 완성한
  프롬프트는 64,000자까지 허용합니다.
- JavaScript, 셸 구문과 중첩 표현식을 평가하지 않습니다. 값을 일반 문자열로
  한 번 치환하며 누락, 중복, 알 수 없는 정의와 잘못된 값을 확인합니다.
- 템플릿 목록과 실행 창에서 값을 입력하고 명시적으로 적용합니다. 적용한
  프롬프트는 편집할 수 있으며 입력이나 본문이 바뀌면 명령 미리보기를 다시
  확인합니다.
- 템플릿별 최대 20개, 전체 최대 1,000개 개정을 보관합니다. 이전 내용을
  미리 보고 새 개정으로 복원합니다. 새 화면은 개정 충돌을 검사하며 예상
  개정 번호를 보내지 않는 기존 PATCH 클라이언트도 유지합니다.
- 기존 분류, 기본 어시스턴트와 읽기, 쓰기 권한을 재사용합니다. 템플릿 적용과
  개정 작업만으로 CLI를 실행하지 않습니다.

### 컨텍스트 묶음

- 선택한 메시지 인용과 사용자 메모를 이름 있는 묶음으로 저장하고 선택
  프로젝트와 지시사항을 덧붙입니다.
- 로컬 세션의 메시지 ID와 문자 범위로 인용을 가져오고 세션, 메시지,
  어시스턴트, 제목과 수집 시각을 기록합니다. 클라이언트가 보낸 본문을
  원본 메시지로 취급하지 않습니다.
- 원본이 바뀌어도 저장한 인용은 유지합니다. 인용 본문은 읽기 전용이며 이름,
  사용자 메모, 순서와 포함 여부를 바꿉니다. 원본을 찾지 못하면 상태를 표시하고
  저장한 내용을 자동 삭제하지 않습니다.
- 묶음은 최대 200개, 묶음당 20개 항목, 항목당 8,000자, 항목 본문 합계
  48,000자로 제한합니다. 원본 메시지는 수집당 8 MiB까지 처리하며 전체
  세션 대신 선택한 메시지만 읽습니다. 이름, 설명, 지시사항의 한도는
  200자, 500자, 8,000자입니다.
- 변경 시 버전을 검사하고 실패하면 원래 내용을 유지합니다. 목록은 페이지별
  메타데이터만 읽고 모든 인용 본문을 함께 가져오지 않습니다.
- 프롬프트 준비, 복사, Markdown/JSON 내보내기와 실행 초안을 제공합니다.
  출처와 사용자 지시사항을 구분하고 기존 규칙으로 민감값을 마스킹합니다.
  64,000자를 넘으면 항목을 몰래 생략하지 않고 거절합니다.
- 세션에서 묶음에 추가하거나 작업과 실행 준비에 연결합니다. 이 기능은
  로컬 조합이며 AI 요약이나 정확한 토큰 계산으로 표시하지 않습니다.

### 저장 검색과 빠른 접근

- 세션 검색어, 필터, 정렬과 페이지 크기를 이름으로 저장하며 페이지 위치는
  제외합니다. 전체 기간, 오늘, 최근 7일, 최근 30일과 직접 지정 기간을
  지원합니다. 상대 기간은 열 때 브라우저의 현지 날짜와 일광절약시간을 반영합니다.
- 최대 50개 검색에 120자 이하 이름, 고정 여부, 시각과 버전을 저장합니다.
  알 수 없는 필터와 오래된 버전의 수정은 거절합니다.
- 세션 화면에서 저장, 열기, 수정, 삭제와 고정을 제공하고 빠른 검색에도
  고정 항목을 표시합니다. 기존 URL 검색 형식과 API를 사용하며 페이지 위치는
  처음으로 되돌립니다.
- 모든 저장 검색을 백그라운드에서 실행하거나 건수를 일괄 계산하지 않습니다.
  검색 조건 메타데이터만 저장합니다.

### 구조와 자원 한도

기존 SQLite 연결에 `productivity_work_items`, `productivity_context_packs`,
`productivity_saved_views`와 템플릿 개정 메타데이터용 작은 테이블을 추가합니다.
기존 스키마 버전 4, 지문, 메시지, 검색 본문, 메모와 북마크를 유지하며
초기화할 때 원본 이력을 전체 탐색하거나 다시 쓰지 않습니다.

새 API는 `/api/productivity` 아래 두고 기존 `/api/templates`는 호환되게
확장합니다. 변경에는 `retryWrite`와 트랜잭션을 사용하고 기존 Host, Origin,
로컬 연결, 프록시와 변경 요청 헤더 검사를 유지합니다. 의존성을 추가하지 않고
식별자, 열거형, 날짜, 크기와 버전을 검증합니다. 한영 화면과 사용자 원문을
구분합니다.

변경된 종류만 담은 작은 `productivity-change` SSE 이벤트로 필요한 목록을
갱신합니다. 작업, 묶음과 저장 검색 편집 때문에 전체 이력을 다시 가져오지
않습니다. 새 화면은 지연 로딩하고 기존 시각 요소, 키보드와 모바일 동선을
유지합니다. 데모는 별도 예시를 사용하며 실제 에이전트를 실행하지 않습니다.

### 검증과 전달

기준은 `e32f704`이며 변경 전 테스트 1,226개를 통과했습니다. 기존 격리 작업
사본과 `/tmp/my-agent-ops-1.4-test.lock`을 사용하고 테스트 작업자는 최대
2개로 제한합니다.

합성 자료로 입력 검증, 재시작 후 보존, 수정 충돌, 한도, 출처, 마스킹,
문자열 치환, 상대 날짜와 실행 연결의 원자성을 검증합니다. 기존 이력,
지문과 사용자 정리 정보가 유지되는지도 확인합니다. Chromium에서 작업부터
실행 준비까지, 템플릿 입력과 이력, 컨텍스트 선택과 내보내기, 저장 검색을
한영, 모바일과 프록시 환경으로 검증합니다.

전체 단위 테스트, 타입 검사와 빌드, 관련 브라우저 검증, 운영 의존성만 설치한
압축 파일 검증을 수행하고 독립 리뷰와 실제 결과를 기록합니다. 기존 GitHub
승인 범위에서 README, 변경 이력, 버전, 태그와 설치 파일을 맞추고 작업이
없는 시점에 이전 빌드를 백업한 뒤 배포합니다. 릴리스를 준비하기 전에는
Unreleased를 유지하며 게시 시점에 맞춰 날짜를 확인합니다.
