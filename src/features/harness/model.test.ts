import { expect, test } from 'vitest';
import { isEditablePolicy, parseToolInput, previewBlockReason, runtimeState, settingsInput } from './model';
import { harnessProject, hookPreview, policy, runtime, settings } from './testFixtures';

test('tool input accepts only bounded JSON objects and preserves literal command text', () => {
  expect(parseToolInput('{"command":"$(literal) `pwd` <script>"}')).toEqual({ command: '$(literal) `pwd` <script>' });
  for (const value of ['null', '[]', '5', '"text"', '{"broken":}']) expect(() => parseToolInput(value)).toThrow();
  expect(() => parseToolInput(JSON.stringify({ text: '한'.repeat(22000) }))).toThrow();
});

test('tool input rejects non-finite numbers and structures that the API cannot evaluate faithfully', () => {
  for (const input of ['{"number":1e999}', '{"__proto__":{}}', '{"value":"\\u0000"}']) {
    expect(() => parseToolInput(input)).toThrow();
  }
  expect(() => parseToolInput('{"a":'.repeat(26) + 'null' + '}'.repeat(26))).toThrow();
});

test('Python 3.9 remains visibly unsupported even when an observed engine version exists', () => {
  expect(runtimeState(runtime({ state: 'ready', pythonVersion: '3.9.25' }))).toBe('unsupported');
  expect(runtimeState(runtime({ pythonVersion: '3.10.0' }))).toBe('ready');
  expect(runtimeState(runtime({ state: 'missing', pythonVersion: null }))).toBe('missing');
});

test('editing requires an unredacted app-owned policy in the current scope', () => {
  expect(isEditablePolicy(policy(), harnessProject.id)).toBe(true);
  expect(isEditablePolicy(policy({ scope: 'user' }), harnessProject.id)).toBe(false);
  expect(isEditablePolicy(policy({ redacted: true }), harnessProject.id)).toBe(false);
  expect(isEditablePolicy(policy({ projectId: null }), harnessProject.id)).toBe(false);
  expect(isEditablePolicy(policy({ projectId: null }), undefined)).toBe(true);
});

test('expired, mismatched and blocked previews cannot be applied', () => {
  const request = { projectId: harnessProject.id, client: 'codex' as const, action: 'install' as const };
  expect(previewBlockReason(hookPreview(), request, Date.parse('2026-09-26'))).toBeNull();
  expect(previewBlockReason(hookPreview({ expiresAt: '2020-01-01' }), request, Date.parse('2026-09-26'))).toBeTruthy();
  expect(previewBlockReason(hookPreview({ expiresAt: 'not-a-date' }), request, Date.now())).toBeTruthy();
  expect(previewBlockReason(hookPreview({ projectId: 'other' }), request, Date.now())).toBeTruthy();
  expect(previewBlockReason(hookPreview({ client: 'kiro-cli' }), request, Date.now())).toBeTruthy();
  expect(previewBlockReason(hookPreview({ canApply: false }), request, Date.now())).toBeTruthy();
});

test('settings keep their original revision, bound Python paths and reject fractional retention values', () => {
  expect(settingsInput(settings(), { pythonPath: '/opt/python', retentionDays: '60', maxCacheRecords: '4000' })).toEqual({
    revision: 1, pythonPath: '/opt/python', retentionDays: 60, maxCacheRecords: 4000,
  });
  expect(settingsInput(settings(), { pythonPath: '', retentionDays: '30', maxCacheRecords: '2000' }).pythonPath).toBeNull();
  expect(() => settingsInput(settings(), { pythonPath: 'a'.repeat(4097), retentionDays: '30', maxCacheRecords: '2000' })).toThrow();
  expect(() => settingsInput(settings(), { pythonPath: '', retentionDays: '1.5', maxCacheRecords: '2000' })).toThrow();
  expect(() => settingsInput(settings(), { pythonPath: 'relative/python', retentionDays: '30', maxCacheRecords: '2000' })).toThrow();
  expect(() => settingsInput(settings(), { pythonPath: '', retentionDays: '91', maxCacheRecords: '2000' })).toThrow();
  expect(() => settingsInput(settings(), { pythonPath: '', retentionDays: '30', maxCacheRecords: '99' })).toThrow();
});
