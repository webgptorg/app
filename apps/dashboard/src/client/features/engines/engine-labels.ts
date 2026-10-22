import type { BadgeTone } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import type { EngineView, HeartbeatView } from '../../../shared/api/routes';

const SHORT_ID_LENGTH = 8;

/** The first characters of the engine ID: what the list shows and what the revoke dialog asks to be typed. */
export function shortEngineId(engineId: string): string {
    return engineId.slice(0, SHORT_ID_LENGTH);
}

/** Every status in words, so colour is never the only carrier (D-06 brief, accessibility). */
export function engineStatusLabel(engine: Pick<EngineView, 'status' | 'suspendedBy'>): string {
    switch (engine.status) {
        case 'online':
            return m.engines_status_online();
        case 'offline':
            return m.engines_status_offline();
        case 'never-seen':
            return m.engines_status_never_seen();
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

export function uptimeLabel(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    return m.engine_uptime({ hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) });
}
