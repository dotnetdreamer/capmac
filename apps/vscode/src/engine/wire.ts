/**
 * Messages between the extension and its engine process: CapMac Studio's own
 * main⇄host protocol (host-protocol.ts), plus each screen's port messages,
 * which in Studio travel on a MessagePort of their own.
 */
import type { HostToMain, MainToHost } from '../../../desktop/src/shared/host-protocol.js';
import type { ScreenPortCommand, ScreenPortMessage } from '../../../desktop/src/shared/contract.js';

export type ToEngine =
  | MainToHost
  | { kind: 'port-message'; streamId: string; message: ScreenPortCommand }
  | { kind: 'port-close'; streamId: string };

export type FromEngine =
  | HostToMain
  | { kind: 'port-message'; streamId: string; message: ScreenPortMessage }
  | { kind: 'port-closed'; streamId: string };
