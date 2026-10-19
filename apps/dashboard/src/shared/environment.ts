import { z } from 'zod';

export const environmentSchema = z.enum(['dev', 'staging', 'production']);
export type Environment = z.infer<typeof environmentSchema>;
