import { useCurrentMember } from '../session/use-current-member';
import { ControlCenter } from './control-center';
import { HomeHeader } from './home-header';
import { homeVariant } from './home-variant';
import { MemberHome } from './member-home';

/** The first screen after sign-in: the control center for members who oversee the engine, a personal home otherwise. */
export function HomePage() {
    const { permissions } = useCurrentMember();
    return (
        <section aria-labelledby="page-title" className="flex flex-col gap-6">
            <HomeHeader now={new Date()} />
            {homeVariant(permissions) === 'control-center' ? <ControlCenter /> : <MemberHome />}
        </section>
    );
}
