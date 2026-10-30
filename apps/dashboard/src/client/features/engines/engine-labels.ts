import type { BadgeTone } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import type { EngineView, HeartbeatView } from '../../../shared/api/routes';

/** Every status in words, so colour is never the only carrier (D-06 brief, accessibility). */
export function engineStatusLabel(engine: Pick<EngineView, 'status' | 'suspendedBy'>): string {
    switch (engine.status) {
        case 'online':
            return m.engines_status_online();
        case 'offline':
            return m.engines_status_offline();
        case 'never-seen':
            return m.engines_status_never_seen();
        case 'owner-pending':
            return m.engines_status_owner_pending();
        case 'unknown':
            return m.engines_status_unknown();
        case 'suspended':
            return engine.suspendedBy === 'owner' ? m.engines_status_revoked() : m.engines_status_suspended();
    }
}

export function engineStatusTone(status: EngineView['status']): BadgeTone {
    switch (status) {
        case 'online':
            return 'success';
        case 'offline':
            return 'warning';
        case 'suspended':
            return 'danger';
        case 'never-seen':
        case 'owner-pending':
            return 'info';
        case 'unknown':
            return 'neutral';
    }
}

export function updateStateLabel(update: HeartbeatView['update']): string {
    switch (update) {
        case 'none':
            return m.engines_update_none();
        case 'available':
            return m.engines_update_available();
        case 'pending':
            return m.engines_update_pending();
        case 'installing':
            return m.engines_update_installing();
    }
}

export function cpuLoadLabel(load: HeartbeatView['cpuLoad']): string {
    switch (load) {
        case 'low':
            return m.engines_cpu_low();
        case 'medium':
            return m.engines_cpu_medium();
        case 'high':
            return m.engines_cpu_high();
    }
}

export function modeLabel(mode: EngineView['mode']): string {
    switch (mode) {
        case 'tunnel':
            return m.engine_mode_tunnel();
        case 'direct':
            return m.engine_mode_direct();
    }
}

/** "1 d 2 h", "3 h 25 min": the two largest units, as engine-ui shows durations. */
export function uptimeLabel(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours >= 24) {
        return m.engine_uptime_days({ days: String(Math.floor(hours / 24)), hours: String(hours % 24) });
    }
    return m.engine_uptime({ hours: String(hours), minutes: String(minutes % 60) });
}
