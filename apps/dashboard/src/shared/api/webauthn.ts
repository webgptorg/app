import { z } from 'zod';

/**
 * The WebAuthn JSON shapes `@simplewebauthn/browser` produces and consumes, as strict schemas. Lengths are generous
 * caps for real authenticators (attestation objects with certificate chains run to a few kilobytes), not exact sizes.
 */
const base64url = (max: number) =>
    z
        .string()
        .min(1)
        .max(max)
        .regex(/^[A-Za-z0-9_-]+$/);

export const credentialIdSchema = base64url(1366);

const transportSchema = z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
export type AuthenticatorTransport = z.infer<typeof transportSchema>;

const authenticatorAttachmentSchema = z.enum(['platform', 'cross-platform']);

const credentialDescriptorSchema = z.strictObject({
    id: credentialIdSchema,
    type: z.literal('public-key'),
    transports: z.array(transportSchema).max(8).optional(),
});

const hintsSchema = z.array(z.enum(['hybrid', 'security-key', 'client-device'])).max(3);

export const registrationOptionsSchema = z.strictObject({
    challenge: base64url(128),
    rp: z.strictObject({ name: z.string().max(64), id: z.string().max(253) }),
    user: z.strictObject({ id: base64url(128), name: z.string().max(254), displayName: z.string().max(254) }),
    pubKeyCredParams: z.array(z.strictObject({ alg: z.number().int(), type: z.literal('public-key') })).max(8),
    timeout: z.number().int().positive(),
    attestation: z.literal('none'),
    excludeCredentials: z.array(credentialDescriptorSchema).max(64),
    authenticatorSelection: z.strictObject({
        residentKey: z.literal('required'),
        requireResidentKey: z.literal(true),
        userVerification: z.literal('required'),
    }),
    extensions: z.strictObject({ credProps: z.literal(true) }),
    hints: hintsSchema,
});
export type RegistrationOptions = z.infer<typeof registrationOptionsSchema>;

export const authenticationOptionsSchema = z.strictObject({
    challenge: base64url(128),
    timeout: z.number().int().positive(),
    rpId: z.string().max(253),
    allowCredentials: z.array(credentialDescriptorSchema).max(64),
    userVerification: z.literal('required'),
});
export type AuthenticationOptions = z.infer<typeof authenticationOptionsSchema>;

const clientExtensionResultsSchema = z.strictObject({
    credProps: z.strictObject({ rk: z.boolean().exactOptional() }).exactOptional(),
});

export const registrationResponseSchema = z.strictObject({
    id: credentialIdSchema,
    rawId: credentialIdSchema,
    type: z.literal('public-key'),
    response: z.strictObject({
        clientDataJSON: base64url(4096),
        attestationObject: base64url(16_384),
        authenticatorData: base64url(8192).exactOptional(),
        transports: z.array(transportSchema).max(8).exactOptional(),
        publicKeyAlgorithm: z.number().int().exactOptional(),
        publicKey: base64url(4096).exactOptional(),
    }),
    authenticatorAttachment: authenticatorAttachmentSchema.exactOptional(),
    clientExtensionResults: clientExtensionResultsSchema,
});
export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

export const authenticationResponseSchema = z.strictObject({
    id: credentialIdSchema,
    rawId: credentialIdSchema,
    type: z.literal('public-key'),
    response: z.strictObject({
        clientDataJSON: base64url(4096),
        authenticatorData: base64url(8192),
        signature: base64url(2048),
        userHandle: base64url(128).exactOptional(),
    }),
    authenticatorAttachment: authenticatorAttachmentSchema.exactOptional(),
    clientExtensionResults: clientExtensionResultsSchema,
});
export type AuthenticationResponse = z.infer<typeof authenticationResponseSchema>;
