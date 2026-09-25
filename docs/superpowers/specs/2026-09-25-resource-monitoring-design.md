# Application resource monitoring

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

### Objective

Add an operating view of the resources used by my-agent-ops and evaluate useful
follow-up features with their resource costs. Measure the app server, its owned
import worker, and its owned CLI jobs separately. Keep monitoring inexpensive
and preserve the existing history, execution, privacy, and proxy boundaries.

### Decisions

Use a small in-process collector and a dedicated read-only API. External
monitoring services would add deployment and account requirements; storing every
sample in SQLite would grow the cache the user is trying to control. Retain a
bounded recent window in memory instead.

- Sample CPU and memory every 5 seconds; retain at most 180 samples (15 minutes).
- Read CPU deltas from `process.cpuUsage()` and monotonic elapsed time. Define
  100% as one logical CPU, so multithreaded consumption can exceed 100%.
- Report server RSS and heap bytes. Read owned worker/job process trees on
  Linux/macOS with one bounded `/bin/ps` invocation only while owned roots exist.
  Use cumulative CPU time differences, not lifetime-average `%CPU`. Keep PID
  start identity in the baseline; report missing measurements as unknown.
- Keep server, import worker, and agent-job scopes separate. Sum each process
  once; describe RSS sums as per-process resident memory, not unique physical RAM.
  Preserve ownership of detached run groups after their leader exits.
- Report the app data directory's logical file sizes, allocated bytes when
  supported, database/WAL/backups/other breakdown, and available filesystem space.
  Installation dependencies and original assistant history are outside this
  explicitly labeled runtime-data total.
- Refresh disk metadata every 60 seconds. Do not read file contents or SQLite
  rows. Skip symlinks/special files, deduplicate hardlinks, and bound traversal
  to 10,000 entries, depth 12, and a 2-second between-operation time budget.
  Keep at most one disk scan in flight; a slow filesystem must not block CPU
  sampling or API reads. Report partial/failed scans without substituting zero.
- Make `GET /api/resources` return the cached snapshot and bounded history.
  It must not trigger scans, SQL queries, process discovery, or global SSE refresh.
  Existing Host/Origin/proxy rules still apply; reject unexpected query fields.
- Stop timers and cancel owned sampler subprocesses during shutdown. Samples do
  not survive restart and introduce no persistent tables, logs, or telemetry.
- Add a Resources navigation entry, cards, separate CPU/memory trends, process
  scope table, storage breakdown, timestamps, collection cost, and partial/stale
  states. Pause browser polling while hidden, unmounted, or explicitly paused.
  Support Korean/English, light/dark mode, keyboard access, and mobile layouts.
- Report actual resources of the isolated demo server; do not simulate live
  measurements. Explain that the conversation data is the demo content.

### Additional feature assessment

The user additionally requested an MCP entry under Analytics and management.
Implement assistant-specific server discovery, redacted configuration analysis,
and explicit bounded connection checks. Configuration alone does not establish
an active assistant connection. Report the app's check result and timestamp;
never claim to observe another CLI's live connection without evidence.
Automatic refresh must not start MCP commands or network sessions. A user check
previews the configured target, then performs only MCP initialization and
metadata listing, never tool calls. Track owned probe processes as a separate
resource scope and preserve existing configuration files.

| Feature | Benefit | Cost and status |
|---|---|---|
| Resource trends and disk breakdown | Identify server/import/job pressure and backup growth | Implement now with bounded memory and metadata-only scans |
| Low filesystem-space notice | Warn before new imports or runs fail to write | Derive from the existing disk snapshot; no extra scanner |
| Per-assistant Kiro credit display | Show native recorded credits instead of misleading token counters | Confirmed local `metering_usage` source; follow-up needs deduplication and a separate usage field, not token conversion |
| Import scheduling and budgets | Avoid heavy imports during interactive work | Follow-up can reuse the owned sync controller; requires explicit scheduling semantics |
| Retention and backup cleanup | Control long-term storage growth | Follow-up must preview affected data and preserve verified backup/recovery; no automatic deletion in this change |

### Acceptance evidence

1. Test CPU units, reset/unknown handling, PID reuse, ownership filtering,
   descendants/groups, sampling failure, and fixed history bounds.
2. Test database/WAL/backup categories, hardlinks, symlinks, sparse allocation,
   unreadable/limited scans, and slow scans without API or sampling blockage.
3. Test route guards, caching, shutdown, demo behavior, and unchanged cache/native
   data; keep all test execution local with fake CLI jobs.
4. Inspect desktop/mobile and both languages in browser tests, including polling
   pause/resume, unknown values, stale errors, and trend/table correspondence.
5. Run the required application checks and relevant existing browser regression.
   Measure collector/API time and idle memory on synthetic and real app metadata;
   record actual results and limitations without billing or model inference.
6. Update README, API/operating/design/reference docs and Unreleased. Validate
   the packaged artifact. Verify the installed runtime after any authorized
   update; do not restart while user-owned work is active.

## 한국어

### 목표

my-agent-ops의 자원 사용을 확인하는 운영 화면을 추가하고, 후속 기능의
효용과 자원 비용을 검토합니다. 앱 서버, 앱이 실행한 수집 작업, CLI 작업을
나눠 측정합니다. 수집 부하를 제한하고 기존 기록·실행·개인정보·프록시
경계를 유지합니다.

### 설계

프로세스 내부의 작은 수집기와 전용 읽기 API를 사용합니다. 외부 모니터링
서비스는 배포와 계정 구성을 늘리고, 모든 표본을 SQLite에 저장하면 관리해야
할 캐시가 커집니다. 최근 표본만 개수를 제한해 메모리에 보관합니다.

- CPU와 메모리는 5초마다 수집하고 최대 180개, 최근 15분을 보관합니다.
- `process.cpuUsage()`의 차이와 단조 증가 시간을 사용합니다. 논리 CPU
  하나를 100%로 정의하므로 여러 스레드를 사용하면 100%를 넘을 수 있습니다.
- 서버 RSS와 힙 크기를 표시합니다. Linux/macOS의 소유 작업 트리는
  실행 중인 루트가 있을 때만 제한된 `/bin/ps` 호출 한 번으로 읽습니다.
  프로세스 수명 전체의 평균 `%CPU` 대신 누적 CPU 시간의 차이를 사용합니다.
  PID와 시작 식별자를 보관하고 측정값이 없으면 미확인으로 표시합니다.
- 서버, 수집 작업, 에이전트 작업을 구분하고 프로세스마다 한 번만 합산합니다.
  RSS 합계는 프로세스별 상주 메모리의 합이며 공유 페이지를 제거한 물리 RAM
  사용량으로 표현하지 않습니다. 실행 그룹은 리더 종료 뒤에도 소유 범위를
  유지합니다.
- 앱 데이터 디렉터리의 파일 크기 합계, 지원되는 경우 실제 할당량,
  DB·WAL·백업·기타 구분, 파일시스템 여유 공간을 제공합니다. 설치 의존성과
  원본 코딩 도구 기록은 화면에 명시한 런타임 데이터 합계에서 제외합니다.
- 디스크는 60초마다 메타데이터만 확인하고 파일 내용이나 SQLite 행을 읽지
  않습니다. 심볼릭 링크·특수 파일은 건너뛰고 하드링크는 중복 계산하지 않습니다.
  최대 10,000개 항목, 깊이 12, 메타데이터 작업 사이에서 확인하는 2초 시간
  한도를 적용합니다. 디스크 작업은 하나만 유지하며 느린 파일시스템이 CPU
  수집이나 API 조회를 막지 않게 합니다. 부분 집계·실패를 0으로 바꾸지 않습니다.
- `GET /api/resources`는 보관된 표본과 제한된 이력을 반환합니다. 조회할 때
  스캔, SQL, 프로세스 검색, 전체 SSE 갱신을 실행하지 않습니다. 기존
  Host·Origin·프록시 규칙을 적용하고 예상하지 않은 쿼리 필드는 거부합니다.
- 종료 시 타이머와 수집기 소유의 보조 프로세스를 정리합니다. 재시작하면
  표본은 사라지며 영구 테이블·로그·외부 전송은 추가하지 않습니다.
- 자원 메뉴, 카드, CPU·메모리 추이, 프로세스 범위 표, 저장 공간 구분,
  측정 시각·수집 비용·부분 집계·오래된 상태 표시를 추가합니다. 화면이
  숨겨지거나 닫혔거나 사용자가 일시정지하면 브라우저 조회를 멈춥니다.
  한영 전환, 라이트·다크 모드, 키보드 조작, 모바일 화면을 지원합니다.
- 데모도 격리된 데모 서버의 실제 자원을 측정합니다. 실시간 측정값을
  가상으로 만들지 않고 대화 내용이 샘플이라는 점을 설명합니다.

### 추가 기능 검토

사용자의 추가 요청에 따라 분석 및 관리에 MCP 메뉴도 구현합니다.
코딩 어시스턴트별 서버 탐색, 비밀 값을 가린 설정 분석, 사용자가 선택하는
제한된 연결 점검을 제공합니다. 설정만으로 실제 어시스턴트 연결을 판단하지
않으며 앱의 점검 결과와 시각을 표시합니다. 자동 갱신으로 MCP 명령이나
네트워크 세션을 시작하지 않습니다. 사용자가 대상을 미리 본 뒤 점검하면
MCP 초기화와 메타데이터 목록만 조회하고 도구는 호출하지 않습니다.
점검 프로세스는 자원 모니터링에서 별도 범위로 추적하며 기존 설정 파일을
보존합니다.

| 기능 | 효용 | 비용과 상태 |
|---|---|---|
| 자원 추이와 디스크 구분 | 서버·수집·실행 부하와 백업 증가 원인 확인 | 메모리 보관량과 메타데이터 스캔을 제한해 이번에 구현 |
| 파일시스템 여유 공간 안내 | 수집·실행의 쓰기 실패 전에 상태 확인 | 같은 디스크 표본에서 계산하며 추가 스캔 없음 |
| Kiro credit 표시 | 토큰 카운터 대신 기록된 credit 확인 | 로컬 `metering_usage` 출처 확인 완료; 후속 작업에서 중복 제거와 별도 사용량 필드가 필요하며 토큰 환산은 사용하지 않음 |
| 수집 일정과 예산 | 대화형 작업 중 무거운 수집 조절 | 기존 소유 수집 제어기를 재사용할 수 있으나 일정 의미를 별도로 정의해야 함 |
| 보관 정책과 백업 정리 | 장기적인 저장 공간 증가 관리 | 대상 미리보기와 검증된 백업·복구가 필요하며 이번 변경에는 자동 삭제 없음 |

### 완료 근거

1. CPU 단위, 초기·초기화 값, PID 재사용, 소유 범위, 자손·그룹, 수집 실패,
   고정된 보관 상한을 테스트합니다.
2. DB·WAL·백업 구분, 하드링크, 심볼릭 링크, 희소 파일 할당량, 읽기 실패,
   탐색 한도, 느린 스캔 중 API·표본 수집의 응답성을 테스트합니다.
3. 가짜 CLI를 사용해 경로 접근 검사, 캐시 응답, 종료, 데모, 캐시와 원본
   데이터 보존을 확인합니다.
4. 브라우저에서 데스크톱·모바일·두 언어를 확인하고 조회 정지·재개,
   미확인 값, 오래된 응답, 추이와 표의 일치 여부를 검증합니다.
5. 필수 앱 검사와 관련 기존 브라우저 회귀 검사를 실행합니다. 합성 데이터와
   실제 앱 메타데이터에서 수집·API 시간과 유휴 메모리를 측정하고 결과와
   한계를 기록합니다. 청구 조회나 모델 추론은 실행하지 않습니다.
6. README, API·운영·설계·참조 문서, Unreleased를 갱신하고 배포 패키지를
   검증합니다. 승인 범위의 설치 갱신 후 실제 동작을 확인하며, 사용자 작업이
   실행 중일 때는 재시작하지 않습니다.
