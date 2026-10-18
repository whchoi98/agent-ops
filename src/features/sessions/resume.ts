import type { ConnectorStatus, SessionDetail } from '../../../shared/types';

export type ResumeBlock = 'unsupported' | 'source-missing';

/** Korean source strings; each has an explicit English translation in ui.en.ts. */
export const RESUME_BLOCK_MESSAGES: Record<ResumeBlock, { title: string; notice: string }> = {
  unsupported: {
    title: '이 기록은 CLI에서 직접 이어갈 수 없습니다. 작업 인계를 사용하세요.',
    notice: '이 기록은 CLI에서 직접 이어갈 수 없습니다. 다른 에이전트에 맥락을 전달할 수 있습니다.',
  },
  'source-missing': {
    title: '원본 기록 파일을 찾을 수 없어 CLI에서 이어갈 수 없습니다. 작업 인계를 사용하세요.',
    notice: '기록된 경로에 원본 기록 파일이 없어 CLI에서 이어갈 수 없습니다. 파일을 옮겼다면 다시 동기화하고, 아니면 보존된 기록의 맥락을 다른 에이전트에 전달하세요.',
  },
};

/** Why a recorded session cannot start a native resume, or null when it can. */
export function resumeBlock(
  session: Pick<SessionDetail, 'resumable' | 'sourceAvailable'> | null | undefined,
  connector: Pick<ConnectorStatus, 'supportsResume'> | undefined,
): ResumeBlock | null {
  if (!session || session.resumable === false) return 'unsupported';
  if (session.sourceAvailable === false) return 'source-missing';
  return connector?.supportsResume ? null : 'unsupported';
}
