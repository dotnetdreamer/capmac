/** Messages between the main process and the engine host (utility process). */
import type { CallResult, EngineMethod, Envelope, PromptRequest, PromptResponse } from './contract.js';

export interface HostSettings {
  verbose: boolean;
  osLogs: boolean;
}

export interface HostInit {
  /** agent.mjs that is uploaded to the Mac. */
  agentPath: string;
  /** The bundled sample app ("Run the sample app"). */
  sampleDir: string | null;
  /** Where "Run the sample app" puts its copy (Documents\capmac Studio). */
  samplesHome: string;
  settings: HostSettings;
}

export type MainToHost =
  | { kind: 'init'; init: HostInit }
  | { kind: 'call'; id: number; method: EngineMethod; params: unknown }
  | { kind: 'prompt-response'; response: PromptResponse }
  /** Comes with the engine's end of a MessageChannel in `ports`. */
  | { kind: 'screen-open'; streamId: string; mac: string; udid: string }
  | { kind: 'settings'; settings: HostSettings }
  | { kind: 'visibility'; visible: boolean }
  | { kind: 'shutdown' };

export type HostToMain =
  | { kind: 'ready' }
  | { kind: 'result'; id: number; result: CallResult<unknown> }
  | { kind: 'events'; batch: Envelope[] }
  | { kind: 'prompt'; prompt: PromptRequest }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'shutdown-done' };
