# macOS desktop application inventory

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

<a id="english"></a>
## English

### What is observed

The inventory describes the **server host**, not the computer running the
browser. Run my-agent-ops on the Mac to inspect its supported app locations.
Linux, Windows and other hosts return `unsupported-host`, with
`installed: null`; they do not report that the user's Mac apps are absent.
Demo mode returns unverified entries without inspecting the host.

| App ID | Display name | Version meaning | Fixed bundle name |
|---|---|---|---|
| `codex-app` | Codex App | Desktop app | `Codex.app`, `ChatGPT.app` with identifier `com.openai.codex` |
| `claude-desktop` | Claude Desktop | App/container containing the Code tab | `Claude.app` |
| `kiro-ide` | Kiro IDE | IDE, separate from Kiro CLI | `Kiro.app` |

For each name, only `/Applications/<name>` and the current server user's
`~/Applications/<name>` are candidates: eight paths in total. This is a bounded
candidate policy, not an exhaustive installed-application index. Other renamed apps,
nested folders, mounted installer images and other users' homes are not searched.
No directory enumeration, Spotlight search or broad home scan is used.

`items[].installations` contains all observed copies, ordered **system then
user**, with `Codex.app` before `ChatGPT.app` within each root. The UI displays the first copy even if its metadata is incomplete.
It neither chooses the highest version nor silently substitutes a lower-priority
copy. `not-installed` means no matching app was found at any supported candidate.
Inaccessible or unsafe candidates without a found copy yield `unverified`.
For `Codex.app`, `Claude.app` and `Kiro.app`, a regular bundle directory establishes
presence; signature authenticity, launchability and account access remain unverified.

The ambiguous `ChatGPT.app` name requires an exact `CFBundleIdentifier` match
to `com.openai.codex`. A different valid identifier is excluded with
`bundle-identifier-mismatch`; an unreadable, missing or invalid identifier leaves
that candidate `unverified`. Neither case contributes a Codex installation or
version. An identifier match preserves missing version/build fields as `null`.

Each installation records its path, location, metadata status, diagnostic codes,
and `source.path` / `source.keys`:

| Field | Exact source key | Treatment |
|---|---|---|
| `version` | `CFBundleShortVersionString` | Preserve the observed string |
| `build` | `CFBundleVersion` | Preserve the observed string, including leading zeros |
| `bundleIdentifier` | `CFBundleIdentifier` | Preserve the valid identifier |

Missing or invalid values remain `null`. A build is never substituted for a
missing app version. No npm release, inferred desktop “latest” version or
semantic-version comparison is used. Desktop apps and CLI packages have separate
release streams. Authentication, cloud chats, full private histories and
internal Code engine versions remain explicitly `unverified`.

### Discovery and cache boundaries

`DesktopAppService` is lazy; its constructor does not inspect the filesystem.
One server-owned service caches complete reports, including missing, partial
and unsupported results, for up to ten minutes. Concurrent requests and refreshes
share one in-flight discovery. Manual refresh bypasses a completed cache.
`checkedAt`, `expiresAt` and `cacheTtlMs` describe that report.

The implementation rejects symlinks at Applications roots, bundles, `Contents`
and `Info.plist`, as well as non-regular metadata and hardlinked plists.
Trusted root parents are canonicalized, allowing system aliases such as macOS
`/var` → `/private/var`. File and directory identities are rechecked; changed
metadata is discarded, including when a path changes during conversion.

Metadata is opened read-only with `O_NOFOLLOW` and `O_NONBLOCK`. At most 256 KiB
is accepted per plist. The service supplies validated bytes over stdin to:

```text
/usr/bin/plutil -convert json -o - -
```

The command and arguments are fixed; no shell, target app executable, app
`--version` command or user-selected path is executed. XML and binary plists use
the same converter. Each helper has a two-second timeout, a 256 KiB output limit,
a minimal fixed environment and `SIGKILL` termination. At most eight helpers run,
sequentially, per discovery; filesystem work is also restricted to the fixed
paths. JSON has a depth limit of 24 and a 4,096-node limit. Version/build strings
are limited to 128 characters / 256 UTF-8 bytes; identifiers to 255 ASCII
characters. Diagnostics expose fixed codes, not helper output or arbitrary
metadata properties. Discovery makes no vendor/network requests.

### Integration contract

The app mounts one service under its existing access guards:

```ts
import { DesktopAppService, registerDesktopAppRoutes } from './desktop-apps.js';

const desktopApps = new DesktopAppService({ demo });
registerDesktopAppRoutes(app, desktopApps);
```

`DesktopAppServiceOptions` accepts trusted host/test injection for `platform`,
`applicationsDir`, `homeDir`, `converter`, `converterTimeoutMs`, `cacheTtlMs`,
`now`, and `demo`. These are not HTTP inputs. A custom converter receives a
bounded `Buffer` plus `{ signal, timeoutMs, maxOutputBytes }`. The public report
contract is `DesktopAppReport` in `shared/desktop-apps.ts`.

| Route | Accepted input | Result |
|---|---|---|
| `GET /api/desktop-apps` | No query parameters or request body | Cached report, or discovery after expiry |
| `POST /api/desktop-apps/refresh` | `X-Agent-Ops: 1`; absent body or exactly `{}`; no query parameters | Fresh report, coalesced with any in-flight discovery |

Unknown fields, explicit JSON `null`, arrays, scalars and malformed JSON are
rejected. Refresh bodies are capped at 1 KiB. Both routes return
`Cache-Control: no-store`; the cache is owned by the service. The route registrar
also checks the refresh header itself. Existing Host, Origin, local-peer and
configured proxy guards must remain in place.

Below the existing CLI comparison in Settings:

```tsx
import { DesktopApps } from '../features/versions/DesktopApps';

<DesktopApps demo={data.demo} />
```

`DESKTOP_EN_MESSAGES` from `src/i18n/desktop.en.ts` is included in the provider's
message map. Korean source strings provide Korean copy; no additional Korean
mapping is needed. `desktopApi.report(signal)` and
`desktopApi.refresh(signal)` reuse the exported `request<T>` client, preserving
the proxy prefix, mutation header and cancellation. Existing provider marks,
version/connector styles and responsive rules are reused. There is no polling
or additional stylesheet. Demo rendering makes no inventory request.

See [API](../api.md), [operations](../operations.md) and
[verification](../verification.md) for the integrated feature.
`docs/reference` is included in the package's `files` manifest.

### Vendor and client distinctions

Sources were retrieved on **2026-09-25**. These notes are documentation evidence,
not an inspection of any installed app or a new MCP adapter.

- **Codex:** Local Codex state follows `CODEX_HOME`, defaulting to `~/.codex`.
  Current OpenAI documentation describes shared desktop/CLI/IDE MCP
  configuration in `config.toml`. The old Codex documentation URLs now redirect
  to ChatGPT Learn and call the desktop client the ChatGPT desktop app.
  This inventory checks both `Codex.app` and `ChatGPT.app`; the latter requires
  identifier `com.openai.codex`. Shared configuration directories alone do not
  establish app identity or version.
- **Claude:** The Code tab belongs to the Claude desktop container and runs a
  Code engine. Current docs say local Code sessions also load Chat's
  `claude_desktop_config.json`, along with `~/.claude.json` and project
  `.mcp.json`. The Chat definition wins duplicate names; user-scope stdio
  definitions can also outrank project definitions in Desktop. Standalone CLI
  behavior differs: it does not directly read the Chat file and offers an import
  command. The MCP inventory preserves the source/surface distinction; this app
  inventory does not invoke an MCP discovery/import command.
- **Kiro:** Vendor installation documentation distinguishes the IDE from the
  CLI. The inventory's `kiro-ide` record is the IDE bundle, not `kiro-cli`.

Primary sources:

1. [Apple — Core Foundation Info.plist keys](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html)
2. [OpenAI — Advanced configuration, including CODEX_HOME](https://learn.chatgpt.com/docs/config-file/config-advanced)
3. [OpenAI — MCP configuration shared across clients](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
4. [Anthropic — Claude Code Desktop reference](https://code.claude.com/docs/en/desktop.md)
5. [Anthropic — MCP configuration and Desktop import](https://code.claude.com/docs/en/mcp.md)
6. [Kiro — IDE/CLI installation](https://kiro.dev/docs/getting-started/installation/)

### Verification performed on Linux — 2026-09-25

```bash
npm test -- tests/desktop-apps.test.ts tests/desktop-apps-api.test.ts tests/desktop-apps-plutil.test.ts tests/desktop-apps-ui.test.ts tests/desktop-apps-client.test.ts
```

Baseline result before the 1.2.1 correction: **71 tests passed in five files**. Tests use temporary bundles, an
injected plist converter, a mocked child-process boundary, Fastify injection and
React server rendering. The binary fixture was also decoded with Python's
`plistlib` to confirm it is a valid binary plist.

A scoped TypeScript compiler-API check used the repository's `tsconfig.json`
options and the 13 new TypeScript entry files, including their imports:
**zero diagnostics**. Default service discovery on this Linux host returned
`unsupported-host`, `installed: null` and zero inspected candidates for all three
apps. Owned-file whitespace checks (including untracked files), document anchors,
source URLs and the existing package manifest entry were reviewed successfully.
These focused checks used no paid inference, real app invocation, live-service
change or credential access.

**Native macOS validation is unavailable on this Linux host.** These results
verify boundaries and converter invocation, not real macOS `plutil` behavior,
real vendor bundles or native macOS behavior. Integrated build/browser evidence
is recorded in [verification](../verification.md).

<a id="korean"></a>
## 한국어

### 확인하는 정보

검사 대상은 **my-agent-ops 서버가 실행 중인 기기**입니다. 브라우저로 접속한
사용자의 Mac을 원격 검사하지 않습니다. Mac의 앱 정보를 확인하려면 해당
Mac에서 서버를 실행해야 합니다. Linux·Windows 등에서는
`unsupported-host`, `installed: null`을 반환합니다. 데모에서는 호스트를
검사하지 않고 미확인 항목을 반환합니다.

| 앱 ID | 표시 이름 | 버전의 의미 | 고정 번들 이름 |
|---|---|---|---|
| `codex-app` | Codex App | 데스크톱 앱 | `Codex.app`, 식별자가 `com.openai.codex`인 `ChatGPT.app` |
| `claude-desktop` | Claude Desktop | Code 탭을 포함한 앱/컨테이너 | `Claude.app` |
| `kiro-ide` | Kiro IDE | Kiro CLI와 별개인 IDE | `Kiro.app` |

각 이름에 대해 `/Applications/<이름>`과 서버 실행 사용자의
`~/Applications/<이름>`만 확인합니다. 후보는 총 여덟 곳이며, 전체 설치 앱
목록을 만드는 기능은 아닙니다. 이외의 이름으로 바꾼 앱, 하위 폴더, 설치 디스크 이미지,
다른 사용자의 홈은 탐색하지 않습니다. 디렉터리 열거·Spotlight 검색·홈 전체
검색도 사용하지 않습니다.

`items[].installations`에는 확인된 설치본이 **시스템 → 사용자** 순서로
들어가며 각 루트에서는 `Codex.app`, `ChatGPT.app` 순서로 확인합니다.
UI는 첫 설치본의 메타데이터가 부족해도 그 설치본을 표시합니다.
버전 크기로 정렬하거나 다른 설치본으로 조용히 대체하지 않습니다.
`not-installed`는 지원 후보에서 일치하는 앱을 찾지 못했다는 뜻입니다. 접근 불가나
안전 경계에 걸린 후보만 있다면 `unverified`입니다. `Codex.app`, `Claude.app`,
`Kiro.app`은 일반 번들 디렉터리가 있으면 설치된 것으로 표시합니다.
서명 진위, 실행 가능 여부와 계정 접근 권한은 미확인으로 남깁니다.

`ChatGPT.app`은 `CFBundleIdentifier`가 정확히 `com.openai.codex`일 때만
Codex App으로 인식합니다. 유효한 다른 식별자라면
`bundle-identifier-mismatch`로 제외하고 식별자를 읽지 못했거나 값이
누락되거나 형식이 잘못된 경우에는 후보를 `unverified`로 표시합니다.
이 경우 Codex 설치본이나 버전을 표시하지 않습니다. 식별자가 일치해도
버전이나 빌드가 없으면 해당 값은 `null`로 유지합니다.

설치 위치, 메타데이터 상태, 진단 코드와 함께 `source.path`·`source.keys`를
제공합니다. 버전은 `CFBundleShortVersionString`, 빌드는 `CFBundleVersion`,
번들 식별자는 `CFBundleIdentifier`에서 읽습니다. 문자열과 빌드의 선행 0을
보존하며, 누락되거나 잘못된 값은 `null`입니다. 빌드를 앱 버전으로 대신
사용하지 않습니다.

데스크톱 앱과 CLI 패키지는 배포 채널이 다릅니다. npm 릴리스나 추정한 앱 최신
버전과 비교하지 않습니다. 인증 상태, 클라우드 대화, 전체 비공개 이력,
내부 Code 엔진 버전은 명시적으로 `unverified`로 남깁니다.

### 검사·캐시의 경계

서비스 생성자는 파일시스템을 검사하지 않습니다. 서버가 소유한 서비스 하나가
최초 요청 때 검사하고, 미설치·부분 결과·지원하지 않는 호스트 결과까지 최대
10분 동안 캐시합니다. 동시 요청과 새로고침은 진행 중인 검사 하나를 공유합니다.
수동 새로고침은 완료된 캐시를 건너뛰며,
`checkedAt`·`expiresAt`·`cacheTtlMs`가 결과의 확인 시각과 유효기간을 나타냅니다.

Applications 루트, 번들, `Contents`, `Info.plist`의 심볼릭 링크와 일반 파일이
아닌 메타데이터, 하드링크 plist는 제외합니다. 신뢰된 루트의 상위 경로는 정규화해
macOS의 `/var` → `/private/var` 같은 시스템 경로 별칭을 허용합니다. 파일과
디렉터리의 식별 정보를 재확인하며, 변환 중 경로 변경을 포함해 검사 도중 바뀐
메타데이터는 표시하지 않습니다.

`O_NOFOLLOW`·`O_NONBLOCK`으로 읽기 전용 파일을 열고 256 KiB 이하만
처리합니다. XML·바이너리 plist 모두 검증한 바이트를
`/usr/bin/plutil -convert json -o - -`의 표준 입력에 전달합니다. 명령과 인수는
고정되어 있으며 셸이나 대상 앱, 앱의 `--version` 명령을 실행하지 않습니다.
변환기마다 2초 제한, 출력 256 KiB 제한, 고정 최소 환경, `SIGKILL` 종료를
적용합니다. 검사 한 번에 최대 여덟 변환기를 순차 실행하며 파일 조회도 고정
경로로 제한합니다. JSON 깊이는 24, 노드는 4,096개까지입니다. 버전·빌드는
128자·UTF-8 256바이트, 식별자는 ASCII 255자까지 허용합니다.
진단에는 고정 코드만 담고 변환기 출력이나 임의 메타데이터를 노출하지 않습니다.
실행 중 공급사·외부 네트워크에 요청하지 않습니다.

### 통합

앱의 기존 접근 검사 아래에 서비스 하나를 등록합니다.

```ts
import { DesktopAppService, registerDesktopAppRoutes } from './desktop-apps.js';

const desktopApps = new DesktopAppService({ demo });
registerDesktopAppRoutes(app, desktopApps);
```

`DesktopAppServiceOptions`의 `platform`, `applicationsDir`, `homeDir`,
`converter`, `converterTimeoutMs`, `cacheTtlMs`, `now`, `demo`는 신뢰된
서버 설정·테스트 주입용이며 HTTP 입력이 아닙니다. 변환기에는 제한된 `Buffer`와
`{ signal, timeoutMs, maxOutputBytes }`가 전달됩니다. 공개 계약은
`shared/desktop-apps.ts`의 `DesktopAppReport`입니다.

`GET /api/desktop-apps`는 쿼리와 본문을 받지 않습니다.
`POST /api/desktop-apps/refresh`는 `X-Agent-Ops: 1`과 생략한 본문 또는
정확한 `{}`만 허용합니다. 쿼리, 추가 필드, `null`, 배열, 스칼라, 잘못된 JSON은
거부하며 새로고침 본문은 1 KiB까지입니다. 두 경로는
`Cache-Control: no-store`를 반환하고 캐시는 서비스가 관리합니다.
라우트 자체의 새로고침 헤더 검사와 기존 Host·Origin·로컬 피어·프록시 검사를
모두 유지해야 합니다.

Settings의 기존 CLI 비교 아래에 `<DesktopApps demo={data.demo} />`를
표시하고, `src/i18n/desktop.en.ts`의 `DESKTOP_EN_MESSAGES`를 번역 사전에
포함합니다. 한글 원문 키가 한국어 UI를 제공하므로 별도 한국어 매핑은 없습니다.
`desktopApi.report(signal)`·`desktopApi.refresh(signal)`은 기존
`request<T>`를 사용해 프록시 경로, 변경 요청 헤더와 취소를 보존합니다.
ProviderMark와 기존 카드·버전·반응형 스타일을 재사용하며 폴링이나 추가
스타일시트는 없습니다. 데모 컴포넌트는 설치 정보 요청을 보내지 않습니다.

통합된 기능은 [API](../api.md), [운영](../operations.md),
[검증 기록](../verification.md)에서 확인할 수 있습니다. `docs/reference`는
패키지의 `files`에 포함됩니다.

### 공급사와 클라이언트 구분

위 영문 절에 연결한 공식 출처를 **2026-09-25**에 조회했습니다. 문서 확인
결과이며, 실제 앱이나 MCP 설정을 검사한 결과가 아닙니다.

- **Codex:** 로컬 상태는 `CODEX_HOME`을 따르며 기본값은 `~/.codex`입니다.
  현재 문서는 데스크톱·CLI·IDE의 `config.toml` 공유를 설명합니다.
  이전 Codex 문서 주소는 ChatGPT Learn으로 이동하며 데스크톱 제품 이름도
  ChatGPT desktop app으로 표기합니다. 이 기능은 `Codex.app`과
  `ChatGPT.app`을 확인하며, 후자는 식별자가 `com.openai.codex`여야 합니다.
  공유 설정 경로만으로 앱의 정체나 버전을 판단하지 않습니다.
- **Claude:** Code 탭은 Claude 앱에 포함됩니다. 현재 문서상 로컬 Code 세션은
  Chat의 `claude_desktop_config.json`, `~/.claude.json`, 프로젝트
  `.mcp.json`을 함께 읽습니다. 이름 충돌 시 Chat 설정이 우선하며,
  Desktop에서는 사용자 범위 stdio 설정이 프로젝트보다 우선할 수도 있습니다.
  독립 CLI는 Chat 설정 파일을 직접 읽지 않고 가져오기 명령을 제공합니다.
  MCP 목록은 이 출처·실행 표면의 차이를 보존합니다.
  앱 설치 정보 수집은 MCP 탐색이나 가져오기 명령을 실행하지 않습니다.
- **Kiro:** 공식 설치 문서는 IDE와 CLI를 구분합니다. `kiro-ide`는 IDE
  번들이며 `kiro-cli`가 아닙니다.

### Linux 검증 기록 — 2026-09-25

1.2.1 수정 전 기준 검증에서 영문 절의 대상 npm 테스트 명령으로
**5개 파일, 71개 테스트가 통과**했습니다.
임시 번들, 주입한 plist 변환기, 모의 child-process 경계, Fastify 요청 주입,
React 서버 렌더링을 사용했습니다. 바이너리 plist 픽스처는 Python
`plistlib`으로도 유효성을 확인했습니다.

저장소 `tsconfig.json` 옵션으로 신규 TypeScript 진입 파일 13개와 그 import를
검사한 결과 **진단 0개**였습니다. 이 Linux 호스트의 기본 서비스 호출은 세 앱
모두 `unsupported-host`, `installed: null`, 검사 후보 0개를 반환했습니다.
미추적 파일을 포함한 담당 파일의 공백 검사, 문서 앵커·출처 URL과 기존 패키지
포함 항목도 확인했습니다. 이 집중 검사에서는 유료 추론, 실제 앱
실행, 운영 서비스 변경, 인증 정보 접근을 수행하지 않았습니다.

**이 Linux 호스트에서는 macOS 실기기 검증을 수행할 수 없습니다.**
검증 결과는 검사 경계와 변환기 호출을 다루며, 실제 macOS `plutil`이나 공급사
앱의 동작을 검증한 결과는 아닙니다. 통합 빌드·브라우저 근거는
[검증 기록](../verification.md)에 기록합니다.
