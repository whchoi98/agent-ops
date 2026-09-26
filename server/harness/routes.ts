import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { HARNESS_AUDIT_CLIENTS, HARNESS_CLIENTS } from '../../shared/harness.js';
import type { HarnessService } from './service.js';
import { HARNESS_MAX_INPUT_BYTES, HARNESS_MAX_POLICY_BYTES, harnessError } from './types.js';

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes('\0'));
const scope = z.object({ projectId: text(200).optional() }).strict();
const empty = z.object({}).strict();
const opaque = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const revision = text(200);
const policyContent = z.string().max(HARNESS_MAX_POLICY_BYTES).refine(value =>
  !value.includes('\0') && Buffer.byteLength(value) <= HARNESS_MAX_POLICY_BYTES, 'Policy exceeds its byte limit or contains NUL.');
const policyParams = z.object({ id: opaque }).strict();
const settings = z.object({
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  pythonPath: z.string().max(4096).refine(value => isAbsolute(value) && !/[\0\r\n]/.test(value), 'Use an absolute Python executable path.').nullable(),
  retentionDays: z.number().int().min(1).max(90),
  maxCacheRecords: z.number().int().min(100).max(10000),
}).strict();
const evaluation = scope.extend({
  policyId: opaque, revision, client: z.enum(HARNESS_CLIENTS), toolName: text(160),
  toolInput: z.custom<Record<string, unknown>>(value =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value), 'Tool input must be a JSON object.').superRefine((value, context) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    let visited = 0;
    while (queue.length) {
      const current = queue.pop()!;
      if (++visited > 10000 || current.depth > 24) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Tool input is too deeply nested.' }); return;
      }
      if (typeof current.value === 'string' && current.value.includes('\0')) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Tool input contains NUL.' }); return;
      }
      if (current.value && typeof current.value === 'object') {
        for (const [key, child] of Object.entries(current.value)) {
          if (['__proto__', 'constructor', 'prototype'].includes(key) || key.includes('\0')) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'Tool input contains an unsupported key.' }); return;
          }
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(value)) > HARNESS_MAX_INPUT_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Tool input exceeds its byte limit.' });
    }
  }),
}).strict();
const hook = z.object({
  projectId: text(200), client: z.enum(HARNESS_CLIENTS), action: z.enum(['install', 'remove']),
  policyId: opaque.optional(), revision: revision.optional(),
}).strict().refine(value => value.action === 'remove' || Boolean(value.policyId && value.revision), 'Choose a policy revision before installing hooks.');
const validate = scope.extend({
  policyId: opaque.optional(), revision: revision.optional(), content: policyContent.optional(),
}).strict().refine(value => value.content !== undefined
  ? value.policyId === undefined && value.revision === undefined
  : Boolean(value.policyId && value.revision), 'Provide either draft content or a saved policy revision.');
const audit = scope.extend({
  client: z.enum(HARNESS_AUDIT_CLIENTS).optional(), action: z.enum(['allow', 'ask', 'deny', 'error']).optional(),
  sessionId: text(200).optional(), q: z.string().max(500).refine(value => !value.includes('\0')).optional(),
  offset: z.coerce.number().int().min(0).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const mutation = {
  bodyLimit: 2 * HARNESS_MAX_INPUT_BYTES,
  onRequest: async (request: { headers: Record<string, unknown> }) => {
    if (request.headers['x-agent-ops'] !== '1') throw harnessError(403, 'X-Agent-Ops: 1 header required.');
  },
};
async function observed<T>(reply: FastifyReply, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const closed = () => { if (!reply.raw.writableEnded) controller.abort(); };
  reply.raw.once('close', closed);
  try { return await operation(controller.signal); }
  finally { reply.raw.off('close', closed); }
}
export function registerHarnessRoutes(app: FastifyInstance, service: HarnessService) {
  app.get('/api/harness/status', async request => { empty.parse(request.query); return service.status(); });
  app.get('/api/harness', async request => service.catalog(scope.parse(request.query).projectId));
  app.post('/api/harness/refresh', mutation, async request => {
    empty.parse(request.query);
    return service.refresh(scope.parse(request.body ?? {}).projectId);
  });
  app.patch('/api/harness/settings', mutation, async request => {
    empty.parse(request.query);
    return service.saveSettings(settings.parse(request.body));
  });
  app.post('/api/harness/runtime/check', mutation, async (request, reply) => {
    empty.parse(request.query); empty.parse(request.body ?? {});
    return observed(reply, signal => service.checkRuntime(signal));
  });
  app.get('/api/harness/policies/:id', async request =>
    service.policy(policyParams.parse(request.params).id, scope.parse(request.query).projectId));
  app.post('/api/harness/policies/validate', mutation, async (request, reply) => {
    empty.parse(request.query);
    const input = validate.parse(request.body);
    return observed(reply, signal => service.validatePolicy(input, signal));
  });
  app.put('/api/harness/policies/managed', mutation, async request => {
    empty.parse(request.query);
    return service.savePolicy(scope.extend({
      content: policyContent, expectedRevision: revision.nullable(),
    }).strict().parse(request.body));
  });
  app.post('/api/harness/evaluate', mutation, async (request, reply) => {
    empty.parse(request.query);
    const input = evaluation.parse(request.body);
    return observed(reply, signal => service.evaluate(input, signal));
  });
  app.post('/api/harness/hooks/preview', mutation, async (request, reply) => {
    empty.parse(request.query);
    const input = hook.parse(request.body);
    return observed(reply, signal => service.previewHooks(input, signal));
  });
  app.post('/api/harness/hooks/apply', mutation, async request => {
    empty.parse(request.query);
    const input = z.object({ projectId: text(200), previewId: opaque }).strict().parse(request.body);
    return service.applyHooks(input.previewId, input.projectId);
  });
  app.get('/api/harness/audit', async request => service.audit(audit.parse(request.query)));
  app.addHook('onClose', async () => service.close());
}
