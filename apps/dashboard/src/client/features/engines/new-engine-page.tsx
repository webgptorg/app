import { Banner, Button, Card, CopyButton, ExternalLink, Tabs } from '@ptbk/ui';
import { useEffect, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type LinkCodeView } from '../../../shared/api/routes';
import type { InstallPathLabelKey } from '../../../shared/install-paths';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode } from '../../api/queries';
import { useBrowser } from '../../core/browser';
import { Link } from '../../core/link';
import { useAppMutation } from '../../core/mutations';
import { useSession } from '../session/use-session';

const LINK_PERMISSION = 'engine.link';
const SECOND_MS = 1000;
const MOVING_ANCHOR = 'moving-an-existing-deployment';

const INSTALL_PATH_LABELS: Record<InstallPathLabelKey, () => string> = {
    'docker-server': () => m.engines_new_tab_docker_server(),
    'docker-compose': () => m.engines_new_tab_docker_compose(),
    'already-running': () => m.engines_new_tab_already_running(),
};

type InstallCommandView = LinkCodeView['installCommands'][number];

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

function guideLink(guideUrl: string, anchor: string): string {
    return `${guideUrl}#${anchor}`;
}

/** Text only: a command is never parsed as markup, and the copy is the exact configured string. */
function InstallPathPanel(props: { readonly path: InstallCommandView; readonly guideUrl: string }) {
    const { path, guideUrl } = props;
    return (
        <div className="flex flex-col gap-3">
            {path.id === 'compose' ? <p className="text-sm">{m.engines_new_compose_hint()}</p> : null}
            <div className="flex items-start gap-1">
                <pre className="min-w-0 flex-1 rounded-control bg-(--code-text-bg) p-3 font-mono text-sm wrap-anywhere whitespace-pre-wrap text-(--code-text-text)">
                    <code>{path.command}</code>
                </pre>
                <CopyButton value={path.command} label={m.engines_new_copy()} />
            </div>
            <p className="text-sm">
                {m.engines_new_requirements()}{' '}
                <ExternalLink href={guideLink(guideUrl, path.docsAnchor)}>{m.engines_new_docs()}</ExternalLink>
            </p>
            {path.id === 'connect' ? (
                <p className="text-sm">
                    {m.engines_new_move()}{' '}
                    <ExternalLink href={guideLink(guideUrl, MOVING_ANCHOR)}>{m.engines_new_move_docs()}</ExternalLink>
                </p>
            ) : null}
        </div>
    );
}

/** Shown once: the code lives only in this component's state and is never fetched again. */
function InstallCommand(props: {
    readonly view: LinkCodeView;
    readonly onRenew: () => void;
    readonly renewing: boolean;
}) {
    const remaining = useRemainingMs(props.view.expiresAt);
    const paths = props.view.installCommands;
    const [selectedId, setSelectedId] = useState<string>(paths[0]?.id ?? '');
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
                <Tabs
                    label={m.engines_new_tabs_label()}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    tabs={paths.map((path) => ({
                        id: path.id,
                        label: INSTALL_PATH_LABELS[path.labelKey](),
                        panel: <InstallPathPanel path={path} guideUrl={props.view.installGuideUrl} />,
                    }))}
                />
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
