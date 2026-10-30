/**
 * Passkey provider names by AAGUID, to tell an account's passkeys apart. Names only: no icons, nothing fetched.
 *
 * Every entry is one the vendor itself publishes, with the page it comes from. The community list
 * (github.com/passkeydeveloper/passkey-authenticator-aaguids) carries no licence, so it is not copied here. An AAGUID
 * names a provider for display only; it is self-reported under `attestation: 'none'` and never trusted for security.
 */
const PROVIDERS: ReadonlyMap<string, string> = new Map([
    // https://web.dev/articles/webauthn-aaguid
    ['ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', 'Google Password Manager'],
    // https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-authentication-entra-passkeys-on-windows
    ['08987058-cadc-4b81-b6e1-30de50dcbe96', 'Windows Hello'],
    ['9ddd1817-af5a-4672-a2b9-3e3dd95000a9', 'Windows Hello'],
    ['6028b017-b1d4-4c02-b4b3-afcdafc96bb2', 'Windows Hello'],
    // https://docs.yubico.com/hardware/yubikey-guidance/best-practices/glossary.html
    ['d7781e5d-e353-46aa-afe2-3ca49f13332a', 'YubiKey 5 NFC'],
    // https://www.1password.community/1password-at-home-31/how-does-an-app-know-that-the-passkey-is-saved-in-1password-11063
    ['bada5566-a7aa-401f-bd96-45619a55120d', '1Password'],
]);

const AAGUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_PROVIDER = '00000000-0000-0000-0000-000000000000';

/**
 * The AAGUID worth storing: lowercase, or null for the all-zero one that providers send to stay anonymous and for
 * anything that is not a UUID.
 */
export function normalizeAaguid(aaguid: string): string | null {
    const lower = aaguid.toLowerCase();
    return AAGUID_PATTERN.test(lower) && lower !== UNKNOWN_PROVIDER ? lower : null;
}

export function passkeyProviderName(aaguid: string | null): string | null {
    return aaguid === null ? null : (PROVIDERS.get(aaguid) ?? null);
}
