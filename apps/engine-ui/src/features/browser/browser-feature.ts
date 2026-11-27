import { defineFeature } from '../../app/registry/feature';
import { WATCH_REQUIREMENT } from './browser-queries';
import { useBrowserEventSync } from './use-browser-event-sync';

/**
 * The engine's browser (`browser-tab@1`, draft): watching the tabs agents work in, taking one over, answering an agent's
 * request for help and signing in to a site in a fresh tab. It has no page of its own in the navigation; its items
 * appear where the work is (Home, the run, the chat, the Wallet), and nothing at all without the capability.
 */
export const browserFeature = defineFeature({
    id: 'browser',
    requires: WATCH_REQUIREMENT,
    eventSync: { useEventSync: useBrowserEventSync },
});
