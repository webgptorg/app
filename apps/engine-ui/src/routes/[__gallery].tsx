import { createFileRoute, lazyRouteComponent, notFound } from '@tanstack/react-router';

/**
 * Every `@ptbk/ui` component in every state, for `test:csp` only: that build sets `VITE_UI_GALLERY=1`. In a production
 * build the condition is the constant `false`, so the gallery is not bundled at all (test/dist.test.ts checks) and the
 * route answers "not found".
 */
export const Route = createFileRoute('/__gallery')({
    beforeLoad: () => {
        if (import.meta.env.VITE_UI_GALLERY !== '1') notFound({ throw: true });
    },
    component:
        import.meta.env.VITE_UI_GALLERY === '1'
            ? lazyRouteComponent(() => import('../features/gallery/gallery-page'), 'GalleryPage')
            : () => null,
});
