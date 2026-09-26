import { useMemo } from 'react';
import { createNoticeTranslator, translate, type MessageValues } from '../../i18n/core';
import { useTemplateFieldsI18n } from '../template-fields/i18n';
import { useContextPackI18n } from '../context-packs/i18n';

const messages: Readonly<Record<string, string>> = {
  '템플릿 입력을 먼저 적용한 뒤 명령을 미리 보세요.': 'Apply template inputs before previewing the command.',
  '템플릿이 적용된 프롬프트입니다. 내용을 직접 수정할 수 있습니다.': 'The template is already applied. You can edit the prompt directly.',
  '변수 값 다시 입력': 'Enter variables again',
  '선택한 템플릿을 찾을 수 없습니다. 직접 작성을 선택하거나 다른 템플릿을 고르세요.': 'The selected template is unavailable. Choose direct writing or another template.',
  '컨텍스트 연결': 'Context references',
  '선택한 컨텍스트 추가': 'Add selected context',
  '컨텍스트 조합 중…': 'Compiling context…',
  '조합 취소': 'Cancel compilation',
  '취소했습니다. 프롬프트와 선택한 연결은 그대로 유지됩니다.': 'Cancelled. Your prompt and selected references are unchanged.',
  '{count}개 연결 · {pending}개 추가 대기': '{count} references · {pending} awaiting insertion',
  '연결을 제거해도 프롬프트 본문은 지우지 않습니다. 필요한 내용은 직접 편집하세요.': 'Removing a reference keeps the prompt text. Edit the text yourself if needed.',
  '이미 추가한 묶음은 다시 선택해도 본문을 중복해서 추가하지 않습니다.': 'Previously inserted packs are not appended again when reselected.',
  '선택한 컨텍스트를 추가한 뒤 명령을 미리 보세요.': 'Add the selected context before previewing the command.',
  '컨텍스트 연결은 중복 없이 최대 5개까지 선택하세요.': 'Select at most five distinct context references.',
  '조합한 컨텍스트 응답을 확인할 수 없습니다. 다시 시도하세요.': 'The compiled context response could not be verified. Try again.',
  '컨텍스트를 포함한 프롬프트는 64,000자 이하여야 합니다.': 'The prompt including context must be at most 64,000 characters.',
  '프롬프트는 64,000자 이하여야 합니다.': 'The prompt must be at most 64,000 characters.',
  '초안이 변경되었습니다. 현재 내용을 유지한 채 컨텍스트를 다시 조합하세요.': 'The draft changed. Compile context again using the current draft.',
  '프로젝트가 지정된 작업은 원래 프로젝트에 연결됩니다.': 'This work item remains linked to its original project.',
  '작업에서 준비한 실행입니다. 준비한 작업 버전으로 결과를 연결합니다.': 'This run was prepared from a work item. Its result will link using the prepared work-item version.',
  '작업이 변경되었을 수 있습니다. 초안은 유지되며, 작업의 최신 상태를 확인한 뒤 다시 준비할 수 있습니다.': 'The work item may have changed. Your draft is preserved; check the latest work-item state before preparing another run.',
  '미리보기 취소': 'Cancel preview',
  '미리보기를 취소했습니다. 작성 중인 초안은 그대로 유지됩니다.': 'Preview cancelled. Your current draft is unchanged.',
};
const korean = Object.fromEntries(Object.entries(messages).map(([source, target]) => [target, source]));

export function useRunContextI18n() {
  const template = useTemplateFieldsI18n();
  const context = useContextPackI18n();
  return useMemo(() => {
    const localNotice = createNoticeTranslator(template.language, messages, korean);
    return {
      language: template.language,
      t: (source: string, values?: MessageValues) => Object.hasOwn(messages, source)
        ? translate(template.language, source, messages, values) : template.t(source, values),
      notice: (source: string) => {
        const local = localNotice(source);
        return local === source ? context.notice(template.notice(source)) : local;
      },
    };
  }, [template, context]);
}
