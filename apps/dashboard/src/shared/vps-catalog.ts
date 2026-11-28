import { DIGITALOCEAN_MONTHLY_USD, providerId, type VpsProviderId } from './vps';

export const DIGITALOCEAN = {
    id: providerId.enum.digitalocean,
    label: 'DigitalOcean',
    region: 'fra1',
    size: 's-2vcpu-4gb',
    image: 'ubuntu-24-04-x64',
    monthlyUsd: DIGITALOCEAN_MONTHLY_USD,
    hourlyUsd: 0.03571,
    billingUrl: 'https://cloud.digitalocean.com/account/billing',
    resourcesUrl: 'https://cloud.digitalocean.com/droplets',
    authorize: 'https://cloud.digitalocean.com/v1/oauth/authorize',
    scopes: 'droplet:create droplet:read regions:read sizes:read actions:read image:read snapshot:read vpc:read',
} as const;

export const VPS_PROVIDERS = { digitalocean: DIGITALOCEAN } satisfies Record<
    VpsProviderId,
    { readonly id: VpsProviderId }
>;
