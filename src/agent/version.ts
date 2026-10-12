declare const __CAPMAC_VERSION__: string | undefined;

/** Injected by the build script; "dev" when running from source (tests). */
export const AGENT_VERSION: string = typeof __CAPMAC_VERSION__ === 'string' ? __CAPMAC_VERSION__ : 'dev';
