# Recorded usage, import controls and app updates

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

Version 1.3.0 adds recorded Kiro credits, controls for app-managed history imports
and a separate workbench update guide. Native histories stay read-only; these
features do not add model inference, telemetry or automatic installers.

### Read recorded Kiro usage

Open a Kiro session to see recorded credits in its primary usage summary, with
token details retained separately. Analytics includes credit totals and coverage
by assistant, model and project. Session comparisons, credit sorting and
JSON/Markdown/HTML exports carry the same measurement.

| Value | Interpretation |
|---|---|
| Finite nonnegative number, including `0` | Recorded credit usage; decimal values are retained |
| Missing `Usage.credits` or `null` | Unrecorded or unknown, never an inferred zero |
| `Usage.creditsPartial: true` | The available record is incomplete; read it with the credit value and diagnostics |
| Aggregate coverage | `knownCreditSessions` out of `kiroSessions`, with `partialCreditSessions` among the recorded sessions |

Credits are independent of tokens, context percentages and USD. They are not an
invoice or a live account balance. Read `recordedCredits` together with coverage:
an aggregate zero with no recorded sessions does not establish zero consumption.
Daily analytics group the session's recorded total by its **session start date
in UTC**, not the time of each turn or charge.

The current plain Kiro run-output reader does not extract credits. Those runs
remain unrecorded; a resumed session's cumulative credits are never assigned to
one run.

The importer reads
`session_state.conversation_metadata.user_turn_metadatas[].metering_usage[]`.
It sums finite nonnegative numeric `value` entries whose `unit` is `credit` or
`credits`. Equal-valued entries within one array remain separate records.

Repeated turn snapshots replace earlier observations. Growing message-ID lists
and later loop IDs are reconciled without counting the turn again. Freshness
uses a validated envelope `updated_at` or `updatedAt`, then the turn's end time.
Unidentified, ambiguous, unsupported or malformed records stay unknown or partial
and retain diagnostics. Each parsed session's ledger is capped at **20,000 turns** and
**40,000 message identity aliases**; exceeding a bound makes credits unknown.
Numeric overflow also remains unknown.

The one-time backfill changes only Kiro's parser fingerprint to
`format-v4-kiro-credits`. Other providers keep `format-v3`. Schema **4** and the
existing session JSON remain in use, without a persistent per-turn ledger.
Usage-only updates skip inflation and reconstruction of existing search content;
transcripts and user titles, notes, tags and bookmarks remain intact.

### Choose and stop imports

In **Settings → Execution and synchronization**, select **Automatic sync mode**, adjust
the interval and **Sync time budget**, then save the settings.

| Setting | Values | Default |
|---|---|---|
| `syncMode` | `interval`, `idle`, `manual` | `interval` |
| `scanIntervalSeconds` | Integer, 15-3,600 seconds | `60` |
| `syncMaxSeconds` | Integer, 30-1,800 seconds | `1800` |

`interval` starts automatic work at startup and after each completion interval.
`idle` uses that schedule but defers while this workbench has queued or running
CLI jobs, checking again after at most **15 seconds**. It does not inspect
unrelated OS jobs or claim the whole computer is idle. `manual` has no automatic
start. **Sync now** works in every mode, bypasses idle gating and shares an
already-running import instead of starting a second one.

The **Import controls** card shows activity, automatic state, next check, trigger,
elapsed time, the current attempt's budget and the last outcome.

1. Choose **Sync now** to start an app-managed import.
2. Choose **Stop current sync** to interrupt that owned worker. Repeated stop
   requests are harmless.
3. Wait for cleanup to finish, then choose **Sync now** again when ready.

Cancellation, time-budget expiry and failure remain separate outcomes
(`cancelled`, `timed-out`, `failed`); success is `completed`. Already committed
sessions survive interruption. An incomplete attempt does not invent a complete
import count. The previous persisted import report may therefore be older than
the latest attempt status.

Only one managed import runs at a time. Budget expiry initiates owned-process
termination with bounded SIGTERM/SIGKILL and pipe cleanup. Editing the settings
does not change an active attempt's starting budget. The next automatic interval
starts after termination, using the current policy. Server shutdown permanently
closes the controller; an ordinary stop leaves it reusable.

Settings use the existing JSON storage. Scheduling and the current/last attempt
are held in bounded RAM and reset on server restart. While active, lightweight
`sync-state` SSE updates use a **2-second** cadence without a full report payload.
The archive refreshes once at termination, not on every progress update.

These controls and budgets apply to imports owned by the running app. They do
not control independently launched `agent-ops sync` commands. Demo import controls
are disabled; legacy demo sync requests return harmless no-op responses without
starting a native-history driver.

### Check and update the workbench

Open **Settings → my-agent-ops updates**. Its running app version is separate
from coding CLI and desktop app versions.

1. Read the cached status, or choose **Check app release** for an explicit check.
2. Review the latest version, release page, source and check/publication times.
3. If a newer release offers commands, wait for jobs and imports to finish, then
   stop the app in its **server terminal** with `Ctrl+C`, or stop its managed service.
4. Copy the commands for your installation method and run them on that server.
   For Git, save local changes and use the existing my-agent-ops source checkout.
5. Restart with your previous data directory, environment variables and startup
   options, including `--data-dir`, `--port` and `--public-url`, then reload the browser.

The checker uses only
`https://api.github.com/repos/whchoi98/agent-ops/releases/latest`.
It sends no credentials, current-version query, conversations or configuration.
Construction, cache reads and demo mode make no external request.

| Limit or state | Behavior |
|---|---|
| Request ownership | One request in flight; concurrent checks share it |
| Total deadline | 8 seconds for headers, body and validation |
| Response size | At most 256 KiB |
| Cooldown | At least 60 seconds between attempts, including failures |
| Cache | Bounded release metadata in RAM; cleared on restart |
| Shutdown | Aborts the owned request |
| Status | `not-checked`, `current`, `update-available`, `ahead`, `unavailable`, `demo` |

Redirects, draft/prerelease releases and malformed metadata are rejected.
Stable SemVer, the release page, tag and archive URL must match
`whchoi98/agent-ops` and the exact `agent-ops-local-<version>.tgz` name.
A valid release without a validated archive can still show its release page and
Git instructions, but offers no npm install command.

Commands are offered only for a validated newer release. npm uses the exact
validated archive URL. Git fetches that release tag from the fixed repository,
then uses `git merge --ff-only FETCH_HEAD`, `npm ci` and `npm run build`, joined
with `&&` so a failed step stops the chain. Neither command restarts the app.
A newer local source build may report `ahead`; the guide does not offer a downgrade.
Demo mode supplies no installation commands. The UI only copies text and never
executes an install or restart.

### API and code pointers

All routes retain the existing Host, Origin, local-peer and proxy checks.
Mutations require `X-Agent-Ops: 1`. See the [API contract](../api.md) for response
shapes and the [operations guide](../operations.md) for backup and service procedures.

| Purpose | Route or source |
|---|---|
| Cached import status | `GET /api/sync/status`, `Bootstrap.syncStatus` |
| Start or await an import | `POST /api/sync/start`, `POST /api/sync` |
| Stop the owned import | `POST /api/sync/cancel` |
| Cached app update / explicit check | `GET /api/app-update`, `POST /api/app-update/check` |
| Credit source and summaries | `server/providers/kiro-credits.ts`, `server/providers/kiro.ts`, `shared/credits.ts`, `server/analytics.ts` |
| Import lifecycle | `server/sync-manager.ts`, `server/background-sync.ts`, `shared/sync-control.ts` |
| Release validation and UI | `server/app-update.ts`, `server/app-update/`, `shared/app-update.ts`, `src/features/app-update/` |

For installation commands, read [the README](../../README.md#installation).
For OS measurements independent of recorded usage, read [resources](resources.md).

## 한국어

1.3.0은 기록된 Kiro credit, 앱이 관리하는 이력 수집 제어와 별도의 앱 업데이트
안내를 추가합니다. 원본 이력은 읽기 전용으로 유지하며 모델 추론, 텔레메트리,
자동 설치 기능은 추가하지 않습니다.

### 기록된 Kiro 사용량 읽기

Kiro 세션을 열면 주요 사용량 요약에 기록된 credit을 표시하고 토큰 상세도
별도로 유지합니다. 분석 화면에는 에이전트, 모델, 프로젝트별 credit 합계와
기록 범위가 있습니다. 세션 비교, credit 정렬과 JSON/Markdown/HTML 내보내기도
같은 측정값을 사용합니다.

| 값 | 해석 |
|---|---|
| `0`을 포함한 유한한 비음수 | 기록된 credit 사용량이며 소수를 유지 |
| `Usage.credits` 필드 없음 또는 `null` | 미기록 또는 미확인, 0으로 추정하지 않음 |
| `Usage.creditsPartial: true` | 기록이 불완전하므로 credit 값과 진단을 함께 확인 |
| 합계의 기록 범위 | `kiroSessions` 중 `knownCreditSessions`, 기록된 세션 중 `partialCreditSessions` |

credit은 토큰, 컨텍스트 비율, USD와 별개이며 청구서나 실시간 계정 잔액이
아닙니다. `recordedCredits`는 기록 범위와 함께 읽습니다. 기록된 세션이 없을 때
합계가 0이어도 실제 소비가 0이라는 뜻은 아닙니다. 날짜별 분석은 각 turn이나
청구 시각 대신 **UTC 세션 시작일**에 해당 세션의 기록된 합계를 묶습니다.

현재 일반 Kiro 실행 출력에서는 credit을 추출하지 않아 실행별 사용량은
미기록으로 남깁니다. 재개한 세션의 누적 credit을 실행 한 번에 배정하지 않습니다.

수집기는
`session_state.conversation_metadata.user_turn_metadatas[].metering_usage[]`를
읽습니다. `unit`이 `credit` 또는 `credits`인 항목에서 유한한 0 이상 숫자형
`value`를 합산합니다. 배열 안에서 값이 같은 항목도 각각의 기록으로 유지합니다.

같은 turn의 반복 스냅샷은 앞선 기록을 교체합니다. 메시지 ID 목록이 늘거나
나중에 loop ID가 생겨도 같은 turn을 중복 계산하지 않습니다. 최신 기록은 검증한
envelope의 `updated_at` 또는 `updatedAt`, 그다음 turn 종료 시각으로 판단합니다.
식별자가 없거나 모호한 기록, 미지원 형식과 잘못된 값은 미확인 또는 부분 기록으로
남기고 진단을 유지합니다. 파싱하는 세션별 집계는 **turn 20,000개**, **메시지 식별자 별칭
40,000개**까지 보관하며 한도를 넘으면 credit을 미확인으로 처리합니다.
숫자 합산 범위를 넘는 값도 미확인으로 남깁니다.

한 번의 보충 수집에는 Kiro 파서 지문만 `format-v4-kiro-credits`로 바꾸고 다른
제공자는 `format-v3`를 유지합니다. 스키마 **4**와 기존 세션 JSON을 사용하며
turn별 집계를 영구 저장하지 않습니다. 사용량만 바뀌면 기존 검색 본문의 압축
해제와 재구축을 건너뜁니다. 대화 원문, 사용자 제목, 메모, 태그와 북마크는 유지합니다.

### 수집 방식 선택과 중단

**설정 → 실행 및 동기화**에서 **자동 동기화 방식**, 수집 간격과 **동기화 시간
제한**을 정한 뒤 저장합니다.

| 설정 | 값 | 기본값 |
|---|---|---|
| `syncMode` | `interval`, `idle`, `manual` | `interval` |
| `scanIntervalSeconds` | 정수, 15-3,600초 | `60` |
| `syncMaxSeconds` | 정수, 30-1,800초 | `1800` |

`interval`은 시작 시와 수집 완료 후 설정한 간격마다 자동으로 실행합니다.
`idle`은 같은 일정을 사용하되 앱의 CLI 작업이 대기 또는 실행 중이면 수집을
미루고 최대 **15초** 뒤 다시 확인합니다. 관련 없는 OS 작업을 조사하거나 기기
전체가 유휴 상태라고 판단하지 않습니다. `manual`은 자동으로 시작하지 않습니다.
**지금 동기화**는 모든 모드에서 유휴 조건을 건너뛰며 이미 수집 중이면 같은
작업을 공유합니다.

**수집 제어** 카드에는 현재 상태, 자동 수집 상태, 다음 확인 시각, 시작 방식,
경과 시간, 현재 작업의 시간 제한과 마지막 결과가 표시됩니다.

1. **지금 동기화**로 앱이 관리하는 수집을 시작합니다.
2. **현재 동기화 중단**으로 해당 소유 작업을 멈춥니다. 중단을 반복 요청해도
   문제가 없습니다.
3. 종료 정리가 끝나면 필요할 때 **지금 동기화**로 다시 시작합니다.

취소, 시간 초과, 실패는 각각 `cancelled`, `timed-out`, `failed`로 구분하며
성공은 `completed`입니다. 중단 전에 저장한 세션은 유지합니다. 불완전한 수집의
전체 건수를 추정하지 않으므로 기존에 저장된 수집 보고서는 마지막 시도 상태보다
오래된 값일 수 있습니다.

앱이 관리하는 수집은 한 번에 하나만 실행합니다. 시간 제한이 지나면 소유
프로세스에 SIGTERM/SIGKILL을 단계적으로 보내고 파이프를 제한된 시간 안에
정리합니다. 설정을 바꿔도 진행 중인 작업은 시작할 때 정한 시간 제한을 유지합니다. 작업이
종료되면 현재 정책으로 다음 자동 수집 간격을 계산합니다. 서버 종료는 제어기를
영구 종료하지만 일반 중단 후에는 다시 수집할 수 있습니다.

설정은 기존 JSON 저장소를 사용합니다. 일정과 현재 시도, 마지막 시도는 보관량을
제한한 RAM에 두며 서버를 다시 시작하면 초기화합니다. 진행 중에는 전체 보고서
없이 작은 `sync-state` SSE 상태를 **2초** 간격으로 보냅니다. 매 진행 알림이
아닌 수집 종료 시 한 번만 이력을 새로고침합니다.

이 제어와 시간 제한은 실행 중인 앱이 소유한 수집에만 적용합니다. 별도로 시작한
`agent-ops sync` 명령은 제어하지 않습니다. 데모에서는 수집 제어를 비활성화하며
기존 동기화 API 요청은 원본 이력 드라이버를 시작하지 않고 무해한 응답만 반환합니다.

### 앱 자체의 버전 확인과 업데이트

**설정 → my-agent-ops 업데이트**를 엽니다. 현재 실행 중인 앱의 버전이며 코딩
CLI나 데스크톱 앱 버전과 구분합니다.

1. 캐시된 상태를 읽거나 **앱 최신 릴리스 확인**으로 직접 조회합니다.
2. 최신 버전, 릴리스 페이지, 출처와 확인 시각, 게시 시각을 확인합니다.
3. 새 릴리스에 명령이 표시되면 작업과 수집이 끝날 때까지 기다린 뒤 **서버
   터미널**에서 `Ctrl+C`로 앱을 멈추거나 앱을 관리하는 서비스를 중지합니다.
4. 설치 방식에 맞는 명령을 복사해 해당 서버에서 실행합니다. Git 설치는 로컬
   변경을 저장한 뒤 기존 my-agent-ops 소스 체크아웃에서 실행합니다.
5. 기존 데이터 디렉터리, 환경 변수와 `--data-dir`, `--port`, `--public-url`을
   포함한 시작 옵션으로 다시 실행하고 브라우저를 새로고침합니다.

조회 주소는
`https://api.github.com/repos/whchoi98/agent-ops/releases/latest`로 고정합니다.
인증 정보, 현재 버전을 담은 쿼리, 대화와 설정은 보내지 않습니다. 서비스 생성,
캐시 읽기와 데모 모드에서는 외부 요청을 만들지 않습니다.

| 한도 또는 상태 | 동작 |
|---|---|
| 요청 소유권 | 한 번에 요청 하나, 동시에 들어온 확인은 같은 요청을 공유 |
| 전체 시간 제한 | 헤더, 본문과 검증을 합쳐 8초 |
| 응답 크기 | 최대 256 KiB |
| 재확인 간격 | 실패를 포함한 시도 사이 최소 60초 |
| 캐시 | 필요한 릴리스 메타데이터만 RAM에 보관하고 재시작 시 초기화 |
| 종료 | 소유 요청 중단 |
| 상태 | `not-checked`, `current`, `update-available`, `ahead`, `unavailable`, `demo` |

리다이렉트, 초안, 사전 릴리스와 잘못된 메타데이터는 거부합니다. 안정 SemVer,
릴리스 페이지, 태그와 설치 파일 URL을 `whchoi98/agent-ops` 및 정확한
`agent-ops-local-<version>.tgz` 이름과 대조합니다. 릴리스가 유효해도 설치 파일을
검증하지 못하면 릴리스 페이지와 Git 안내만 표시하고 npm 명령은 제공하지 않습니다.

검증된 새 릴리스에만 명령을 표시합니다. npm은 검증한 설치 파일의 정확한 URL을
사용합니다. Git은 고정 저장소의 해당 태그를 가져온 뒤
`git merge --ff-only FETCH_HEAD`, `npm ci`, `npm run build`를 실행하며 각 단계를
`&&`로 연결해 실패하면 다음 단계로 넘어가지 않습니다. 두 방식 모두 앱을
재시작하지 않습니다. 더 앞선 로컬 소스는 `ahead`로 표시할 수 있으며 다운그레이드를
안내하지 않습니다. 데모에는 설치 명령이 없고 화면은 텍스트 복사만 지원하며
설치나 재시작을 실행하지 않습니다.

### API와 코드 위치

모든 경로에 기존 Host, Origin, 로컬 연결과 프록시 검사를 적용합니다.
변경 요청에는 `X-Agent-Ops: 1`이 필요합니다. 응답 형식은 [API 계약](../api.md),
백업과 서비스 관리 절차는 [운영 가이드](../operations.md)를 참고하세요.

| 용도 | 경로 또는 소스 |
|---|---|
| 캐시된 수집 상태 | `GET /api/sync/status`, `Bootstrap.syncStatus` |
| 수집 시작 또는 완료 대기 | `POST /api/sync/start`, `POST /api/sync` |
| 소유 수집 중단 | `POST /api/sync/cancel` |
| 캐시된 앱 업데이트 / 명시적 확인 | `GET /api/app-update`, `POST /api/app-update/check` |
| credit 출처와 요약 | `server/providers/kiro-credits.ts`, `server/providers/kiro.ts`, `shared/credits.ts`, `server/analytics.ts` |
| 수집 수명 관리 | `server/sync-manager.ts`, `server/background-sync.ts`, `shared/sync-control.ts` |
| 릴리스 검증과 화면 | `server/app-update.ts`, `server/app-update/`, `shared/app-update.ts`, `src/features/app-update/` |

설치 명령은 [README](../../README.md#설치-방법), 기록된 사용량과 별개인 OS
측정값은 [자원](resources.md#한국어)을 참고하세요.
