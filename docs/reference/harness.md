# Harness management

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

### Open the page

Choose **Analysis and management > Harness management**, or open `#/harness`.
Select a registered project to manage its policies and native hooks. The global
scope shows user policy and audit sources.

Use the **Engine**, **Policies**, **Decision test**, **Hooks** and **Audit** tabs
to switch tasks. Drafts remain available when switching tabs.

The page distinguishes engine readiness, hook configuration and observed audit
events. A configured hook does not by itself establish that a client invoked it.
Information refers to the computer running my-agent-ops.

### Install the optional engine

Policy reading and audit viewing work without Python. To validate with the
AutoHarness engine, run the following commands on the my-agent-ops server host.
Use Python 3.10 or later; this integration was checked with AutoHarness 0.1.1.

```bash
# Check the Python version.
python3 --version

# Choose the same data directory as my-agent-ops.
agent_ops_data_dir="${AGENT_OPS_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-ops}"

# Create a separate environment for AutoHarness.
python3 -m venv "$agent_ops_data_dir/harness/venv"

# Install the reviewed upstream revision.
"$agent_ops_data_dir/harness/venv/bin/python" -m pip install \
  "https://github.com/aiming-lab/AutoHarness/archive/3561e468f9ca9f9bf282512e695bd32e4e90fef4.tar.gz"

# Copy this interpreter path into Harness management if using a custom location.
printf '%s\n' "$agent_ops_data_dir/harness/venv/bin/python"
```

Save the Python path and choose the engine check action. Inspect both the
Python version and the detected AutoHarness version. A missing package, an
unsupported Python version or an engine error leaves evaluation unavailable.
The page labels 0.1.1 as the tested version, not a remote latest-release check.

Installing the npm package keeps the Python engine optional. On a Mac, run these
commands on that Mac when my-agent-ops also runs there.

If the engine reports an unsafe managed path, inspect ownership and permissions
on the app data directory. The bridge rejects another owner's paths and
group/world-writable managed paths. Use a directory owned by the server account,
normally with mode `0700`, and retain that protection when restoring a backup.

### Inspect and edit a policy

Policies appear with their source, revision, mode and rule count. Discovery
includes the user configuration, the first project configuration, the local
override and the app-managed policy.

The project search order is `.autoharness.yaml`, `constitution.yaml`,
`.autoharness/constitution.yaml`, then `autoharness.yaml`. The local override is
`.autoharness.local.yaml`; the user configuration is `~/.autoharness/config.yaml`.

Select a policy to read it. Checks and newly installed hooks use that selected
policy. To apply rules from several sources together, collect them in an
app-managed policy and review the result.

Use the managed-policy editor to save changes. Existing source files remain
read-only in this interface. Save checks the expected revision; a conflict
requires reloading the current saved policy. Policy files are limited to 64 KiB
and must use the supported bounded YAML structure. Unsupported aliases, tags,
excessive nesting and duplicate keys produce validation errors.

Structural validation works without the engine. Engine validation is marked
separately when the real Python engine checks the policy. Redacted source text
cannot be saved over the original secrets.

### Test a decision

Choose a policy, a client, a tool name and JSON input. For example, use `Bash`
with this input:

```json
{"command":"git status --short"}
```

The result shows `allow`, `ask`, `deny` or `error`, together with risk and reason.
The bridge asks AutoHarness to evaluate the input; it does not run the supplied
tool command. Test records are identified separately from native hook events.

### Preview and manage native hooks

Enable execution for the registered project, confirm the engine, then choose a
client and preview its hook configuration. Review the files and notices before
applying. Changed files, policy revisions, runtime configuration or project
settings require a new preview.

| Client | Managed project configuration |
|---|---|
| Claude Code | `.claude/settings.local.json` |
| Codex | `.codex/hooks.json` |
| Kiro IDE 1.0+ and CLI 3.0+ | `.kiro/hooks/agent-ops-autoharness.json` |

Kiro IDE and CLI share one hook definition and binding. Applying or removing
either Kiro entry affects that shared configuration. Events without reliable
client attribution appear as **Kiro shared**.

Review and trust the new Codex hook in the native `/hooks` interface. The
workbench does not mark native trust as confirmed from a configuration file.
Known older Kiro versions and unknown version evidence are shown explicitly.

An allowed AutoHarness decision retains the client's normal permission flow.
An approval-needed decision stays `ask` in the audit record. The adapter can
request interactive approval from Claude Code; Codex and Kiro currently block
that request because their supported pre-tool protocol cannot express that
approval flow. Runs started by my-agent-ops are unattended, so their bridge also
blocks an approval-needed request.
The bridge records pre/post metadata and uses the native protocol to report
blocking decisions and errors.

Remove only the workbench-managed hook through the preview flow. Other hook
entries, policies and audit records are preserved. Backups are kept in the app's
data directory.

### Read audit records and storage limits

Filter records by client, decision, session or text and use pagination. Counts
refer to the retained window. The page shows bytes read, source file sizes,
invalid lines and incomplete windows.

The reader starts from a bounded recent range and verifies retained byte ranges
within its read budget before accepting appended records. It handles partial
lines, file replacement and rotation.
The default cache limit is 2,000 records with a 30-day viewing window; these
settings control the workbench cache and filtering.

Workbench-owned logs use `events.jsonl`, `events.1.jsonl` and
`events.2.jsonl`. External AutoHarness logs are read without rewriting or
deleting them. Audit views omit raw tool arguments and output.

### API and verification

Use the [API reference](../api.md) for `/api/harness` endpoints and the
[verification record](../verification.md) for actual test and deployment results.
`GET /api/harness/status` reports whether a harness mutation or engine process
is active without starting discovery or an engine.

Demo mode supplies synthetic policies, client states and audit records. It
blocks real engine checks, evaluations and native configuration changes.

---

## 한국어

### 화면 열기

**분석 및 관리 > 하니스 관리**를 선택하거나 `#/harness`로 이동합니다.
등록된 프로젝트를 선택하면 해당 프로젝트의 정책과 훅을 관리합니다. 전체 범위에서는
사용자 정책과 감사 로그 출처를 확인합니다.

**엔진**, **정책**, **판정 테스트**, **훅**, **감사 기록** 탭으로 작업을 전환합니다.
탭을 바꿔도 작성 중인 입력은 유지됩니다.

엔진 준비 상태, 훅 설정과 감사 이벤트 관측 여부를 구분해 표시합니다. 훅 파일이
설정됐다는 사실만으로 클라이언트가 이를 실행했다고 판단하지 않습니다. 표시 정보는
my-agent-ops를 실행하는 컴퓨터를 기준으로 합니다.

### 선택형 엔진 설치

Python이 없어도 정책과 감사 로그를 읽을 수 있습니다. AutoHarness 엔진으로
검증하려면 my-agent-ops를 실행하는 컴퓨터에서 다음 명령을 실행합니다.
Python 3.10 이상이 필요하며, 이 연동은 AutoHarness 0.1.1을 기준으로 확인했습니다.

```bash
# Python 버전을 확인합니다.
python3 --version

# my-agent-ops와 같은 데이터 디렉터리를 선택합니다.
agent_ops_data_dir="${AGENT_OPS_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-ops}"

# AutoHarness 전용 가상환경을 만듭니다.
python3 -m venv "$agent_ops_data_dir/harness/venv"

# 검토한 upstream 개정을 설치합니다.
"$agent_ops_data_dir/harness/venv/bin/python" -m pip install \
  "https://github.com/aiming-lab/AutoHarness/archive/3561e468f9ca9f9bf282512e695bd32e4e90fef4.tar.gz"

# 다른 경로에 설치했다면 이 출력값을 하니스 관리의 Python 경로에 입력합니다.
printf '%s\n' "$agent_ops_data_dir/harness/venv/bin/python"
```

Python 경로를 저장한 뒤 엔진 확인 기능을 실행합니다. Python 버전과 실제
AutoHarness 버전을 함께 확인합니다. 패키지가 없거나 Python 버전을 지원하지
않거나 엔진 오류가 있으면 판정 기능을 사용할 수 없습니다. 화면의 0.1.1은
검증 기준 버전이며 원격 최신 릴리스 조회 결과가 아닙니다.

npm 패키지 설치와 Python 엔진 설치는 별개입니다. Mac에서 my-agent-ops를
실행한다면 위 명령도 해당 Mac에서 실행합니다.

관리 경로가 안전하지 않다는 오류가 나오면 앱 데이터 디렉터리의 소유자와 권한을
확인합니다. 브리지는 다른 사용자가 소유하거나 그룹 또는 다른 사용자에게 쓰기가
허용된 관리 경로를 거절합니다. 서버 계정이 소유하는 경로를 사용하고 일반적으로
`0700` 권한을 설정하며, 백업을 복원할 때도 이 보호를 유지합니다.

### 정책 확인과 편집

정책의 출처, 개정, 모드와 규칙 수를 표시합니다. 사용자 설정, 프로젝트에서 처음
찾은 설정, 로컬 덮어쓰기 설정과 앱 관리 정책을 조회합니다.

프로젝트에서는 `.autoharness.yaml`, `constitution.yaml`,
`.autoharness/constitution.yaml`, `autoharness.yaml` 순서로 찾습니다.
로컬 덮어쓰기 파일은 `.autoharness.local.yaml`, 사용자 설정은
`~/.autoharness/config.yaml`입니다.

정책을 선택해 내용을 읽습니다. 판정 테스트와 새 훅에는 선택한 정책을 적용합니다.
여러 출처의 규칙을 함께 적용하려면 앱 관리 정책에 모아 저장한 뒤 내용을 확인합니다.

앱 관리 정책은 편집기에서 저장합니다. 이 화면에서 기존 원본 파일은 읽기 전용입니다.
저장할 때 예상 개정을 확인하므로 충돌이 나면 최신 저장 내용을 다시 불러옵니다.
정책 파일은 64 KiB 이내여야 하며 지원하는 YAML 구조를 사용해야 합니다.
지원하지 않는 별칭과 태그, 과도한 중첩과 중복 키는 검증 오류로 표시합니다.

형식 검증은 엔진 없이도 동작합니다. 실제 Python 엔진으로 확인한 경우에는 엔진
검증 여부를 따로 표시합니다. 가려진 원문으로 기존 비밀 값을 덮어쓸 수는 없습니다.

### 판정 테스트

정책, 클라이언트, 도구 이름과 JSON 입력을 선택합니다. 예를 들어 `Bash`에
다음 입력을 전달합니다.

```json
{"command":"git status --short"}
```

위험도와 이유를 포함해 `allow`, `ask`, `deny`, `error` 중 하나를 표시합니다.
브리지는 AutoHarness에 판정을 요청하며 입력한 도구 명령을 실행하지 않습니다.
이 테스트 기록은 실제 훅 이벤트와 구분합니다.

### 훅 미리보기와 관리

등록 프로젝트의 실행을 허용하고 엔진을 확인한 뒤 클라이언트를 선택해 훅 설정을
미리 봅니다. 변경 파일과 안내를 읽고 적용합니다. 파일, 정책 개정, 실행 환경이나
프로젝트 설정이 바뀌면 새 미리보기가 필요합니다.

| 클라이언트 | 관리하는 프로젝트 설정 |
|---|---|
| Claude Code | `.claude/settings.local.json` |
| Codex | `.codex/hooks.json` |
| Kiro IDE 1.0 이상, CLI 3.0 이상 | `.kiro/hooks/agent-ops-autoharness.json` |

Kiro IDE와 CLI는 하나의 훅 정의와 바인딩을 공유합니다. 어느 Kiro 항목에서
적용하거나 제거해도 이 공통 설정에 반영됩니다. 실제 클라이언트를 구별할 수 없는
이벤트는 **Kiro 공통**으로 표시합니다.

Codex에서는 기본 `/hooks` 화면에서 새 훅을 검토하고 신뢰하도록 설정합니다.
설정 파일만으로 신뢰 검토가 끝났다고 표시하지 않습니다. 확인된 Kiro 구버전과
버전을 확인하지 못한 경우도 구분합니다.

AutoHarness가 허용한 경우 클라이언트의 기존 권한 절차를 따릅니다. 승인이 필요한
판정은 감사 기록에 `ask`로 남깁니다. Claude Code의 대화형 실행에는 승인 요청을
전달할 수 있습니다. Codex와 Kiro는 지원하는 사전 훅 프로토콜에서 이 승인 동선을
표현할 수 없어 요청을 차단합니다. my-agent-ops가 시작한 비대화형 실행도 승인이
필요한 요청을 차단합니다. 실행 전후 메타데이터를 기록하며
차단 판정과 오류는 각 클라이언트의 기본 프로토콜로 전달합니다.

제거할 때도 미리보기를 거쳐 앱이 관리하는 훅만 제거합니다. 다른 훅, 정책과
감사 기록은 유지하며 백업은 앱 데이터 디렉터리에 보관합니다.

### 감사 기록과 저장 공간

클라이언트, 판정, 세션이나 검색어로 기록을 찾고 페이지를 이동합니다. 건수는
보관 중인 범위를 기준으로 합니다. 읽은 바이트 수, 원본 파일 크기, 잘못된 줄과
일부만 읽은 범위를 함께 표시합니다.

처음에는 최근 구간을 제한해서 읽습니다. 이후에도 읽기 한도 안에서 보관 구간의
연속성을 확인한 뒤 추가된 기록을 수집하며 부분 줄, 파일 교체와 회전을 처리합니다.
기본 캐시는 2,000개 기록과 30일 조회 범위이며
이 설정은 앱의 캐시와 필터에 적용됩니다.

앱이 기록하는 로그는 `events.jsonl`, `events.1.jsonl`,
`events.2.jsonl`을 사용합니다. 외부 AutoHarness 로그는 덮어쓰거나 삭제하지
않고 읽습니다. 감사 화면에는 도구 인수와 출력 원문을 보관하지 않습니다.

### API와 검증

`/api/harness` 경로는 [API 문서](../api.md), 실제 테스트와 배포 결과는
[검증 기록](../verification.md)에서 확인합니다. `GET /api/harness/status`는
파일 탐색이나 엔진을 시작하지 않고 하니스 변경 작업과 검사 프로세스의 실행 여부를
반환합니다.

데모에서는 합성 정책, 연결 상태와 감사 기록을 제공합니다. 실제 엔진 확인,
판정 실행과 원본 훅 설정 변경은 차단합니다.
