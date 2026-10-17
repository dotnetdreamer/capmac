// Types of the capmac skill installer (engine/agent-skills.ts), shared with
// capmac Studio's page. Dependency-free.

export type SkillScope = 'global' | 'project';

/** installed: capmac's, this version · outdated: capmac's, older · foreign: a "capmac" skill someone else wrote. */
export type SkillState = 'installed' | 'outdated' | 'missing' | 'foreign';

export interface SkillPlace {
  /** The skill folder, e.g. C:\Users\me\.agents\skills\capmac. */
  dir: string;
  state: SkillState;
  version?: string;
}

export interface AgentSkillStatus {
  id: string;
  name: string;
  detected: boolean;
  /** Where capmac would install it, and whether it is there. */
  global: SkillPlace;
  project: SkillPlace | null;
  /** The agent sees the skill in a folder it reads (maybe one installed for another agent). */
  seenGlobal: boolean;
  seenInProject: boolean;
}

/**
 * What adding the skill would find in one folder, before anything is written:
 * nothing · CapMac's copy of this version as it wrote it (current), edited
 * since (changed), or from another version (older, newer) · a "capmac" skill
 * someone else wrote (foreign).
 */
export type SkillPlanState = 'missing' | 'current' | 'changed' | 'older' | 'newer' | 'foreign';

export interface SkillPlanEntry {
  dir: string;
  /** The chosen agents that capmac installs the skill here for (ids). */
  agents: string[];
  /** Every agent that reads this folder (names). */
  readers: string[];
  state: SkillPlanState;
  /** The version of CapMac's copy that is there. */
  version?: string;
}

export interface SkillChange {
  dir: string;
  /** Agents that read this folder (so they get, or lose, the skill). */
  agents: string[];
  result: 'written' | 'updated' | 'removed' | 'unchanged' | 'skipped-foreign' | 'absent';
}

export interface CapmacCommandStatus {
  /** Where `capmac` is found for new terminals (an npm install, or capmac Studio's launcher), or null. */
  found: string | null;
  /** It is capmac Studio's launcher. */
  ours: boolean;
}
