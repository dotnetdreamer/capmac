/**
 * Visual Studio for a Flutter app's Windows app: Flutter builds it with
 * Visual Studio's C++ tools and the CMake that comes with them. CapMac checks
 * before a build (Flutter itself only says "Unable to find suitable Visual
 * Studio toolchain") and offers to add what is missing (see visual-studio.ts).
 */
import type { EngineContext } from '../context.js';
import { ensureVisualStudio, visualStudioState, type VsRequirement, type VsState } from '../visual-studio.js';

/** What Flutter needs from Visual Studio 2019 or later, by its installer ids (as Flutter's visual_studio.dart asks). */
export const VS_COMPONENTS: Record<string, string> = {
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64': 'MSVC C++ x64/x86 build tools',
  'Microsoft.VisualStudio.Component.VC.CMake.Project': 'C++ CMake tools for Windows',
};

const FLUTTER_VS: VsRequirement = {
  components: VS_COMPONENTS,
  // Either workload carries those components: Visual Studio's, or the Build Tools'.
  anyWorkload: ['Microsoft.VisualStudio.Workload.NativeDesktop', 'Microsoft.VisualStudio.Workload.VCTools'],
  framework: 'Flutter',
  installerHint: '“C++ CMake tools for Windows” under “Desktop development with C++”',
};

/** Whether this PC's Visual Studio can build a Flutter app's Windows app, and if not, what it lacks. */
export function windowsToolchain(): Promise<VsState> {
  return visualStudioState(FLUTTER_VS);
}

/** Makes sure Visual Studio can build the Windows app, offering to add what it lacks. */
export function ensureWindowsToolchain(ctx: EngineContext, signal?: AbortSignal): Promise<void> {
  return ensureVisualStudio(FLUTTER_VS, ctx, signal);
}
