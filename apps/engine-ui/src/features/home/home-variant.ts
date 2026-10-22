import type { Permission } from '@ptbk/engine-api';

export type HomeVariant = 'control-center' | 'member';

/**
 * The control center is for members who oversee the engine; `security.read` stands for that until the engine has an
 * explicit oversight permission, which would replace it here and nowhere else. Never the role name (ADR 0006).
 */
export function homeVariant(permissions: ReadonlySet<Permission>): HomeVariant {
    return permissions.has('security.read') ? 'control-center' : 'member';
}
