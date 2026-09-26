# Productivity workspace

[![English](https://img.shields.io/badge/lang-English-blue)](#english) [![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](#한국어)

## English

### Overview

Use work items, parameterized templates, context packs and saved session views
to turn conversation history into a reviewed next action.

Organization, template rendering and context compilation run locally. Starting
an assistant still requires the existing explicit CLI flow, a registered project
with execution enabled, and the server host's CLI installation and authentication.

### Components

#### Work items

Create a work item in **Work items**, or use **Create work item** in a session's
details. A session creates a draft with its title, matching project and a session
reference; it does not copy the transcript. Add a description and next action,
choose priority and due date, and link sessions or context packs.

Use list or board mode and filter by text, project, status, priority, due date
or archive. The board shows the current page, not every matching work item.
Status counts can exceed the visible cards. **Overview** shows up to five open
items; `done` items are excluded from the open filter.

Select a checkbox in **Overview** to mark that work item done. The item leaves
the open list after it is saved. Select the title to open its details.
If saving fails, the checkbox clears and an error appears. If another edit
caused a conflict, choose **Reload work items** before trying again.

Save changes before choosing **Prepare run**. Preparation copies the goal,
description, next action and session references, compiles attached packs and
opens an editable read-only draft. Select a project if the item has none.
Review the final prompt and command, then explicitly start the run.

Work-item titles, descriptions and next actions reject NUL (`U+0000`).
An assembled work-item prompt containing NUL is also rejected during preparation;
review the work text and source context before trying again.

The server saves the run and its work-item link in one transaction before
launch. It checks the current version, sets the item to `in_progress`, records
the last run and advances the version. Competing submissions from the same
version cannot create two linked runs. A preview does not reserve a version,
so a later edit can still prevent start.

Inspect the last run result and mark the item `done` yourself. A successful CLI
exit does not establish that the work is complete. Reopen a done or archived
item before preparing another run. Archiving or deleting work leaves linked
sessions, runs and context packs intact.

#### Parameterized templates and history

In **Templates**, edit a prompt and define its `{{name}}` inputs as `text`,
`multiline` or `select`. Each definition has a label and required flag, with
optional help text and a default. Select inputs have explicit options. Every
defined variable must appear in the prompt, and every placeholder needs a
definition.

Choose **Use template** in the library, or select a template in the new-run
dialog. Fill the inputs, inspect the rendered prompt and explicitly apply it.
The result remains editable. Applying a template replaces the prompt and keeps
the selected pack references. For any selected packs, choose **Add selected
context** again before previewing the command. Input or prompt changes require
another command preview before start.

Substitution is one pass over the original prompt. Values containing braces,
shell syntax or other expressions remain literal text; no JavaScript, shell or
nested expression is evaluated. Templates without variable definitions, or
with an empty definition list, preserve their original braces and text.

Open template history to preview retained revisions and restore one as a new
revision. New templates start at revision 1; legacy templates are treated as
revision 1 and recorded lazily on edit. Retention is bounded both per template
and globally, so fewer than 20 revisions may remain for an older template.
Deletion also removes that template's history.

#### Context packs

Create a named pack in **Context packs**, optionally selecting a project and
adding instructions. From a message in the session reader, choose **Add to
context pack**, select or create a destination, and review the source range
before saving.

Pack pickers show all packs by default, including packs without a project.
In a picker with a current project, enable **Show only this project** to narrow
the list. Changing the filter or page preserves existing selections.

The capture dialog uses a zero-based UTF-16 offset and length in the original
message. A shortened search preview carries its original `contentOffset`;
the initial capture range starts there and is at most 8,000 units. You can edit
the range. The shown preview is display-only and is not sent as source text.
The server reads the selected message by ID and rejects a range that splits a
surrogate pair or exceeds the message.

Captured message text and provenance are immutable snapshots. They include
source session/message IDs, assistant, session title, role, message time,
capture time and range. A later source edit does not rewrite the snapshot.
Source availability means the IDs still exist; it does not prove the content
is unchanged. An unavailable source leaves the saved excerpt intact.

Rename item labels, add or edit operator notes, remove items and save their
order. Captured text itself is read-only. Save pending metadata, note and order
changes before compiling or exporting.

Compile to inspect and copy a prompt containing instructions, every selected
item and its provenance. Export Markdown or JSON, or prepare a read-only run
draft. Compilation assembles saved text locally: it is not an AI summary and
the character count is not a token estimate. Oversize output is rejected
instead of silently dropping items.

In the run dialog, select up to five packs and choose **Add selected context**.
Newly selected packs are compiled before the prompt changes; failure,
cancellation or an intervening draft edit leaves the existing prompt intact.
Deselecting and reselecting an applied pack does not append its text twice.
Applying a template replaces the prompt and requires adding selected context
again. Manual prompt edits are retained as written; removing a pack reference
leaves the current prompt text untouched. Later pack changes do not silently
refresh an open run draft. The command preview and explicit start still follow.

#### Saved session views and the command palette

Set the search, filters, sort and page size in **Sessions**, then choose
**Save current view**. Give the view a name and choose all time, today,
last 7 days, last 30 days or a custom range. Open, rename, update, pin or delete
it from the saved-view toolbar. When editing an existing view, choose
**Use current session filters** if those should replace its saved query.

Opening a view replaces the current session query and resets pagination to
the first page. The saved query excludes the offset. Relative periods are
calculated on open in the browser's local calendar, including daylight-saving
changes: last 7 days includes today and the previous six dates, and last 30
includes today and the previous 29. Custom ranges retain the session API's
date semantics; a date-only end boundary includes that full UTC day.

Press `Ctrl/Cmd + K` to open the palette. Use arrow keys and Enter to choose a
page, work item, pinned view, project or template; Escape closes it. Project
shortcuts open related sessions and template shortcuts prepare a run. Palette
choices do not launch an assistant.

Palette search waits 220 ms after typing and requests at most five sessions
and five work items. It shows at most eight matching pinned views and, when
searching, five project and five template shortcuts from existing metadata.
The full-search actions open the paginated work-item or session page.

### Key decisions

#### Limits and bounded reads

Text limits below use UTF-16 code units, as JavaScript strings do. The source
capture limit uses bytes. These are application bounds, not model token limits.

| Area | Limit |
|---|---|
| Work items | 10,000 stored, including archived items; title 200; description and next action 8,000 each |
| Work-item references | 20 unique session IDs and 5 unique context-pack IDs per item |
| Context packs | 200 packs; name 200, description 500 and instructions 8,000 characters |
| Context items | 20 per pack; 8,000 per excerpt or note; 48,000 total item-text characters per pack |
| Capture source | 8 MiB per serialized source message; only the selected message is read |
| Compiled context and run prompt | 64,000 characters for each compiled pack and for the final combined run prompt; up to 5 linked packs per run |
| Template inputs | 20 variables; ASCII identifier names up to 40; labels 200; help text 500; values/defaults/options 8,000 each; 1-50 unique options for a select |
| Template prompts and history | Stored prompt 32,000; rendered prompt 64,000; at most 20 revisions per template and 1,000 overall |
| Saved views | 50 views; name 120 characters; saved session page size 1-200; no saved offset |

Work-item and pack lists default to 25 and accept at most 100 records per
request. Work-item search is limited to 200 characters and offsets to
0-1,000,000; pack search to 500 characters and offsets to 0-200. Work-item lists
contain short previews; pack lists omit instructions and item bodies.
Saved views return at most 50 metadata records without running their searches
or calculating result counts. These collections are not added to bootstrap.
Template-only refresh uses the existing template list separately.

#### Drafts, conflicts and explicit execution

Open editors keep the version or revision associated with their draft.
Background metadata refreshes update lists without silently rebasing unsaved
fields. Stale work-item, pack and saved-view writes return HTTP 409 without a
partial update. New template clients send `expectedRevision`; older PATCH
clients may omit it. Restoring a template requires the current expected
revision. Template deletion retains its existing unversioned contract.

Keep a copy of edits you need before explicitly reloading the latest record,
which replaces the draft. Inspect conflicts and reconcile deliberately;
the UI does not silently retry a mutation with a newer version. Draft
preservation during refresh does not make unsaved text durable across a
browser reload or a closed dialog.

Run preparation holds the selected template snapshot, edited prompt and work
version. Changes invalidate the accepted command preview; start uses that
preview's request. The server checks work-item linkage again at creation.
The IDs attached to a run are references; they do not ask the run API to
render a template or recompile context.

Starting a new run preparation, including a template shortcut in `Ctrl/Cmd + K`,
replaces the existing form and its command preview with a fresh form.

#### Storage, privacy and refresh

The feature services use small extension tables on the existing SQLite
connection. Supported schema version remains 4. Initialization does not scan
or rewrite native messages, fingerprints, search documents or user annotations.
No dependency, automatic inference, telemetry or background saved-search
execution is added. Demo metadata remains in the separate demo store and
cannot start assistants.

Stored excerpts and notes may contain sensitive text. Compile and export apply
the current rules in `server/privacy.ts` to string values while leaving saved
snapshots intact. A `redacted` result indicates that a rule changed text; it
does not guarantee all secrets were found. Review output before sharing.
JSON export contains a redacted pack; Markdown contains the compiled prompt.

New routes inherit the root API's Host, Origin, local-peer, mutation-header
and configured proxy checks. The shared typed browser request helper retains
HTTP status information for conflict handling.
Small `productivity-change` SSE messages carry only the entity kind.
Feature listeners refresh bounded metadata, and template changes fetch only
the template list instead of reloading the archive. Existing run, reconnect
and periodic refresh behavior remains separate.

### Code pointers

Paths refer to a source checkout; installation archives contain compiled code
in `dist/` and public documentation.

| Area | Source |
|---|---|
| Work-item contracts, service and routes | `shared/work-items.ts`, `server/productivity/work-items.ts`, `server/productivity/work-item-routes.ts` |
| Template definitions and history | `shared/template-fields.ts`, `server/productivity/templates.ts`, `src/features/template-fields/` |
| Context capture, storage and output | `shared/context-packs.ts`, `server/productivity/context-packs.ts`, `server/productivity/context-packs/`, `server/productivity/context-pack-routes.ts` |
| Saved queries and calendar ranges | `shared/saved-views.ts`, `server/productivity/saved-views.ts`, `src/features/saved-views/` |
| Run linkage and frozen preparation | `server/app.ts`, `server/runner.ts`, `server/commands.ts`, `src/features/runs/RunContextModel.ts`, `src/features/runs/RunContextCompile.ts` |
| UI and refresh | `src/pages/WorkItems.tsx`, `src/pages/ContextPacks.tsx`, `src/features/sessions/SessionReader.tsx`, `src/components/CommandPalette.tsx`, `src/state/AppProvider.tsx` |

Feature tables are `productivity_work_items`, `productivity_context_packs`,
`productivity_context_pack_items`, `productivity_saved_views` and
`productivity_template_revisions`.

### Cross-references

- [README usage](../../README.md#productivity-workflow): the short user flow.
- [API contracts](../api.md#productivity-workspace): actual request/response shapes, validation and SSE.
- [Operations](../operations.md#생산성-작업-공간): storage, conflicts and preparation troubleshooting in Korean.
- [Documentation index](../README.md#english) and [implementation map](INDEX.md#english).

## 한국어

### 개요

작업센터, 변수형 템플릿, 컨텍스트 묶음과 저장 검색으로 대화 이력을 다음 할 일에
연결합니다.

업무 정리, 템플릿 치환과 컨텍스트 조합은 로컬에서 처리합니다. 에이전트를 시작하려면
기존 CLI 실행 절차를 명시적으로 거치고 등록 프로젝트의 실행을 허용해야 합니다.
CLI 설치와 인증은 서버 호스트를 기준으로 합니다.

### 구성 요소

#### 작업센터

**작업센터**에서 작업을 만들거나 세션 상세의 **작업으로 저장**을 사용합니다.
세션에서 시작하면 제목, 일치하는 프로젝트와 세션 참조를 초안에 넣으며 대화 본문을
복제하지 않습니다. 설명과 다음 할 일을 적고 우선순위, 기한을 정한 뒤 세션이나
컨텍스트 묶음을 연결합니다.

목록이나 보드에서 검색어, 프로젝트, 상태, 우선순위, 기한과 보관 여부로 범위를
좁힙니다. 보드는 현재 페이지의 작업만 표시하므로 상태별 전체 건수가 화면의 카드
수보다 클 수 있습니다. **개요**에는 진행할 작업을 최대 5개 표시하며 완료한
`done` 작업은 열린 작업 필터에서 제외합니다.

**개요**에서 작업 앞의 체크박스를 선택하면 완료로 저장하고 진행할 작업 목록에서
제외합니다. 제목을 누르면 상세 화면을 엽니다. 저장에 실패하면 체크를 해제하고
오류를 표시합니다. 다른 곳에서 수정한 내용과 충돌하면 **작업 새로고침**을 누른 뒤
다시 시도합니다.

변경 내용을 저장한 뒤 **실행 준비**를 선택합니다. 목표, 설명, 다음 할 일과 세션
참조를 복사하고 연결한 묶음을 조합해 편집 가능한 읽기 전용 초안을 엽니다.
프로젝트가 없는 작업은 프로젝트를 선택합니다. 최종 프롬프트와 명령을 확인한 뒤
실행을 직접 시작합니다.

작업의 제목, 설명과 다음 할 일에 NUL (`U+0000`)이 있으면 저장을 거절합니다.
작업에서 조합한 실행 프롬프트에 NUL이 있어도 준비를 거절하므로 작업 내용과
원본 컨텍스트를 확인한 뒤 다시 시도합니다.

서버는 프로세스를 시작하기 전에 실행 기록과 작업 연결을 한 트랜잭션으로 저장합니다.
현재 버전을 검사하고 상태를 `in_progress`로 바꾸며 마지막 실행을 기록하고 버전을
올립니다. 같은 버전으로 들어온 요청이 연결된 실행을 두 번 만들 수는 없습니다.
미리보기는 버전을 예약하지 않으므로 이후 수정으로 실행 시작이 거절될 수 있습니다.

마지막 실행 결과를 살펴보고 업무를 마쳤을 때 직접 `done`으로 바꿉니다. CLI가
성공으로 종료돼도 업무 완료를 뜻하지 않습니다. 완료하거나 보관한 작업은 다시
열어야 실행을 준비할 수 있습니다. 작업을 보관하거나 삭제해도 연결된 세션, 실행과
컨텍스트 묶음은 유지합니다.

#### 변수형 템플릿과 이력

**템플릿**에서 프롬프트를 편집하고 `{{name}}` 입력을 `text`, `multiline`,
`select`로 정의합니다. 각 정의에는 표시 이름과 필수 여부가 있으며 도움말과 기본값을
덧붙일 수 있습니다. 선택 입력에는 선택지를 지정합니다. 정의한 변수는 프롬프트에
있어야 하고 모든 자리표시자에는 변수 정의가 필요합니다.

목록에서 **템플릿 사용**을 선택하거나 새 실행 창에서 템플릿을 고릅니다. 값을 입력하고
완성된 프롬프트를 확인한 뒤 명시적으로 적용합니다. 결과는 계속 편집할 수 있습니다.
템플릿을 적용하면 프롬프트를 교체하고 선택한 묶음 참조는 유지합니다.
묶음을 선택했다면 **선택한 컨텍스트 추가**를 다시 누른 뒤 명령을 미리 봅니다.
입력이나 프롬프트를 바꾸면 실행 전 명령 미리보기를 다시 확인합니다.

치환은 원래 프롬프트를 한 번 읽어 처리합니다. 값에 중괄호, 셸 구문이나 다른
표현식이 있어도 일반 텍스트로 남기며 JavaScript, 셸, 중첩 표현식을 평가하지 않습니다.
변수 정의가 없거나 빈 목록인 기존 템플릿은 중괄호와 본문을 그대로 유지합니다.

개정 이력에서 보관된 내용을 미리 보고 새 개정으로 복원합니다. 새 템플릿은 개정 1로
시작하며 기존 템플릿은 개정 1로 취급하고 첫 편집 때 기록합니다. 템플릿별 한도와
전체 한도가 함께 적용되므로 오래된 템플릿에는 20개보다 적은 이력이 남을 수 있습니다.
템플릿을 삭제하면 해당 이력도 삭제합니다.

#### 컨텍스트 묶음

**컨텍스트 묶음**에서 이름을 정하고 필요하면 프로젝트와 지시사항을 추가합니다.
세션 리더의 메시지에서 **컨텍스트 묶음에 추가**를 선택하고 저장할 묶음을 고르거나
새로 만든 뒤 원본 범위를 확인해 저장합니다.

묶음 선택기는 프로젝트가 없는 묶음까지 모든 묶음을 기본으로 표시합니다.
현재 프로젝트가 있는 선택기에서 **현재 프로젝트만 표시**를 켜면 목록을 좁힙니다.
필터나 페이지를 바꿔도 이미 선택한 묶음은 유지합니다.

인용 창의 시작 위치와 길이는 원본 메시지의 0부터 시작하는 UTF-16 단위입니다.
축약된 검색 미리보기에는 원본의 `contentOffset`이 포함되며 초기 인용 범위는
그 위치부터 최대 8,000단위입니다. 범위는 직접 바꿀 수 있습니다. 화면의 미리보기
본문은 원본 텍스트로 서버에 보내지 않습니다. 서버는 ID로 선택한 메시지를 읽고
서로게이트 쌍을 나누거나 메시지를 벗어나는 범위를 거절합니다.

저장한 인용 본문과 출처는 변경되지 않는 스냅샷입니다. 원본 세션과 메시지 ID,
에이전트, 세션 제목, 역할, 메시지 시각, 인용 시각과 범위를 포함합니다.
이후 원본을 수정해도 스냅샷은 바뀌지 않습니다. 원본 사용 가능 여부는 ID가 아직
있는지만 확인하며 본문이 같다는 뜻은 아닙니다. 원본을 찾지 못해도 저장한 인용은
유지합니다.

항목 이름을 바꾸고 사용자 메모를 추가하거나 편집하며 항목을 삭제하고 순서를
저장합니다. 인용 본문은 읽기 전용입니다. 조합이나 내보내기 전에는 작성 중인
묶음 정보, 메모와 순서 변경을 저장합니다.

조합 결과에서 지시사항, 선택한 모든 항목과 출처를 확인하고 프롬프트를 복사합니다.
Markdown이나 JSON으로 내보내거나 읽기 전용 실행 초안을 준비할 수도 있습니다.
저장한 텍스트를 로컬에서 합치는 기능이며 AI 요약이 아닙니다. 문자 수는 토큰
추정값이 아닙니다. 한도를 넘으면 항목을 몰래 생략하지 않고 조합을 거절합니다.

실행 창에서 묶음을 최대 5개 고르고 **선택한 컨텍스트 추가**를 누릅니다. 새로
선택한 묶음의 조합이 끝나야 프롬프트를 바꿉니다. 실패, 취소나 조합 중 초안 변경이
발생하면 기존 프롬프트를 유지합니다. 이미 추가한 묶음은 선택을 해제했다가 다시
골라도 본문을 중복해서 붙이지 않습니다. 템플릿을 적용해 프롬프트를 교체했다면
선택한 컨텍스트를 다시 추가합니다. 직접 편집한 프롬프트는 입력한 대로 유지하며
묶음 참조를 제거해도 현재 본문을 고치지 않습니다. 이후 묶음이 바뀌어도 열린 실행
초안을 자동으로 고치지 않습니다. 명령 미리보기와 명시적인 실행 시작은 그대로 거칩니다.

#### 저장 검색과 명령 팔레트

**세션**에서 검색어, 필터, 정렬과 페이지 크기를 정한 뒤 **현재 조건 저장**을
선택합니다. 이름을 붙이고 전체 기간, 오늘, 최근 7일, 최근 30일이나 직접 지정
기간을 고릅니다. 도구 모음에서 열기, 이름과 조건 수정, 고정, 삭제를 사용합니다.
기존 검색을 편집할 때 저장 조건을 현재 세션 필터로 바꾸려면 **현재 세션 조건 가져오기**를 선택합니다.

저장 검색을 열면 현재 세션 조건을 교체하고 첫 페이지로 돌아갑니다. 페이지 위치는
저장하지 않습니다. 상대 기간은 열 때 브라우저의 현지 날짜와 일광절약시간을 반영해
계산합니다. 최근 7일은 오늘과 앞선 6일, 최근 30일은 오늘과 앞선 29일을 포함합니다.
직접 지정 기간은 기존 세션 API의 날짜 규칙을 따르며 날짜만 지정한 종료일은
UTC 기준 해당 날짜의 끝까지 포함합니다.

`Ctrl/Cmd + K`로 팔레트를 열고 방향키와 Enter로 페이지, 작업, 고정 검색,
프로젝트나 템플릿을 선택합니다. Escape로 닫습니다. 프로젝트 바로가기는 관련
세션을 열고 템플릿 바로가기는 실행을 준비합니다. 팔레트 선택만으로 에이전트를
시작하지 않습니다.

팔레트는 입력 후 220 ms를 기다린 뒤 세션과 작업을 각각 최대 5개 조회합니다.
일치하는 고정 검색은 최대 8개, 검색 중에는 기존 메타데이터에서 프로젝트와
템플릿 바로가기를 각각 5개까지 표시합니다. 전체 검색 동작은 페이지별 조회가
가능한 작업센터나 세션 화면을 엽니다.

### 주요 결정

#### 한도와 페이지 조회

아래 문자 한도는 JavaScript 문자열과 같은 UTF-16 단위를 사용합니다. 원본 인용
한도는 바이트 기준입니다. 앱의 처리 한도이며 모델의 토큰 한도가 아닙니다.

| 영역 | 한도 |
|---|---|
| 작업 | 보관한 작업을 포함해 10,000개, 제목 200자, 설명과 다음 할 일 각각 8,000자 |
| 작업 참조 | 작업당 중복 없는 세션 ID 20개, 컨텍스트 묶음 ID 5개 |
| 컨텍스트 묶음 | 200개, 이름 200자, 설명 500자, 지시사항 8,000자 |
| 컨텍스트 항목 | 묶음당 20개, 인용이나 메모당 8,000자, 묶음의 항목 본문 합계 48,000자 |
| 인용 원본 | 직렬화된 원본 메시지당 8 MiB, 선택한 메시지만 읽음 |
| 조합 결과와 실행 프롬프트 | 묶음별 조합과 최종 실행 프롬프트 각각 64,000자, 실행당 연결 묶음 최대 5개 |
| 템플릿 입력 | 변수 20개, ASCII 식별자 이름 40자, 표시 이름 200자, 도움말 500자, 값과 기본값, 선택지 각각 8,000자, 선택 입력의 중복 없는 선택지 1-50개 |
| 템플릿 본문과 이력 | 저장 프롬프트 32,000자, 완성 프롬프트 64,000자, 템플릿별 개정 최대 20개와 전체 1,000개 |
| 저장 검색 | 50개, 이름 120자, 세션 페이지 크기 1-200, 페이지 위치 저장 제외 |

작업과 묶음 목록은 요청당 기본 25개, 최대 100개를 반환합니다. 작업 검색어는
200자, 페이지 위치는 0-1,000,000이며 묶음 검색어는 500자, 페이지 위치는 0-200입니다.
작업 목록에는 짧은 미리보기만 담고 묶음 목록에서는 지시사항과 항목 본문을 제외합니다.
저장 검색은 최대 50개의 메타데이터만 반환하며 검색 실행이나 결과 건수 계산을 하지
않습니다. 이 목록들은 bootstrap에 추가하지 않으며 템플릿만 새로고침할 때는 기존
템플릿 목록을 별도로 읽습니다.

#### 초안, 충돌과 명시적인 실행

열린 편집 창은 초안의 버전이나 개정 번호를 유지합니다. 백그라운드 메타데이터
갱신은 목록을 바꾸지만 저장하지 않은 입력을 새 버전에 맞춰 몰래 바꾸지 않습니다.
오래된 작업, 묶음과 저장 검색의 변경 요청은 부분 저장 없이 HTTP 409를 반환합니다.
새 템플릿 클라이언트는 `expectedRevision`을 보내며 기존 PATCH 클라이언트는 생략할
수 있습니다. 템플릿 복원에는 현재 예상 개정 번호가 필요합니다. 템플릿 삭제는
버전을 받지 않는 기존 계약을 유지합니다.

최신 내용을 직접 다시 불러오면 초안을 교체하므로 필요한 수정은 먼저 복사해 둡니다.
충돌 내용을 살펴보고 직접 조정합니다. UI는 새 버전으로 변경 요청을 자동 재시도하지
않습니다. 새로고침 중 초안 보존은 브라우저를 다시 로드하거나 대화창을 닫은 뒤에도
저장하지 않은 텍스트를 보관한다는 뜻은 아닙니다.

실행을 준비하는 동안 선택한 템플릿 스냅샷, 편집한 프롬프트와 작업 버전을 유지합니다.
내용이 바뀌면 확인한 명령 미리보기를 무효화하며 실행 시작에는 해당 미리보기의 요청을
사용합니다. 서버는 실행 생성 시 작업 연결을 다시 검사합니다. 실행에 붙인 ID는
참조 기록이며 실행 API에 템플릿 치환이나 컨텍스트 재조합을 요청하지 않습니다.

`Ctrl/Cmd + K`의 템플릿 바로가기 등에서 새 실행을 준비하면 기존 폼과 명령
미리보기를 새 폼으로 교체합니다.

#### 저장, 개인정보와 새로고침

서비스는 기존 SQLite 연결의 작은 확장 테이블을 사용하며 지원 스키마 버전은 4를
유지합니다. 초기화 시 원본 메시지, 지문, 검색 본문이나 사용자 정리 정보를 전체
탐색하거나 다시 쓰지 않습니다. 의존성, 자동 추론, 텔레메트리나 저장 검색의
백그라운드 실행을 추가하지 않습니다. 데모 메타데이터는 별도 저장소를 사용하며
에이전트를 시작할 수 없습니다.

저장한 인용과 메모에는 민감한 텍스트가 들어 있을 수 있습니다. 조합과 내보내기는
문자열 값에 `server/privacy.ts`의 현재 규칙을 적용하고 저장된 스냅샷은 유지합니다.
`redacted`는 규칙이 텍스트를 바꿨다는 표시이며 모든 비밀을 찾았다는 보증은 아닙니다.
공유 전에 결과를 확인하세요. JSON에는 마스킹된 묶음, Markdown에는 조합한 프롬프트를
담습니다.

새 경로도 루트 API의 Host, Origin, 로컬 피어, 변경 요청 헤더와 설정된 프록시
검사를 따릅니다. 공통 브라우저 요청 함수는 타입과 HTTP 상태를 유지해 충돌을 처리합니다.
작은 `productivity-change` SSE 메시지는 변경 종류만 전달합니다. 기능별 화면은
범위를 제한한 메타데이터를 갱신하고 템플릿 변경은 전체 이력 대신 템플릿 목록만
다시 읽습니다. 기존 실행, 재접속과 주기적인 새로고침은 별도로 유지합니다.

### 코드 위치

경로는 소스 체크아웃 기준입니다. 설치 압축 파일에는 `dist/`의 빌드 코드와 공개
문서가 들어 있습니다.

| 영역 | 소스 |
|---|---|
| 작업 계약, 서비스와 경로 | `shared/work-items.ts`, `server/productivity/work-items.ts`, `server/productivity/work-item-routes.ts` |
| 템플릿 정의와 이력 | `shared/template-fields.ts`, `server/productivity/templates.ts`, `src/features/template-fields/` |
| 컨텍스트 인용, 저장과 출력 | `shared/context-packs.ts`, `server/productivity/context-packs.ts`, `server/productivity/context-packs/`, `server/productivity/context-pack-routes.ts` |
| 저장 조건과 날짜 범위 | `shared/saved-views.ts`, `server/productivity/saved-views.ts`, `src/features/saved-views/` |
| 실행 연결과 준비 내용 보존 | `server/app.ts`, `server/runner.ts`, `server/commands.ts`, `src/features/runs/RunContextModel.ts`, `src/features/runs/RunContextCompile.ts` |
| 화면과 새로고침 | `src/pages/WorkItems.tsx`, `src/pages/ContextPacks.tsx`, `src/features/sessions/SessionReader.tsx`, `src/components/CommandPalette.tsx`, `src/state/AppProvider.tsx` |

기능 테이블은 `productivity_work_items`, `productivity_context_packs`,
`productivity_context_pack_items`, `productivity_saved_views`,
`productivity_template_revisions`입니다.

### 관련 문서

- [README 사용 순서](../../README.md#생산성-기능-사용-순서): 짧은 사용 동선.
- [API 계약](../api.md#productivity-workspace): 실제 요청과 응답 형태, 입력 검증과 SSE.
- [운영](../operations.md#생산성-작업-공간): 저장, 충돌과 실행 준비 문제 해결.
- [문서 색인](../README.md#한국어)과 [구현 지도](INDEX.md#한국어).
