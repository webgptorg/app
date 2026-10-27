export {
    GATEWAY_ASSETS,
    GATEWAY_ASSET_PATH,
    GATEWAY_PAGES,
    GATEWAY_PAGES_DIR,
    SIMPLEWEBAUTHN_BROWSER_SHA256,
} from './assets';
export type { GatewayAsset, GatewayPage } from './assets';
export { pickGatewayLanguage } from './language';
export type { GatewayLanguage } from './language';
export { renderGatewayPage } from './render-page';
export type { GatewayPageValues } from './render-page';
export { isSafeNextPath } from '../pages/next-path.js';
