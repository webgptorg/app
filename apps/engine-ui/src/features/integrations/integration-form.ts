import { McpServerUrl, RepositoryName } from '@ptbk/engine-api';
import type { ServerFieldError } from '@ptbk/ui';
import { z } from 'zod';

import { m } from '../../paraglide/messages';

/** The contract's limits on what an integration may reference (`secretNames`). */
export const MAX_SECRET_NAMES = 50;
const MAX_SECRET_NAME_LENGTH = 128;

/** Names typed one per line or separated by commas; blanks dropped, duplicates kept once, order kept. */
export function parseSecretNames(text: string): string[] {
    return [
        ...new Set(
            text
                .split(/[,\n]/)
                .map((name) => name.trim())
                .filter((name) => name !== ''),
        ),
    ];
}

export function formatSecretNames(names: readonly string[]): string {
    return names.join(', ');
}

export const CREATABLE_KINDS = ['mcp-server', 'repository'] as const;
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

/**
 * Every field the add and edit forms show; the kind decides which of `url` and `repository` counts. The form holds
 * secret names only: their values are entered on the Secrets page and never pass through here.
 */
export const IntegrationFormSchema = z
    .object({
        kind: z.string(),
        name: z
            .string()
            .trim()
            .min(1, { error: () => m.integration_name_required() })
            .max(128, { error: () => m.integration_name_too_long() }),
        url: z.string().trim(),
        repository: z.string().trim(),
        agentId: z.string(),
        secretNames: z.string(),
    })
    .superRefine((values, context) => {
        if (values.kind === 'mcp-server' && !McpServerUrl.safeParse(values.url).success) {
            context.addIssue({ code: 'custom', path: ['url'], message: m.integration_url_invalid() });
        }
        if (values.kind === 'repository' && !RepositoryName.safeParse(values.repository).success) {
            context.addIssue({ code: 'custom', path: ['repository'], message: m.integration_repository_invalid() });
        }
        const names = parseSecretNames(values.secretNames);
        if (names.length > MAX_SECRET_NAMES || names.some((name) => name.length > MAX_SECRET_NAME_LENGTH)) {
            context.addIssue({
                code: 'custom',
                path: ['secretNames'],
                message: m.integration_secret_names_invalid({ max: MAX_SECRET_NAMES }),
            });
        }
    });
export type IntegrationFormValues = z.input<typeof IntegrationFormSchema>;

/**
 * The engine names request fields as `body.url` or `body.secretNames.3`; the form's fields are `url` and one
 * `secretNames` text, so every secret name error lands on it.
 */
export function toFormErrors(errors: readonly ServerFieldError[]): ServerFieldError[] {
    return errors.map(({ path, message }) => {
        const field = path.replace(/^\/?body[./]/, '');
        return { path: /^secretNames\b/.test(field) ? 'secretNames' : field, message };
    });
}
