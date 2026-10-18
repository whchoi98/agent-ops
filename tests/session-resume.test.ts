import { describe, expect, it } from 'vitest';
import { RESUME_BLOCK_MESSAGES, resumeBlock } from '../src/features/sessions/resume';
import { UI_EN_MESSAGES } from '../src/i18n/ui.en';

describe('session resume availability', () => {
  const supported = { supportsResume: true };

  it.each([
    { session: { resumable: undefined, sourceAvailable: true }, connector: supported, block: null },
    { session: { resumable: undefined, sourceAvailable: undefined }, connector: supported, block: null },
    { session: { resumable: undefined, sourceAvailable: false }, connector: supported, block: 'source-missing' },
    { session: { resumable: undefined, sourceAvailable: false }, connector: undefined, block: 'source-missing' },
    { session: { resumable: false, sourceAvailable: false }, connector: supported, block: 'unsupported' },
    { session: { resumable: false, sourceAvailable: true }, connector: supported, block: 'unsupported' },
    { session: { resumable: undefined, sourceAvailable: true }, connector: { supportsResume: false }, block: 'unsupported' },
  ] as const)('reports $block for $session with $connector', ({ session, connector, block }) => {
    expect(resumeBlock(session, connector)).toBe(block);
  });

  it('treats a session that is still loading as not resumable', () => {
    expect(resumeBlock(undefined, supported)).toBe('unsupported');
  });

  it('has an English translation for every resume explanation', () => {
    const sources = Object.values(RESUME_BLOCK_MESSAGES).flatMap(message => [message.title, message.notice]);
    expect(sources).toHaveLength(4);
    expect(sources.filter(source => !UI_EN_MESSAGES[source])).toEqual([]);
  });
});
