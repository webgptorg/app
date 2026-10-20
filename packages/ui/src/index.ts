export {
    applyTheme,
    persistThemePreference,
    readThemePreference,
    resolveTheme,
    THEME_PREFERENCES,
    THEME_STORAGE_KEY,
} from './theme/preference';
export type { MatchMedia, PreferenceStorage, ResolvedTheme, ThemePreference } from './theme/preference';

export { canUseViewTransitions, withViewTransition } from './motion/view-transition';
export type { ViewTransitionDocument } from './motion/view-transition';
export { prefersReducedMotion, useReducedMotion } from './motion/reduced-motion';
export type { MotionMatchMedia } from './motion/reduced-motion';
export { loadMotion, useMotion } from './motion/lazy-motion';
export type { MotionModule } from './motion/lazy-motion';

export { createFormatters } from './i18n/formatters';
export type { Formatters } from './i18n/formatters';
export { UiProvider, useLocale, useUiMessages } from './i18n/ui-provider';
export type { UiProviderProps } from './i18n/ui-provider';
export type { UiMessages } from './i18n/ui-messages';

export { Button, buttonClassName } from './components/button/button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/button/button';
export { Spinner } from './components/spinner/spinner';
export type { SpinnerProps } from './components/spinner/spinner';
export { VisuallyHidden } from './components/visually-hidden/visually-hidden';
export type { VisuallyHiddenProps } from './components/visually-hidden/visually-hidden';

export { Gallery, GALLERY_ENTRIES } from './gallery';
export type { GalleryEntry } from './gallery-entry';
