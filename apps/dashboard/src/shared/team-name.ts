import { z } from 'zod';

import { normalizeEngineLabel } from './engine-label';

export const TEAM_NAME_MAX_LENGTH = 64;

// The engine label's alphabet, longer, so a team named after its engine's hostname is valid; still nothing that
// reads as markup or an email address where the name is shown or emailed.
const NAME_CHARACTERS = /^[\p{L}\p{M}\p{N} .,_'()#+–-]+$/u;
const EDGE_OR_DOUBLE_SPACE = /^ | $| {2}/;

/** A team's name: account metadata typed in the dashboard, never sent to an engine. Exact, like the engine label. */
export const teamNameSchema = z
    .string()
    .min(1)
    .max(TEAM_NAME_MAX_LENGTH)
    .regex(NAME_CHARACTERS)
    .refine((name) => !EDGE_OR_DOUBLE_SPACE.test(name) && name === name.normalize('NFC'))
    .brand<'TeamName'>();
export type TeamName = z.infer<typeof teamNameSchema>;

export const normalizeTeamName = normalizeEngineLabel;
