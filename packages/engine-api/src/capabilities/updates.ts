import { z } from 'zod';

import { SemVer } from '../common';
import { defineRoute } from '../route';
import { UiUpdateCheck, UiUpdateCheckReader } from '../security';
import { KNOWN_CAPABILITIES } from './capability';

/**
 * `updates@1` (C-19): what an owner needs to see and do about updates from the browser. Most of it is reported where it
 * already lives, in `GET /security`: the engine's version, the newest published one and the command that updates it
 * (`update`), and the UI bundle, its policy, last check and next check (`ui`). The capability adds one action, running
 * the UI loader's normal check early, and one event. Updating the engine itself stays on the host. Design and test
 * cases: docs/engine-integration/updates.md.
 */

/**
 * The periodic check runs at most this far apart (ui-loader.md, Fetch): `GET /security` → `ui.nextCheckAt` is never
 * later than the last check plus this.
 */
export const MAX_UI_CHECK_INTERVAL_MS = 3_600_000;

/**
 * At most one check-now per engine in this window, whoever asks; earlier is 429 `update-check-too-soon`. Scheduled
 * checks do not count. The release store is shared, so a busy browser tab must not turn into load on it.
 */
export const UPDATE_CHECK_MIN_INTERVAL_MS = 60_000;

/**
 * Sent after every UI update check, scheduled or asked for, and whenever the bundle the engine serves changes (an
 * install, a revocation's fallback). `uiVersion` is the bundle served from now on, `null` while none is; a page built
 * as another version offers a reload. Carries no check details: those are in `GET /security` (`security.read`).
 */
export const UpdatesChangedEvent = z.strictObject({
    type: z.literal('updates.changed'),
    uiVersion: SemVer.nullable(),
});
export type UpdatesChangedEvent = z.infer<typeof UpdatesChangedEvent>;

export const UPDATES_ROUTES = {
    checkForUiUpdate: defineRoute({
        id: 'checkForUiUpdate',
        method: 'POST',
        path: '/updates/ui/check',
        summary: 'Run the UI loader’s normal update check now, and answer its result',
        description:
            'Exactly the check the engine’s timer runs, only earlier: the same policy, verification, delay, ' +
            'revocation and downgrade rules, and never `mode: manual`, so a release still inside its delay is ' +
            '`refused` with `delay-not-elapsed` and its `eligibleAt`. A check already running is joined, not ' +
            'repeated. The engine answers once the check has ended and `GET /security` reports it as ' +
            '`ui.lastUpdateCheck`, then sends `updates.changed`. Under `manual` there is no scheduled check to run ' +
            'early: 409 `update-policy-manual`. More than one request per engine within ' +
            '`UPDATE_CHECK_MIN_INTERVAL_MS` is 429 `update-check-too-soon`. Audited as `updates.ui-check`.',
        permission: 'settings.manage',
        capability: KNOWN_CAPABILITIES.updates,
        responses: { 200: { kind: 'json', schema: UiUpdateCheck, read: UiUpdateCheckReader } },
        problems: ['update-check-too-soon', 'update-policy-manual'],
    }),
} as const;
