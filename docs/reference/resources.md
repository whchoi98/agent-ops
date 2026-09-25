# Application resources

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

Open **Analytics and management → Resources** to inspect the current app server,
owned import worker, assistant jobs, and MCP probe processes. These are operating
system measurements, separate from recorded tokens, credits, or billing.

### Measurements and scope

| Measurement | Meaning |
|---|---|
| Server CPU | Difference in Node user/system CPU microseconds divided by monotonic elapsed time; one logical CPU is 100% |
| Owned process CPU | Difference in cumulative process CPU time on Linux/macOS; OS counter precision can make short intervals coarse |
| Resident memory | RSS bytes, summed once per selected process; shared pages can appear in more than one process |
| Heap | Node heap used/total bytes; not the entire process RSS |
| Logical data size | Regular files in the configured app data directory, counting hardlinked files once |
| Allocated file space | File allocation blocks where available; excludes directory metadata and is not deduplicated physical usage of shared filesystem extents |
| Available space | Space available on the filesystem containing the app data directory; not the app's own usage |

CPU can exceed 100% when several threads/cores are active. A first CPU sample,
counter reset, inaccessible process, unsupported platform, or failed probe
remains unknown. A scope with no owned jobs has a measured count of zero.
Short jobs can start and finish between samples. The source scope is the Node
server, tracked import worker, tracked run groups, and tracked MCP probe processes;
this is not a machine-wide process inventory or a billing/accounting meter.
HTTP MCP checks run inside the server process.

Only fixed numeric/time columns from `/bin/ps` are read, without a shell.
Command lines, arguments, and unrelated process metadata are not returned.
The sampler follows tracked descendants and owned run groups, keeps process
start identity to detect PID reuse, and does not signal application jobs.
The process probe has a 2-second timeout, 1 MiB output limit, and 512-owned-process
limit. Unsupported child metrics do not suppress the Node server's own readings.

Disk categories are `database`, `wal` (including SHM), `backups`, and `other`.
Installation dependencies and original assistant history directories are outside
this explicitly labeled data-directory total. Symlink entries are skipped;
hardlinks are deduplicated. Sparse/compressed/shared-extent files can differ
from logical file sizes. An incomplete scan is a partial observed sum, not proof
of total size. Missing or unreadable roots remain unknown.

### Collection cost and lifecycle

- CPU/memory: every 5 seconds, at most 180 in-memory samples (15 minutes).
- Disk: every 60 seconds, file metadata only; no transcript contents or SQL.
- Disk traversal: 10,000 entries, depth 12, and a 2-second time budget checked
  between operations; individual filesystem latency is not a hard real-time guarantee.
- At most one process sample and one disk scan are in flight. Slow disk work
  does not hold up CPU sampling or reads of the cached report.
- `GET /api/resources` returns cached observations and never initiates a scan,
  process query, database query, or global archive/SSE refresh.
- Browser polling stops when hidden, unmounted, or paused. Manual refresh while
  paused fetches one cached report; it does not restart automatic polling.
- Shutdown stops timers and aborts the owned process probe. Samples disappear
  on restart; no monitoring table, logfile, or telemetry service is added.

The page includes last measurement times, unknown/stale/partial states, interactive
CPU/RSS sample selectors, allocation breakdown, a notice below 10% filesystem
availability, and collection elapsed times. Collection duration includes waiting
for metadata and must not be read as CPU time.

### API and implementation

The no-query `GET /api/resources` response is `ResourceReport` from
`shared/resources.ts`. Existing loopback, Host, Origin and proxy rules apply.
There is no path/PID selector or process-control API.

| Component | Source |
|---|---|
| Collector and bounded history | `server/resources/monitor.ts` |
| Owned-process counters | `server/resources/processes.ts`, `server/runner.ts`, `server/background-sync.ts` |
| File metadata and filesystem space | `server/resources/disk.ts` |
| Cached route/lifecycle | `server/app.ts` |
| Visible-only polling and view | `src/hooks/useResources.ts`, `src/pages/Resources.tsx` |
| Interactive trends and units | `src/features/resources/` |

Run the optional benchmark from a source checkout:

```bash
node --expose-gc --import tsx scripts/benchmark-resources.ts
# Also read the existing app directory's metadata, without opening SQLite.
node --expose-gc --import tsx scripts/benchmark-resources.ts \
  --data-dir "$HOME/.local/share/agent-ops"
```

All benchmark writes and CPU work use temporary synthetic fixtures. Sampling
timings are a burst microbenchmark; API timings use Fastify injection and exclude
network/proxy latency. Heap deltas include runtime noise. See
[verification](../verification.md) for actual measurements and coverage.

### Further capabilities and their costs

| Capability | Current state and resource impact |
|---|---|
| Resource trends, storage categories, low-space notice | Implemented with bounded memory and cached metadata |
| MCP discovery and explicit metadata checks | Separate menu; cached declarations and user-triggered, bounded probes |
| macOS desktop app inventory | Fixed bundle candidates and cached plist metadata; see [desktop apps](desktop-apps.md) |
| Kiro credit usage | CLI `metering_usage` source confirmed; UI/import work remains and needs deduplication and a distinct credit field |
| Import schedules or budgets | Candidate improvement using the existing owned sync controller |
| Retention/backup cleanup | Candidate improvement requiring a concrete preview and verified recovery; no automatic deletion here |

## 한국어

**분석 및 관리 → 자원**에서 앱 서버, 앱이 실행한 동기화 작업, 에이전트 작업,
MCP 점검 프로세스를 확인합니다. 운영체제에서 측정한 값이며 기록된 토큰,
credit, 청구 사용량과는 별개입니다.

### 측정값과 범위

| 측정값 | 의미 |
|---|---|
| 서버 CPU | Node 사용자·시스템 CPU 마이크로초의 차이를 단조 증가 경과 시간으로 나눈 값이며 논리 CPU 하나가 100% |
| 소유 프로세스 CPU | Linux/macOS 누적 CPU 시간의 차이이며 운영체제 카운터 정밀도에 따라 짧은 구간은 거칠게 표시될 수 있음 |
| 상주 메모리 | 선택한 프로세스별 RSS 바이트를 한 번씩 합산하며 공유 페이지는 여러 프로세스에 포함될 수 있음 |
| 힙 | Node 힙의 사용·전체 크기이며 전체 RSS와는 다름 |
| 데이터 파일 크기 | 설정한 앱 데이터 디렉터리의 일반 파일 크기이며 하드링크 중복 제외 |
| 파일 할당량 | 지원되는 파일 할당 블록 기준이며 폴더 메타데이터와 파일시스템 공유 영역의 물리 중복 제거는 반영하지 않음 |
| 여유 공간 | 데이터 디렉터리가 있는 파일시스템의 사용 가능 공간이며 앱 자체의 사용량이 아님 |

여러 스레드·코어를 사용하면 CPU가 100%를 넘을 수 있습니다. 첫 CPU 표본,
카운터 초기화, 프로세스 접근 실패, 미지원 운영체제, 점검 실패는 미확인으로
표시합니다. 소유 작업이 없는 범위의 프로세스 수는 0입니다. 짧은 작업은 표본
사이에 시작하고 종료될 수 있습니다. Node 서버, 추적 중인 수집 작업·실행
그룹·MCP 점검 프로세스가 대상이며 전체 기기의 프로세스 목록이나 청구용
계측기는 아닙니다. HTTP MCP 점검은 서버 프로세스에 포함됩니다.

셸 없이 `/bin/ps`의 정해진 숫자·시간 열만 읽습니다. 명령줄, 인수, 관련 없는
프로세스 정보는 반환하지 않습니다. 추적 중인 자손과 실행 그룹을 확인하고
프로세스 시작 식별자로 PID 재사용을 구분하며 앱 작업에 신호를 보내지
않습니다. 프로세스 조회는 2초, 출력 1 MiB, 소유 프로세스 512개로 제한합니다.
자식 프로세스 측정을 지원하지 않아도 Node 서버 자체의 값은 유지합니다.

디스크는 `database`, `wal`(SHM 포함), `backups`, `other`로 나눕니다.
설치 의존성과 원본 코딩 도구의 기록 디렉터리는 이 데이터 합계에서 제외합니다.
심볼릭 링크는 건너뛰고 하드링크는 중복 계산하지 않습니다. 희소·압축 파일과
공유 영역을 사용하는 파일은 논리 크기와 할당량이 다를 수 있습니다.
불완전한 스캔은 확인한 부분의 합계이며 전체 크기를 입증하지 않습니다.
경로가 없거나 읽을 수 없으면 미확인으로 표시합니다.

### 수집 비용과 수명

- CPU·메모리는 5초마다 수집하고 최대 180개, 최근 15분을 메모리에 보관합니다.
- 디스크는 60초마다 메타데이터만 확인하며 대화 내용이나 SQL을 읽지 않습니다.
- 디스크 탐색은 10,000개 항목, 깊이 12, 작업 사이에서 확인하는 2초 시간
  한도를 적용합니다. 개별 파일시스템 지연까지 실시간으로 보장하는 한도는 아닙니다.
- 프로세스 표본과 디스크 스캔을 각각 하나만 실행합니다. 느린 디스크 작업이
  CPU 수집이나 보관된 보고서 조회를 막지 않습니다.
- `GET /api/resources`는 보관된 값만 반환하며 스캔, 프로세스·DB 조회,
  전체 이력·SSE 갱신을 시작하지 않습니다.
- 화면이 숨겨지거나 닫히거나 일시정지하면 브라우저 조회를 멈춥니다.
  일시정지 중 새로고침은 보관된 보고서 한 번만 가져오며 자동 조회를 재개하지 않습니다.
- 종료 시 타이머와 수집기 소유 보조 프로세스를 정리합니다. 재시작하면 표본이
  사라지며 모니터링 테이블·로그·외부 전송 서비스를 추가하지 않습니다.

화면에는 마지막 측정 시각, 미확인·오래된 값·부분 집계, CPU·RSS 표본 선택,
파일 할당량 구분, 파일시스템 여유 공간 10% 미만 안내, 수집 경과 시간을
표시합니다. 수집 시간에는 메타데이터 대기가 포함되며 CPU 사용 시간이 아닙니다.

### API와 구현

쿼리 없는 `GET /api/resources`는 `shared/resources.ts`의 `ResourceReport`를
반환합니다. 기존 루프백·Host·Origin·프록시 규칙을 적용하며 경로·PID 선택이나
프로세스 제어 API는 제공하지 않습니다.

| 구성 요소 | 소스 |
|---|---|
| 수집기와 보관 상한 | `server/resources/monitor.ts` |
| 소유 프로세스 카운터 | `server/resources/processes.ts`, `server/runner.ts`, `server/background-sync.ts` |
| 파일 메타데이터와 여유 공간 | `server/resources/disk.ts` |
| 캐시 응답과 수명 관리 | `server/app.ts` |
| 보이는 화면의 조회와 표시 | `src/hooks/useResources.ts`, `src/pages/Resources.tsx` |
| 표본 선택과 단위 | `src/features/resources/` |

소스 체크아웃에서 선택적으로 벤치마크를 실행합니다.

```bash
node --expose-gc --import tsx scripts/benchmark-resources.ts
# SQLite를 열지 않고 기존 앱 디렉터리의 메타데이터도 확인합니다.
node --expose-gc --import tsx scripts/benchmark-resources.ts \
  --data-dir "$HOME/.local/share/agent-ops"
```

벤치마크의 쓰기와 CPU 작업은 임시 합성 데이터를 사용합니다. 수집 시간은
연속 호출한 마이크로벤치마크이며 API 시간은 Fastify 내부 요청 기준으로
네트워크·프록시 지연을 제외합니다. 힙 차이에는 런타임 변동도 포함됩니다.
실측값과 검증 범위는 [검증 기록](../verification.md)을 참고하세요.

### 후속 기능과 비용

| 기능 | 현재 상태와 자원 영향 |
|---|---|
| 자원 추이·저장 공간 구분·용량 부족 안내 | 메모리 보관량과 메타데이터 캐시를 제한해 구현 |
| MCP 탐색과 명시적 메타데이터 점검 | 별도 메뉴에서 선언을 캐시하고 사용자가 선택할 때 제한된 점검 실행 |
| macOS 데스크톱 앱 정보 | 고정 번들 후보와 plist 캐시 사용; [앱 정보](desktop-apps.md) 참고 |
| Kiro credit 사용량 | CLI `metering_usage` 출처 확인 완료; 중복 제거와 별도 credit 필드를 포함한 수집·화면 작업은 후속 대상 |
| 수집 일정과 예산 | 기존 소유 수집 제어기를 활용할 수 있는 개선 후보 |
| 보관 정책·백업 정리 | 대상 미리보기와 검증된 복구가 필요한 개선 후보이며 자동 삭제는 적용하지 않음 |
