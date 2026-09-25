# Usage and operating controls

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

### Objective and selected features

Extend the existing workbench with recorded Kiro credits, explicit import controls
and an app update guide. These address the user's previous questions about Kiro
usage, resource consumption and Mac upgrades. Preserve native history, user
metadata, process ownership, local access guards and both interface languages.

The user delegated feature selection and implementation. The optional preference
question defaults to usage and resource management. Implement all three features
as a coherent release; do not replace implementation with a list of suggestions.

### Recorded Kiro credits

Current local metadata contains
`session_state.conversation_metadata.user_turn_metadatas[].metering_usage[]`,
with numeric `value`, `unit: "credit"` and `unitPlural: "credits"`. A turn can
contain several records. `loop_id` identifies the turn and includes `agent_id`
and `rand` in the inspected records.

- Extend `Usage` with optional `credits: number | null` and
  `creditsPartial: boolean`; absent legacy fields mean unrecorded.
- Sum finite, nonnegative credit values within a turn. Keep decimals and recorded
  zero. Never convert tokens, context percentages or USD into credits.
- Track turns separately from token counters. Replace repeated snapshots of the
  same turn instead of accumulating them again; use stable turn identities.
  Resolve growing message-ID lists and later loop IDs after collecting identity
  evidence. Prefer the validated envelope update time, then the turn end time.
  Equal-valued records within an array remain separate records.
- Mark partial results when some turn records are missing or invalid. Bound the
  ledger to 20,000 turn groups and 40,000 message identities; report unrecorded
  usage when attribution is ambiguous or a bound is exceeded.
- Read the established metadata location. Unsupported old formats retain unknown
  credits. A transcript rejected by existing import validation remains rejected.
- Change only the Kiro parser revision for the one-time backfill. Preserve Codex
  and Claude fingerprints. Keep unchanged message rows and search documents
  unchanged when only usage metadata changes.
- Use the existing JSON session storage and schema 4. Add no tables, bulk SQL
  migration or persistent per-turn ledger.
- Prefer credits for Kiro usage summaries in session and run views; retain raw
  token details as separate measurements. Do not assign a whole resumed session's
  credits to one run. Unrecorded run credits remain unknown.
- Add separate recorded-credit totals and coverage to analytics, a credits sort
  for sessions, comparison details and all export formats. Daily analytics keep
  the existing session-start-date grouping and label that scope.

### Import controls

Persist `syncMode` (`interval`, `idle`, `manual`) and `syncMaxSeconds` in the
existing settings JSON. Default to `interval` and 1,800 seconds to preserve the
existing automatic mode and maximum duration. Keep `scanIntervalSeconds` at
15 through 3,600 seconds; accept time budgets from 30 through 1,800 seconds.

- Run one owned import at a time. Manual requests coalesce and bypass automatic
  mode or idle gating while retaining the time budget.
- In idle mode, defer automatic imports while this workbench has active CLI work.
  Do not inspect unrelated OS processes or claim the entire machine is idle.
- Schedule the next automatic check after completion, using the configured
  interval. Retry an idle deferral after at most 15 seconds. Keep one timer.
- A manual stop interrupts the current owned child and allows a later import.
  Shutdown cancellation still permanently closes the controller. Preserve the
  existing SIGTERM/SIGKILL escalation and bounded pipe cleanup.
- Budget expiry is distinct from cancellation and failure. Already committed
  sessions survive; do not invent a complete import count after interruption.
- Keep scheduling and the last attempt in bounded memory. Reuse the existing
  persisted last import report. Expose a cached status API, mode, next check,
  active duration and last outcome in Settings.
- Send lightweight sync-state events during work. Refresh archive/bootstrap data
  once at termination, rather than on every progress tick.
- Preserve manual synchronization when automatic work is disabled. Demo controls
  operate only on isolated demo state and never inspect native history.

### App update guide

Add a separate Settings card for the workbench itself, distinct from CLI and
desktop app versions. GET returns cached state and makes no network request.
An explicit check reads the public repository's latest GitHub release.

- Fixed repository: `whchoi98/agent-ops`.
- One request in flight, eight-second total deadline, 256 KiB response limit and
  60-second minimum interval between checks. Cache only bounded metadata in RAM.
- Send no credentials, current-version query, conversation or configuration data.
  Reject redirects and malformed, draft or prerelease responses.
- Compare validated SemVer versions. Show not checked, current, update available,
  ahead of release, and unavailable states with timestamps and source.
- Validate the release page and installation asset against the fixed repository,
  tag and `agent-ops-local-<version>.tgz` name. Do not offer an npm command when
  the asset is missing or invalid.
- Provide copyable npm and Git update instructions and the release page. Commands
  run in the user's server terminal after stopping the app and retain existing
  startup settings. Never execute an installer or restart from this feature.
- Demo mode makes no network requests and does not offer nonexistent install
  assets. Close aborts pending work.

### Resource and verification requirements

Add no dependency, native history mutation, model inference or external telemetry.
Use the existing isolated worktree and at most two test workers.
Preserve README/CHANGELOG bilingual structure, short installation labels and
comma/ordinary-dash punctuation.

Verify fractional/zero/unknown/partial credits, duplicate snapshots, native-source
boundaries, targeted backfill, metadata-only writes, sorting, aggregation and
exports. Verify scheduling, idle deferral, repeated stops, budget expiry,
subprocess cleanup, access guards and cheap progress events. Verify update
metadata validation, coalescing, time/size limits, demo behavior and safe commands.
Run full unit tests, type checking, build, relevant browser tests and an isolated
installation archive test. Inspect live behavior after an authorized update.
Publish synchronized version, changelog, tag, release notes and assets through
the already requested GitHub delivery workflow.

## 한국어

### 목표와 선정한 기능

기존 앱에 Kiro의 기록된 credit, 명시적인 수집 제어, 앱 업데이트 안내를
추가합니다. 앞서 요청한 Kiro 사용량, 자원 소비, Mac 업그레이드 문제를
해결하는 기능입니다. 원본 이력, 사용자 메타데이터, 프로세스 소유권,
로컬 접근 검사와 한영 화면을 보존합니다.

사용자가 기능 선정과 구현을 맡겼으며 선택 질문의 기본 방향은 사용량과
자원 관리입니다. 세 기능을 하나의 릴리스로 구현하고 제안 목록만으로
작업을 끝내지 않습니다.

### Kiro의 기록된 credit

현재 로컬 기록에는
`session_state.conversation_metadata.user_turn_metadatas[].metering_usage[]`가
있으며 숫자형 `value`, `unit: "credit"`, `unitPlural: "credits"`를 담습니다.
한 turn에 여러 기록이 들어갑니다. 확인한 기록의 `loop_id`는 `agent_id`와
`rand`를 포함하며 turn을 식별합니다.

- `Usage`에 선택 필드 `credits: number | null`, `creditsPartial: boolean`을
  추가합니다. 기존 기록에 필드가 없으면 미기록으로 처리합니다.
- turn 안의 유한한 0 이상 credit 값을 합산하며 소수와 기록된 0을 보존합니다.
  토큰, 컨텍스트 비율, USD를 credit으로 환산하지 않습니다.
- 토큰 카운터와 별도로 turn을 관리합니다. 안정적인 식별자로 같은 turn의
  반복 스냅샷을 교체하며 중복 합산하지 않습니다. 늘어난 메시지 ID 목록과
  나중에 생긴 loop ID는 식별 근거를 모은 뒤 대조합니다. 검증한 envelope
  갱신 시각, turn 종료 시각 순으로 최신 기록을 판단합니다. 배열 안에서
  값이 같은 기록은 서로 다른 기록으로 유지합니다.
- 일부 turn 기록이 없거나 잘못되면 부분 기록으로 표시합니다. 최대
  20,000개 turn 그룹과 40,000개 메시지 식별자를 보관하며 소속이 모호하거나
  한도를 넘으면 사용량을 미기록으로 표시합니다.
- 확인된 메타데이터 위치를 읽습니다. 지원하지 않는 이전 형식은 credit을
  미확인으로 남기며 기존 수집 검증이 거부한 대화도 계속 거부합니다.
- 한 번의 보충 수집에는 Kiro 파서 버전만 변경합니다. Codex와 Claude의
  지문은 유지하고 사용량만 바뀌면 메시지 행과 검색 본문을 다시 쓰지 않습니다.
- 기존 세션 JSON과 스키마 4를 사용합니다. 테이블, 일괄 SQL 마이그레이션,
  영구 turn별 원장은 추가하지 않습니다.
- 세션과 실행 요약에서 Kiro는 credit을 우선 표시하며 원본 토큰 상세는
  별도로 유지합니다. 재개한 전체 세션의 credit을 실행 한 번에 배정하지
  않으며 실행 기록에 credit이 없으면 미확인으로 표시합니다.
- 통계에 별도 credit 합계와 기록 범위를 추가하고 세션의 credit 정렬,
  비교 상세, 모든 내보내기 형식을 지원합니다. 날짜별 통계는 기존의
  세션 시작일 기준을 유지하며 그 범위를 표시합니다.

### 수집 제어

기존 설정 JSON에 `syncMode` (`interval`, `idle`, `manual`)와
`syncMaxSeconds`를 저장합니다. 기본값은 `interval`, 1,800초로 기존
자동 모드와 최대 시간을 유지합니다. `scanIntervalSeconds`는 15~3,600초,
수집 시간 제한은 30~1,800초를 허용합니다.

- 소유 수집 작업은 하나만 실행합니다. 수동 요청은 병합하고 자동 모드나
  유휴 조건을 건너뛰되 시간 제한은 적용합니다.
- 유휴 모드에서는 앱의 CLI 작업이 실행 중이면 자동 수집을 미룹니다.
  관련 없는 OS 프로세스를 조사하거나 기기 전체가 유휴 상태라고 판단하지 않습니다.
- 완료 후 설정 간격에 맞춰 다음 자동 확인을 예약합니다. 유휴 대기는 최대
  15초 뒤 다시 확인하며 타이머는 하나만 유지합니다.
- 수동 중단은 현재 소유 자식 프로세스를 멈추고 다음 수집은 허용합니다.
  앱 종료 시에는 제어기를 영구 종료하며 기존 SIGTERM/SIGKILL 단계와
  파이프 정리 시간 제한을 유지합니다.
- 시간 초과, 취소, 실패를 구분합니다. 이미 저장된 세션은 보존하며
  중단된 수집의 전체 건수를 추정하지 않습니다.
- 일정과 마지막 시도는 보관량을 제한한 메모리에서 관리합니다. 기존의
  마지막 수집 보고서는 재사용하고 캐시 상태 API, 모드, 다음 확인 시각,
  진행 시간과 마지막 결과를 설정 화면에 표시합니다.
- 진행 중에는 작은 수집 상태 이벤트만 보내고 종료 시 한 번 이력과
  bootstrap 데이터를 갱신합니다.
- 자동 수집이 꺼져 있어도 수동 수집은 유지합니다. 데모는 격리된 데이터만
  사용하며 원본 이력을 읽지 않습니다.

### 앱 업데이트 안내

CLI, 데스크톱 앱 버전과 구분한 앱 자체의 업데이트 카드를 설정에 추가합니다.
GET은 캐시 상태만 반환하고 명시적인 확인 요청이 공개 GitHub 릴리스를 읽습니다.

- 저장소는 `whchoi98/agent-ops`로 고정합니다.
- 요청 하나, 전체 8초, 응답 256 KiB, 확인 간격 최소 60초로 제한하며
  필요한 메타데이터만 메모리에 보관합니다.
- 인증 정보, 현재 버전을 담은 쿼리, 대화와 설정은 보내지 않습니다.
  리다이렉트, 잘못된 응답, 초안과 사전 릴리스는 거부합니다.
- 검증한 SemVer를 비교하고 미확인, 최신, 업데이트 가능, 공개 릴리스보다
  앞선 버전, 조회 불가 상태를 시각과 출처와 함께 표시합니다.
- 릴리스 페이지와 설치 파일을 고정 저장소, 태그,
  `agent-ops-local-<version>.tgz` 이름과 대조합니다. 설치 파일이 없거나
  잘못되면 npm 명령을 제공하지 않습니다.
- npm과 Git 업데이트 명령 복사 및 릴리스 페이지를 제공합니다. 앱 종료 후
  서버 터미널에서 기존 시작 설정을 유지해 실행하도록 안내합니다.
  이 기능이 설치나 재시작을 직접 실행하지 않습니다.
- 데모는 네트워크를 사용하거나 존재하지 않는 설치 파일을 제공하지 않으며
  종료 시 진행 중인 요청을 중단합니다.

### 자원과 검증 기준

의존성, 원본 이력 수정, 모델 추론, 외부 텔레메트리는 추가하지 않습니다.
기존 격리 작업 사본과 최대 두 테스트 작업자를 사용합니다.
README와 CHANGELOG의 이중 언어 구조, 짧은 설치 선택 문구, 쉼표와 일반
대시 표기를 유지합니다.

credit의 소수, 0, 미기록, 부분 기록, 중복 스냅샷, 원본 접근 경계, 선택적
보충 수집, 메타데이터만 변경하는 쓰기, 정렬, 집계와 내보내기를 검증합니다.
일정, 유휴 대기, 반복 중단, 시간 초과, 자식 프로세스 정리, 접근 검사와
가벼운 진행 이벤트를 확인합니다. 업데이트 메타데이터, 요청 병합, 시간과
크기 제한, 데모와 명령 복사를 검증합니다. 전체 단위 테스트, 타입 검사,
빌드, 관련 브라우저 테스트, 격리된 설치 파일 검증을 실행합니다.
승인된 서비스 갱신 후 실제 동작을 확인하고, 기존 GitHub 전달 요청에 따라
버전, 변경 이력, 태그, 릴리스 노트와 설치 파일을 맞춰 공개합니다.
