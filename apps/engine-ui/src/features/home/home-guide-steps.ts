/** The next steps Home's robot can offer, in the order it offers them. */
export const HOME_GUIDE_STEPS = ['create-agent', 'set-up-wallet', 'invite-colleague', 'ask-chatter'] as const;
export type HomeGuideStep = (typeof HOME_GUIDE_STEPS)[number];

/**
 * One step as Home sees it: `null` when the member cannot take it here (no capability or permission), otherwise
 * whether it still waits, or `undefined` while the answer is loading.
 */
export type StepState = { readonly pending: boolean | undefined } | null;

export type HomeGuide =
    /** Something earlier is still loading: show nothing yet, so the line never flips from one step to another. */
    | { readonly kind: 'loading' }
    | { readonly kind: 'step'; readonly step: HomeGuideStep }
    /** Nothing left to do: a quiet tip the member can dismiss for good on this device. */
    | { readonly kind: 'done' }
    | { readonly kind: 'hidden' };

/** Only the first step that still waits; one line, one action, never a checklist. */
export function nextHomeGuide(steps: Readonly<Record<HomeGuideStep, StepState>>, dismissed: boolean): HomeGuide {
    for (const step of HOME_GUIDE_STEPS) {
        const state = steps[step];
        if (state === null) continue;
        if (state.pending === undefined) return { kind: 'loading' };
        if (state.pending) return { kind: 'step', step };
    }
    return dismissed ? { kind: 'hidden' } : { kind: 'done' };
}

/**
 * The Wallet waits while it was never set up or holds no login yet. `unavailable` is not offered: this host cannot
 * protect the key, so there is nothing for the member to do here.
 */
export function walletNeedsSetup(wallet: {
    readonly state: string;
    readonly records: readonly unknown[];
    readonly lockedRecords: number;
}): boolean {
    switch (wallet.state) {
        case 'ready':
            return wallet.records.length === 0 && wallet.lockedRecords === 0;
        case 'empty':
        case 'setup':
            return true;
        default:
            return false;
    }
}
