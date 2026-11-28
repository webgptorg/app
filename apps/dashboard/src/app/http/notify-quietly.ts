import type { NotificationEvent, PlatformNotificationKind } from '../../shared/notifications/registry';
import type { NotificationTarget } from '../../domain/notifications/notifications';
import type { DashboardDeps } from '../deps';

const NOTIFY_TIMEOUT_MS = 10_000;

/**
 * A producer's `notify` after the response: best effort, since the change it reports already happened and a lost
 * notification must not fail it. Logged by kind only, never who or which project.
 */
export async function notifyQuietly<K extends PlatformNotificationKind>(
    deps: Pick<DashboardDeps, 'notifications' | 'logger'>,
    kind: K,
    target: NotificationTarget,
    event: NotificationEvent<K>,
): Promise<void> {
    try {
        await deps.notifications.notify(kind, target, event, AbortSignal.timeout(NOTIFY_TIMEOUT_MS));
    } catch (error) {
        deps.logger.error('notifications.notify-failed', {
            kind,
            error: error instanceof Error ? error.name : 'unknown',
        });
    }
}
