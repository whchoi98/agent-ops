# Getting started

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

Use Node.js 20.19 or later and npm. From the repository root:

```bash
npm ci
npm run build
npm run demo -- --port 4318
```

Open `http://127.0.0.1:4318`. Demo data is isolated and agent execution is disabled.
Stop with `Ctrl+C`; use `npm start` for native history on port 4317.
Real agent execution requires the corresponding installed CLI and its login.

<a id="macos-english"></a>
### macOS source installation

Prepare Git and Node.js/npm meeting the project requirement above, then run in
the Mac terminal:

```bash
git clone https://github.com/whchoi98/agent-ops.git
cd agent-ops
node --version
npm --version
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4317`; keep the terminal open and stop with `Ctrl+C`.
Install dependencies on the target Mac. The server reads that Mac's files and
uses its installed CLIs. Inspect **Settings** for detected CLIs and history
paths; actual execution requires the relevant CLI's separate installation/login.

The default cache directory is `~/.local/share/agent-ops`, subject to
`AGENT_OPS_DATA_DIR` and `XDG_DATA_HOME`. The macOS Kiro source list also includes
`~/Library/Application Support/kiro-cli/data.sqlite3`. Other paths can be set in
the UI. **한/EN** beside the theme control changes the interface language.

Mac path support is implemented, but the recorded runtime verification is on
Linux ARM64. See [verification](verification.md) for that limit and
[the runbook](runbooks/local-operations.md) for updates and diagnostics.

For a remote EC2 with an authenticated code-server proxy:

```bash
npm start -- --port 4327 --public-url https://YOUR_DOMAIN/proxy/4327/
```

Replace `YOUR_DOMAIN` with the browser-facing domain. See
[operations](operations.md) for the environment file and systemd setup.
The service template contains example user and installation paths to customize.

Use `npm run dev -- --demo` for UI development. To validate application changes:

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

Tests use temporary data and controlled processes. Native history validation is
optional; read [the verification scope](verification.md) before running it.

<a id="korean"></a>
## 한국어

Node.js 20.19 이상과 npm을 사용합니다. 저장소 루트에서 실행하세요.

```bash
npm ci
npm run build
npm run demo -- --port 4318
```

`http://127.0.0.1:4318`을 엽니다. 데모 데이터는 격리되며 에이전트 실행은
차단됩니다. `Ctrl+C`로 종료한 뒤 `npm start`를 실행하면 포트 4317에서 실제
이력을 읽습니다. 실제 에이전트 실행에는 해당 CLI의 설치와 로그인이 필요합니다.

<a id="macos-korean"></a>
### macOS 소스 설치

위 프로젝트 요구 사항에 맞는 Node.js/npm과 Git을 준비하고 Mac 터미널에서
실행합니다.

```bash
git clone https://github.com/whchoi98/agent-ops.git
cd agent-ops
node --version
npm --version
npm ci
npm run build
npm start
```

`http://127.0.0.1:4317`에 접속합니다. 터미널을 열어 두고 `Ctrl+C`로 종료합니다.
의존성은 해당 Mac에서 설치합니다. 서버는 Mac의 파일과 설치된 CLI를 사용합니다.
**설정**에서 CLI와 기록 경로를 확인하고, 실제 작업을 실행하려면 해당 CLI를
별도로 설치·로그인하세요.

기본 캐시는 `~/.local/share/agent-ops`이며 `AGENT_OPS_DATA_DIR`과 `XDG_DATA_HOME`
설정을 따릅니다. macOS의 Kiro 수집 경로에는
`~/Library/Application Support/kiro-cli/data.sqlite3`도 포함됩니다. 다른 경로는
화면에서 지정할 수 있습니다. 테마 옆 **한/EN** 버튼으로 화면 언어를 바꿉니다.

Mac 경로 지원은 구현되어 있으나 기록된 실행 검증 환경은 Linux ARM64입니다.
한계는 [검증 기록](verification.md), 업데이트·진단은
[런북](runbooks/local-operations.md)을 참고하세요.

인증된 code-server 프록시가 있는 원격 EC2에서는 다음과 같이 실행합니다.

```bash
npm start -- --port 4327 --public-url https://YOUR_DOMAIN/proxy/4327/
```

`YOUR_DOMAIN`을 브라우저에서 사용하는 도메인으로 바꾸세요. 환경 파일과
systemd 설정은 [운영 가이드](operations.md)를 참고합니다. 서비스 예제의
사용자와 설치 경로는 환경에 맞게 수정해야 합니다.

화면 개발에는 `npm run dev -- --demo`를 사용합니다. 애플리케이션 변경을
검증할 때에는 다음 명령을 실행합니다.

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

테스트는 임시 데이터와 제어 가능한 프로세스를 사용합니다. 실제 이력 검증은
선택 사항이며 실행 전에 [검증 범위](verification.md)를 확인하세요.
