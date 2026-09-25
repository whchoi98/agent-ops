import type { Project } from '../../shared/types.js';
import type { ExtensionCandidate } from './types.js';

export interface DemoExtension { candidate: ExtensionCandidate; documents: Record<string, string> }

export function demoExtensions(project: Pick<Project, 'id' | 'name' | 'path'> | null): DemoExtension[] {
  const definitions: DemoExtension[] = [];
  function add(
    agent: ExtensionCandidate['agent'], kind: ExtensionCandidate['kind'], slug: string,
    name: string, status: ExtensionCandidate['status'], documents: Record<string, string>,
    extra: Partial<ExtensionCandidate> = {},
  ) {
    const rootPath = `/demo/${agent}/${slug}`;
    const entry = kind === 'skill' ? 'SKILL.md' : kind === 'power' ? 'POWER.md'
      : agent === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json';
    const candidate: ExtensionCandidate = {
      key: `demo:${agent}:${slug}`, agent, kind, name, scope: 'user', rootPath,
      path: `${rootPath}/${entry}`, status,
      statusReason: status === 'disabled' ? '데모 설정에서 비활성화한 항목입니다.'
        : status === 'unknown' ? '설치 상태만 확인되며 CLI 활성화는 확인되지 않은 샘플입니다.'
          : '기능 확인을 위한 샘플 구성입니다.',
      evidence: [{ source: `/demo/${agent}/settings`, detail: '데모 자료 · 실제 로컬 설정이 아닙니다.' }],
      ...extra,
    };
    definitions.push({ candidate, documents });
    return candidate;
  }
  add('codex', 'skill', 'code-review', '코드 리뷰', 'available', {
    'SKILL.md': '---\nname: 코드 리뷰\ndescription: 변경한 코드의 정확성과 회귀 가능성을 검토합니다.\nallowed-tools: [Read, Grep]\n---\n# 코드 리뷰\n코드 검토를 요청할 때 사용합니다.\n\n## 점검 순서\n변경 범위와 회귀 테스트를 확인하세요.\n[체크리스트](references/checklist.md)를 참고하세요.',
    'references/checklist.md': '# 검토 체크리스트\n변경 범위를 먼저 확인하세요.\n회귀 테스트, 오류 처리, 권한 경계를 검토합니다.',
    'agents/openai.yaml': 'interface:\n  display_name: 코드 리뷰\npolicy:\n  allow_implicit_invocation: true',
  });
  const codexPlugin = add('codex', 'plugin', 'workspace-tools', 'workspace-tools', 'enabled', {
    '.codex-plugin/plugin.json': JSON.stringify({ name: 'workspace-tools', version: '1.0.0', description: '프로젝트 점검을 위한 스킬 모음', skills: './skills' }, null, 2),
    'skills/check/SKILL.md': '---\nname: 테스트 점검\ndescription: 테스트 누락과 실행 방법을 확인합니다.\n---\n# 테스트 점검\n테스트 정의를 읽고 빠진 조건을 보고하세요.',
  }, { version: '1.0.0' });
  add('codex', 'skill', 'workspace-tools/skills/check', 'workspace-tools:테스트 점검', 'enabled', {
    'SKILL.md': '---\nname: 테스트 점검\ndescription: 테스트 누락과 실행 방법을 확인합니다.\nallowed-tools: [Read]\n---\n# 테스트 점검\n회귀 테스트를 검토합니다.',
  }, { pluginKey: codexPlugin.key, pluginName: codexPlugin.name });
  add('claude', 'plugin', 'review-kit', 'review-kit', 'enabled', {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'review-kit', version: '1.2.0', description: '문서 검색과 검토를 묶은 데모 플러그인' }, null, 2),
    '.mcp.json': JSON.stringify({ mcpServers: { docs: { command: 'demo-docs-only', env: { DEMO_VALUE: 'sample-value-to-redact' } } } }, null, 2),
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'demo-hook-never-executed' }] }] } }, null, 2),
    'README.md': '# Review kit\n문서 검색을 위한 MCP와 읽기 전 점검 훅의 샘플 정의입니다.',
  }, { version: '1.2.0' });
  add('claude', 'skill', 'deploy-check', '배포 점검', 'disabled', {
    'SKILL.md': '---\nname: 배포 점검\ndescription: 배포 전 변경과 검증 결과를 점검합니다.\ndisable-model-invocation: true\nallowed-tools: [Read]\n---\n# 배포 점검\n배포 전 검증 요청에 사용합니다. 설정에서 비활성화한 샘플입니다.',
  });
  add('kiro', 'skill', 'docs-analysis', '문서 분석', 'available', {
    'SKILL.md': '---\nname: 문서 분석\ndescription: 설계 문서의 구조와 빠진 요구 사항을 검토합니다.\n---\n# 문서 분석\n문서 검토 요청에 사용합니다.\n## 결과\n근거와 개선 제안을 구분해서 작성하세요.',
  }, { usedBy: ['docs-agent'] });
  add('kiro', 'power', 'project-explorer', '프로젝트 탐색', 'unknown', {
    'POWER.md': '---\nname: 프로젝트 탐색\ndescription: 프로젝트 구조와 도구 구성을 이해하기 위한 Power입니다.\nkeywords: [project, architecture]\n---\n# 프로젝트 탐색\n설계와 프로젝트 탐색 요청에 참고하는 Kiro Power 예제입니다.',
    'mcp.json': JSON.stringify({ mcpServers: { projectDocs: { command: 'demo-power-never-executed' } } }, null, 2),
  });
  if (project) add('codex', 'skill', 'project-rules', '프로젝트 규칙', 'available', {
    'SKILL.md': `---\nname: 프로젝트 규칙\ndescription: 선택한 데모 프로젝트의 검토 규칙입니다.\n---\n# 프로젝트 규칙\n${project.name}의 변경 범위를 확인하세요.`,
  }, { scope: 'project' });
  return definitions;
}
