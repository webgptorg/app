import type { ClientInfo } from '@ptbk/engine-api';

export type DeviceKind = 'phone' | 'tablet' | 'computer';

export interface SessionDevice {
    readonly browser: string | null;
    readonly os: string | null;
    readonly kind: DeviceKind;
}

// Order matters: Edge, Opera and Samsung Internet also say "Chrome" and "Safari", Chrome also says "Safari".
const BROWSERS: readonly (readonly [RegExp, string])[] = [
    [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
    [/\bOPR\/|\bOpera\b/, 'Opera'],
    [/\bSamsungBrowser\//, 'Samsung Internet'],
    [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
    // Headless Chrome (automation, previews) names itself without a word boundary before "Chrome".
    [/\bChrome\/|\bCriOS\/|\bChromium\/|\bHeadlessChrome\//, 'Chrome'],
    [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

// iPads that ask for the desktop site say "Macintosh"; they are counted as Macs, which is what they claim.
const SYSTEMS: readonly (readonly [RegExp, string, DeviceKind])[] = [
    [/\biPad\b/, 'iPadOS', 'tablet'],
    [/\biPhone\b|\biPod\b/, 'iOS', 'phone'],
    [/\bAndroid\b.*\bMobile\b/, 'Android', 'phone'],
    [/\bAndroid\b/, 'Android', 'tablet'],
    [/\bCrOS\b/, 'ChromeOS', 'computer'],
    [/\bWindows\b/, 'Windows', 'computer'],
    [/\bMac OS X\b|\bMacintosh\b/, 'macOS', 'computer'],
    [/\bLinux\b/, 'Linux', 'computer'],
];

/**
 * A rough browser and system from the session's user agent, for recognising a device in the list. The user agent is
 * whatever the client sent, so this is a hint for people, never something to decide on.
 */
export function sessionDevice(client: ClientInfo | null): SessionDevice {
    const agent = client?.userAgent ?? '';
    const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1] ?? null;
    const system = SYSTEMS.find(([pattern]) => pattern.test(agent));
    return { browser, os: system?.[1] ?? null, kind: system?.[2] ?? 'computer' };
}
