/** Per organization. Every issued code counts for the full hour, including redeemed and cancelled codes. */
export const LINK_CODE_LIMITS = { active: 100, perHour: 200, windowMs: 60 * 60 * 1000 } as const;
