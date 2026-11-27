import { Banner, Button } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useEngineEvents } from '../../app/engine-events-context';
import { UI_VERSION } from '../../app/ui-version';
import { m } from '../../paraglide/messages';
import { securityKeys } from '../security/security-keys';

/**
 * After an update check (`updates.changed`), offers a reload once the project serves another UI version than the one
 * this page was built as. Never reloads by itself: a half-written message would be lost.
 */
export function UiReloadSlot() {
    const queryClient = useQueryClient();
    const [served, setServed] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState<string | null>(null);
    useEngineEvents({
        onEvent: (event) => {
            if (event.type !== 'updates.changed') return;
            void queryClient.invalidateQueries({ queryKey: securityKeys.overview() });
            setServed(event.uiVersion);
        },
    });
    if (served === null || served === UI_VERSION || served === dismissed) return null;
    return (
        <Banner
            tone="info"
            className="mb-3"
            title={m.updates_reload_title()}
            onDismiss={() => {
                setDismissed(served);
            }}
            action={
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        window.location.reload();
                    }}
                >
                    {m.updates_reload_action()}
                </Button>
            }
        >
            {m.updates_reload_body({ version: served })}
        </Banner>
    );
}
