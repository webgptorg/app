import { z } from 'zod';

/** The locales the message catalogues carry; `test/catalogues.test.ts` keeps this in step with Paraglide's settings. */
export const localeSchema = z.enum(['en', 'cs']);
export type Locale = z.infer<typeof localeSchema>;
