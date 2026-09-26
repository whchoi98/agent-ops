import { z } from 'zod';
import { CONTEXT_PACK_LIMITS as limits } from '../../../shared/context-packs.js';
import { problem } from '../common.js';

export const packIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const sourceId = z.string().min(1).max(500).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value));
const projectId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const title = z.string().max(limits.nameChars).refine(value => value.trim().length > 0);
const body = z.string().min(1).max(limits.itemChars);
export const versionSchema = z.object({ version: z.number().int().positive().safe() }).strict();

export const createSchema = z.object({
  name: title,
  description: z.string().max(limits.descriptionChars).default(''),
  projectId: projectId.nullable().default(null),
  instructions: z.string().max(limits.instructionsChars).default(''),
}).strict();
export const updateSchema = createSchema.partial().extend(versionSchema.shape).strict()
  .refine(value => ['name', 'description', 'projectId', 'instructions'].some(key => Object.hasOwn(value, key)));
export const itemSchema = z.discriminatedUnion('kind', [
  z.object({
    ...versionSchema.shape, kind: z.literal('message'), sessionId: sourceId, messageId: sourceId,
    offset: z.number().int().nonnegative().safe(), length: z.number().int().min(1).max(limits.itemChars),
  }).strict(),
  z.object({ ...versionSchema.shape, kind: z.literal('note'), title, text: body }).strict(),
]);
export const itemUpdateSchema = z.object({
  ...versionSchema.shape, title: title.optional(), text: body.optional(),
}).strict().refine(value => value.title !== undefined || value.text !== undefined);
export const reorderSchema = z.object({
  ...versionSchema.shape, itemIds: z.array(packIdSchema).max(limits.items),
}).strict();
export const querySchema = z.object({
  q: z.string().max(500).optional(),
  projectId: projectId.optional(),
  offset: z.number().int().min(0).max(limits.packs).default(0),
  limit: z.number().int().min(1).max(limits.maxPageSize).default(limits.defaultPageSize),
}).strict();
export const exportFormatSchema = z.enum(['md', 'json']);

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw problem(400, 'Invalid context pack request. Check the fields and limits.');
  return result.data;
}
