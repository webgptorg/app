import { MAX_WALLET_LABEL_LENGTH, MAX_WALLET_PASSWORD_LENGTH, MAX_WALLET_USERNAME_LENGTH } from '@ptbk/engine-api';
import { z } from 'zod';

import { MAX_IMPORT_ROWS, parseImportCsv } from './import-csv';
import { OneTimeValue } from './one-time-value';
import { toWalletOrigin } from './wallet-origin';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface ImportLogin {
    readonly id: number;
    readonly origin: string;
    readonly username: string;
    readonly label: string;
}

export interface ImportPreview {
    readonly logins: readonly ImportLogin[];
    readonly skipped: number;
}

/** Separate from the preview: only this private, non-serialisable memory holds passwords before selection. */
export class ImportPasswords {
    #values = new Map<number, OneTimeValue>();

    set(id: number, value: string): void {
        this.#values.set(id, new OneTimeValue(value));
    }

    take(id: number): OneTimeValue {
        const value = this.#values.get(id) ?? new OneTimeValue('');
        this.#values.delete(id);
        return value;
    }

    clear(): void {
        for (const value of this.#values.values()) value.take();
        this.#values.clear();
    }

    toJSON(): Record<string, never> {
        return {};
    }
}

export type ImportFailure = 'invalid' | 'encrypted' | 'too-large' | 'too-many';
export type PasswordImportResult =
    | { readonly kind: 'parsed'; readonly preview: ImportPreview; readonly passwords: ImportPasswords }
    | { readonly kind: ImportFailure };

const Login = z.object({
    username: z.string().trim().min(1).max(MAX_WALLET_USERNAME_LENGTH),
    password: z.string().min(1).max(MAX_WALLET_PASSWORD_LENGTH),
    label: z.string().trim().max(MAX_WALLET_LABEL_LENGTH),
});
const BitwardenItem = z.object({
    type: z.literal(1),
    name: z.string().nullish(),
    deletedDate: z.string().nullish(),
    login: z.object({
        username: z.string().nullish(),
        password: z.string().nullish(),
        uris: z.array(z.unknown()).max(MAX_IMPORT_ROWS).nullish(),
    }),
});
const Uri = z.object({ uri: z.string().max(2048), match: z.number().nullish() });
const Envelope = z.object({ encrypted: z.literal(false).optional(), items: z.array(z.unknown()) });

/** The engine upserts case-insensitive accounts and treats a leading www as the same service. */
export function importLoginKey(login: { readonly origin: string; readonly username: string | null }): string {
    const url = new URL(login.origin);
    return JSON.stringify([url.protocol, url.host.replace(/^www\./, ''), login.username?.trim().toLowerCase() ?? null]);
}

/** An older engine may hide the account metadata: protect every account on that service in that case. */
export function hasImportConflict(keys: ReadonlySet<string>, login: ImportLogin): boolean {
    return keys.has(importLoginKey(login)) || keys.has(importLoginKey({ ...login, username: null }));
}

function importOrigin(website: string): string | null {
    // URL() removes embedded tabs/newlines and accepts separators in hostnames. A combined URI cell must never
    // accidentally grant a password to a different, partially parsed host. JSON supports separate URI entries.
    if (website.length > 2048 || /[\r\n\t]/.test(website)) return null;
    const origin = toWalletOrigin(website);
    return origin !== null && !/[,;]/.test(new URL(origin).hostname) ? origin : null;
}

class PreviewBuilder {
    readonly passwords = new ImportPasswords();
    readonly #logins = new Map<string, ImportLogin | null>();
    #nextId = 0;
    skipped = 0;

    add(website: string, values: unknown): void {
        const origin = importOrigin(website);
        const parsed = Login.safeParse(values);
        if (origin === null || !parsed.success) {
            this.skipped += 1;
            return;
        }
        const { username, password, label } = parsed.data;
        const key = importLoginKey({ origin, username });
        const previous = this.#logins.get(key);
        if (previous !== undefined) {
            // Conflicting exports must never silently choose which password wins. Exclude the whole group.
            if (previous !== null) {
                this.passwords.take(previous.id).take();
                this.skipped += 1;
            }
            this.#logins.set(key, null);
            this.skipped += 1;
            return;
        }
        const id = this.#nextId++;
        this.#logins.set(key, { id, origin, username, label });
        this.passwords.set(id, password);
    }

    result(): PasswordImportResult {
        const logins = [...this.#logins.values()].filter((login) => login !== null);
        if (logins.length > MAX_IMPORT_ROWS) {
            this.passwords.clear();
            return { kind: 'too-many' };
        }
        return { kind: 'parsed', preview: { logins, skipped: this.skipped }, passwords: this.passwords };
    }
}

function parseBitwarden(text: string): PasswordImportResult {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { kind: 'invalid' };
    }
    if (typeof raw === 'object' && raw !== null && 'encrypted' in raw && raw.encrypted !== false) {
        return { kind: 'encrypted' };
    }
    // Export envelopes have provider-specific metadata; parse known fields and discard all other contents.
    const envelope = Envelope.safeParse(raw);
    if (!envelope.success) return { kind: 'invalid' };
    if (envelope.data.items.length > MAX_IMPORT_ROWS) return { kind: 'too-many' };
    const builder = new PreviewBuilder();
    for (const rawItem of envelope.data.items) {
        const item = BitwardenItem.safeParse(rawItem);
        if (!item.success || item.data.deletedDate != null) {
            builder.skipped += 1;
            continue;
        }
        const { login, name } = item.data;
        const origins = new Map<string, string>();
        for (const rawUri of login.uris ?? []) {
            const uri = Uri.safeParse(rawUri);
            // "Never" and regular-expression matching are not website grants in the Wallet.
            if (!uri.success || uri.data.match === 4 || uri.data.match === 5) continue;
            const origin = importOrigin(uri.data.uri);
            if (origin !== null) origins.set(importLoginKey({ origin, username: null }), origin);
        }
        if (origins.size === 0) builder.skipped += 1;
        for (const origin of origins.values()) {
            builder.add(origin, { username: login.username, password: login.password, label: name ?? '' });
        }
        const result = builder.result();
        if (result.kind !== 'parsed') return result;
    }
    return builder.result();
}

function column(headers: readonly string[], names: readonly string[]): number | undefined {
    const matches = headers.flatMap((header, index) => (names.includes(header) ? [index] : []));
    return matches.length === 1 ? matches[0] : undefined;
}

function parseCsv(text: string): PasswordImportResult {
    const csv = parseImportCsv(text);
    if (csv.kind !== 'rows') return csv;
    const [header, ...rows] = csv.rows;
    if (header === undefined) return { kind: 'invalid' };
    const headers = header.map((value) => value.trim().toLowerCase());
    if (new Set(headers).size !== headers.length) return { kind: 'invalid' };
    const website = column(headers, ['login_uri', 'url', 'website', 'hostname']);
    const username = column(headers, ['login_username', 'username', 'user name']);
    const password = column(headers, ['login_password', 'password']);
    const label = column(headers, ['name', 'title']);
    if (website === undefined || username === undefined || password === undefined) return { kind: 'invalid' };
    const type = headers.indexOf('type');
    const archived = headers.indexOf('archived');
    const builder = new PreviewBuilder();
    for (const row of rows) {
        if (row.length !== headers.length) {
            builder.passwords.clear();
            return { kind: 'invalid' };
        }
        if ((type >= 0 && row[type] !== 'login') || (archived >= 0 && /^(true|1)$/i.test(row[archived] ?? ''))) {
            builder.skipped += 1;
            continue;
        }
        builder.add(row[website] ?? '', {
            username: row[username],
            password: row[password],
            label: label === undefined ? '' : row[label],
        });
    }
    return builder.result();
}

/** No filename, row content or parser exception is ever used as an error message. */
export function parsePasswordImport(text: string): PasswordImportResult {
    if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) return { kind: 'too-large' };
    const clean = text.replace(/^\uFEFF/, '');
    const first = clean.trimStart().charAt(0);
    return first === '{' || first === '[' ? parseBitwarden(clean) : parseCsv(clean);
}
