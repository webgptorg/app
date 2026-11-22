import type { GatewayLanguage } from './language';

/**
 * What the server fills into a page. One set for every page: a page uses the names it needs, and the server always
 * passes all of them, so adding a placeholder to a page cannot silently render empty.
 */
export interface GatewayPageValues {
    readonly lang: GatewayLanguage;
    readonly engineId: string;
    /** The engine's hostname, without scheme. */
    readonly hostname: string;
    /** `deriveEngineFingerprint(engineId).formatted`: `XXXX-XXXX-XXXX-XXXX-XXXX`. */
    readonly fingerprint: string;
    /** The fingerprint's 5×5 cells, row by row, `1` filled and `0` empty. */
    readonly fingerprintCells: string;
    /** The engine's CLI name in the recovery hints, such as `ptbk` or `mock-engine`. */
    readonly command: string;
    /** Complete host commands; pending ptbk engines include `--onboarding <engine-id>`. */
    readonly setupLinkCommand?: string;
    readonly resetOwnerCommand?: string;
    readonly statusCommand?: string;
    /** Whether the engine has an owner. Public: the sign-in page shows it to anyone anyway. */
    readonly owner: 'none' | 'set';
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const FINGERPRINT_CELLS = /^[01]{25}$/;
const LANGUAGES: ReadonlySet<string> = new Set(['en', 'cs']);
const OWNER_STATES: ReadonlySet<string> = new Set(['none', 'set']);
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set([
    'lang',
    'engineId',
    'hostname',
    'fingerprint',
    'fingerprintCells',
    'command',
    'owner',
] satisfies (keyof GatewayPageValues)[]);

const ESCAPES: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);

function escapedValues(values: GatewayPageValues): ReadonlyMap<string, string> {
    const record = values as unknown as Readonly<Record<string, unknown>>;
    const escaped = new Map<string, string>();
    for (const name of PLACEHOLDER_NAMES) {
        const value = record[name];
        if (typeof value !== 'string') throw new Error(`Gateway page value "${name}" is missing`);
        escaped.set(name, escapeHtml(value));
    }
    // These three steer the stylesheet and the script, so a wrong one would show the wrong state rather than text.
    if (!LANGUAGES.has(values.lang)) throw new Error('Gateway page value "lang" is not en or cs');
    if (!OWNER_STATES.has(values.owner)) throw new Error('Gateway page value "owner" is not none or set');
    if (!FINGERPRINT_CELLS.test(values.fingerprintCells)) {
        throw new Error('Gateway page value "fingerprintCells" is not 25 cells of 0 and 1');
    }
    const connect = values.command === 'ptbk' ? 'ptbk connect' : values.command;
    escaped.set(
        'setupLinkCommand',
        escapeHtml(
            values.setupLinkCommand ?? `${connect} ${values.command === 'ptbk' ? '--setup-link' : 'setup-link'}`,
        ),
    );
    escaped.set(
        'resetOwnerCommand',
        escapeHtml(
            values.resetOwnerCommand ?? `${connect} ${values.command === 'ptbk' ? '--reset-owner' : 'owner --reset'}`,
        ),
    );
    escaped.set('statusCommand', escapeHtml(values.statusCommand ?? `${values.command} status`));
    return escaped;
}

/**
 * Fills a page template's `{{name}}` placeholders with HTML-escaped values. Throws on an unknown placeholder, a stray
 * `{{` or a missing or malformed value, so a page and its server cannot drift apart unnoticed.
 */
export function renderGatewayPage(template: string, values: GatewayPageValues): string {
    const escaped = escapedValues(values);
    let placeholders = 0;
    const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
        const value = escaped.get(name);
        if (value === undefined) throw new Error(`Unknown gateway page placeholder "{{${name}}}"`);
        placeholders += 1;
        return value;
    });
    if (template.split('{{').length - 1 !== placeholders) throw new Error('Malformed gateway page placeholder');
    return rendered;
}
