import type { IncomingHttpHeaders } from 'node:http';

export interface PublicAddress {
  origin: string;
  host: string;
  basePath: string;
}

export function parsePublicUrl(value?: string): PublicAddress | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Public URL must be a complete HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname.includes('//') || !/^\/[A-Za-z0-9._~/-]*$/.test(url.pathname)) {
    throw new Error('Public URL requires HTTPS, a safe path, and no credentials, query, or fragment.');
  }
  return { origin: url.origin, host: url.host, basePath: url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/` };
}

export function stripProxyPrefix(rawUrl: string, address: PublicAddress | null): string {
  if (!address || address.basePath === '/') return rawUrl;
  const question = rawUrl.indexOf('?');
  const path = question === -1 ? rawUrl : rawUrl.slice(0, question);
  const query = question === -1 ? '' : rawUrl.slice(question);
  if (path === address.basePath.slice(0, -1)) return `/${query}`;
  if (path.startsWith(address.basePath)) return `/${path.slice(address.basePath.length)}${query}`;
  return rawUrl;
}

function loopbackHost(host: string) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());
}
function localPeer(peer?: string) {
  return Boolean(peer && (peer === '::1' || /^127\.\d+\.\d+\.\d+$/.test(peer) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(peer)));
}
const deny = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 403 }); };

/** The public URL is operator configuration, never inferred from forwarded headers. */
export function enforceAccess(headers: IncomingHttpHeaders, peer: string | undefined, address: PublicAddress | null) {
  const host = headers.host || '';
  let parsed: URL;
  try { parsed = new URL(`http://${host}`); } catch { return deny('Local host required.'); }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return deny('Invalid host.');
  const local = loopbackHost(parsed.hostname);
  const proxyTarget = address !== null && parsed.hostname === '0.0.0.0';
  const publicHost = address !== null && new URL(`https://${host}`).host === address.host;
  if (!local && !proxyTarget && !publicHost) return deny('Host is not configured for this application.');
  if (!localPeer(peer)) return deny('A local connection or authenticated local reverse proxy is required.');
  if (headers['sec-fetch-site'] === 'cross-site') return deny('Cross-site access is disabled.');
  if (headers.origin) {
    const allowed = (local && headers.origin === `http://${host}`) || (address && headers.origin === address.origin);
    if (!allowed) return deny('Same-origin access required.');
  }
}
