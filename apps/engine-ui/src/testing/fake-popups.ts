import { vi } from 'vitest';
import type { Mock } from 'vitest';

import type { StepUpPopup, StepUpPopups } from '../features/step-up/step-up-popup';

export interface FakePopup extends StepUpPopup {
    readonly url: string;
    closed: boolean;
}

export interface FakePopups extends StepUpPopups {
    readonly open: Mock<(url: string) => FakePopup | null>;
    /** The windows opened so far, newest last. */
    readonly opened: readonly FakePopup[];
    /** What the gateway's page posts once the passkey verified, for the newest window; then it closes. */
    confirm(): void;
    /** Posts anything on the channel, as another tab or an old window might. */
    post(data: unknown): void;
}

/** The browser's popup and channel for the step-up, driven by the test; `blocked` opens nothing. */
export function createFakePopups({ blocked = false }: { readonly blocked?: boolean } = {}): FakePopups {
    const listeners = new Set<(data: unknown) => void>();
    const opened: FakePopup[] = [];
    const post = (data: unknown) => {
        for (const listener of [...listeners]) listener(data);
    };
    return {
        opened,
        open: vi.fn((url: string) => {
            if (blocked) return null;
            const popup: FakePopup = {
                url,
                closed: false,
                close() {
                    popup.closed = true;
                },
            };
            opened.push(popup);
            return popup;
        }),
        listen: (onMessage) => {
            listeners.add(onMessage);
            return () => {
                listeners.delete(onMessage);
            };
        },
        confirm() {
            const popup = opened.at(-1);
            if (popup === undefined) throw new Error('no step-up window is open');
            post({ type: 'step-up-confirmed', nonce: new URL(popup.url, 'https://x').searchParams.get('nonce') });
            popup.closed = true;
        },
        post,
    };
}
