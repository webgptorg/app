import { DurableObject } from 'cloudflare:workers';

import { countAttempt, type WindowState } from './fixed-window';

const STATE_KEY = 'window';

/**
 * The counter behind `createDurableObjectRateLimiter`, one instance per HMAC-named key. It keeps nothing past its
 * window: the alarm at the window's end deletes the state, and an expired window is replaced on access anyway.
 */
export class HourlyRateLimiter extends DurableObject {
    async consume(limit: number, windowMs: number, nowMs: number): Promise<'allowed' | 'limited'> {
        const state = (await this.ctx.storage.get<WindowState>(STATE_KEY)) ?? null;
        const decision = countAttempt(state, { limit, windowMs }, nowMs);
        if (decision.kind === 'limited') {
            return 'limited';
        }
        await this.ctx.storage.put(STATE_KEY, decision.state);
        if (decision.newWindow) {
            await this.ctx.storage.setAlarm(decision.state.start + windowMs);
        }
        return 'allowed';
    }

    override async alarm(): Promise<void> {
        await this.ctx.storage.deleteAll();
    }
}
