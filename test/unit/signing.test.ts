import { describe, expect, it } from 'vitest';
import { decideSigningTeam, launchedApp, settingsArgs, teamOf } from '../../packages/core/src/agent/ops/build.js';

describe('which team a device build signs with', () => {
  const base = { isSimulator: false, projectTeam: '' as string | null, coveringTeams: [] as string[], targetName: 'iPhone 15' };

  it('uses the explicit team (capmac.json / --team), even when other profiles could sign', () => {
    expect(decideSigningTeam({ ...base, explicitTeam: 'TEAMX', coveringTeams: ['A', 'B'] })).toEqual({ team: 'TEAMX', auto: false });
  });

  it('adds no team for a simulator', () => {
    expect(decideSigningTeam({ ...base, isSimulator: true })).toEqual({ team: undefined, auto: false });
  });

  it('honours a team the Xcode project resolves, without overriding it, even when other profiles cover the device', () => {
    // The project's team can come from an .xcconfig or a $(…) variable, not only a literal in the .pbxproj.
    expect(decideSigningTeam({ ...base, projectTeam: 'TEAMP', coveringTeams: ['A', 'B'] })).toEqual({ team: undefined, auto: false });
  });

  it('auto-picks the one team whose profile covers the device when nothing else names one', () => {
    expect(decideSigningTeam({ ...base, coveringTeams: ['ONLY'] })).toEqual({ team: 'ONLY', auto: true });
  });

  it('asks the project to choose when several teams can sign and nothing names one', () => {
    const decision = decideSigningTeam({ ...base, coveringTeams: ['A', 'B'] });
    expect('error' in decision).toBe(true);
    if ('error' in decision) {
      expect(decision.error.message).toContain('A, B');
      expect(decision.error.hint).toMatch(/ios\.team|--team/);
    }
  });

  it('adds no team when none is set and none covers the device (xcodebuild then explains)', () => {
    expect(decideSigningTeam({ ...base })).toEqual({ team: undefined, auto: false });
  });

  it('picks nothing, and blocks nothing, when it could not read the project’s team: the project may name one', () => {
    expect(decideSigningTeam({ ...base, projectTeam: null, coveringTeams: ['ONLY'] })).toEqual({ team: undefined, auto: false });
    expect(decideSigningTeam({ ...base, projectTeam: null, coveringTeams: ['A', 'B'] })).toEqual({ team: undefined, auto: false });
  });
});

// A scheme that builds an auxiliary app first but runs PhoneApp (as Xcode writes it).
const scheme = (runnable: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.3">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForRunning = "YES">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "102004D769C8AFF012576C1F" BuildableName = "Aux.app" BlueprintName = "Aux" ReferencedContainer = "container:TeamTest.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
         <BuildActionEntry buildForRunning = "YES">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "C448CD84B359FD1ED576F669" BuildableName = "PhoneApp.app" BlueprintName = "PhoneApp" ReferencedContainer = "container:TeamTest.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug">
      <MacroExpansion>
         <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "102004D769C8AFF012576C1F" BuildableName = "Aux.app" BlueprintName = "Aux" ReferencedContainer = "container:TeamTest.xcodeproj">
         </BuildableReference>
      </MacroExpansion>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" launchStyle = "0">
${runnable}
   </LaunchAction>
</Scheme>
`;
const runsPhoneApp = `      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "C448CD84B359FD1ED576F669" BuildableName = "PhoneApp.app" BlueprintName = "PhoneApp" ReferencedContainer = "container:TeamTest.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>`;

// `xcodebuild -scheme Multi -showBuildSettings -json` on a Mac, trimmed: Aux names a team, PhoneApp none.
const settings = (entries: Array<{ target: string; extension?: string; type?: string; team?: string }>) =>
  JSON.stringify(
    entries.map((e) => ({
      action: 'build',
      buildSettings: {
        TARGET_NAME: e.target,
        WRAPPER_EXTENSION: e.extension ?? 'app',
        PRODUCT_TYPE: e.type ?? 'com.apple.product-type.application',
        FULL_PRODUCT_NAME: `${e.target}.${e.extension ?? 'app'}`,
        ...(e.team ? { DEVELOPMENT_TEAM: e.team } : {}),
      },
      target: e.target,
    })),
    null,
    2,
  );
const auxFirst = settings([{ target: 'Aux', team: 'AUXTEAM123' }, { target: 'PhoneApp' }]);

describe('the app whose team counts', () => {
  it('is the one the scheme runs, not the first app it builds', () => {
    const app = launchedApp(scheme(runsPhoneApp));
    expect(app).toEqual({ target: 'PhoneApp', product: 'PhoneApp.app' });
    // PhoneApp names no team, so CapMac may pick one, even though Aux (listed first) names its own.
    expect(teamOf(auxFirst, app!)).toBe('');
    expect(teamOf(auxFirst, { target: 'Aux', product: 'Aux.app' })).toBe('AUXTEAM123');
  });

  it('is unknown when the scheme runs nothing and it builds several apps', () => {
    expect(launchedApp(scheme(''))).toBeNull();
    // What opBuild falls back to for a scheme that names no app: the target named like the scheme.
    expect(teamOf(auxFirst, { target: 'Multi', product: 'Multi.app' })).toBeNull();
  });

  it('is the only app when the scheme’s app is not found by name (its extensions do not count)', () => {
    const appAndWidget = settings([{ target: 'App', team: 'TEAMAPP' }, { target: 'HomeCard', extension: 'appex', type: 'com.apple.product-type.app-extension', team: 'TEAMWIDGET' }]);
    expect(teamOf(appAndWidget, { target: 'App', product: 'App.app' })).toBe('TEAMAPP');
    expect(teamOf(appAndWidget, { target: 'Renamed', product: 'Renamed.app' })).toBe('TEAMAPP');
  });

  it('reads the settings after xcodebuild’s own lines, and is unknown when there are none', () => {
    expect(teamOf(`Resolve Package Graph\n[1/2] Fetching\n${auxFirst}`, { target: 'Aux', product: 'Aux.app' })).toBe('AUXTEAM123');
    expect(teamOf('xcodebuild: error: The project named "App" does not contain a scheme named "Nope".', { target: 'App', product: 'App.app' })).toBeNull();
  });

  it('decodes XML in the scheme’s names', () => {
    const runnable = runsPhoneApp.replaceAll('PhoneApp', 'Tom &amp; Jerry');
    expect(launchedApp(scheme(runnable))).toEqual({ target: 'Tom & Jerry', product: 'Tom & Jerry.app' });
  });
});

describe('the settings CapMac asks xcodebuild for', () => {
  it('match the build: its project, configuration, derived data and extra arguments, for any iOS device', () => {
    const args = settingsArgs({ workspace: null, xcodeproj: '/p/ios/App/App.xcodeproj' }, 'App', 'Debug', '/p/DerivedData', ['DEVELOPMENT_TEAM=CLITEAM99', '-xcconfig', 'team.xcconfig']);
    expect(args).toEqual([
      '-project', '/p/ios/App/App.xcodeproj',
      '-scheme', 'App',
      '-configuration', 'Debug',
      '-destination', 'generic/platform=iOS',
      '-derivedDataPath', '/p/DerivedData',
      '-skipPackagePluginValidation',
      '-skipMacroValidation',
      'DEVELOPMENT_TEAM=CLITEAM99', '-xcconfig', 'team.xcconfig',
      '-showBuildSettings',
      '-json',
    ]);
    expect(settingsArgs({ workspace: '/p/ios/App/App.xcworkspace', xcodeproj: '/p/ios/App/App.xcodeproj' }, 'App', 'Release', '/d').slice(0, 2)).toEqual(['-workspace', '/p/ios/App/App.xcworkspace']);
  });
});
