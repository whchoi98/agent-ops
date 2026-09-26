import type { ContextPack, ContextPackCompilation, ContextPackPage } from '../../../shared/context-packs';

export function contextPack(patch: Partial<ContextPack> = {}): ContextPack {
  return {
    id: 'pack-fixture', name: '원문 pack', description: 'Original description', projectId: 'project-fixture',
    instructions: 'Keep original instructions', version: 3, itemCount: 2, totalChars: 33,
    createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T11:00:00.000Z',
    items: [
      {
        id: 'pack-item-source', kind: 'message', title: 'Source label', text: '저장한 원문 <script>text</script>',
        createdAt: '2026-09-25T10:01:00.000Z', sourceAvailable: false,
        source: {
          sessionId: 'codex:fixture', messageId: 'message-fixture', agent: 'codex',
          sessionTitle: '설정', role: 'assistant', messageTimestamp: '2026-09-25T09:00:00.000Z',
          capturedAt: '2026-09-25T10:01:00.000Z', offset: 0, length: 28,
        },
      },
      {
        id: 'pack-item-note', kind: 'note', title: 'Operator note', text: '메모 원문',
        source: null, sourceAvailable: null, createdAt: '2026-09-25T10:02:00.000Z',
      },
    ],
    ...patch,
  };
}
export function contextPackPage(): ContextPackPage {
  const { items: _items, instructions: _instructions, ...summary } = contextPack();
  return { items: [summary], total: 2, offset: 0, limit: 1 };
}
export function contextCompilation(patch: Partial<ContextPackCompilation> = {}): ContextPackCompilation {
  const prompt = '# Context pack\n\nOriginal source and instructions\n';
  return { packId: 'pack-fixture', version: 3, prompt, characters: prompt.length, itemCount: 2, redacted: false, ...patch };
}
