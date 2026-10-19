// The package compiles against the ES library only, which lacks this Web API every runtime has.
declare function atob(data: string): string;

export function fromBase64(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
