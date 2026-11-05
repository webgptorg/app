import { fail } from './kit';
import type { Handlers } from './kit';

/** Live sessions are design only: even a core told to advertise them has nothing to open. */
export const LIVE_HANDLERS: Pick<Handlers, 'openLiveAudioSession' | 'openBrowserTabSession'> = {
    openLiveAudioSession: () => fail('capability-not-supported'),
    openBrowserTabSession: () => fail('capability-not-supported'),
};
