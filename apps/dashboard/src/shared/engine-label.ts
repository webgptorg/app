import { z } from 'zod';

export const ENGINE_LABEL_MAX_LENGTH = 40;
const SHORT_ID_LENGTH = 8;

// Letters, marks and digits of any script, spaces and a little punctuation: enough for "Produkce – Brno (2)", nothing
// that reads as markup, a URL or an email address where the label is shown or emailed.
const LABEL_CHARACTERS = /^[\p{L}\p{M}\p{N} .,_'()#+–-]+$/u;
const EDGE_OR_DOUBLE_SPACE = /^ | $| {2}/;

/**
 * The owner's own name for an engine: account metadata typed in the dashboard, never sent to or read from the engine.
 * Exact, so the server stores what the SPA showed: callers normalise input with {@link normalizeEngineLabel} first.
 */
export const engineLabelSchema = z
    .string()
    .min(1)
    .max(ENGINE_LABEL_MAX_LENGTH)
    .regex(LABEL_CHARACTERS)
    .refine((label) => !EDGE_OR_DOUBLE_SPACE.test(label) && label === label.normalize('NFC'))
    .brand<'EngineLabel'>();
export type EngineLabel = z.infer<typeof engineLabelSchema>;

/** What a person typed, as the label it stands for: NFC, single spaces, no spaces at the ends. */
export function normalizeEngineLabel(input: string): string {
    return input.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** The engine ID's first characters: what the revoke dialog asks to be typed. */
export function shortEngineId(engineId: string): string {
    return engineId.slice(0, SHORT_ID_LENGTH);
}

/** How every screen and email names an engine: the owner's label, or else the short ID, always with one ellipsis. */
export function engineLabel(engine: { readonly engineId: string; readonly label: string | null }): string {
    return engine.label ?? `${shortEngineId(engine.engineId)}…`;
}

/**
 * What the screens and emails call a project: its label, else the name someone gave its team (ADR 0018), else its short
 * ID. A team made for an unnamed engine carries its hostname or ID, which is no name.
 */
export function projectName(project: {
    readonly engineId: string;
    readonly hostname: string;
    readonly label: string | null;
    readonly teamName: string | null;
}): string {
    const { teamName } = project;
    const given = teamName !== null && teamName !== project.hostname && teamName !== project.engineId;
    return project.label ?? (given ? teamName : engineLabel({ engineId: project.engineId, label: null }));
}
