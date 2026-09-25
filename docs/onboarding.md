# Getting started

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

Use Node.js 20.19 or later and npm. From the repository root:

```bash
npm ci
npm run build
npm run demo -- --port 4328
```

Open `http://127.0.0.1:4328`. Demo data is isolated and agent execution is disabled.
Stop with `Ctrl+C`; use `npm start` for native history on port 4317.
Real agent execution requires the corresponding installed CLI and its login.

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
npm run demo -- --port 4328
```

`http://127.0.0.1:4328`을 엽니다. 데모 데이터는 격리되며 에이전트 실행은
차단됩니다. `Ctrl+C`로 종료한 뒤 `npm start`를 실행하면 포트 4317에서 실제
이력을 읽습니다. 실제 에이전트 실행에는 해당 CLI의 설치와 로그인이 필요합니다.

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
