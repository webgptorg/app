/** `invite`: the link came from the invitation page's "Email me a link" (D-35). */
export type RecoverVia = 'invite';

export interface RecoverSearch {
    readonly via?: RecoverVia;
}

/** Only the hint the server puts in the invitee's link passes; it changes the wording, never what the token does. */
export function parseRecoverSearch(search: Readonly<Record<string, unknown>>): RecoverSearch {
    return search['via'] === 'invite' ? { via: 'invite' } : {};
}
