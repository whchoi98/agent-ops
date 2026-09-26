# Implementation reference

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

<a id="english"></a>
## English

### Overview and components

Use this map to find the implementation and its existing detailed document.
Code paths refer to the source checkout; npm archives provide compiled code in
`dist/` and the linked public documentation.

| Area | Code pointers | Reference |
|---|---|---|
| CLI/configuration | `server/index.ts`, `server/config.ts`, `server/lock.ts` | [Onboarding](../onboarding.md), [runbook](../runbooks/local-operations.md) |
| HTTP/proxy access | `server/app.ts`, `server/access.ts`, `shared/types.ts` | [API](../api.md), [operations](../operations.md) |
| History/storage | `server/providers/`, `server/sync.ts`, `server/background-sync.ts`, `server/store.ts`, `server/search-index.ts` | [Storage decision](../decisions/0002-history-storage.md) |
| Maintenance | `server/maintenance.ts`, `server/database-file.ts`, `server/write-retry.ts` | [Runbook](../runbooks/local-operations.md) |
| Execution/sharing | `server/commands.ts`, `server/runner.ts`, `server/privacy.ts` | [API](../api.md), [local-workbench decision](../decisions/0001-local-workbench.md) |
| Productivity workspace | `server/productivity/`, `shared/work-items.ts`, `shared/context-packs.ts`, `shared/template-fields.ts`, `shared/saved-views.ts`, `src/features/runs/RunContextModel.ts` | [Productivity](productivity.md#english), [API](../api.md#productivity-workspace) |
| Extensions/versions | `server/extensions/`, `server/versions.ts`, `shared/extensions.ts`, `shared/versions.ts` | [Operations](../operations.md), [API](../api.md) |
| Resource monitoring | `server/resources/`, `shared/resources.ts`, `src/pages/Resources.tsx` | [Resources](resources.md) |
| Recorded credits/import controls | `server/providers/kiro-credits.ts`, `server/sync-manager.ts`, `shared/credits.ts`, `shared/sync-control.ts` | [Usage and sync](usage-and-sync.md#english), [API](../api.md) |
| Workbench updates | `server/app-update.ts`, `server/app-update/`, `shared/app-update.ts`, `src/features/app-update/` | [Usage and sync](usage-and-sync.md#english), [operations](../operations.md) |
| MCP configuration/checks | `server/mcp/`, `shared/mcp.ts`, `src/features/mcp/` | [MCP](mcp.md), [API](../api.md) |
| Harness management | `server/harness/`, `shared/harness.ts`, `src/features/harness/` | [Harness guide](harness.md#english), [API](../api.md) |
| macOS desktop apps | `server/desktop-apps/`, `shared/desktop-apps.ts`, `src/features/versions/DesktopApps.tsx` | [Desktop apps](desktop-apps.md) |
| UI/language | `src/App.tsx`, `src/state/`, `src/i18n/`, `src/features/`, `src/pages/` | [Architecture](../architecture.md), [design](../design.md) |
| Build/tests/distribution | `scripts/build.ts`, `scripts/package-smoke.mjs`, `tests/`, `src/**/*.test.*` | [Contributing](../../CONTRIBUTING.md), [verification](../verification.md) |

### Key decisions and cross-references

[ADR 0001](../decisions/0001-local-workbench.md) covers local data, source privacy
and explicit execution. [ADR 0002](../decisions/0002-history-storage.md) covers
import concurrency, stable search identity and offline conversion.
[AGENTS.md](../../AGENTS.md) contains contributor instructions;
[the documentation index](../README.md) is the entry point for public guides.

<a id="korean"></a>
## 한국어

### 개요와 구성 요소

구현과 기존 상세 문서를 찾기 위한 색인입니다. 코드 경로는 소스 체크아웃을
기준으로 하며 npm 패키지에는 `dist/`의 빌드 코드와 연결된 공개 문서가 들어 있습니다.

| 영역 | 코드 위치 | 참조 |
|---|---|---|
| CLI·설정 | `server/index.ts`, `server/config.ts`, `server/lock.ts` | [온보딩](../onboarding.md), [런북](../runbooks/local-operations.md) |
| HTTP·프록시 접근 | `server/app.ts`, `server/access.ts`, `shared/types.ts` | [API](../api.md), [운영](../operations.md) |
| 이력·저장소 | `server/providers/`, `server/sync.ts`, `server/background-sync.ts`, `server/store.ts`, `server/search-index.ts` | [저장소 결정](../decisions/0002-history-storage.md) |
| 유지보수 | `server/maintenance.ts`, `server/database-file.ts`, `server/write-retry.ts` | [런북](../runbooks/local-operations.md) |
| 실행·공유 | `server/commands.ts`, `server/runner.ts`, `server/privacy.ts` | [API](../api.md), [로컬 워크벤치 결정](../decisions/0001-local-workbench.md) |
| 생산성 작업 공간 | `server/productivity/`, `shared/work-items.ts`, `shared/context-packs.ts`, `shared/template-fields.ts`, `shared/saved-views.ts`, `src/features/runs/RunContextModel.ts` | [생산성](productivity.md#한국어), [API](../api.md#productivity-workspace) |
| 확장·버전 | `server/extensions/`, `server/versions.ts`, `shared/extensions.ts`, `shared/versions.ts` | [운영](../operations.md), [API](../api.md) |
| 자원 모니터링 | `server/resources/`, `shared/resources.ts`, `src/pages/Resources.tsx` | [자원](resources.md) |
| 기록된 credit과 수집 제어 | `server/providers/kiro-credits.ts`, `server/sync-manager.ts`, `shared/credits.ts`, `shared/sync-control.ts` | [사용량과 수집](usage-and-sync.md#한국어), [API](../api.md) |
| 앱 자체 업데이트 | `server/app-update.ts`, `server/app-update/`, `shared/app-update.ts`, `src/features/app-update/` | [사용량과 수집](usage-and-sync.md#한국어), [운영](../operations.md) |
| MCP 설정·점검 | `server/mcp/`, `shared/mcp.ts`, `src/features/mcp/` | [MCP](mcp.md), [API](../api.md) |
| 하니스 관리 | `server/harness/`, `shared/harness.ts`, `src/features/harness/` | [하니스 가이드](harness.md#한국어), [API](../api.md) |
| macOS 데스크톱 앱 | `server/desktop-apps/`, `shared/desktop-apps.ts`, `src/features/versions/DesktopApps.tsx` | [앱 정보](desktop-apps.md) |
| UI·언어 | `src/App.tsx`, `src/state/`, `src/i18n/`, `src/features/`, `src/pages/` | [아키텍처](../architecture.md), [설계](../design.md) |
| 빌드·테스트·배포 파일 | `scripts/build.ts`, `scripts/package-smoke.mjs`, `tests/`, `src/**/*.test.*` | [기여](../../CONTRIBUTING.md), [검증](../verification.md) |

### 주요 결정과 관련 문서

[ADR 0001](../decisions/0001-local-workbench.md)은 로컬 데이터·원본 보호·명시적 실행을,
[ADR 0002](../decisions/0002-history-storage.md)는 수집 동시성·안정적인 검색 연결과
오프라인 변환을 다룹니다. 작업 지침은 [AGENTS.md](../../AGENTS.md),
공개 가이드의 시작점은 [문서 색인](../README.md)입니다.
