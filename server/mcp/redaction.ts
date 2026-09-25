import { sanitizeText } from '../extensions/analysis.js';
import { object } from './types.js';

/** Values are collected before projection so aliases into names/descriptions cannot reveal credentials. */
export function secretValues(value: unknown): string[] {
  const result = new Set<string>();
  const stack = [{ value, sensitive: false }];
  let visited = 0;
  while (stack.length && ++visited <= 20000) {
    const { value: current, sensitive } = stack.pop()!;
    if (typeof current === 'string') {
      if (sensitive && current) {
        result.add(current);
        // Servers often echo only the credential, rather than its HTTP authorization scheme.
        const authorization = /^(Bearer|Basic)\s+(.+)$/i.exec(current);
        if (authorization) {
          result.add(authorization[2]);
          if (authorization[1].toLowerCase() === 'basic' && /^[A-Za-z0-9+/=]+$/.test(authorization[2])) {
            const decoded = Buffer.from(authorization[2], 'base64').toString('utf8');
            result.add(decoded);
            const colon = decoded.indexOf(':');
            if (colon >= 0) {
              if (colon) result.add(decoded.slice(0, colon));
              if (colon + 1 < decoded.length) result.add(decoded.slice(colon + 1));
            }
          }
        }
        if (!authorization) {
          for (const part of current.matchAll(/(?:^|[;\s])[^=;\s]+=([^;]+)(?=;|$)/g)) {
            if (part[1].trim()) result.add(part[1].trim());
          }
        }
      }
      continue;
    }
    for (const [key, entry] of Object.entries(object(current))) {
      // These values name environment variables; configure() separately records any resolved values.
      if (!sensitive && ['env_vars', 'env_http_headers', 'bearer_token_env_var'].includes(key)) continue;
      if (/^(?:url|uri)$/i.test(key) && typeof entry === 'string') {
        try {
          const url = new URL(entry);
          for (const part of [url.username, url.password, ...url.searchParams.values()]) {
            if (part) { result.add(part); try { result.add(decodeURIComponent(part)); } catch { /* Already opaque. */ } }
          }
        } catch { /* Invalid URLs are never included in public summaries. */ }
      }
      const hidden = sensitive || /env$|headers|args|token|password|secret|credential|authorization|cookie|oauth/i.test(key);
      if (Array.isArray(entry)) for (const child of entry) stack.push({ value: child, sensitive: hidden });
      else stack.push({ value: entry, sensitive: hidden });
    }
  }
  return [...result];
}

export function redactor(secrets: string[]) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  // A pathological configuration is still safe to summarize without quadratic work.
  if (values.length > 2048 || values.reduce((total, value) => total + value.length, 0) > 1024 * 1024) {
    return (input: string, _limit = 512): string => input ? '[redacted]' : '';
  }
  return (input: string, limit = 512): string => {
    // Redact before clipping, including encoded copies that servers may echo in metadata.
    let text = input;
    for (const value of values) {
      let encoded = value;
      try { encoded = encodeURIComponent(value); } catch { /* Unpaired Unicode still gets literal redaction. */ }
      for (const variant of new Set([value, encoded])) text = text.split(variant).join('[redacted]');
    }
    return sanitizeText(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, limit);
  };
}
