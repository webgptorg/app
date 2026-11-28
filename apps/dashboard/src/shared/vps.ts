import { z } from 'zod';

export const VPS_CALLBACK = '/vps/return';
export const DIGITALOCEAN_MONTHLY_USD = 24;
export const providerId = z.enum(['digitalocean']);
export type VpsProviderId = z.infer<typeof providerId>;

export function isVpsProvider(value: unknown): value is VpsProviderId {
    return typeof value === 'string' && Object.hasOwn(providerId.enum, value);
}
const referralUrl = z
    .string()
    .regex(/^https:\/\/m\.do\.co\/c\/[a-zA-Z0-9]+$/)
    .optional();
export const digitalOceanConfig = z.strictObject({
    clientId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .optional(),
    referralUrl,
});
export const cloudOffer = z.strictObject({
    provider: providerId,
    referralUrl,
});
export type CloudOffer = z.infer<typeof cloudOffer>;
