import { Banner, Button, Card, CodeText } from '@ptbk/ui';
import { useEffect, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type LinkCodeView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import { useSession } from '../session/use-session';

const LINK_PERMISSION = 'engine.link';
const SECOND_MS = 1000;

type UpgradeReason = 'not-entitled' | 'engine-limit';

function upgradeReason(error: unknown): UpgradeReason | null {
    const code = problemCode(error);
    return code === 'not-entitled' || code === 'engine-limit' ? code : null;
}

function linkCodeErrorMessage(error: unknown): string | undefined {
    switch (upgradeReason(error)) {
        case 'not-entitled':
            return m.engines_new_not_entitled_title();
        case 'engine-limit':
            return m.engines_new_engine_limit_title();
        case null:
            return undefined;
    }
}

/** Ticks every second from the injected clock; the caller remounts it per code (`key`). */
function useRemainingMs(until: number): number {
    const { now } = useBrowser();
    const [current, setCurrent] = useState(now);
    useEffect(() => {
        const timer = setInterval(() => {
            setCurrent(now());
        }, SECOND_MS);
        return () => {
            clearInterval(timer);
        };
    }, [now]);
    return Math.max(0, until - current);
}

function minutesAndSeconds(ms: number): string {
    const seconds = Math.ceil(ms / SECOND_MS);
    return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

function UpgradeBanner(props: { readonly reason: UpgradeReason }) {
    const title =
        props.reason === 'not-entitled' ? m.engines_new_not_entitled_title() : m.engines_new_engine_limit_title();
    return (
        <Banner tone="warning" title={title}>
            <p>
                {props.reason === 'not-entitled'
                    ? m.engines_new_not_entitled_body()
                    : m.engines_new_engine_limit_body()}
            </p>
            <Link to="/billing">{m.engines_new_upgrade()}</Link>
        </Banner>
    );
}

/** Shown once: the code lives only in this component's state and is never fetched again. */
function InstallCommand(props: {
    readonly view: LinkCodeView;
    readonly onRenew: () => void;
    readonly renewing: boolean;
}) {
    const remaining = useRemainingMs(props.view.expiresAt);
    if (remaining === 0) {
        return (
            <Banner tone="warning" title={m.engines_new_expired_title()}>
                <p>{m.engines_new_expired_body()}</p>
                <Button variant="secondary" loading={props.renewing} onClick={props.onRenew}>
                    {m.engines_new_create_again()}
                </Button>
            </Banner>
        );
    }
    return (
        <Card title={m.engines_new_command_title()}>
            <div className="flex flex-col gap-3">
                <p className="text-sm">{m.engines_new_command_body()}</p>
                <CodeText value={props.view.installCommand} copyable copyLabel={m.engines_new_copy()} />
                <p className="text-sm text-text-muted" aria-live="off">
                    {m.engines_new_expires_in({ time: minutesAndSeconds(remaining) })}
                </p>
            </div>
        </Card>
    );
}

export function NewEnginePage() {
    const client = useApiClient();
    const session = useSession();
    const canLink = session.activeOrg.permissions.includes(LINK_PERMISSION);
    const create = useAppMutation<LinkCodeView>({
        mutationFn: async () => dataOrThrow(await client.call(apiRoutes.createLinkCode, {})),
        errorMessage: linkCodeErrorMessage,
    });
    const reason = upgradeReason(create.error);
    const renew = () => {
        create.mutate();
    };
    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.engines_new_title()}</h1>
            <p>{m.engines_new_intro()}</p>
            {!canLink ? <Banner tone="info">{m.engines_new_not_allowed()}</Banner> : null}
            {reason === null ? null : <UpgradeBanner reason={reason} />}
            {create.data === undefined ? (
                <div>
                    <Button variant="primary" loading={create.isPending} disabled={!canLink} onClick={renew}>
                        {m.engines_new_create()}
                    </Button>
                </div>
            ) : (
                <InstallCommand
                    key={create.data.linkCode}
                    view={create.data}
                    onRenew={renew}
                    renewing={create.isPending}
                />
            )}
        </div>
    );
}
