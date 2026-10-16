import deviceSource from './devstream.m';
import source from './simstream.m';

/** The helper's Objective-C source, compiled on the Mac on first use. */
export const HELPER_SOURCE: string = source;

/** The device screen helper's source, built on the Mac into CapMac.app on first use. */
export const DEVICE_HELPER_SOURCE: string = deviceSource;

import appHookSource from './apphook.m';

/** CapMac's module for native Mac apps (Flutter's Mac apps), built on the Mac into a dylib on first use. */
export const APP_HOOK_SOURCE: string = appHookSource;
