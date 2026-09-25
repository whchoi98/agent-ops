/** The server's trusted <base> keeps API/SSE requests inside a proxy mount. */
export function apiUrl(path: string, baseUri = document.baseURI): string {
  if (!path.startsWith('/')) throw new Error('API paths must start with a slash.');
  return new URL(`api${path}`, baseUri).toString();
}
