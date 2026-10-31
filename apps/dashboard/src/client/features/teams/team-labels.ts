import { m } from '../../../paraglide/messages';

export type OrgRole = 'owner' | 'admin' | 'member';

export function roleLabel(role: OrgRole): string {
    switch (role) {
        case 'owner':
            return m.role_owner();
        case 'admin':
            return m.role_admin();
        case 'member':
            return m.role_member();
    }
}

/** The state shown beside a person in a team (teams spec): the engine stays the authority on all of them. */
export type PersonState = 'invited' | 'not-opened' | 'waiting' | 'has-access' | 'removing';

export function personStateLabel(state: PersonState): string {
    switch (state) {
        case 'invited':
            return m.team_state_invited();
        case 'not-opened':
            return m.team_state_not_opened();
        case 'waiting':
            return m.team_state_waiting();
        case 'has-access':
            return m.team_state_has_access();
        case 'removing':
            return m.team_state_removing();
    }
}

export function accessState(access: 'none' | 'waiting' | 'approved'): PersonState {
    switch (access) {
        case 'none':
            return 'not-opened';
        case 'waiting':
            return 'waiting';
        case 'approved':
            return 'has-access';
    }
}
