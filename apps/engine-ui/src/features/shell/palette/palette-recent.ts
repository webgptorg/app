import { AgentId } from '@ptbk/engine-api';
import type { MemberId } from '@ptbk/engine-api';
import type { PreferenceStorage } from '@ptbk/ui';
import { z } from 'zod';

export const MAX_RECENT = 5;

/**
 * What the member last picked in the palette. Places and commands are kept by ID and shown only while they still
 * resolve, so a lost permission or capability drops them; an agent keeps its name, since it may not be among the
 * agents the palette lists.
 */
export const RecentPick = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('item'), id: z.string().min(1).max(200) }),
    z.object({ kind: z.literal('agent'), id: AgentId, label: z.string().min(1).max(200) }),
]);
export type RecentPick = z.infer<typeof RecentPick>;

/** Per member, so someone else signing in on the same browser does not see what this member opened. */
export function recentStorageKey(memberId: MemberId): string {
    return `ptbk.palette.recent.${memberId}`;
}

export function pickKey(pick: RecentPick): string {
    return pick.kind === 'agent' ? `agent:${pick.id}` : pick.id;
}

/** Tolerant: storage is the member's own, but a bad or outdated entry is dropped rather than trusted. */
export function readRecentPicks(storage: PreferenceStorage | undefined, memberId: MemberId): RecentPick[] {
    try {
        const raw = storage?.getItem(recentStorageKey(memberId));
        if (raw === null || raw === undefined) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((entry) => {
            const pick = RecentPick.safeParse(entry);
            return pick.success ? [pick.data] : [];
        });
    } catch {
        return [];
    }
}

/** The newest first, each once, at most `MAX_RECENT`. */
export function rememberPick(
    storage: PreferenceStorage | undefined,
    memberId: MemberId,
    pick: RecentPick,
): RecentPick[] {
    const picks = [
        pick,
        ...readRecentPicks(storage, memberId).filter((previous) => pickKey(previous) !== pickKey(pick)),
    ].slice(0, MAX_RECENT);
    try {
        storage?.setItem(recentStorageKey(memberId), JSON.stringify(picks));
    } catch {
        // Recents are a convenience; without storage the palette simply has none.
    }
    return picks;
}
