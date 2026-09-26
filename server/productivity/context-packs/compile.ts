import { redact } from '../../privacy.js';
import {
  CONTEXT_PACK_LIMITS as limits, type ContextPack, type ContextPackCompilation,
} from '../../../shared/context-packs.js';
import { problem } from '../common.js';

/** Redact string values, not serialized JSON, to keep quotes and newlines valid. */
export function cleanPack(pack: ContextPack): ContextPack {
  return JSON.parse(JSON.stringify(pack), (_key, value: unknown) => typeof value === 'string' ? redact(value) : value) as ContextPack;
}
function fenced(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}
const metadata = (text: string) => JSON.stringify(text);

export function compilePack(original: ContextPack, clean = cleanPack(original)): ContextPackCompilation {
  const sections = [
    `# Context pack: ${metadata(clean.name)}`,
    'Locally assembled from saved message excerpts and operator notes.',
    `Pack: ${clean.id}\nVersion: ${clean.version}`,
    ...(clean.projectId ? [`Project: ${metadata(clean.projectId)}`] : []),
    ...(clean.description ? [clean.description] : []),
    '## Operator instructions',
    clean.instructions || '(No additional instructions.)',
    '## Selected context',
  ];
  clean.items.forEach((item, index) => {
    sections.push(`### ${index + 1}. ${metadata(item.title)}`);
    if (item.kind === 'message') {
      const source = item.source;
      sections.push([
        'Kind: Captured message excerpt (read-only snapshot)',
        `Source session: ${metadata(source.sessionId)}`,
        `Source title: ${metadata(source.sessionTitle)}`,
        `Source message: ${metadata(source.messageId)}`,
        `Assistant: ${source.agent}`,
        `Message role: ${source.role}`,
        `Message time: ${metadata(source.messageTimestamp)}`,
        `Captured at: ${source.capturedAt}`,
        `Character range: offset ${source.offset}, length ${source.length} (UTF-16)`,
        `Source: ${item.sourceAvailable ? 'Available (may have changed since capture)' : 'Unavailable (saved excerpt retained)'}`,
      ].join('\n'));
    } else sections.push(`Kind: Operator note\nCreated at: ${item.createdAt}`);
    sections.push(fenced(item.text));
  });
  const prompt = sections.join('\n\n') + '\n';
  if (prompt.length > limits.promptChars) {
    throw problem(413, 'Compiled context exceeds 64,000 characters. Shorten instructions or remove items; nothing was omitted.');
  }
  return {
    packId: clean.id, version: clean.version, prompt, characters: prompt.length,
    itemCount: clean.items.length, redacted: JSON.stringify(original) !== JSON.stringify(clean),
  };
}
