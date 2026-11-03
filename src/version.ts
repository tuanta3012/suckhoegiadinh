import pkg from '../package.json';

export const CURRENT_APP_VERSION = pkg.version;
export const RELEASE_APP_VERSION =
  (import.meta as ImportMeta & { env: { VITE_APP_VERSION?: string } }).env.VITE_APP_VERSION || CURRENT_APP_VERSION;
