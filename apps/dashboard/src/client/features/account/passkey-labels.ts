import { m } from '../../../paraglide/messages';
import type { PasskeyView } from '../../../shared/api/routes';

/** The provider's name when the dashboard knows its AAGUID, otherwise just "Passkey". */
export function passkeyName(passkey: PasskeyView): string {
    return passkey.provider ?? m.passkey_name();
}

/**
 * The name with its creation date, for labels that must tell two passkeys of the same provider apart (the remove
 * button, the confirmation).
 */
export function passkeyLabel(passkey: PasskeyView, formatDate: (date: Date) => string): string {
    return m.passkey_label({ name: passkeyName(passkey), date: formatDate(new Date(passkey.createdAt)) });
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
