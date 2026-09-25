import type { Agent, ImportedSession, Message, PromptTemplate, Run } from '../shared/types.js';
import { AGENTS, emptyUsage } from '../shared/types.js';
import type { Store } from './store.js';

export function seedTemplates(store: Store) {
  if (store.getMeta('templates-initialized')) return;
  const specs: Array<Omit<PromptTemplate, 'id' | 'updatedAt'>> = [
    { name: '변경 사항 리뷰', description: '변경된 코드의 결함과 회귀 위험을 근거와 함께 검토합니다.', category: 'review', agent: 'any', policy: 'read-only',
      prompt: '현재 프로젝트의 git diff를 검토해 주세요. 실제 결함과 회귀 위험을 우선하고 파일과 위치, 재현 조건을 설명해 주세요. 변경하지 말고 확인된 사실과 미확인 사항을 구분해 주세요.' },
    { name: '실패 원인 조사', description: '증상부터 재현, 원인, 수정 제안까지 차례로 조사합니다.', category: 'debug', agent: 'any', policy: 'read-only',
      prompt: '프로젝트의 실패하는 테스트 또는 오류를 조사해 주세요. 관련 코드를 읽고 재현 조건과 근본 원인을 찾은 뒤 최소 수정안과 검증 방법을 제시해 주세요. 우선 조사만 수행해 주세요.\n\n조사할 증상: ' },
    { name: '회귀 테스트 추가', description: '확인된 동작을 보호하는 테스트를 작성하고 검증합니다.', category: 'build', agent: 'any', policy: 'workspace-write',
      prompt: '최근 변경 사항을 읽고 주요 동작을 보호하는 회귀 테스트를 추가해 주세요. 기존 테스트 패턴을 따르고 구현을 그대로 반복하는 테스트는 피하세요. 가능한 테스트를 실행하고 결과와 실행하지 못한 검증을 구분해 보고해 주세요.' },
    { name: '운영 문서 동기화', description: '실제 코드와 실행 명령을 기준으로 문서를 갱신합니다.', category: 'docs', agent: 'any', policy: 'workspace-write',
      prompt: 'README와 운영 문서를 현재 코드에 맞게 갱신해 주세요. 설치, 실행, 설정, 검증, 문제 해결을 포함하세요. 존재하지 않는 명령이나 미검증 기능을 문서에 추가하지 말고 변경 근거를 확인해 주세요.' },
    { name: '인계 전 점검', description: '다음 에이전트가 이어갈 수 있도록 현재 상태를 정리합니다.', category: 'review', agent: 'any', policy: 'read-only',
      prompt: '현재 프로젝트의 작업 상태를 확인하고 인계 메모를 작성해 주세요. 목표, 변경된 파일, 완료된 검증, 남은 문제, 다음에 수행할 구체적인 작업을 포함하세요. 비밀키나 인증 정보는 포함하지 마세요.' },
    { name: '기능 구현', description: '요구사항과 기존 구조를 확인하고 기능을 완성합니다.', category: 'build', agent: 'any', policy: 'workspace-write',
      prompt: '아래 기능을 현재 프로젝트의 구조와 스타일에 맞게 구현해 주세요. 필요한 동작 테스트를 추가하고 실제 검증 결과를 보고해 주세요. 기존 사용자 변경을 유지하세요.\n\n구현할 기능: ' },
  ];
  specs.forEach((spec, i) => store.saveTemplate({ ...spec, id: `template-${i + 1}`, updatedAt: new Date().toISOString() }));
  store.setMeta('templates-initialized', true);
}

export function seedDemo(store: Store) {
  if (store.getMeta('demo-seeded')) return;
  const projects = [
    { path: '/workspace/commerce-api', name: 'commerce-api', color: '#3564e8' },
    { path: '/workspace/atlas-web', name: 'atlas-web', color: '#0e9f8f' },
    { path: '/workspace/platform-infra', name: 'platform-infra', color: '#8b5cf6' },
    { path: '/workspace/design-system', name: 'design-system', color: '#d88756' },
  ].map((project) => store.saveProject({ ...store.ensureProject(project.path, project.name), color: project.color, executionEnabled: true }));
  const titles = [
    '결제 웹훅의 중복 이벤트 처리 개선',
    '검색 결과 페이지의 접근성 점검',
    '배포 파이프라인 캐시 실패 원인 조사',
    'Button 컴포넌트의 키보드 탐색 수정',
    'API 응답 캐시와 만료 정책 검토',
    '워크스페이스 전환 흐름 구현',
    '서비스 권한 정책 최소화 검토',
    '테이블 컴포넌트 회귀 테스트 추가',
    '주문 조회 페이지 성능 개선',
    '검색 필터 URL 동기화',
    '컨테이너 헬스 체크 실패 분석',
    '디자인 토큰 다크 모드 정리',
  ];
  const now = Date.now();
  for (let i = 0; i < 84; i++) {
    const agent = AGENTS[(i + Math.floor(i / 7)) % 3];
    const project = projects[i % projects.length];
    const date = new Date(now - (Math.floor(i / 3) * 24 * 60 + (i % 3) * 65 + 8) * 60000);
    const end = new Date(date.getTime() + (4 + i % 9) * 60000);
    const id = `demo-${agent}-${String(i + 1).padStart(3, '0')}`;
    const messages: Message[] = [
      { id: `${id}-u1`, role: 'user', content: `${titles[i % titles.length]} 작업을 진행해 주세요. 현재 코드와 테스트를 먼저 확인하고 필요한 변경과 검증 결과를 정리해 주세요.`, timestamp: date.toISOString() },
      { id: `${id}-a1`, role: 'assistant', content: '먼저 관련 모듈과 테스트를 확인하겠습니다. 기존 동작을 유지하면서 변경 범위를 좁히고, 재현 가능한 검증부터 진행합니다.', timestamp: new Date(date.getTime() + 20000).toISOString() },
      { id: `${id}-c1`, role: 'assistant', toolName: ['read_file', 'Read', 'fs_read'][AGENTS.indexOf(agent)], content: '{"path":"src/services/webhook.ts"}', timestamp: new Date(date.getTime() + 30000).toISOString() },
      { id: `${id}-t1`, role: 'tool', toolName: ['read_file', 'Read', 'fs_read'][AGENTS.indexOf(agent)], content: `src/${i % 2 ? 'components/SearchPanel.tsx' : 'services/webhook.ts'}\n\nexport async function handleEvent(event: Event) {\n  const existing = await findEvent(event.id);\n  if (existing) return { status: 'already_processed' };\n  return processEvent(event);\n}`, timestamp: new Date(date.getTime() + 35000).toISOString() },
      { id: `${id}-a2`, role: 'assistant', content: '현재 구현을 확인했습니다. 동시에 들어오는 요청을 처리할 때 동일한 이벤트가 두 번 실행될 수 있어, 처리 상태를 원자적으로 기록하는 방식으로 수정 범위를 정했습니다.', timestamp: new Date(date.getTime() + 60000).toISOString() },
      { id: `${id}-c2`, role: 'assistant', toolName: ['exec_command', 'Bash', 'execute_bash'][AGENTS.indexOf(agent)], content: '{"command":"npm test"}', timestamp: new Date(date.getTime() + 90000).toISOString() },
      { id: `${id}-t2`, role: 'tool', toolName: ['exec_command', 'Bash', 'execute_bash'][AGENTS.indexOf(agent)], content: i % 17 === 8 ? 'FAIL tests/integration.test.ts\nExpected idempotency key to be unique.\n1 failed, 23 passed.' : 'PASS tests/unit.test.ts\nPASS tests/integration.test.ts\n24 tests passed. Duration 1.82s.', isError: i % 17 === 8, timestamp: new Date(date.getTime() + 120000).toISOString() },
      { id: `${id}-a3`, role: 'assistant', content: i % 17 === 8
        ? '통합 테스트에서 동시 요청 처리 실패를 재현했습니다. 유니크 키 충돌 이후의 재시도 분기를 더 확인해야 합니다. 현재 결과를 저장했으며 수정이 완료됐다고 판단하지 않았습니다.'
        : '### 변경 결과\n\n- 기존 응답 형식과 동작을 유지했습니다.\n- 중복 요청을 처리하는 분기를 명확히 했습니다.\n- 정상 요청, 재시도, 동시 요청을 검증하는 테스트를 추가했습니다.\n\n```text\n24 tests passed\nType check completed\n```\n\n실제 배포 환경 검증은 별도로 필요합니다. 다음 작업자는 변경된 테스트와 현재 워크스페이스 상태부터 확인할 수 있습니다.',
        timestamp: end.toISOString() },
    ];
    const session: ImportedSession = {
      id, nativeId: `sample-${i + 1}`, agent, title: titles[i % titles.length],
      projectPath: project.path, projectName: project.name,
      model: agent === 'codex' ? 'codex-default' : agent === 'claude' ? 'claude-default' : 'kiro-default',
      startedAt: date.toISOString(), updatedAt: end.toISOString(),
      status: i % 17 === 8 ? 'failed' : i % 13 === 9 ? 'recorded' : 'completed',
      messageCount: messages.length, toolCallCount: 2,
      usage: {
        inputTokens: 5000 + (i * 741) % 48000, outputTokens: 700 + (i * 397) % 9200,
        cacheReadTokens: 2000 + (i * 521) % 2900, cacheWriteTokens: agent === 'claude' ? 600 + i * 13 : null,
        costUsd: agent === 'claude' ? Math.round((0.1 + (i % 11) * 0.043) * 1000) / 1000 : null,
      },
      sourcePath: `demo://${agent}/${id}`, messages,
    };
    store.upsertSession(session);
    if (i < 12 && i % 3 === 0) store.patchSession(id, { bookmarked: true, tags: ['review', 'release'], note: '다음 배포 전에 회귀 테스트 결과를 다시 확인합니다.' });
    else if (i % 5 === 0) store.patchSession(id, { tags: ['performance'] });
  }
  const parent = store.allSessions().find((session) => session.agent === 'claude')!;
  const childId = `${parent.id}:subagent:review`;
  const childStarted = new Date(Date.parse(parent.startedAt) + 20000).toISOString();
  const childFinished = new Date(Date.parse(parent.updatedAt) - 1000).toISOString();
  store.upsertSession({
    id: childId, nativeId: 'sample-subagent-review', agent: 'claude',
    title: `하위 검토 · ${parent.title}`, projectPath: parent.projectPath, projectName: parent.projectName,
    model: parent.model, startedAt: childStarted, updatedAt: childFinished, status: 'recorded',
    messageCount: 4, toolCallCount: 1, usage: emptyUsage(), sourcePath: 'demo://claude/subagent-review',
    parentId: parent.id, resumable: false,
    messages: [
      { id: 'child-user', role: 'user', content: '담당 컴포넌트의 접근성과 키보드 탐색을 검토하고 부모 작업에 결과를 전달하세요.', timestamp: childStarted },
      { id: 'child-call', role: 'assistant', toolName: 'Read', content: '{"path":"src/components/SearchPanel.tsx"}', timestamp: childStarted },
      { id: 'child-result', role: 'tool', toolName: 'Read', content: '검토할 컴포넌트와 관련 테스트를 읽었습니다.', timestamp: childStarted },
      { id: 'child-assistant', role: 'assistant', content: '키보드 탐색과 포커스 복원 검증을 부모 작업에 전달했습니다. 이 샘플 기록에는 사용량이 포함되어 있지 않습니다.', timestamp: childFinished },
    ],
  });
  store.patchSession(childId, { tags: ['subagent'] });
  const longStarted = new Date(now - 20 * 86400000).toISOString();
  const longMessages: Message[] = Array.from({ length: 180 }, (_, i) => ({
    id: `long-message-${i}`,
    role: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'tool',
    ...(i % 3 ? { toolName: 'read' } : {}),
    content: i === 80
      ? '[sample] Service readiness check passed.\n'.repeat(1800) + '\n후반부 점검 결과: 모든 점검 항목을 확인했습니다.'
      : `점검 ${i + 1}: 샘플 서비스의 상태와 기록을 확인합니다.`,
    timestamp: new Date(Date.parse(longStarted) + i * 60000).toISOString(),
  }));
  store.upsertSession({
    id: 'demo-kiro-long', nativeId: 'sample-long-history', agent: 'kiro',
    title: '대규모 로그 점검 기록', projectPath: projects[2].path, projectName: projects[2].name,
    model: 'kiro-default', startedAt: longStarted, updatedAt: longMessages.at(-1)!.timestamp,
    status: 'recorded', messageCount: longMessages.length, toolCallCount: 60,
    usage: emptyUsage(), sourcePath: 'demo://kiro/long-history', resumable: false,
    messages: longMessages,
  });
  store.patchSession('demo-kiro-long', { tags: ['긴기록'], note: '긴 기록에서 페이지 탐색, 전체 검색, 메시지 펼치기를 확인할 수 있는 샘플입니다.' });
  const runSpecs: Array<{ agent: Agent; title: string; status: Run['status'] }> = [
    { agent: 'codex', title: '결제 웹훅 회귀 테스트', status: 'completed' },
    { agent: 'claude', title: '검색 컴포넌트 접근성 리뷰', status: 'completed' },
    { agent: 'kiro', title: '배포 파이프라인 점검', status: 'failed' },
    { agent: 'codex', title: '디자인 토큰 정리', status: 'cancelled' },
  ];
  runSpecs.forEach((spec, i) => {
    const project = projects[i];
    const createdAt = new Date(now - (55 - i * 8) * 60000).toISOString();
    const run: Run = {
      ...spec, id: `demo-run-${i + 1}`, projectId: project.id, projectName: project.name, projectPath: project.path,
      prompt: `${spec.title} 작업을 수행하고 결과를 정리해 주세요.`, policy: 'read-only',
      createdAt, startedAt: createdAt, finishedAt: new Date(new Date(createdAt).getTime() + 180000).toISOString(),
      exitCode: spec.status === 'completed' ? 0 : spec.status === 'failed' ? 1 : null,
      error: spec.status === 'failed' ? 'Sample: integration test failed. Review the output before retrying.' : null,
      nativeSessionId: `sample-run-${i}`, usage: emptyUsage(), command: `${spec.agent === 'kiro' ? 'kiro-cli chat' : spec.agent} [demo preview]`,
    };
    store.insertRun(run);
    store.appendEvent(run.id, 'system', 'Sample execution record. No CLI was started.');
    store.appendEvent(run.id, 'stdout', `Inspecting project ${project.name}…`);
    store.appendEvent(run.id, 'stdout', spec.status === 'completed' ? '24 tests passed. Review completed.' : 'Integration test needs further investigation.');
    if (spec.status === 'failed') store.appendEvent(run.id, 'stderr', 'FAIL deploy/cache.test.ts: missing cache namespace');
  });
  store.setMeta('demo-seeded', true);
}
