/**
 * An iPhone at this PC, shown and driven with no Mac: the screen from CapMac's screen-mirroring
 * receiver (the iPhone mirrors to it over Wi-Fi) and touch through WebDriverAgent. Exposed as its
 * own entry point (`@capmac/core/engine/iphone/index`) so only the front ends that use it pull in
 * the helpers these modules ship.
 */
export { PhoneScreen, type PhoneScreenOptions, type PhoneScreenHandlers, type PhoneWait } from './screen.js';
export { MirrorReceiver, mirrorReceiver, receiverHome, receiverInstalled, RECEIVER_VERSION, type MirrorClient, type ReceiverState } from './receiver.js';
export { iphoneTouchState, setUpIphoneTouch, type TouchState } from './touch.js';
export { WDA_VERSION, forgetWdaInstall } from './wda.js';
