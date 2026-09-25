import { expect, it } from 'vitest';
import { apiUrl } from './urls';

it('keeps API and event requests under the served application base', () => {
  expect(apiUrl('/bootstrap', 'http://127.0.0.1:4327/')).toBe('http://127.0.0.1:4327/api/bootstrap');
  expect(apiUrl('/events', 'https://workbench.example.com/proxy/4327/')).toBe('https://workbench.example.com/proxy/4327/api/events');
  expect(apiUrl('/sessions?q=%ED%99%95%EC%9D%B8', 'https://workbench.example.com/proxy/4327/')).toBe('https://workbench.example.com/proxy/4327/api/sessions?q=%ED%99%95%EC%9D%B8');
});
