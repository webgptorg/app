// Included right after worker-configuration.d.ts in tsconfig.worker.json, so these overloads take precedence.
// `@ptbk/protocol` is portable Web-API code typed against the DOM's WebCrypto and Encoding declarations; workerd's
// generated types are looser for these calls. These overloads state what workerd returns for them.
interface SubtleCrypto {
    generateKey(algorithm: 'Ed25519', extractable: boolean, keyUsages: string[]): Promise<CryptoKeyPair>;
    exportKey(format: 'raw', key: CryptoKey): Promise<ArrayBuffer>;
}

interface TextEncoder {
    encode(input: string): Uint8Array<ArrayBuffer>;
}
