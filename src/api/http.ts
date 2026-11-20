import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest } from '../core/errors.js';
import type { Member } from '../core/members.js';

export const uuid = z.string().uuid();

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest('invalid_request', r.error.issues.map((i) => i.path.join('.') || '(root)').join(', '));
  return r.data;
}

export const me = (req: FastifyRequest): Member => {
  if (!req.member) throw new AppError('unauthenticated', 401);
  return req.member;
};
