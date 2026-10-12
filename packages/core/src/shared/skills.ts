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
