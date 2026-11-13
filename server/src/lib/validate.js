import { z } from 'zod';

export { z };

export const uuid = z.string().uuid();

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function pageOffset({ page, limit }) {
  return (page - 1) * limit;
}

/** Parse req.body / req.query with a zod schema (throws ZodError → 400). */
export const body = (schema, req) => schema.parse(req.body ?? {});
export const queryParams = (schema, req) => schema.parse(req.query ?? {});
