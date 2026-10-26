/** What the engine's address still lacks before a browser can use it; `setup-link` waits for none. */
export type AddressGap = 'relay' | 'certificate';

/**
 * The address works once a relay routes the hostname and a valid certificate is in place. Whether the name resolves
 * is not checked here: the relays' DNS is the platform's, and the engine cannot see it from inside.
 */
export function addressGaps(state: { readonly relaysReady: number; readonly certificateValid: boolean }): AddressGap[] {
    const gaps: AddressGap[] = [];
    if (state.relaysReady === 0) gaps.push('relay');
    if (!state.certificateValid) gaps.push('certificate');
    return gaps;
}
