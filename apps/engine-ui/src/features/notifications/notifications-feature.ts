import { Inbox } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { NOTIFICATIONS, useUnseenNotifications } from './notifications-queries';

/**
 * The member's inbox (`notifications@1`, ADR 0027): what waits for them inside the project, with its content, and
 * where to handle it. Nothing of it leaves the engine; the dashboard learns only counts, through the heartbeat.
 */
export const notificationsFeature = defineFeature({
    id: 'notifications',
    requires: NOTIFICATIONS,
    nav: {
        group: 'work',
        order: 10,
        label: m.nav_inbox,
        icon: Inbox,
        to: '/inbox',
        useBadge: useUnseenNotifications,
    },
});
