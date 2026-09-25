import { expect, test } from 'vitest';
import { readExtensionQuery } from './model';

test('project scope uses a registered ID and preserves the selected filters and page', () => {
  const query = readExtensionQuery(
    'agent=codex&kind=skill&status=enabled&scope=project&projectId=registered&offset=40&limit=20&q=코드+리뷰',
    [{ id: 'registered' }],
  );
  expect(query).toEqual({
    agent: 'codex', kind: 'skill', status: 'enabled', scope: 'project', projectId: 'registered',
    offset: 40, limit: 20, q: '코드 리뷰',
  });
});

test('an arbitrary path or a removed project ID cannot become a project request', () => {
  for (const projectId of ['../private', '/home/example', 'removed']) {
    const query = readExtensionQuery(`projectId=${encodeURIComponent(projectId)}&scope=project`, [{ id: 'registered' }]);
    expect(query.projectId).toBeUndefined();
    expect(query.scope).toBeUndefined();
  }
});

test('unknown query values, including inherited object keys, are not forwarded as filters', () => {
  const query = readExtensionQuery('agent=other&kind=toString&status=__proto__&scope=constructor', []);
  expect(query.agent).toBeUndefined();
  expect(query.kind).toBeUndefined();
  expect(query.status).toBeUndefined();
  expect(query.scope).toBeUndefined();
});

test('invalid page offsets and unsupported page sizes fall back to the first page', () => {
  for (const offset of ['-20', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    const query = readExtensionQuery(`offset=${offset}&limit=99999`, []);
    expect(query.offset).toBe(0);
    expect(query.limit).toBe(20);
  }
});

test('a search retains spaces while typing and cannot exceed the input length bound', () => {
  expect(readExtensionQuery('q=코드+', []).q).toBe('코드 ');
  expect(readExtensionQuery(`q=${'가'.repeat(600)}`, []).q).toHaveLength(500);
  expect(readExtensionQuery('', []).projectId).toBeUndefined();
});
