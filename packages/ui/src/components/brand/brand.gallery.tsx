import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { BrandLockup, BrandMark } from './brand-mark';
import { BrandRobot, RobotGuide } from './brand-robot';
import type { RobotPose } from './brand-robot';

const POSES: readonly RobotPose[] = ['working', 'thinking', 'assembling', 'finished', 'resting'];

export const brandGallery: GalleryEntry = {
    id: 'brand',
    title: 'Brand',
    render: () => (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-4">
                <BrandMark />
                <BrandMark size={48} />
                <BrandLockup />
                <BrandLockup width={240} />
            </div>
            <div className="flex flex-wrap items-end gap-4">
                {POSES.map((pose) => (
                    <BrandRobot key={pose} pose={pose} />
                ))}
            </div>
            <RobotGuide action={<Button variant="primary">{'Create an agent'}</Button>}>
                {'Start with one agent. You can add more any time.'}
            </RobotGuide>
            <RobotGuide layout="stack" pose="finished" size="lg">
                {'All set.'}
            </RobotGuide>
        </div>
    ),
};
