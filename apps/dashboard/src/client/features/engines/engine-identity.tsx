import { deriveEngineFingerprint } from '@ptbk/protocol';
import { TrustMark } from '@ptbk/ui';
import type { TrustMarkSize } from '@ptbk/ui';
import { CircleDashed } from 'lucide-react';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import type { EngineView, TeamView } from '../../../shared/api/routes';

/**
 * What a team's engine is called on screen. A team made for an engine nobody named carries its hostname or ID, which is
 * no name: the engine's own label reads better then, and otherwise the hostname stands as the name.
 */
export function engineDisplayName(
    team: Pick<TeamView, 'name'>,
    engine: Pick<EngineView, 'engineId' | 'hostname' | 'label'> | undefined,
): string {
    const name: string = team.name;
    const unnamed = engine !== undefined && (name === engine.hostname || name === engine.engineId);
    return unnamed ? (engine.label ?? engine.hostname) : name;
}

/**
 * The engine's fingerprint seal, the mark that identifies it everywhere it is listed. Before an engine is linked
 * there is no fingerprint to show, and a seal would promise one: a dashed circle stands in.
 */
export function EngineMark(props: {
    readonly engineId: string | null;
    readonly name: string;
    readonly size?: TrustMarkSize;
    /** Where a labelled seal of the same engine is already on the page, this one is only a visual anchor. */
    readonly decorative?: boolean;
}) {
    if (props.engineId === null) {
        return (
            <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-text-muted">
                <CircleDashed className="size-5" />
            </span>
        );
    }
    const mark = (
        <TrustMark
            fingerprint={deriveEngineFingerprint(props.engineId)}
            state="verified"
            size={props.size ?? 'sm'}
            showCode={false}
            className="shrink-0"
            label={m.engines_fingerprint_label({ name: props.name })}
        />
    );
    return props.decorative === true ? (
        <span aria-hidden="true" className="flex shrink-0">
            {mark}
        </span>
    ) : (
        mark
    );
}

/**
 * Mark, name and, when it says something the name does not, the hostname as a quiet mono line under it. A long
 * hostname wraps anywhere rather than being cut, so the full address stays readable on a phone.
 */
export function EngineIdentity(props: {
    readonly engineId: string | null;
    readonly name: string;
    readonly hostname?: string | undefined;
    /** The name, usually a quiet link to the engine; defaults to the plain name. */
    readonly children?: ReactNode;
}) {
    const { name, hostname } = props;
    const nameIsAddress = hostname === name;
    return (
        <span className="flex min-w-0 items-center gap-3">
            <EngineMark engineId={props.engineId} name={name} />
            <span className="flex min-w-0 flex-col">
                <span
                    className={`min-w-0 font-medium [overflow-wrap:anywhere] ${nameIsAddress ? 'font-mono text-sm' : ''}`}
                >
                    {props.children ?? name}
                </span>
                {hostname === undefined || nameIsAddress ? null : (
                    <span className="min-w-0 font-mono text-xs text-text-muted [overflow-wrap:anywhere]">
                        {hostname}
                    </span>
                )}
            </span>
        </span>
    );
}
