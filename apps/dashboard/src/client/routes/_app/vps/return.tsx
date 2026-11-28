import { createFileRoute } from '@tanstack/react-router';
import { VpsReturn } from '../../../features/engines/vps-launch';

export const Route = createFileRoute('/_app/vps/return')({ component: VpsReturn });
