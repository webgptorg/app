import { z } from 'zod';

export const VPS_CALLBACK = '/vps/return';
export const DIGITALOCEAN = {
    id: 'digitalocean',
    label: 'DigitalOcean',
    region: 'fra1',
    size: 's-2vcpu-4gb',
    image: 'ubuntu-24-04-x64',
    monthlyUsd: 24,
    hourlyUsd: 0.03571,
    billingUrl: 'https://cloud.digitalocean.com/account/billing',
    resourcesUrl: 'https://cloud.digitalocean.com/droplets',
    authorize: 'https://cloud.digitalocean.com/v1/oauth/authorize',
    scopes: 'droplet:create droplet:read regions:read sizes:read actions:read image:read snapshot:read vpc:read',
} as const;

export const VPS_PROVIDERS = { digitalocean: DIGITALOCEAN } as const;
export type VpsProviderId = keyof typeof VPS_PROVIDERS;
export function isVpsProvider(value: unknown): value is VpsProviderId {
    return typeof value === 'string' && Object.hasOwn(VPS_PROVIDERS, value);
}
export const providerId = z.enum([DIGITALOCEAN.id]);
export const digitalOceanConfig = z.strictObject({
    clientId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .optional(),
    referralUrl: z
        .string()
        .regex(/^https:\/\/m\.do\.co\/c\/[a-zA-Z0-9]+$/)
        .optional(),
});
export const cloudOffer = z.strictObject({
    provider: providerId,
    referralUrl: digitalOceanConfig.shape.referralUrl,
});
export type CloudOffer = z.infer<typeof cloudOffer>;
