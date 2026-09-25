# MCP inventory and connection checks

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

Open **Analytics and management → MCP**. Filter declarations by provider, selected
registered project, scope, configuration status or transport. Details show
redacted configuration, source/client provenance, static findings, and the
results of an explicitly requested metadata check.

### Configuration and client identity

Configuration presence is not a native client's live connection state. The UI
keeps source readers, per-client applicability, and the workbench's latest probe
separate. A previously successful probe is timestamped evidence, not an ongoing
connection to another application.

| Family | Bounded local sources |
|---|---|
| Codex App / CLI | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml`; selected `.codex/config.toml` |
| Claude Code | `~/.claude.json`, the selected project's local entry, `.mcp.json`, applicable `.claude/settings*.json` controls |
| Claude Desktop Chat | macOS `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Kiro IDE / shared configuration | `~/.kiro/settings/mcp.json` and selected `.kiro/settings/mcp.json` |
| Kiro CLI agents | Bounded `.kiro/agents` declarations with agent/includeMcpJson evidence |
| Plugins and Powers | Evidenced owned installs and their declared MCP components; ambiguous caches stay unverified |

Codex project trust, Claude approval/disable controls, and relevant source
precedence remain part of the analysis. Active profiles, CLI overrides, managed
policies, account connectors and native sessions are not inferred from files.

Local Claude Code Desktop sessions can also consume Desktop Chat declarations,
whereas standalone Code CLI does not read that Chat file directly. Desktop Chat
can override the same server name for Desktop Code without disabling its CLI
declaration. The **Configuration by client** table reports these differences.
Mixed consumer states appear as unknown at the row level; they are not applied
to the whole provider. Kiro IDE and CLI source readers are likewise identified.
See [desktop app distinctions](desktop-apps.md) for the vendor documentation.

### Explicit connection workflow

1. Open a declaration and review its source, masked command/endpoint and findings.
2. Request a preview. This still launches no command and opens no network session.
3. Start the check from that preview. Configuration and project execution settings
   are revalidated; expired, reused or changed previews cannot start a new check.
4. Inspect the independent result, protocol/server information and observed
   tools/resources/prompts metadata. Cancel an active check when necessary.

Supported checks use POSIX stdio, Streamable HTTP (JSON or SSE responses), or
declared legacy HTTP+SSE. Only initialization and advertised metadata-listing
methods are used. No tools, resources or prompts are executed/read through their
content APIs, and no model inference is requested.

A stdio check starts the configured program with argument arrays. Its startup
can have side effects; this is not an OS sandbox. With a project selected,
that project's execution permission is required. Only owned process groups are
stopped. HTTP checks use the declared endpoint and configured authentication;
they send no conversation content. Redirects are refused, legacy SSE endpoints
stay on the same origin, and plain HTTP is restricted to loopback. Cleanup
deletes only a session created by that probe or closes its own stream.

Native OAuth sessions, dynamic header helpers, remote executors, WebSocket
transports and Windows stdio group cleanup are unsupported. Their declarations
can still be inspected with a clear limitation. The app does not import native
credentials or run an authentication command. Demo checks are disabled.

### Resource and privacy limits

- Discovery: 60-second cache, eight cached selections, two simultaneous scans,
  256 configuration reads, 4 MiB total input, 256 KiB per file, 4,096 directory
  entries and 512 declarations.
- Checks: one probe across service instances, 10-second protocol deadline,
  followed by bounded owned cleanup.
- Preview/result storage: 64 previews with 60-second expiry and 64 retained
  results, all in memory. Refresh invalidates previews, not an active check.
- Protocol: 256 KiB per message, 2 MiB total protocol/stderr bytes, 1,024 messages,
  four pages and 100 observed entries per metadata family.
- Browser: no automatic probes; only active checks are polled, with a bounded
  observation window. Hidden/unmounted views stop their requests.

Arguments are hidden; environment and header values are not returned. URL
credentials, paths, queries, session IDs, schemas, resource URIs, raw output and
error bodies are excluded. Known credentials and encoded forms are redacted from
metadata. Tool descriptions remain data and never become execution instructions.
Counts describe returned entries; truncation never claims an unseen total.

Contracts are in `shared/mcp.ts`; the implementation is in `server/mcp/`.
See [API routes](../api.md), [resource monitoring](resources.md), and
[verification](../verification.md). Native configuration files are not edited.

## 한국어

**분석 및 관리 → MCP**에서 제공자, 등록된 프로젝트, 범위, 설정 상태, 전송
방식으로 선언을 찾습니다. 상세 화면은 마스킹된 설정, 출처와 클라이언트,
정적 진단, 사용자가 요청한 메타데이터 점검 결과를 보여줍니다.

### 설정과 클라이언트 구분

설정이 있다는 사실은 실제 클라이언트 연결 상태가 아닙니다. 설정을 읽는
클라이언트, 클라이언트별 적용 상태, 워크벤치의 최근 점검을 구분합니다.
성공한 점검도 표시된 시각의 근거이며 다른 앱에 유지되는 연결을 뜻하지 않습니다.

| 구분 | 제한된 로컬 출처 |
|---|---|
| Codex App / CLI | `$CODEX_HOME/config.toml`, 기본 `~/.codex/config.toml`; 선택한 `.codex/config.toml` |
| Claude Code | `~/.claude.json`, 선택한 프로젝트의 로컬 항목, `.mcp.json`, 관련 `.claude/settings*.json` 제어 |
| Claude Desktop Chat | macOS의 `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Kiro IDE / 공유 설정 | `~/.kiro/settings/mcp.json`, 선택한 `.kiro/settings/mcp.json` |
| Kiro CLI 에이전트 | 탐색 한도가 있는 `.kiro/agents` 선언과 에이전트/includeMcpJson 근거 |
| 플러그인·파워 | 소유·설치 근거가 있는 선언된 MCP 구성; 모호한 캐시는 미확인 유지 |

Codex 프로젝트 신뢰, Claude 승인·비활성 제어, 관련 설정 우선순위를 함께
분석합니다. 활성 프로필, CLI 재정의, 관리 정책, 계정 커넥터와 실제 세션은
파일만 보고 추정하지 않습니다.

로컬 Claude Code Desktop은 Desktop Chat 선언도 읽을 수 있지만 독립 Code
CLI는 Chat 파일을 직접 읽지 않습니다. 같은 이름의 Desktop Chat 선언이
Desktop Code에서 우선하더라도 CLI의 선언까지 비활성화하지 않습니다.
**클라이언트별 적용 상태** 표에서 차이를 확인합니다. 적용 상태가 서로 다르면
행 전체는 불명으로 표시하며 특정 클라이언트의 상태를 제공자 전체로 확대하지
않습니다. Kiro IDE와 CLI의 출처 구분도 표시합니다. 공급사 문서는
[데스크톱 앱 구분](desktop-apps.md)을 참고하세요.

### 명시적 연결 점검

1. 선언을 열어 출처, 마스킹된 명령·주소, 진단을 검토합니다.
2. 미리보기를 요청합니다. 이 단계에서는 명령이나 네트워크 세션을 시작하지 않습니다.
3. 미리보기에서 점검을 시작합니다. 설정과 프로젝트 실행 권한을 다시 확인하며
   만료·재사용·변경된 미리보기로는 새 점검을 시작하지 않습니다.
4. 독립 점검 결과, 프로토콜·서버 정보, 도구·리소스·프롬프트 목록을 확인하고
   필요한 경우 진행 중인 점검을 취소합니다.

POSIX stdio, JSON/SSE 응답의 Streamable HTTP, 명시된 기존 HTTP+SSE를
지원합니다. 초기화와 지원을 선언한 메타데이터 목록만 요청합니다.
도구 호출, 리소스 내용 읽기, 프롬프트 실행·본문 조회, 모델 추론은 요청하지 않습니다.

stdio 점검은 인수 배열로 설정된 프로그램을 시작합니다. 시작 과정에 부수
효과가 있을 수 있으며 OS 샌드박스는 아닙니다. 프로젝트를 선택했다면 해당
프로젝트의 실행 허용이 필요합니다. 소유한 프로세스 그룹만 종료합니다.
HTTP는 설정한 주소와 인증을 사용하며 대화 내용은 보내지 않습니다.
리디렉션은 거부하고 기존 SSE의 메시지 주소는 같은 출처로 제한합니다.
평문 HTTP는 루프백만 허용합니다. 정리할 때는 해당 점검이 만든 세션이나
스트림만 닫습니다.

원래 앱의 OAuth 세션, 동적 헤더 도우미, 원격 실행기, WebSocket,
Windows stdio 그룹 정리는 지원하지 않습니다. 해당 선언은 제약과 함께
조회할 수 있습니다. 인증 정보를 가져오거나 인증 명령을 실행하지 않으며
데모 점검도 차단합니다.

### 자원과 개인정보 제한

- 탐색: 캐시 60초, 선택 범위 캐시 8개, 동시 스캔 2개, 설정 읽기 256회,
  총 입력 4 MiB, 파일당 256 KiB, 디렉터리 항목 4,096개, 선언 512개입니다.
- 점검: 서비스 인스턴스 전체에서 하나만 실행하며 프로토콜 제한 시간은
  10초입니다. 이후 소유 자원을 제한된 시간 안에 정리합니다.
- 보관: 미리보기 64개, 유효 시간 60초, 결과 64개를 메모리에 보관합니다.
  갱신하면 미리보기를 무효화하지만 실행 중인 점검은 유지합니다.
- 프로토콜: 메시지당 256 KiB, 프로토콜·stderr 총 2 MiB, 메시지 1,024개,
  메타데이터 종류별 4페이지·확인된 항목 100개로 제한합니다.
- 브라우저: 점검을 자동 실행하지 않습니다. 실행 중인 점검만 제한된 시간
  동안 조회하고 숨겨지거나 닫힌 화면의 요청은 중단합니다.

인수와 환경 변수·헤더 값은 반환하지 않습니다. URL 인증·경로·쿼리,
세션 ID, 스키마, 리소스 URI, 원시 출력과 오류 본문도 제외합니다.
알려진 비밀 값과 인코딩된 형태는 메타데이터에서도 가립니다.
도구 설명은 데이터로 다루며 실행 지시로 사용하지 않습니다. 개수는 반환받은
항목 기준이며 잘린 결과로 원격 전체 개수를 추정하지 않습니다.

공개 계약은 `shared/mcp.ts`, 구현은 `server/mcp/`에 있습니다.
[API](../api.md), [자원 모니터링](resources.md), [검증 기록](../verification.md)을
함께 참고하세요. 원래 설정 파일은 수정하지 않습니다.
