# ADR 0002: Background import and compressed search documents

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

Status: implemented. Recorded: 2026-09-25.

### Context

Large imports blocked HTTP work and repeatedly rewrote unchanged conversations.
The cache also held an uncompressed copy of searchable text. User annotations,
literal Korean/English search and existing histories needed to survive optimization.

### Decision

Run live import through an owned `agent-ops sync` subprocess. The UI uses
`POST /api/sync/start` for immediate acceptance and receives progress through
bootstrap/SSE; keep the waiting `/api/sync` contract available.

Persist file and Kiro-row checkpoints. Update changed message ordinals and
search documents; preserve newer persisted history against older competing
sources. Session, project, template and settings mutations retry short SQLite
lock conflicts asynchronously.

New caches use schema 4 with compressed UTF-8 search bodies and external-content
FTS5. Match results by stable session ID rather than implicit session rowids.
Keep canonical message JSON and user annotations in their existing tables.

Existing schema-3 caches convert only through offline `optimize`. Hold server
and sync locks, reject database-file aliases, create a consistent gzip backup
and verify its decoded bytes with SHA-256 before conversion. Commit the search
layout and version marker together, then reclaim pages with `VACUUM`. Check
stored B-trees directly and rebuild derived postings without an extra full
retokenization of the old FTS corpus.

### Consequences and evidence

Optimization needs temporary space and a service interruption. The backup also
uses disk space; active DB reduction does not imply lower total disk use while
the backup is retained. Old binaries that support only schema 3 need a restored
backup in a separate directory. No retention period or automatic history
deletion is introduced.

Code pointers: `server/background-sync.ts`, `server/sync.ts`,
`server/providers/kiro-sqlite.ts`, `server/store.ts`, `server/search-index.ts`,
`server/maintenance.ts`, `server/database-file.ts`, `server/write-retry.ts`,
`src/state/refreshQueue.ts`.

See [storage operations](../operations.md#저장-공간-최적화),
[the operations runbook](../runbooks/local-operations.md), and
[verification](../verification.md) for the measured results and regression cases.

<a id="korean"></a>
## 한국어

상태: 구현됨. 기록일: 2026-09-25.

### 배경

대규모 수집이 HTTP 처리를 막고 같은 대화를 반복 저장했으며, 캐시에는 검색용
본문의 비압축 사본도 들어 있었습니다. 최적화 중 사용자 메모와 기존 이력,
한글·영문 리터럴 검색을 보존해야 했습니다.

### 결정

라이브 수집은 앱이 소유한 `agent-ops sync` 자식 프로세스에서 실행합니다.
화면은 `POST /api/sync/start`로 접수 응답을 바로 받고 bootstrap·SSE로 진행
상태를 갱신합니다. 완료를 기다리는 기존 `/api/sync` 계약도 유지합니다.

파일과 Kiro 행별 지문을 저장하고 변경된 메시지 순번·검색 본문만 갱신합니다.
오래된 경쟁 소스가 저장된 최신 이력을 덮어쓰지 않도록 합니다. 세션·프로젝트·
템플릿·설정 변경은 짧은 SQLite 잠금 경합이 있으면 비동기로 재시도합니다.

새 캐시는 UTF-8 검색 본문을 압축한 스키마 4와 외부 본문 기반 FTS5를 사용합니다.
검색 결과는 암시적인 행 번호 대신 안정적인 세션 ID로 연결합니다. 원본 메시지
JSON과 사용자 메모·태그 등은 기존 테이블에 보존합니다.

기존 스키마 3은 오프라인 `optimize`로만 전환합니다. 서버·동기화 잠금을 획득하고
DB 연결 파일을 거절합니다. 일관된 gzip 백업을 만든 뒤 복원 스트림의 SHA-256을
검증하고 변환합니다. 검색 구조와 버전 표시는 같은 트랜잭션에 반영한 다음
`VACUUM`으로 공간을 회수합니다. 저장 B-tree를 직접 검사하고 기존 FTS 본문을
한 번 더 토큰화하지 않으면서 검색 색인을 재생성합니다.

### 영향과 근거

최적화에는 임시 공간과 서비스 중단이 필요합니다. 백업도 용량을 차지하므로
보관 중인 백업을 제외한 DB 감소량을 전체 디스크 절감량으로 해석하지 않습니다.
스키마 3까지만 지원하는 이전 실행 파일은 별도 디렉터리에 복원한 백업을
사용해야 합니다. 보존 기간이나 자동 이력 삭제는 추가하지 않습니다.

코드 위치: `server/background-sync.ts`, `server/sync.ts`,
`server/providers/kiro-sqlite.ts`, `server/store.ts`, `server/search-index.ts`,
`server/maintenance.ts`, `server/database-file.ts`, `server/write-retry.ts`,
`src/state/refreshQueue.ts`.

실측 결과와 회귀 검증은 [저장소 운영](../operations.md#저장-공간-최적화),
[운영 런북](../runbooks/local-operations.md), [검증 기록](../verification.md)을
참고하세요.
