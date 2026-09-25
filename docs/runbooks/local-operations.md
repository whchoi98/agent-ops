# Local operations

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

Use the following commands from a built source checkout. For a global npm
installation, replace `node dist/server/index.js` with `agent-ops`. Keep the
same `--data-dir` and `--demo` selection across related commands.

### Start and diagnose

```bash
npm start
```

Open `http://127.0.0.1:4317`. Keep the terminal open; stop with `Ctrl+C`.
In another terminal, from the same checkout:

```bash
curl --fail http://127.0.0.1:4317/api/health
node dist/server/index.js doctor
```

Health reports `{ok,version,demo}`. Doctor reports connector discovery and
import counts, not account authentication. Use the UI synchronization button
while the server runs; it acknowledges the job without holding a long request
open. An initial import can take longer than later incremental scans.

The listener, data location and public URL may differ in an existing service.
Use its configured values. EC2 proxy/systemd instructions are in
[operations](../operations.md#원격-머신에서-사용); the Linux service template is
not a macOS launchd configuration.

### Update a source installation

Let owned work finish and stop the server. Review local Git changes before
updating a clean checkout:

```bash
git pull --ff-only
npm ci
npm run build
npm start
```

If Git reports local changes or divergence, reconcile them before proceeding;
do not discard them with a reset. Repeat the health check. Updating source or
docs alone does not restart an existing process.

### Back up and optimize

Stop the server and standalone sync processes for the selected data directory.
For a shared/live deployment, perform this during its approved maintenance
window. Check free space and existing backups.

```bash
node dist/server/index.js optimize --data-dir "$HOME/.local/share/agent-ops"
```

Use the actual configured data directory if it differs. The command requires
free space of three times the current DB size plus 128 MiB. It validates stored
tables, creates and verifies a compressed backup, converts the search store,
reclaims pages and reports the result as JSON.

Check `beforeBytes`, `afterBytes`, `backupPath`, `backupBytes` and `documents`.
Retain the reported backup; there is no automatic backup deletion. Source
assistant databases are not modified.

Restart with the same data directory, then check health, a known session and a
known search term. Restore or downgrade only using the
[documented backup procedure](../operations.md#저장-공간-최적화); do not mix a restored
DB with another installation's WAL/SHM. A converted schema-4 cache cannot be
opened by an older binary that supports only schema 3.

<a id="korean"></a>
## 한국어

아래 명령은 빌드한 소스 체크아웃에서 실행합니다. 전역 npm 설치라면
`node dist/server/index.js`를 `agent-ops`로 바꿉니다. 관련 명령에서 `--data-dir`과
`--demo` 선택을 일관되게 유지하세요.

### 시작과 진단

```bash
npm start
```

`http://127.0.0.1:4317`을 엽니다. 터미널을 열어 두고 `Ctrl+C`로 종료합니다.
다른 터미널의 같은 체크아웃에서 확인합니다.

```bash
curl --fail http://127.0.0.1:4317/api/health
node dist/server/index.js doctor
```

Health는 `{ok,version,demo}`를 반환합니다. Doctor는 CLI 발견 상태와 수집 건수를
보고하며 계정 인증 검사는 하지 않습니다. 서버 실행 중에는 화면의 동기화 버튼을
사용합니다. 긴 요청을 계속 열어 두지 않고 작업 접수 후 상태를 갱신합니다.
첫 수집은 이후의 증분 수집보다 오래 걸릴 수 있습니다.

기존 서비스의 포트·데이터 경로·공개 URL이 다르면 해당 설정을 따릅니다.
EC2 프록시와 systemd 절차는 [운영](../operations.md#원격-머신에서-사용)에 있습니다.
Linux 서비스 예제는 macOS의 launchd 설정이 아닙니다.

### 소스 설치 업데이트

소유한 작업이 끝난 뒤 서버를 종료합니다. 로컬 Git 변경을 확인하고 정리된
체크아웃에서 업데이트합니다.

```bash
git pull --ff-only
npm ci
npm run build
npm start
```

로컬 수정이나 브랜치 분기가 있으면 먼저 정리하고 reset으로 버리지 않습니다.
시작 후 health를 다시 확인합니다. 소스나 문서 변경만으로 기존 프로세스가
재시작되지는 않습니다.

### 백업과 최적화

선택한 데이터 디렉터리의 서버와 별도 동기화를 종료합니다. 공유·운영 배포에서는
승인된 유지보수 시간에 진행하고 여유 공간과 기존 백업을 확인합니다.

```bash
node dist/server/index.js optimize --data-dir "$HOME/.local/share/agent-ops"
```

실제 설정 경로가 다르면 명령의 데이터 디렉터리를 바꿉니다. 현재 DB 크기의
3배 + 128 MiB 여유 공간이 필요합니다. 저장 테이블을 검사하고 압축 백업을
생성·검증한 뒤 검색 저장소 변환, 공간 회수와 JSON 결과 출력을 진행합니다.

결과의 `beforeBytes`, `afterBytes`, `backupPath`, `backupBytes`, `documents`를
확인하고 보고된 백업을 보관합니다. 백업 자동 삭제는 없으며 원본 어시스턴트
DB는 변경하지 않습니다.

같은 데이터 디렉터리로 재시작하고 health, 알고 있는 세션과 검색어를 확인합니다.
복원·이전 버전 전환은 [백업 절차](../operations.md#저장-공간-최적화)를 따르며,
복원 DB에 다른 설치의 WAL/SHM을 섞지 않습니다. 변환한 스키마 4 캐시는
스키마 3까지만 지원하는 이전 실행 파일로 열 수 없습니다.
