import { m } from '../../../paraglide/messages';
import type { PasskeyView } from '../../../shared/api/routes';

const NAME_SUFFIX_LENGTH = 6;

/**
 * The API stores no passkey name (D-02), so a passkey is named by the end of its credential ID: stable, distinct
 * between passkeys, and what nobody can tell apart otherwise. It is public data, not a secret.
 */
export function passkeyName(passkey: PasskeyView): string {
    return m.passkey_name({
        suffix: passkey.credentialId
            .replace(/[^A-Za-z0-9]/g, '')
            .slice(-NAME_SUFFIX_LENGTH)
            .toUpperCase(),
    });
}

/** Where the passkey lives: a synced passkey manager (backed up) or this one authenticator. */
export function passkeyOrigin(passkey: PasskeyView): string {
    return passkey.backedUp ? m.passkey_origin_synced() : m.passkey_origin_device();
}

export function passkeyAddedVia(passkey: PasskeyView): string {
    switch (passkey.addedVia) {
        case 'signup':
            return m.passkey_added_via_signup();
        case 'account':
            return m.passkey_added_via_account();
        case 'recovery':
            return m.passkey_added_via_recovery();
    }
}
