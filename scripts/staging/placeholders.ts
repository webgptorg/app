// Fills staging's placeholders in wrangler.jsonc and the staging OpenTofu roots from one set of values (the local,
// git-ignored staging.env; docs/staging-runbook.md, Placeholders). Plain string replacement of known placeholders, so
// the files keep their layout and comments; production's placeholders are never touched.

export const STAGING_FILES = {
    wrangler: 'apps/dashboard/wrangler.jsonc',
    cloudflareTfvars: 'infra/cloudflare/environments/staging/terraform.tfvars',
    cloudflareMain: 'infra/cloudflare/environments/staging/main.tf',
    relayTfvars: 'infra/relay/environments/staging/terraform.tfvars',
    relayMain: 'infra/relay/environments/staging/main.tf',
} as const;

/** The one staging relay in both tfvars; its hostname is `<RELAY_NAME>.<STAGING_ZONE>`. */
export const RELAY_NAME = 'relay-fsn';

export const DEFAULT_INSTALL_GUIDE_URL =
    'https://github.com/webgptorg/app/blob/main/docs/engine-integration/installation.md';

const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[a-z0-9._+-]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const IPV6 = /^[0-9a-f:]+$/;
const CIDR = /^([0-9.]+\/[0-9]{1,2}|[0-9a-f:]+\/[0-9]{1,3})$/;

const VALUE_RULES = {
    CLOUDFLARE_ACCOUNT_ID: { pattern: /^[0-9a-f]{32}$/, hint: '32 lower-case hex characters' },
    STAGING_ZONE: { pattern: DOMAIN, hint: 'a lower-case domain' },
    ENGINE_DOMAIN: { pattern: DOMAIN, hint: 'a lower-case domain' },
    CHALLENGE_ZONE: { pattern: DOMAIN, hint: 'a lower-case domain' },
    DASHBOARD_HOST: { pattern: DOMAIN, hint: 'a lower-case hostname' },
    EMAIL_SENDING_DOMAIN: { pattern: DOMAIN, hint: 'a lower-case domain' },
    SECURITY_CONTACT: { pattern: EMAIL, hint: 'an email address' },
    OPS_EMAIL: { pattern: EMAIL, hint: 'an email address' },
    ABUSE_EMAIL: { pattern: EMAIL, hint: 'an email address' },
    ADMIN_NAME: { pattern: /^[a-z][a-z0-9-]{0,30}$/, hint: 'a lower-case user name' },
    ADMIN_SSH_PUBLIC_KEY: {
        pattern:
            /^(ssh-ed25519|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [ -~]*)?$/,
        hint: 'one ed25519 or ECDSA P-256 public key line',
    },
    ADMIN_CIDRS: { pattern: /^[0-9a-f.:/]+(,[0-9a-f.:/]+)*$/, hint: 'comma-separated CIDRs' },
    RELAY_IPV4: { pattern: IPV4, hint: 'an IPv4 address' },
    RELAY_IPV6: { pattern: IPV6, hint: 'a lower-case IPv6 address' },
    D1_DATABASE_ID: { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, hint: 'a UUID' },
    INSTALL_GUIDE_URL: { pattern: /^https:\/\/[^\s#"\\]+$/, hint: 'an https URL without a fragment' },
} as const;

export type StagingKey = keyof typeof VALUE_RULES;
export type StagingValues = Partial<Record<StagingKey, string>>;

export class StagingValuesError extends Error {
    override readonly name = 'StagingValuesError';
}

function isStagingKey(key: string): key is StagingKey {
    return Object.hasOwn(VALUE_RULES, key);
}

/** `KEY=value` lines; `#` comments and blank lines are skipped, an empty value counts as not known yet. */
export function parseStagingEnv(text: string): StagingValues {
    const values: StagingValues = {};
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (match?.[1] === undefined || match[2] === undefined) {
            throw new StagingValuesError(`line ${String(index + 1)}: expected KEY=value`);
        }
        const key = match[1];
        if (!isStagingKey(key)) throw new StagingValuesError(`line ${String(index + 1)}: unknown key ${key}`);
        const value = match[2].trim().replace(/^"(.*)"$/, '$1');
        if (value !== '') values[key] = value;
    }
    return validateStagingValues(values);
}

export function validateStagingValues(values: StagingValues): StagingValues {
    for (const [key, value] of Object.entries(values) as [StagingKey, string][]) {
        const rule = VALUE_RULES[key];
        if (!rule.pattern.test(value) || /["\\\n]/.test(value)) {
            throw new StagingValuesError(`${key} must be ${rule.hint}`);
        }
    }
    for (const cidr of values.ADMIN_CIDRS?.split(',') ?? []) {
        if (!CIDR.test(cidr)) throw new StagingValuesError(`ADMIN_CIDRS: ${cidr} is not a CIDR`);
    }
    const zones = [values.STAGING_ZONE, values.ENGINE_DOMAIN, values.CHALLENGE_ZONE].filter(
        (zone): zone is string => zone !== undefined,
    );
    for (const a of zones) {
        for (const b of zones) {
            if (a !== b && (a.endsWith(`.${b}`) || b.endsWith(`.${a}`))) {
                throw new StagingValuesError(`${a} and ${b} must be separate domains, neither inside the other`);
            }
        }
    }
    if (new Set(zones).size !== zones.length) {
        throw new StagingValuesError('STAGING_ZONE, ENGINE_DOMAIN and CHALLENGE_ZONE must be three different domains');
    }
    for (const key of ['DASHBOARD_HOST', 'EMAIL_SENDING_DOMAIN'] as const) {
        const host = values[key];
        if (host === undefined) continue;
        if (values.STAGING_ZONE === undefined) throw new StagingValuesError(`${key} needs STAGING_ZONE`);
        if (host !== values.STAGING_ZONE && !host.endsWith(`.${values.STAGING_ZONE}`)) {
            throw new StagingValuesError(`${key} must be inside STAGING_ZONE`);
        }
    }
    return values;
}

interface Replacement {
    readonly file: keyof typeof STAGING_FILES;
    readonly placeholder: string;
    readonly needs: readonly StagingKey[];
    readonly value: (values: Required<StagingValues>) => string;
}

const dashboardHost = (v: Required<StagingValues>): string => v.DASHBOARD_HOST;
const sendingDomain = (v: Required<StagingValues>): string => v.EMAIL_SENDING_DOMAIN;
const relayHostname = (v: Required<StagingValues>): string => `${RELAY_NAME}.${v.STAGING_ZONE}`;

/** Composite placeholders come before the plain ones they contain. */
const REPLACEMENTS: readonly Replacement[] = [
    { file: 'wrangler', placeholder: 'relay-1.staging.<placeholder>', needs: ['STAGING_ZONE'], value: relayHostname },
    { file: 'wrangler', placeholder: 'app.staging.<placeholder>', needs: ['STAGING_ZONE'], value: dashboardHost },
    { file: 'wrangler', placeholder: '<staging-d1-id>', needs: ['D1_DATABASE_ID'], value: (v) => v.D1_DATABASE_ID },
    {
        file: 'wrangler',
        placeholder: '<staging-engine-domain>',
        needs: ['ENGINE_DOMAIN'],
        value: (v) => v.ENGINE_DOMAIN,
    },
    { file: 'wrangler', placeholder: '<public-install-guide-url>', needs: [], value: (v) => v.INSTALL_GUIDE_URL },
    {
        file: 'wrangler',
        placeholder: 'no-reply@<staging-sending-domain>',
        needs: ['STAGING_ZONE'],
        value: (v) => `no-reply@${sendingDomain(v)}`,
    },
    {
        file: 'wrangler',
        placeholder: 'abuse@<staging-abuse-domain>',
        needs: ['ABUSE_EMAIL'],
        value: (v) => v.ABUSE_EMAIL,
    },
    { file: 'wrangler', placeholder: 'ops@<staging-ops-domain>', needs: ['OPS_EMAIL'], value: (v) => v.OPS_EMAIL },
    {
        file: 'wrangler',
        placeholder: '<staging-account-id>',
        needs: ['CLOUDFLARE_ACCOUNT_ID'],
        value: (v) => v.CLOUDFLARE_ACCOUNT_ID,
    },
    {
        file: 'cloudflareTfvars',
        placeholder: 'app.staging.<placeholder>',
        needs: ['STAGING_ZONE'],
        value: dashboardHost,
    },
    {
        file: 'cloudflareTfvars',
        placeholder: '<staging-account-id>',
        needs: ['CLOUDFLARE_ACCOUNT_ID'],
        value: (v) => v.CLOUDFLARE_ACCOUNT_ID,
    },
    {
        file: 'cloudflareTfvars',
        placeholder: '<staging-engine-domain>',
        needs: ['ENGINE_DOMAIN'],
        value: (v) => v.ENGINE_DOMAIN,
    },
    { file: 'cloudflareTfvars', placeholder: '<staging-zone>', needs: ['STAGING_ZONE'], value: (v) => v.STAGING_ZONE },
    {
        file: 'cloudflareTfvars',
        placeholder: '<staging-email-sending-domain>',
        needs: ['STAGING_ZONE'],
        value: sendingDomain,
    },
    {
        file: 'cloudflareTfvars',
        placeholder: '<security-contact>',
        needs: ['SECURITY_CONTACT'],
        value: (v) => v.SECURITY_CONTACT,
    },
    {
        file: 'cloudflareTfvars',
        placeholder: '<staging-relay-fsn-ipv4>',
        needs: ['RELAY_IPV4'],
        value: (v) => v.RELAY_IPV4,
    },
    {
        file: 'cloudflareTfvars',
        placeholder: '<staging-relay-fsn-ipv6>',
        needs: ['RELAY_IPV6'],
        value: (v) => v.RELAY_IPV6,
    },
    {
        file: 'cloudflareMain',
        placeholder: '<staging-account-id>',
        needs: ['CLOUDFLARE_ACCOUNT_ID'],
        value: (v) => v.CLOUDFLARE_ACCOUNT_ID,
    },
    {
        file: 'relayMain',
        placeholder: '<staging-account-id>',
        needs: ['CLOUDFLARE_ACCOUNT_ID'],
        value: (v) => v.CLOUDFLARE_ACCOUNT_ID,
    },
    {
        file: 'relayTfvars',
        placeholder: 'https://app.<staging-zone>',
        needs: ['STAGING_ZONE'],
        value: (v) => `https://${dashboardHost(v)}`,
    },
    { file: 'relayTfvars', placeholder: '<staging-zone>', needs: ['STAGING_ZONE'], value: (v) => v.STAGING_ZONE },
    {
        file: 'relayTfvars',
        placeholder: '<staging-engine-domain>',
        needs: ['ENGINE_DOMAIN'],
        value: (v) => v.ENGINE_DOMAIN,
    },
    { file: 'relayTfvars', placeholder: '<ops-email>', needs: ['OPS_EMAIL'], value: (v) => v.OPS_EMAIL },
    {
        file: 'relayTfvars',
        placeholder: '"<admin-name>" = ["<admin-ssh-public-key>"]',
        needs: ['ADMIN_NAME', 'ADMIN_SSH_PUBLIC_KEY'],
        value: (v) => `"${v.ADMIN_NAME}" = ["${v.ADMIN_SSH_PUBLIC_KEY}"]`,
    },
    {
        file: 'relayTfvars',
        placeholder: '"<admin-network-cidr>"',
        needs: ['ADMIN_CIDRS'],
        value: (v) =>
            v.ADMIN_CIDRS.split(',')
                .map((cidr) => `"${cidr}"`)
                .join(', '),
    },
];

/** Placeholders deliberately left in staging, with what fills them. */
export const LEFT_ON_PURPOSE: Readonly<Record<string, string>> = {
    '<installer-url>': 'the engine team publishes the installer (apply.md step 12, D-11)',
    '<installer-sha256>': 'the engine team publishes the installer (apply.md step 12, D-11)',
    '<staging-standard-product-id>': 'Stripe test mode, needed only with ADAPTERS.billing = "stripe"',
    '<staging-standard-price-id>': 'Stripe test mode, needed only with ADAPTERS.billing = "stripe"',
};

export interface FillResult {
    readonly files: Readonly<Record<keyof typeof STAGING_FILES, string>>;
    readonly filled: readonly string[];
    /** Staging placeholders still in the files, by file. */
    readonly left: readonly { readonly file: string; readonly placeholder: string; readonly reason: string }[];
}

/** Splits wrangler.jsonc so that only `env.staging` is ever edited. */
function stagingSection(wrangler: string): { before: string; staging: string; after: string } {
    const start = wrangler.indexOf('"staging": {');
    const end = wrangler.indexOf('"production": {');
    if (start < 0 || end < start)
        throw new StagingValuesError('wrangler.jsonc: env.staging or env.production not found');
    return { before: wrangler.slice(0, start), staging: wrangler.slice(start, end), after: wrangler.slice(end) };
}

function withDefaults(values: StagingValues): Required<StagingValues> {
    const zone = values.STAGING_ZONE ?? '';
    return {
        ...Object.fromEntries(Object.keys(VALUE_RULES).map((key) => [key, ''])),
        DASHBOARD_HOST: zone === '' ? '' : `app.${zone}`,
        EMAIL_SENDING_DOMAIN: zone === '' ? '' : `mail.${zone}`,
        INSTALL_GUIDE_URL: DEFAULT_INSTALL_GUIDE_URL,
        ...values,
    } as Required<StagingValues>;
}

function acmeChallengeRecord(values: Required<StagingValues>): string {
    return [
        '',
        "# The relay's own certificate (I-01): lego follows this CNAME into the ACME challenge zone, the only zone its",
        '# token can edit.',
        'extra_records = [',
        `  { zone = "dashboard", name = "_acme-challenge.${RELAY_NAME}.${values.STAGING_ZONE}", type = "CNAME", content = "${RELAY_NAME}.${values.CHALLENGE_ZONE}" },`,
        ']',
        '',
    ].join('\n');
}

const PLACEHOLDER = /<[a-z][a-z0-9-]*>/g;

export function fillPlaceholders(
    input: Readonly<Record<keyof typeof STAGING_FILES, string>>,
    given: StagingValues,
): FillResult {
    const values = withDefaults(validateStagingValues(given));
    const known = (key: StagingKey): boolean => given[key] !== undefined || key === 'INSTALL_GUIDE_URL';
    const wrangler = stagingSection(input.wrangler);
    const files: Record<keyof typeof STAGING_FILES, string> = { ...input, wrangler: wrangler.staging };
    const filled: string[] = [];
    for (const replacement of REPLACEMENTS) {
        if (!replacement.needs.every(known)) continue;
        const text = files[replacement.file];
        if (!text.includes(replacement.placeholder)) continue;
        files[replacement.file] = text.replaceAll(replacement.placeholder, replacement.value(values));
        filled.push(`${STAGING_FILES[replacement.file]}: ${replacement.placeholder}`);
    }
    if (known('STAGING_ZONE') && known('CHALLENGE_ZONE') && !/^extra_records\s*=/m.test(files.cloudflareTfvars)) {
        files.cloudflareTfvars = `${files.cloudflareTfvars.replace(/\n*$/, '\n')}${acmeChallengeRecord(values)}`;
        filled.push(`${STAGING_FILES.cloudflareTfvars}: extra_records (_acme-challenge CNAME)`);
    }
    const left = (Object.keys(STAGING_FILES) as (keyof typeof STAGING_FILES)[]).flatMap((file) =>
        [...new Set(files[file].replace(/^\s*(#|\/\/).*$/gm, '').match(PLACEHOLDER) ?? [])].map((placeholder) => ({
            file: STAGING_FILES[file],
            placeholder,
            reason: LEFT_ON_PURPOSE[placeholder] ?? `needs ${neededFor(file, placeholder)} in staging.env`,
        })),
    );
    if (!/^extra_records\s*=/m.test(files.cloudflareTfvars)) {
        left.push({
            file: STAGING_FILES.cloudflareTfvars,
            placeholder: 'extra_records',
            reason: 'needs STAGING_ZONE and CHALLENGE_ZONE in staging.env',
        });
    }
    return { files: { ...files, wrangler: wrangler.before + files.wrangler + wrangler.after }, filled, left };
}

function neededFor(file: keyof typeof STAGING_FILES, placeholder: string): string {
    const replacement = REPLACEMENTS.find((r) => r.file === file && r.placeholder.includes(placeholder));
    return replacement === undefined || replacement.needs.length === 0 ? 'a value' : replacement.needs.join(' and ');
}
