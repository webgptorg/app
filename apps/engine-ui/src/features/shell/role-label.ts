import type { Role } from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';

const ROLE_LABELS: Readonly<Record<Role, () => string>> = {
    owner: m.role_owner,
    admin: m.role_admin,
    member: m.role_member,
    viewer: m.role_viewer,
};

/** A role, for display only: the UI decides by permission, never by role (ADR 0006). */
export function roleLabel(role: Role): string {
    return ROLE_LABELS[role]();
}
