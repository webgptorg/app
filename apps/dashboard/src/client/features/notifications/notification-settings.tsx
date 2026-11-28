import { Combobox, Section } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useEffect, useId, useRef } from 'react';

import { m } from '../../../paraglide/messages';
import { notificationRoutes } from '../../../shared/api/notification-routes';
import type { NotificationPreferenceView } from '../../../shared/api/notification-routes';
import { notificationChannelSchema } from '../../../shared/notifications/notification-kind';
import type { NotificationChannel } from '../../../shared/notifications/notification-kind';
import { anyKind, NOTIFICATION_KIND_IDS } from '../../../shared/notifications/registry';
import type { NotificationKind } from '../../../shared/notifications/registry';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, queryKeys } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';
import { useSession } from '../session/use-session';
import { notificationPreferencesQuery } from './notification-queries';

/** Where the bell's and every email's "Notification settings" link lands: `/account#notifications`. */
export const NOTIFICATION_SETTINGS_ANCHOR = 'notifications';

const CHANNEL_LABELS: Readonly<Record<NotificationChannel, () => string>> = {
    off: m.notification_channel_off,
    'in-app': m.notification_channel_in_app,
    email: m.notification_channel_email,
};

interface SavePreference {
    readonly kind: NotificationKind;
    readonly channel: NotificationChannel;
}

/**
 * The person's own choice per kind, in the active organization, with their role's default marked. Choosing the default
 * again drops the override on the server, so a later role change moves them along with it.
 */
export function NotificationSettings() {
    const session = useSession();
    const { permissions } = session.activeOrg;
    const hash = useLocation({ select: (location) => location.hash });
    const anchorRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // An email's link lands here from another page or a sign-in, after the router's own hash scroll has run.
        if (hash === NOTIFICATION_SETTINGS_ANCHOR) anchorRef.current?.scrollIntoView({ block: 'start' });
    }, [hash]);
    if (!permissions.includes('notification.read')) {
        return null;
    }
    return (
        <div ref={anchorRef} id={NOTIFICATION_SETTINGS_ANCHOR} className="scroll-mt-20">
            <Section title={m.notification_settings_title()} description={m.notification_settings_description()}>
                <Preferences canManage={permissions.includes('notification.manage')} />
                <p className="text-xs text-text-muted">{m.notification_settings_always()}</p>
            </Section>
        </div>
    );
}

function Preferences({ canManage }: { readonly canManage: boolean }) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const preferences = useQuery(notificationPreferencesQuery(api));
    const saving = useRef<NotificationKind | null>(null);
    const save = useAppMutation({
        mutationFn: async ({ kind, channel }: SavePreference) => {
            saving.current = kind;
            return dataOrThrow(
                await api.call(notificationRoutes.setNotificationPreference, { params: { kind }, body: { channel } }),
            ).preferences;
        },
        onSuccess: (next) => {
            queryClient.setQueryData(queryKeys.notificationPreferences, next);
        },
        successMessage: (_, { kind }) => m.notification_settings_saved({ kind: anyKind(kind).copy.label() }),
        errorMessage: () =>
            saving.current === null
                ? undefined
                : m.notification_settings_save_failed({ kind: anyKind(saving.current).copy.label() }),
    });
    if (preferences.isError) {
        return <p className="text-sm text-text-muted">{m.notification_settings_failed()}</p>;
    }
    if (preferences.data === undefined) {
        return null;
    }
    const byKind = new Map(preferences.data.map((preference) => [preference.kind, preference]));
    const rows = NOTIFICATION_KIND_IDS.flatMap((kind) => {
        const preference = byKind.get(kind);
        return preference === undefined ? [] : [preference];
    });
    return (
        <ul className="flex flex-col divide-y divide-hairline">
            {rows.map((preference) => (
                <PreferenceRow
                    key={preference.kind}
                    preference={preference}
                    disabled={!canManage}
                    onChange={(channel) => {
                        save.mutate({ kind: preference.kind, channel });
                    }}
                />
            ))}
        </ul>
    );
}

function PreferenceRow(props: {
    readonly preference: NotificationPreferenceView;
    readonly disabled: boolean;
    readonly onChange: (channel: NotificationChannel) => void;
}) {
    const labelId = useId();
    const { kind, channel, defaultChannel } = props.preference;
    return (
        <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <span id={labelId} className="text-sm">
                {anyKind(kind).copy.label()}
            </span>
            <Combobox
                aria-labelledby={labelId}
                className="w-full sm:w-64"
                value={channel}
                disabled={props.disabled}
                options={notificationChannelSchema.options.map((option) => ({
                    value: option,
                    label:
                        option === defaultChannel
                            ? m.notification_channel_default({ channel: CHANNEL_LABELS[option]() })
                            : CHANNEL_LABELS[option](),
                }))}
                onChange={(value) => {
                    const next = notificationChannelSchema.safeParse(value);
                    if (next.success && next.data !== channel) props.onChange(next.data);
                }}
            />
        </li>
    );
}
