export function fromBase64(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
