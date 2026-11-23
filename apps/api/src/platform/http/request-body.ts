import { ApiBody, type SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

export const requestBody = (schema: z.ZodType) =>
  ApiBody({
    schema: z.toJSONSchema(schema, {
      io: 'input',
      target: 'openapi-3.0',
    }) as SchemaObject,
  });
