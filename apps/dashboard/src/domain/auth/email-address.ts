import { z } from 'zod';

/** Trimmed and lowercased, so one mailbox maps to one account whatever casing the person types. */
export const emailAddressSchema = z.string().trim().toLowerCase().pipe(z.email().max(254)).brand<'EmailAddress'>();
export type EmailAddress = z.infer<typeof emailAddressSchema>;
