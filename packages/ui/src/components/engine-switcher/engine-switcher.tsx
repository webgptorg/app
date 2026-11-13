import { ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import type { UiMessages } from '../../i18n/ui-messages';
import { cx } from '../../internal/cx';
import { Badge } from '../badge/badge';
import type { BadgeTone } from '../badge/badge';
import { Menu } from '../menu/menu';
import type { MenuEntry } from '../menu/menu';
import type { TrustMarkFingerprint } from '../trust-mark/fingerprint';
import { TrustMark } from '../trust-mark/trust-mark';

export type EngineStatus = 'online' | 'offline' | 'unknown';

export interface CurrentEngine {
    readonly name: string;
    /** The engine's `TrustMark` fingerprint, `null` while its engine ID is unknown. */
    readonly fingerprint: TrustMarkFingerprint | null;
    readonly hostname: string;
}

export interface SwitchableEngine extends CurrentEngine {
    readonly status: EngineStatus;
    /** The engine's own origin; switching is a plain navigation there (its own origin and sign-in). */
    readonly href: string;
}

export interface EngineSwitcherProps {
    readonly current: CurrentEngine;
    /** The member's other engines; engine-ui cannot list them and passes none (only the dashboard can). */
    readonly engines: readonly SwitchableEngine[];
    /** The dashboard's engine list; omitted when `null` (e.g. an engine not linked to a dashboard). */
    readonly allEnginesHref: string | null;
    readonly addEngineHref: string | null;
    /** Mark only, e.g. in a collapsed sidebar; the name stays the accessible name. */
    readonly compact?: boolean;
    /** Actions about the current engine shown above it, e.g. engine-ui's "Verify this engine". */
    readonly leadingItems?: readonly MenuEntry[];
}

const STATUS_TONES: Readonly<Record<EngineStatus, BadgeTone>> = {
    online: 'success',
    offline: 'danger',
    unknown: 'neutral',
};

function statusLabel(messages: UiMessages, status: EngineStatus): string {
    switch (status) {
        case 'online':
            return messages.engineOnline();
        case 'offline':
            return messages.engineOffline();
        case 'unknown':
            return messages.engineUnknown();
    }
}

function EngineIdentity({ engine, status }: { readonly engine: CurrentEngine; readonly status?: ReactNode }) {
    return (
        <span className="flex min-w-0 flex-1 items-center gap-2">
            <span aria-hidden="true" className="inline-flex shrink-0">
                <TrustMark fingerprint={engine.fingerprint} state="verified" size="sm" showCode={false} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium text-(--engine-switcher-text)">{engine.name}</span>
                <span className="truncate text-2xs text-(--engine-switcher-muted)">{engine.hostname}</span>
            </span>
            {status === undefined ? null : <span className="shrink-0">{status}</span>}
        </span>
    );
}

/**
 * A Stripe-style engine menu, opened from the current engine's name and trust mark: the current engine, the other
 * engines as plain links to their own origins, and the dashboard's "All engines" and "Add engine". Fed entirely by
 * the app; it fetches nothing. The current engine is a checked choice (`menuitemradio`), never a link to itself.
 */
export function EngineSwitcher({
    current,
    engines,
    allEnginesHref,
    addEngineHref,
    compact = false,
    leadingItems = [],
}: EngineSwitcherProps) {
    const messages = useUiMessages();
    const items: MenuEntry[] = [
        ...leadingItems,
        ...(leadingItems.length === 0 ? [] : [{ kind: 'separator' as const, id: 'leading' }]),
        { kind: 'heading', id: 'current', label: messages.currentEngine() },
        {
            kind: 'item',
            id: 'current-engine',
            label: `${current.name}, ${current.hostname}`,
            checked: true,
            content: <EngineIdentity engine={current} />,
            onSelect: () => undefined,
        },
        ...engines.map((engine): MenuEntry => {
            const status = statusLabel(messages, engine.status);
            return {
                kind: 'link',
                id: `engine-${engine.hostname}`,
                label: `${engine.name}, ${engine.hostname}, ${status}`,
                href: engine.href,
                content: (
                    <EngineIdentity
                        engine={engine}
                        status={<Badge tone={STATUS_TONES[engine.status]}>{status}</Badge>}
                    />
                ),
            };
        }),
    ];
    const dashboardLinks: MenuEntry[] = [
        ...(allEnginesHref === null
            ? []
            : [{ kind: 'link' as const, id: 'all-engines', label: messages.allEngines(), href: allEnginesHref }]),
        ...(addEngineHref === null
            ? []
            : [{ kind: 'link' as const, id: 'add-engine', label: messages.addEngine(), href: addEngineHref }]),
    ];
    if (dashboardLinks.length > 0) items.push({ kind: 'separator', id: 'dashboard' }, ...dashboardLinks);

    return (
        <Menu
            label={messages.engineSwitcher()}
            items={items}
            matchTriggerWidth={!compact}
            trigger={(trigger) => (
                <button
                    type="button"
                    {...trigger}
                    aria-label={compact ? `${messages.engineSwitcher()}: ${current.name}` : undefined}
                    className={cx(
                        'flex max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-(--engine-switcher-radius) p-2 text-start text-sm hover:bg-(--engine-switcher-hover)',
                        'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                        compact ? 'justify-center' : 'w-full',
                    )}
                >
                    {compact ? (
                        <span aria-hidden="true" className="inline-flex">
                            <TrustMark fingerprint={current.fingerprint} state="verified" size="sm" showCode={false} />
                        </span>
                    ) : (
                        <>
                            <EngineIdentity engine={current} />
                            <ChevronsUpDown
                                aria-hidden="true"
                                className="size-4 shrink-0 text-(--engine-switcher-muted)"
                            />
                        </>
                    )}
                </button>
            )}
        />
    );
}
