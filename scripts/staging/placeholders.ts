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

const IPV4 = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const IPV6 = /^[0-9a-f:]+$/;

const VALUE_RULES = {
    RELAY_IPV4: { pattern: IPV4, hint: 'an IPv4 address' },
    RELAY_IPV6: { pattern: IPV6, hint: 'a lower-case IPv6 address' },
    D1_DATABASE_ID: { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, hint: 'a UUID' },
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
    return values;
}

interface Replacement {
    readonly file: keyof typeof STAGING_FILES;
    readonly placeholder: string;
    readonly needs: readonly StagingKey[];
    readonly value: (values: Required<StagingValues>) => string;
}

/**
 * The staging domains (ptbk.link), the account ID, the admin's SSH key, the contacts and the install guide are committed
 * values, not placeholders; only what exists after runbook steps 6 and 7 is filled in.
 */
const REPLACEMENTS: readonly Replacement[] = [
    { file: 'wrangler', placeholder: '<staging-d1-id>', needs: ['D1_DATABASE_ID'], value: (v) => v.D1_DATABASE_ID },
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
];

/** Placeholders deliberately left in staging, with what fills them. */
export const LEFT_ON_PURPOSE: Readonly<Record<string, string>> = {
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
    return {
        ...Object.fromEntries(Object.keys(VALUE_RULES).map((key) => [key, ''])),
        ...values,
    } as Required<StagingValues>;
}

const PLACEHOLDER = /<[a-z][a-z0-9-]*>/g;

export function fillPlaceholders(
    input: Readonly<Record<keyof typeof STAGING_FILES, string>>,
    given: StagingValues,
): FillResult {
    const values = withDefaults(validateStagingValues(given));
    const known = (key: StagingKey): boolean => given[key] !== undefined;
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
    const left = (Object.keys(STAGING_FILES) as (keyof typeof STAGING_FILES)[]).flatMap((file) =>
        [...new Set(files[file].replace(/^\s*(#|\/\/).*$/gm, '').match(PLACEHOLDER) ?? [])].map((placeholder) => ({
            file: STAGING_FILES[file],
            placeholder,
            reason: LEFT_ON_PURPOSE[placeholder] ?? `needs ${neededFor(file, placeholder)} in staging.env`,
        })),
    );
    return { files: { ...files, wrangler: wrangler.before + files.wrangler + wrangler.after }, filled, left };
}

function neededFor(file: keyof typeof STAGING_FILES, placeholder: string): string {
    const replacement = REPLACEMENTS.find((r) => r.file === file && r.placeholder.includes(placeholder));
    return replacement === undefined ? 'a value' : replacement.needs.join(' and ');
}
