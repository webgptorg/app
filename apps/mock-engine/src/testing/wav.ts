/** The UI's WAV fallback, silent: 16-bit PCM, mono, 16 kHz, `audio/wav`. One second is 32,000 bytes of samples. */
export function silentWav(dataBytes = 32_000): Blob {
    const bytes = new Uint8Array(44 + dataBytes);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);
    return new Blob([bytes], { type: 'audio/wav' });
}
