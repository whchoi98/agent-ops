import { isAlias, isMap, isNode, isScalar, isSeq, parseAllDocuments, parseDocument } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import type { ExtensionAnalysis, ExtensionContent, ExtensionFinding, ExtensionSummary } from '../../shared/extensions.js';
import { redact } from '../privacy.js';

const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const YAML_WARNING = 'YAML 메타데이터를 안전하게 해석할 수 없습니다.';
const REDACTED = '[REDACTED]';
const OMITTED = '[OMITTED]';
const MAX_METADATA_DEPTH = 32;
const MAX_METADATA_NODES = 10_000;
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const yamlOptions = {
  schema: 'core', version: '1.2', merge: false, resolveKnownTags: false,
  stringKeys: true, uniqueKeys: true, prettyErrors: false, logLevel: 'silent',
} as const;
const tomlOptions = { maxDepth: MAX_METADATA_DEPTH, unsafeKeyBehaviour: 'throw', integersAsBigInt: 'asNeeded' } as const;
const tomlKey = String.raw`(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*')`;
const tomlAssignment = new RegExp(String.raw`^(${tomlKey}(?:[ \t]*\.[ \t]*${tomlKey})*)[ \t]*=[ \t]*`);

const normalizedKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const environmentKey = (key: string) => /^(?:env|envs|environment|environmentvariables|envvars)$/.test(normalizedKey(key));
const sensitiveKey = (key: string) =>
  /(?:passwords?|passwd|passphrases?|secrets?|secretkey|secretaccesskey|privatekey|apikeys?|accesskey(?:id)?|tokens?|credentials?|authorization|cookies?|signature)$/.test(normalizedKey(key))
  || /^(?:auth|authentication|pwd|key|sig|code)$/.test(normalizedKey(key));

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeKey(key: string): string {
  try {
    if (key.startsWith('"')) {
      // YAML also permits escapes such as \x5f that JSON does not.
      const document = parseDocument(key, yamlOptions);
      return !document.errors.length && isScalar(document.contents) && typeof document.contents.value === 'string'
        ? document.contents.value : key;
    }
    if (key.startsWith("'")) return key.slice(1, -1).replace(/''/g, "'");
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

interface Mask { start: number; end: number; replacement: string }

function* yamlNodes(root: unknown): Generator<unknown> {
  const stack = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) throw new Error('YAML limit');
    yield node;
    if (isMap(node)) {
      for (const pair of node.items) {
        stack.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const child of node.items) stack.push({ node: child, depth: depth + 1 });
    }
  }
}

function specialYamlMasks(input: string): Mask[] {
  // Require coverage of the entire stream, including examples parsed as scalar text.
  const markers = [...input.matchAll(/(?:^|[\s:[{,?-])([&*])([^\s,[\]{}]+)/g)];
  const aliases = markers.some(marker => marker[1] === '*');
  if (!/^\s*\?(?:\s|$)/m.test(input)
    && !(aliases && markers.some(marker => marker[1] === '&'))) return [];
  const withheld = [{ start: 0, end: input.length, replacement: REDACTED }];
  if (Buffer.byteLength(input) > MAX_FRONTMATTER_BYTES) return withheld;
  try {
    const documents = parseAllDocuments(input, yamlOptions);
    if (documents.some(document => document.errors.length || document.warnings.length)) return withheld;
    const uninspected = new Map<string, number>();
    for (const marker of markers) {
      const key = marker[1] + marker[2];
      uninspected.set(key, (uninspected.get(key) ?? 0) + 1);
    }
    const inspected = (key: string) => uninspected.set(key, Math.max(0, (uninspected.get(key) ?? 0) - 1));
    const masks: Mask[] = [];
    for (const document of documents) {
      for (const node of yamlNodes(document.contents)) {
        if (isAlias(node)) inspected('*' + node.source);
        if ((isScalar(node) || isMap(node) || isSeq(node)) && node.anchor) inspected('&' + node.anchor);
        if (!isMap(node)) continue;
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isNode(pair.value)) continue;
          if (!sensitiveKey(pair.key.value) && !environmentKey(pair.key.value)) continue;
          for (const child of yamlNodes(pair.value)) if (isAlias(child)) return withheld;
          if (pair.value.range) {
            masks.push({ start: pair.value.range[0], end: pair.value.range[1], replacement: `"${REDACTED}"` });
          }
        }
      }
    }
    return [...uninspected.values()].some(count => count > 0) ? withheld : masks;
  } catch {
    return withheld;
  }
}

function tomlPath(source: string): string[] {
  let value: unknown = parseToml(source, tomlOptions);
  const path: string[] = [];
  for (let depth = 0; depth <= MAX_METADATA_DEPTH; depth++) {
    if (Array.isArray(value) && value.length === 1) { value = value[0]; continue; }
    if (!record(value)) return path;
    const keys = Object.keys(value);
    if (!keys.length) return path;
    if (keys.length !== 1) break;
    path.push(keys[0]);
    value = value[keys[0]];
  }
  throw new Error('TOML path limit');
}

function tomlValueEnd(input: string, start: number): { end: number; complete: boolean } {
  const stack: string[] = [];
  let quote = '';
  let triple = false;
  let index = start;
  for (; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (quote === '"' && char === '\\') { index++; continue; }
      if (char !== quote) continue;
      if (!triple) quote = '';
      else if (input.slice(index, index + 3) === quote.repeat(3)) {
        while (input[index + 1] === quote) index++;
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      triple = input.slice(index, index + 3) === char.repeat(3);
      if (triple) index += 2;
    } else if (char === '[' || char === '{') {
      stack.push(char === '[' ? ']' : '}');
      if (stack.length > MAX_METADATA_DEPTH) return { end: input.length, complete: false };
    } else if (char === ']' || char === '}') {
      if (stack.pop() !== char) return { end: input.length, complete: false };
    } else if (char === '#') {
      if (!stack.length) break;
      const newline = input.indexOf('\n', index);
      index = newline < 0 ? input.length : newline;
    } else if ((char === '\n' || char === '\r') && !stack.length) break;
  }
  while (index > start && /[ \t\r]/.test(input[index - 1])) index--;
  return { end: Math.min(index, input.length), complete: !quote && !stack.length };
}

function sensitiveTomlValue(value: unknown): boolean {
  const pending = [value];
  let count = 0;
  while (pending.length) {
    if (++count > MAX_METADATA_NODES) return true;
    const current = pending.pop();
    if (Array.isArray(current)) pending.push(...current);
    else if (record(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (environmentKey(key) || sensitiveKey(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

function tomlMasks(input: string, depth: number): Mask[] {
  if (!input.includes('=') && !/^[ \t>]*\[/m.test(input)) return [];
  if (Buffer.byteLength(input) > MAX_CONFIG_BYTES) return [{ start: 0, end: input.length, replacement: REDACTED }];
  if (/^\s*[[{"]/.test(input)) {
    try { JSON.parse(input); return []; } catch { /* Continue inspecting non-JSON text. */ }
  }
  const masks: Mask[] = [];
  let table: string[] = [];
  let inTable = false;
  let cursor = 0;
  while (cursor < input.length) {
    const newline = input.indexOf('\n', cursor);
    const lineEnd = newline < 0 ? input.length : newline;
    const rawLine = input.slice(cursor, lineEnd).replace(/\r$/, '');
    const prefix = /^[ \t]*(?:>[ \t]*)*/.exec(rawLine)![0];
    const line = rawLine.slice(prefix.length);
    const nextLine = lineEnd + 1;
    if (/^(?:`{3,}|~{3,})/.test(line)) {
      table = [];
      inTable = false;
      cursor = nextLine;
      continue;
    }
    if (!line || line.startsWith('#')) { cursor = nextLine; continue; }
    if (line.startsWith('[')) {
      try {
        table = tomlPath(line);
        inTable = true;
      } catch {
        if (/^\[[^"'[\]\r\n]*\]\s*(?:\(|:)/.test(line)) { cursor = nextLine; continue; }
        masks.push({ start: cursor, end: input.length, replacement: REDACTED });
        break;
      }
      cursor = nextLine;
      continue;
    }
    const assignment = tomlAssignment.exec(line);
    if (!assignment) {
      if (table.some(key => environmentKey(key) || sensitiveKey(key))) {
        masks.push({ start: cursor, end: input.length, replacement: REDACTED });
        break;
      }
      cursor = nextLine;
      continue;
    }
    // Unspaced shell assignments still go through the existing shell redactor.
    if (!inTable && !/[ \t]=|=[ \t]|\./.test(assignment[0])) { cursor = nextLine; continue; }
    const start = cursor + prefix.length + assignment[0].length;
    let end = input.length;
    try {
      const path = [...table, ...tomlPath(`${assignment[1]} = 0`)];
      const span = tomlValueEnd(input, start);
      if (!span.complete) throw new Error('TOML incomplete value');
      end = span.end;
      const value = parseToml(`value = ${input.slice(start, end)}`, tomlOptions).value;
      if (path.some(key => environmentKey(key) || sensitiveKey(key)) || sensitiveTomlValue(value)) {
        masks.push({ start, end, replacement: `"${REDACTED}"` });
      } else if (typeof value === 'string') {
        const clean = depth >= 8 ? REDACTED : sanitizeTextDepth(value, depth + 1);
        if (clean !== value) masks.push({ start, end, replacement: JSON.stringify(clean) });
      }
    } catch {
      // Do not guess where a malformed table/string stops: apparent headers may be its value.
      if (inTable || /env|secret|token|password|credential/i.test(assignment[1])) {
        masks.push({ start, end: input.length, replacement: `"${REDACTED}"` });
        break;
      }
      cursor = nextLine;
      continue;
    }
    const afterValue = input.indexOf('\n', end);
    cursor = afterValue < 0 ? input.length : afterValue + 1;
  }
  return masks;
}

function quotedEnd(input: string, start: number): number {
  const quote = input[start];
  for (let index = start + 1; index < input.length; index++) {
    if (input[index] === '\\') { index++; continue; }
    if (input[index] !== quote) continue;
    if (quote === "'" && input[index + 1] === "'") { index++; continue; }
    return index + 1;
  }
  return input.length;
}

function collectionEnd(input: string, start: number): number {
  const closing = (char: string) => char === '{' ? '}' : char === '[' ? ']' : ')';
  const stack = [closing(input[start])];
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index];
    if (char === '\\') { index++; continue; }
    if (char === '"' || char === "'" || char === '`') { index = quotedEnd(input, index) - 1; continue; }
    if (char === '{' || char === '[' || char === '(') stack.push(closing(char));
    else if (char === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return index + 1;
    }
  }
  return input.length;
}

function shellValueEnd(input: string, start: number, keyStart: number): number {
  const enclosing = /["']/.test(input[keyStart - 1] ?? '') ? input[keyStart - 1] : '';
  let end = start;
  while (end < input.length) {
    const char = input[end];
    if (char === enclosing || (!enclosing && /[\s;]/.test(char))) break;
    if (char === '\\') { end = Math.min(input.length, end + 2); continue; }
    if (char === '"' || char === "'" || char === '`') { end = quotedEnd(input, end); continue; }
    if (char === '(' || char === '{' || char === '[') { end = collectionEnd(input, end); continue; }
    end++;
  }
  return end;
}

function indentedEnd(input: string, start: number, keyStart: number): number {
  const lineStart = input.lastIndexOf('\n', keyStart - 1) + 1;
  const indent = /^[ \t]*(?:-[ \t]+)?/.exec(input.slice(lineStart, keyStart))![0].length;
  let end = input.indexOf('\n', start);
  if (end < 0) return input.length;
  let cursor = end + 1;
  if (input[end - 1] === '\r') end--;
  while (cursor < input.length) {
    let next = input.indexOf('\n', cursor);
    if (next < 0) next = input.length;
    const line = input.slice(cursor, next).replace(/\r$/, '');
    const spaces = /^[ \t]*/.exec(line)![0].length;
    if (line.trim() && spaces <= indent && !(spaces === indent && /^\s*-\s/.test(line))) break;
    end = input[next - 1] === '\r' ? next - 1 : next;
    cursor = next + 1;
  }
  return end;
}

function valueEnd(input: string, start: number, keyStart: number, assignment: string): number {
  if (assignment === '=') return shellValueEnd(input, start, keyStart);
  const char = input[start];
  if (char === '"' || char === "'") return quotedEnd(input, start);
  if (char === '{' || char === '[') return collectionEnd(input, start);
  if (assignment === ':' && (char === '\r' || char === '\n' || char === '#' || char === '|' || char === '>')) {
    return indentedEnd(input, start, keyStart);
  }
  let end = start;
  const delimiter = /[,\r\n}\]]/;
  while (end < input.length && !delimiter.test(input[end])) end++;
  if (assignment === ':' && /[\r\n]/.test(input[end] ?? '')) return indentedEnd(input, end, keyStart);
  return end;
}

function sanitizeUrl(input: string): string {
  const clean = input.replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/?#]*@/i, '$1[REDACTED]@');
  const queryStart = clean.search(/[?#]/);
  if (queryStart < 0) return redact(clean);
  return redact(clean.slice(0, queryStart)) + clean.slice(queryStart).replace(
    /([?&#;])([^=&#;]+)=([^&#;]*)/g,
    (_match, separator: string, key: string, value: string) =>
      `${separator}${key}=${sensitiveKey(decodeKey(key)) || environmentKey(decodeKey(key)) ? REDACTED : redact(value)}`,
  );
}

export function sanitizeText(input: string): string {
  return sanitizeTextDepth(input, 0);
}

function sanitizeTextDepth(input: string, depth: number): string {
  const toml = tomlMasks(input, depth);
  const masks: Mask[] = [...specialYamlMasks(input), ...toml];
  let privateStart = 0;
  let privateDepth = 0;
  for (const match of input.matchAll(/<!--\s*((?:BEGIN\s+|END\s+|\/)?PRIVATE)\s*-->/gi)) {
    if (!/^(?:END|\/)/i.test(match[1])) {
      if (!privateDepth) privateStart = match.index!;
      privateDepth++;
    } else if (privateDepth && --privateDepth === 0) {
      masks.push({ start: privateStart, end: match.index! + match[0].length, replacement: REDACTED });
    }
  }
  if (privateDepth) masks.push({ start: privateStart, end: input.length, replacement: REDACTED });
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== '"') continue;
    const end = quotedEnd(input, index);
    const token = input.slice(index, end);
    if (!token.includes('\\')) { index = end - 1; continue; }
    try {
      const decoded = JSON.parse(token) as string;
      const clean = depth >= 8 ? REDACTED : sanitizeTextDepth(decoded, depth + 1);
      if (clean !== decoded) masks.push({ start: index, end, replacement: JSON.stringify(clean) });
    } catch {
      // Incomplete escaped value strings cannot be safely decoded; hide the whole value.
      if (!/^\s*[:=]/.test(input.slice(end))) masks.push({ start: index, end, replacement: `"${REDACTED}"` });
    }
    index = end - 1;
  }
  for (const match of input.matchAll(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-*(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*$)/g)) {
    masks.push({ start: match.index!, end: match.index! + match[0].length, replacement: '[REDACTED PRIVATE KEY]' });
  }
  for (const match of input.matchAll(/(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^\s<>"'`]+/gi)) {
    masks.push({ start: match.index!, end: match.index! + match[0].length, replacement: sanitizeUrl(match[0]) });
  }
  // Scan fields independently of parsing: invalid/truncated previews still need redaction.
  const assignments = /(^|[\s{,;[("'`])("(?:\\.|[^"\\])*"|'(?:''|\\.|[^'\\])*'|[a-zA-Z_][\w.-]*)([ \t]*)([:=])([ \t]*)/g;
  for (let match = assignments.exec(input); match; match = assignments.exec(input)) {
    const key = decodeKey(match[2]);
    const keyStart = match.index + match[1].length;
    const inspected = toml.find(mask => (keyStart >= mask.start && keyStart < mask.end)
      || (assignments.lastIndex >= mask.start && assignments.lastIndex < mask.end));
    if (inspected) { assignments.lastIndex = inspected.end; continue; }
    const exported = /\bexport[ \t]+$/.test(input.slice(Math.max(0, keyStart - 32), keyStart));
    if (!sensitiveKey(key) && !environmentKey(key)
      && !(match[4] === '=' && (/^[A-Z_][A-Z0-9_]*$/.test(key) || exported || (!match[3] && !match[5])))) continue;
    const start = assignments.lastIndex;
    const end = valueEnd(input, start, keyStart, match[4]);
    const blockSpace = match[4] === ':' && !match[5] && /[\r\n]/.test(input[start] ?? '') ? ' ' : '';
    masks.push({ start, end, replacement: blockSpace + (match[4] === ':' ? `"${REDACTED}"` : REDACTED) });
    assignments.lastIndex = Math.max(end, start);
  }
  masks.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Mask[] = [];
  for (const mask of masks) {
    const previous = merged.at(-1);
    if (!previous || mask.start >= previous.end) merged.push({ ...mask });
    else if (mask.end > previous.end) {
      previous.end = mask.end;
      previous.replacement = REDACTED;
    }
  }
  let result = '';
  let cursor = 0;
  for (const mask of merged) {
    // Reuse the existing credential redactor without invalidating quoted replacements.
    result += redact(input.slice(cursor, mask.start)) + mask.replacement;
    cursor = mask.end;
  }
  return result + redact(input.slice(cursor));
}

export function sanitizeMetadata(value: unknown): Record<string, unknown> {
  if (!record(value)) return {};
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  function clean(current: unknown, depth: number, environment = false): unknown {
    if (++nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) return OMITTED;
    if (environment) {
      if (Array.isArray(current)) return Array.from({ length: Math.min(current.length, MAX_METADATA_NODES) }, () => REDACTED);
      if (!record(current)) return REDACTED;
      return Object.fromEntries(Object.keys(current).slice(0, MAX_METADATA_NODES)
        .filter(key => !unsafeKeys.has(key)).map(key => [sanitizeText(key), REDACTED]));
    }
    if (typeof current === 'string') return sanitizeText(current);
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (typeof current !== 'object' || !current) return undefined;
    if (ancestors.has(current)) return OMITTED;
    if (!Array.isArray(current) && !record(current)) return OMITTED;
    ancestors.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    let result: unknown;
    if (Array.isArray(current)) {
      result = Array.from({ length: Math.min(current.length, MAX_METADATA_NODES) }, (_, index) => {
        const descriptor = descriptors[index];
        return descriptor && 'value' in descriptor ? clean(descriptor.value, depth + 1) ?? null : null;
      });
    } else {
      const entries: [string, unknown][] = [];
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !('value' in descriptor) || unsafeKeys.has(key)) continue;
        if (nodes >= MAX_METADATA_NODES) { entries.push(['…', OMITTED]); break; }
        const next = sensitiveKey(key) ? REDACTED : clean(descriptor.value, depth + 1, environmentKey(key));
        if (next !== undefined) entries.push([sanitizeText(key), next]);
      }
      result = Object.fromEntries(entries);
    }
    ancestors.delete(current);
    return result;
  }
  return clean(value, 0) as Record<string, unknown>;
}

function yamlMetadata(source: string, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(source, 'utf8') > maxBytes) throw new Error('YAML limit');
  const document = parseDocument(source, yamlOptions);
  if (document.errors.length || document.warnings.length || (document.contents && !isMap(document.contents))) {
    throw new Error('YAML mapping');
  }
  for (const node of yamlNodes(document.contents)) if (isAlias(node)) throw new Error('YAML alias');
  // No alias expansion, custom constructors, or parser diagnostics reach callers.
  return sanitizeMetadata(document.toJS({ maxAliasCount: 0 }));
}

export function parseSkillDocument(input: string): {
  metadata: Record<string, unknown>; body: string; warnings: string[];
} {
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(input);
  if (!opening) return { metadata: {}, body: sanitizeText(input), warnings: [] };
  const rest = input.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) {
    return { metadata: {}, body: sanitizeText(input), warnings: ['YAML 메타데이터의 닫는 구분자가 없습니다.'] };
  }
  const source = rest.slice(0, closing.index);
  const body = sanitizeText(rest.slice(closing.index + closing[0].length));
  if (Buffer.byteLength(source, 'utf8') > MAX_FRONTMATTER_BYTES) {
    return { metadata: {}, body, warnings: ['YAML 메타데이터가 분석 크기 제한(64 KiB)을 초과했습니다.'] };
  }
  try {
    return { metadata: yamlMetadata(source, MAX_FRONTMATTER_BYTES), body, warnings: [] };
  } catch {
    return { metadata: {}, body, warnings: [YAML_WARNING] };
  }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function declaredTools(value: unknown): string[] {
  const tools: string[] = [];
  for (const input of strings(value)) {
    let depth = 0;
    let tool = '';
    for (const char of input.replace(/`/g, '')) {
      if (char === '(') depth++;
      if (char === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && /[\s,]/.test(char)) {
        if (tool.trim()) tools.push(tool.trim());
        tool = '';
      } else tool += char;
    }
    if (tool.trim()) tools.push(tool.trim());
  }
  return tools;
}

const prose = (text: string) => text.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
const triggerStatement = (text: string) =>
  /\b(?:use (?:this (?:skill|plugin|power) )?(?:when|for)|triggers?(?:\s+on|\s*[:—-])|activate when)\b/i.test(text)
  || /트리거|사용\s*조건|(?:요청|언급|하는|할)\s*(?:때|경우)/.test(text);
const triggerHeading = (text: string) => /^(?:when to use|usage triggers?|triggers?(?: conditions)?|activation|사용\s*(?:조건|시점)|트리거)$/i.test(text);
const scriptPath = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|ps1|rb|pl)(?:[#?].*)?$/i;

function linkTarget(input: string): string {
  let target = input.replace(/^<|>$/g, '').replace(/[.,;!]+$/, '');
  while (target.endsWith(')') && (target.match(/\)/g)?.length ?? 0) > (target.match(/\(/g)?.length ?? 0)) {
    target = target.slice(0, -1);
  }
  return target;
}

/** Only analyzes supplied data; paths, commands, hooks and URLs are never opened or executed. */
export function analyzeExtension(
  item: ExtensionSummary, contents: ExtensionContent[], metadata: Record<string, unknown>, usedBy: string[] = [],
): ExtensionAnalysis {
  const analysis: ExtensionAnalysis = {
    purpose: '', triggers: [], tools: [], mcpServers: [], hooks: [], resources: [], sections: [], links: [],
    usedBy: [], findings: [], lineCount: 0,
  };
  const add = (values: string[], value: string) => {
    const text = sanitizeText(value).trim();
    if (text && !values.includes(text)) values.push(text);
  };
  const finding = (level: ExtensionFinding['level'], title: string, detail: string) => {
    const clean = { level, title, detail: sanitizeText(detail) };
    if (!analysis.findings.some(entry => entry.title === title && entry.detail === clean.detail)) analysis.findings.push(clean);
  };
  const reference = (input: string) => {
    const target = linkTarget(input.trim());
    if (!target || target.startsWith('#') || target.startsWith('//') || target.includes(REDACTED)) return;
    if (/^https?:\/\//i.test(target)) {
      try {
        const url = new URL(target);
        if (url.hostname && !url.username && !url.password && sanitizeText(target) === target) add(analysis.links, target);
      } catch { /* Malformed links are not navigable references. */ }
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(target) || /^(?:file|skill):\/\//i.test(target)) {
      add(analysis.resources, target);
    }
  };
  const triggerText = (text: string) => {
    for (const sentence of text.split(/(?<=[.!?])\s+|\r?\n/)) {
      if (triggerStatement(sentence)) add(analysis.triggers, prose(sentence));
    }
  };
  let hasPermissions = false;
  const declarations = (config: Record<string, unknown>) => {
    for (const key of ['allowed-tools', 'allowedTools', 'allowed_tools', 'tools']) {
      for (const tool of declaredTools(config[key])) add(analysis.tools, tool);
    }
    for (const key of ['trigger', 'triggers', 'trigger-phrases']) {
      for (const trigger of strings(config[key])) add(analysis.triggers, prose(trigger));
    }
    for (const description of strings(config.description)) triggerText(description);
    for (const key of ['resources', 'references', 'scripts', 'steeringFiles']) {
      for (const path of strings(config[key])) reference(path);
    }
    for (const key of ['homepage', 'repository', 'documentation', 'url']) {
      for (const path of strings(config[key])) if (/^https?:\/\//i.test(path)) reference(path);
    }
    if (record(config.dependencies) && Array.isArray(config.dependencies.tools)) {
      for (const tool of config.dependencies.tools) {
        if (!record(tool) || typeof tool.value !== 'string') continue;
        add(analysis.tools, tool.value);
        if (tool.type === 'mcp') add(analysis.mcpServers, tool.value);
        for (const url of strings(tool.url)) reference(url);
      }
    }
    if (record(config.policy)) {
      if (config.policy.allow_implicit_invocation === false) {
        finding('info', '수동 호출 선언', 'policy.allow_implicit_invocation: false가 선언되어 있습니다. 명시적 호출을 위한 설정이며 실제 호출 기록을 뜻하지 않습니다.');
      } else if (config.policy.allow_implicit_invocation === true) {
        finding('info', '암시적 호출 허용 선언', 'policy.allow_implicit_invocation: true가 선언되어 있습니다. 자동 선택을 허용하는 설정이며 실제 호출 여부는 확인하지 않았습니다.');
      }
    }
    for (const key of ['mcpServers', 'mcp_servers']) {
      if (record(config[key])) {
        for (const [name, server] of Object.entries(config[key])) {
          if (record(server)) add(analysis.mcpServers, name);
        }
      } else for (const path of strings(config[key])) reference(path);
    }
    if (record(config.hooks)) {
      for (const [name, hook] of Object.entries(config.hooks)) {
        if (Array.isArray(hook) || record(hook)) add(analysis.hooks, name);
      }
    } else {
      for (const path of strings(config.hooks)) reference(path);
      if (Array.isArray(config.hooks)) {
        for (const hook of config.hooks) if (record(hook)) {
          for (const event of strings(hook.event)) add(analysis.hooks, event);
        }
      }
    }
    hasPermissions ||= Object.keys(config).some(key => /^(?:permissions?|allowedtools|toolssettings)$/.test(normalizedKey(key)));
  };
  const documents = contents.map(file => {
    const markdown = /(?:markdown|md)$/i.test(file.language) || /\.(?:md|markdown)$/i.test(file.path);
    if (markdown) return { file, markdown, parsed: parseSkillDocument(file.content) };
    let parsed: ReturnType<typeof parseSkillDocument> | null = null;
    if (/^(?:yaml|yml)$/i.test(file.language) || /\.ya?ml$/i.test(file.path)) {
      parsed = { body: sanitizeText(file.content), metadata: {}, warnings: [] };
      try {
        parsed.metadata = yamlMetadata(file.content, MAX_CONFIG_BYTES);
      } catch {
        parsed.warnings.push('YAML 구성을 안전하게 해석할 수 없습니다.');
      }
    } else if (file.language.toLowerCase() === 'json' || /\.json$/i.test(file.path)) {
      parsed = { body: sanitizeText(file.content), metadata: {}, warnings: [] };
      try {
        const value: unknown = JSON.parse(file.content);
        if (record(value)) parsed.metadata = sanitizeMetadata(value);
        else parsed.warnings.push('JSON 구성의 최상위 값이 객체가 아닙니다.');
      } catch {
        parsed.warnings.push('JSON 구성을 해석할 수 없습니다. 손상되거나 잘린 파일일 수 있습니다.');
      }
    }
    return { file, markdown, parsed };
  });
  const entry = (item.kind === 'plugin'
    ? documents.find(document => /(?:^|[/\\])plugin\.json$/i.test(document.file.path))
    : documents.find(document => /(?:^|[/\\])(?:SKILL|POWER)\.md$/i.test(document.file.path)))
    ?? documents.find(document => document.markdown);
  const effectiveMetadata = { ...entry?.parsed?.metadata, ...sanitizeMetadata(metadata) };
  const description = strings(effectiveMetadata.description).find(text => text.trim()) || item.description.trim();
  if (description) analysis.purpose = sanitizeText(description).trim();
  declarations(effectiveMetadata);
  triggerText(sanitizeText(item.description));
  for (const name of usedBy) add(analysis.usedBy, name);

  let fallbackPurpose = '';
  let entryPurpose = '';
  for (const { file, markdown, parsed } of documents) {
    const source = parsed?.body ?? sanitizeText(file.content);
    analysis.lineCount += file.content ? file.content.split(/\r\n|\r|\n/).length - Number(/[\r\n]$/.test(file.content)) : 0;
    for (const warning of parsed?.warnings ?? []) finding('warning', '메타데이터 파싱', warning);
    if (parsed) declarations(parsed.metadata);
    const lines = source.split(/\r\n|\r|\n/);
    let fence = '';
    let inTriggers = false;
    let paragraph: string[] = [];
    const finishParagraph = () => {
      if (!fallbackPurpose && paragraph.length) fallbackPurpose = prose(paragraph.join(' '));
      if (file === entry?.file && !entryPurpose && paragraph.length) entryPurpose = prose(paragraph.join(' '));
      paragraph = [];
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (markdown) {
        const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
          fence = fence ? '' : marker;
          finishParagraph();
          continue;
        }
        if (!fence) {
          const atx = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
          const setext = line.trim() && /^\s{0,3}(?:={3,}|-{3,})\s*$/.test(lines[index + 1] ?? '');
          if (atx || setext) {
            const heading = prose(atx ? atx[1] : line);
            add(analysis.sections, heading);
            inTriggers = triggerHeading(heading);
            if (setext) index++;
            finishParagraph();
          } else {
            const text = prose(line);
            if (text) {
              if (inTriggers) add(analysis.triggers, text);
              else triggerText(text);
              const tools = /^(?:allowed[- ]tools|허용\s*도구)\s*:\s*(.+)$/i.exec(text);
              if (tools) for (const tool of declaredTools(tools[1])) add(analysis.tools, tool);
            }
            if (text && !/^\s*(?:[-*+]\s|\d+[.)]\s|>|[-=*]{3,}|\[[^\]]+\]:)/.test(line)) paragraph.push(text);
            else finishParagraph();
          }
        }
      }
      for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>\n]+>|(?:[^()\s]|\([^()]*\))+)(?:\s+["'][^"']*["'])?\s*\)/g)) reference(match[1]);
      const definition = /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/.exec(line);
      if (definition) reference(definition[1]);
      for (const match of line.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) reference(match[0]);
      // Script and support-file mentions remain references, including those in code examples.
      const withoutUrls = line.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, '');
      for (const match of withoutUrls.matchAll(/(?:\$\{[\w]+\}\/|(?:\.{1,2}|~)\/|\/)?(?:(?:[\w@.+-]+\/)*[\w@.+-]+\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|ps1|rb|pl)\b|(?:scripts|references|assets|steering|agents|commands)\/[^\s"'`<>()[\]{},;]+)/g)) {
        reference(match[0]);
      }
    }
    finishParagraph();
  }
  analysis.purpose ||= entryPurpose || fallbackPurpose || '설명이 없습니다.';
  if (!description) finding('warning', '설명 누락', 'description 메타데이터가 없습니다. 본문 요약이 있으면 대신 표시합니다.');
  if (effectiveMetadata['disable-model-invocation'] === true) {
    finding('info', '수동 호출 선언', 'disable-model-invocation: true가 선언되어 있습니다. 수동 호출을 위한 설정이며 실제 호출 기록을 뜻하지 않습니다.');
  }
  if (analysis.tools.length || hasPermissions) {
    finding('info', '선언된 도구·권한', '도구와 권한은 파일의 선언 정보입니다. 실제 실행 권한이나 런타임 격리를 보장하지 않습니다.');
  }
  const scripts = analysis.resources.filter(path => scriptPath.test(path));
  if (scripts.length) {
    finding('warning', '참조된 스크립트', `${scripts.length}개 스크립트가 참조됩니다. 내용과 필요한 권한을 별도로 검토해야 하며, 정적 분석에서는 실행하지 않았습니다.`);
  }
  if (contents.some(file => file.truncated)) {
    finding('warning', '잘린 미리보기', '일부 파일의 텍스트가 잘렸습니다. 분석과 줄 수는 제공된 내용만 기준으로 합니다.');
  }
  for (const warning of item.warnings) finding('warning', '발견 경고', warning);
  finding('info', '정적 분석 범위', '파일에 선언된 정보를 요약했습니다. 실제 호출 이력이나 실행 여부는 확인하지 않으며, MCP 서버와 훅도 실행하지 않았습니다.');
  return analysis;
}
