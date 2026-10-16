import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIO } from '../../packages/core/src/agent/io.js';
import type { ProjectPaths, ProjectState } from '../../packages/core/src/agent/state.js';
import type { BuildParams } from '../../packages/core/src/shared/protocol.js';
import { decideSigningTeam, launchedApp, opBuild, settingsArgs, teamOf } from '../../packages/core/src/agent/ops/build.js';

const boundary = vi.hoisted(() => ({
  paths: null as ProjectPaths | null,
  state: null as ProjectState | null,
  run: vi.fn(),
  capture: vi.fn(),
  tryCapture: vi.fn(),
  teams: vi.fn(),
}));
vi.mock('../../packages/core/src/agent/env.js', () => ({ toolEnv: async () => ({}), xcodeEnv: async () => ({}) }));
vi.mock('../../packages/core/src/agent/state.js', () => ({
  projectPaths: () => boundary.paths,
  loadState: async () => boundary.state,
  saveState: async () => undefined,
  withProjectLock: async (_paths: unknown, _io: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../packages/core/src/agent/proc.js', async (original) => ({
  ...await original<typeof import('../../packages/core/src/agent/proc.js')>(),
  run: boundary.run,
  capture: boundary.capture,
  tryCapture: boundary.tryCapture,
}));
vi.mock('../../packages/core/src/agent/ops/teams.js', () => ({ signingTeamsFor: boundary.teams }));

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
    expect(app).toEqual({ target: 'PhoneApp', product: 'PhoneApp.app', project: 'TeamTest.xcodeproj' });
    // PhoneApp names no team, so CapMac may pick one, even though Aux (listed first) names its own.
    expect(teamOf(auxFirst, app!)).toBe('');
    expect(teamOf(auxFirst, { target: 'Aux', product: 'Aux.app' })).toBe('AUXTEAM123');
  });

  it('is unknown when the scheme runs nothing and it builds several apps', () => {
    expect(launchedApp(scheme(''))).toBeNull();
    // An ambiguous scheme name cannot identify one of its built apps either.
    expect(teamOf(auxFirst, { target: 'Multi', product: 'Multi.app' })).toBeNull();
  });

  it('ignores extensions and stays unknown when the scheme’s app is absent', () => {
    const appAndWidget = settings([{ target: 'App', team: 'TEAMAPP' }, { target: 'HomeCard', extension: 'appex', type: 'com.apple.product-type.app-extension', team: 'TEAMWIDGET' }]);
    expect(teamOf(appAndWidget, { target: 'App', product: 'App.app' })).toBe('TEAMAPP');
    expect(teamOf(appAndWidget, { target: 'Renamed', product: 'Renamed.app' })).toBeNull();
  });

  it('reads the settings after xcodebuild’s own lines, and is unknown when there are none', () => {
    expect(teamOf(`Resolve Package Graph\n[1/2] Fetching\n${auxFirst}`, { target: 'Aux', product: 'Aux.app' })).toBe('AUXTEAM123');
    expect(teamOf('xcodebuild: error: The project named "App" does not contain a scheme named "Nope".', { target: 'App', product: 'App.app' })).toBeNull();
  });

  it('decodes XML in the scheme’s names', () => {
    const runnable = runsPhoneApp.replaceAll('PhoneApp', 'Tom &amp; Jerry');
    expect(launchedApp(scheme(runnable))).toEqual({ target: 'Tom & Jerry', product: 'Tom & Jerry.app', project: 'TeamTest.xcodeproj' });
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
      '-IDEBuildLocationStyle=Unique',
      '-skipPackagePluginValidation',
      '-skipMacroValidation',
      'DEVELOPMENT_TEAM=CLITEAM99', '-xcconfig', 'team.xcconfig',
      '-showBuildSettings',
      '-json',
    ]);
    expect(settingsArgs({ workspace: '/p/ios/App/App.xcworkspace', xcodeproj: '/p/ios/App/App.xcodeproj' }, 'App', 'Release', '/d').slice(0, 2)).toEqual(['-workspace', '/p/ios/App/App.xcworkspace']);
  });
});

describe('the app opBuild returns', () => {
  let root: string;
  let native: string;
  let products: string;
  let params: BuildParams;
  const io = { signal: new AbortController().signal, send: () => undefined, log: () => undefined } as unknown as AgentIO;
  const runnable = (target = 'PhoneApp', product = 'PhoneApp.app', project = 'App.xcodeproj') =>
    `<Scheme><LaunchAction><BuildableProductRunnable><BuildableReference BlueprintName="${target}" BuildableName="${product}" ReferencedContainer="container:${project}" /></BuildableProductRunnable></LaunchAction></Scheme>`;

  async function write(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  async function product(name: string, bundleId: string): Promise<void> {
    await write(path.join(products, name, 'Info.plist'), JSON.stringify({ CFBundleIdentifier: bundleId, CFBundleExecutable: name.slice(0, -4) }));
  }
  function entry(target: string, productName: string, team = '', project = path.join(native, 'App.xcodeproj')) {
    return { target, buildSettings: {
      TARGET_NAME: target, FULL_PRODUCT_NAME: productName, TARGET_BUILD_DIR: products,
      PROJECT_FILE_PATH: project, WRAPPER_EXTENSION: 'app', PRODUCT_TYPE: 'com.apple.product-type.application', DEVELOPMENT_TEAM: team,
    } };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'capmac-signing-integration-'));
    native = path.join(root, 'src', 'ios', 'App');
    products = path.join(root, 'DerivedData', 'Build', 'Products', 'Debug-iphoneos');
    await fs.mkdir(path.join(native, 'App.xcodeproj'), { recursive: true });
    boundary.paths = { base: root, src: path.join(root, 'src'), project: path.join(root, 'src'), derivedData: path.join(root, 'DerivedData'), logs: path.join(root, 'logs'), stateFile: path.join(root, 'state.json'), lockDir: path.join(root, 'lock') };
    boundary.state = { builds: {}, nativeGen: 1, webGen: 1 } as ProjectState;
    params = { projectId: 'fixture', projectRel: '', scheme: 'RunPhone', configuration: 'Debug', force: true, target: { kind: 'device', udid: 'PHONE', name: 'Phone', os: 'iOS', osVersion: '26', state: 'connected', available: true } };
    boundary.run.mockResolvedValue({ code: 0, tail: [], cancelled: false });
    boundary.capture.mockImplementation(async (_command: string, args: string[]) => fs.readFile(args.at(-1)!, 'utf8'));
    boundary.teams.mockResolvedValue(['PROJECT1234']);
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('PhoneApp', 'PhoneApp.app', 'PROJECT1234')]));
    await write(path.join(native, 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'RunPhone.xcscheme'), runnable());
  });
  afterEach(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('capmac-signing-integration-')) throw new Error('Unexpected fixture cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns the resolved run product, including its bundle identity, instead of an auxiliary or stale scheme product', async () => {
    await product('Auxiliary.app', 'com.test.aux');
    await product('PhoneApp.app', 'com.test.stale');
    const finalDir = path.join(root, 'custom products');
    await write(path.join(finalDir, 'RenamedPhone.app', 'Info.plist'), JSON.stringify({ CFBundleIdentifier: 'com.test.phone', CFBundleExecutable: 'RenamedPhone' }));
    const phone = entry('PhoneApp', 'RenamedPhone.app', 'PROJECT1234');
    phone.buildSettings.TARGET_BUILD_DIR = finalDir;
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('Auxiliary', 'Auxiliary.app', 'OTHER12345'), phone]));
    const result = await opBuild(params, io);
    expect(result.appPath).toBe(path.join(finalDir, 'RenamedPhone.app'));
    expect(result.bundleId).toBe('com.test.phone');
  });

  it('finds a scheme in another project referenced by a workspace group', async () => {
    await fs.rm(path.join(native, 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'RunPhone.xcscheme'));
    await write(path.join(native, 'App.xcworkspace', 'contents.xcworkspacedata'), '<Workspace><Group location="group:Features"><FileRef location="group:Phone.xcodeproj" /></Group></Workspace>');
    const phoneProject = path.join(native, 'Features', 'Phone.xcodeproj');
    await write(path.join(phoneProject, 'xcshareddata', 'xcschemes', 'RunPhone.xcscheme'), runnable('PhoneApp', 'PhoneApp.app', 'Phone.xcodeproj'));
    await product('Auxiliary.app', 'com.test.aux');
    await product('PhoneApp.app', 'com.test.phone');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('Auxiliary', 'Auxiliary.app', 'OTHER12345'), entry('PhoneApp', 'PhoneApp.app', '', phoneProject)]));
    expect((await opBuild(params, io)).bundleId).toBe('com.test.phone');
    expect(boundary.teams).toHaveBeenCalledOnce();
  });

  it('reads the current user’s scheme instead of another user’s same-named scheme', async () => {
    await fs.rm(path.join(native, 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'RunPhone.xcscheme'));
    for (const [user, target] of [['000Other.xcuserdatad', 'Auxiliary'], [`${os.userInfo().username}.xcuserdatad`, 'PhoneApp']]) {
      await write(path.join(native, 'App.xcodeproj', 'xcuserdata', user!, 'xcschemes', 'RunPhone.xcscheme'), runnable(target!, `${target}.app`));
    }
    await product('Auxiliary.app', 'com.test.aux');
    await product('PhoneApp.app', 'com.test.phone');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('Auxiliary', 'Auxiliary.app', 'OTHER12345'), entry('PhoneApp', 'PhoneApp.app', 'PROJECT1234')]));
    expect((await opBuild(params, io)).bundleId).toBe('com.test.phone');
  });

  it('does not invent a runnable app when an explicit scheme has none', async () => {
    await write(path.join(native, 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'RunPhone.xcscheme'), '<Scheme><LaunchAction /></Scheme>');
    await product('RunPhone.app', 'com.test.unrelated');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('RunPhone', 'RunPhone.app', 'OTHER12345')]));
    await expect(opBuild(params, io)).rejects.toThrow(/(?:app.*(?:run|scheme)|(?:run|scheme).*app)/i);
  });

  it('does not choose a product when settings are unknown, or override signing', async () => {
    await product('Auxiliary.app', 'com.test.aux');
    boundary.tryCapture.mockResolvedValue(null);
    await expect(opBuild(params, io)).rejects.toThrow(/app|product/i);
    expect(boundary.teams).not.toHaveBeenCalled();
    expect(boundary.run.mock.calls[0]?.[1]).not.toContain('DEVELOPMENT_TEAM=PROJECT1234');
  });

  it('does not substitute the only built app when the scheme’s run target is absent', async () => {
    await product('Auxiliary.app', 'com.test.aux');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('Auxiliary', 'Auxiliary.app', 'OTHER12345')]));
    await expect(opBuild(params, io)).rejects.toThrow(/app|product/i);
    expect(boundary.teams).not.toHaveBeenCalled();
  });

  it('asks for a simulator build’s settings once it has built, with the build’s own arguments', async () => {
    params.target = { ...params.target, kind: 'simulator', udid: 'SIM' };
    params.team = 'EXPLICIT99';
    params.extraArgs = ['-xcconfig', 'signing.xcconfig', 'PRODUCT_NAME=RenamedPhone'];
    products = path.join(root, 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator');
    await product('RenamedPhone.app', 'com.test.phone');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('PhoneApp', 'RenamedPhone.app', 'EXPLICIT99')]));
    expect((await opBuild(params, io)).bundleId).toBe('com.test.phone');
    // Once built, its Swift packages are in place: asking first could wait minutes for them, for nothing.
    expect(boundary.tryCapture).toHaveBeenCalledOnce();
    expect(boundary.run.mock.invocationCallOrder[0]).toBeLessThan(boundary.tryCapture.mock.invocationCallOrder[0]!);
    const query = boundary.tryCapture.mock.calls[0]![1] as string[];
    // Any simulator: naming one makes xcodebuild look for it first, for the same settings.
    expect(query.slice(query.indexOf('-destination'), query.indexOf('-destination') + 2)).toEqual(['-destination', 'generic/platform=iOS Simulator']);
    expect(query).toContain('DEVELOPMENT_TEAM=EXPLICIT99');
    expect(query).toContain('signing.xcconfig');
    expect(query).toContain('PRODUCT_NAME=RenamedPhone');
  });

  it('reuses the resolved app when unchanged, but never a cached auxiliary app', async () => {
    params.force = false;
    await product('PhoneApp.app', 'com.test.phone');
    const first = await opBuild(params, io);
    boundary.run.mockClear();
    expect((await opBuild(params, io)).skipped).toBe(true);
    expect(boundary.run).not.toHaveBeenCalled();
    const cached = Object.values(boundary.state!.builds)[0]!;
    cached.appPath = path.join(products, 'Auxiliary.app');
    await product('Auxiliary.app', 'com.test.aux');
    const rebuilt = await opBuild(params, io);
    expect(rebuilt.skipped).toBe(false);
    expect(rebuilt.appPath).toBe(first.appPath);
    expect(rebuilt.bundleId).toBe('com.test.phone');
    expect(boundary.run).toHaveBeenCalledOnce();
  });

  it('reuses a simulator build without asking xcodebuild again', async () => {
    params.target = { ...params.target, kind: 'simulator', udid: 'SIM' };
    params.force = false;
    products = path.join(root, 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator');
    await product('PhoneApp.app', 'com.test.phone');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('PhoneApp', 'PhoneApp.app')]));
    expect((await opBuild(params, io)).skipped).toBe(false);
    boundary.run.mockClear();
    boundary.tryCapture.mockClear();
    const again = await opBuild(params, io);
    expect(again).toMatchObject({ skipped: true, bundleId: 'com.test.phone' });
    // Its record came from the settings and nothing native changed: asking would add a second or more to every run.
    expect(boundary.tryCapture).not.toHaveBeenCalled();
    expect(boundary.run).not.toHaveBeenCalled();
  });

  it('checks a build an older CapMac recorded once, then reuses it without asking', async () => {
    params.target = { ...params.target, kind: 'simulator', udid: 'SIM' };
    params.force = false;
    products = path.join(root, 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator');
    await product('Auxiliary.app', 'com.test.aux');
    await product('PhoneApp.app', 'com.test.phone');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('Auxiliary', 'Auxiliary.app', 'OTHER12345'), entry('PhoneApp', 'PhoneApp.app')]));
    await opBuild(params, io);
    // As an older CapMac could leave it: another app the scheme builds, not found from the settings.
    const wrong = Object.values(boundary.state!.builds)[0]!;
    delete wrong.resolved;
    wrong.appPath = path.join(products, 'Auxiliary.app');
    boundary.run.mockClear();
    expect(await opBuild(params, io)).toMatchObject({ skipped: false, bundleId: 'com.test.phone' });
    expect(boundary.run).toHaveBeenCalledOnce();

    // A right one is checked once, then trusted.
    const right = Object.values(boundary.state!.builds)[0]!;
    delete right.resolved;
    boundary.run.mockClear();
    boundary.tryCapture.mockClear();
    expect((await opBuild(params, io)).skipped).toBe(true);
    expect(boundary.tryCapture).toHaveBeenCalledOnce();
    expect(right.resolved).toBe(true);
    boundary.tryCapture.mockClear();
    expect((await opBuild(params, io)).skipped).toBe(true);
    expect(boundary.tryCapture).not.toHaveBeenCalled();
    expect(boundary.run).not.toHaveBeenCalled();
  });

  it('does not reuse a build an older CapMac recorded when it can’t check it', async () => {
    params.target = { ...params.target, kind: 'simulator', udid: 'SIM' };
    params.force = false;
    products = path.join(root, 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator');
    await product('Auxiliary.app', 'com.test.aux');
    await product('PhoneApp.app', 'com.test.phone');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([entry('Auxiliary', 'Auxiliary.app', 'OTHER12345'), entry('PhoneApp', 'PhoneApp.app')]));
    await opBuild(params, io);
    // As an older CapMac could leave it: another app the scheme builds, not found from the settings.
    const old = Object.values(boundary.state!.builds)[0]!;
    delete old.resolved;
    old.appPath = path.join(products, 'Auxiliary.app');
    boundary.run.mockClear();
    boundary.tryCapture.mockResolvedValue(null);
    await expect(opBuild(params, io)).rejects.toThrow(/build settings/);
    expect(boundary.run).toHaveBeenCalledOnce();
  });

  it('never guesses the app when the settings can’t be read after a build', async () => {
    params.target = { ...params.target, kind: 'simulator', udid: 'SIM' };
    products = path.join(root, 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator');
    // Left by a build before the product was renamed (with an -xcconfig or --xcodebuild-arg, the scheme still names it).
    await product('PhoneApp.app', 'com.test.stale');
    boundary.tryCapture.mockResolvedValue(null);
    await expect(opBuild(params, io)).rejects.toThrow(/build settings/);
    // Asked twice: once more in case the first failure was a passing one.
    expect(boundary.tryCapture).toHaveBeenCalledTimes(2);
  });

  it('stops, rather than guesses, when cancelled while it reads the settings', async () => {
    params.target = { ...params.target, kind: 'simulator', udid: 'SIM' };
    products = path.join(root, 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator');
    await product('PhoneApp.app', 'com.test.phone');
    const controller = new AbortController();
    boundary.tryCapture.mockImplementation(async () => {
      controller.abort();
      return null;
    });
    await expect(opBuild(params, { ...io, signal: controller.signal } as AgentIO)).rejects.toThrow(/Cancelled/);
    expect(boundary.tryCapture).toHaveBeenCalledOnce();
  });

  it('asks for any iPhone’s settings before a device build that names no team, once for the team and the app', async () => {
    await product('PhoneApp.app', 'com.test.phone');
    expect((await opBuild(params, io)).bundleId).toBe('com.test.phone');
    expect(boundary.tryCapture).toHaveBeenCalledOnce();
    expect(boundary.tryCapture.mock.invocationCallOrder[0]).toBeLessThan(boundary.run.mock.invocationCallOrder[0]!);
    const query = boundary.tryCapture.mock.calls[0]![1] as string[];
    // Naming the iPhone makes xcodebuild look for it first: seconds over Wi-Fi, and a failure when it is away.
    expect(query.slice(query.indexOf('-destination'), query.indexOf('-destination') + 2)).toEqual(['-destination', 'generic/platform=iOS']);
  });

  it('finds the scheme’s app by its names when its project path is written another way', () => {
    const output = JSON.stringify([entry('Aux', 'Aux.app', 'OTHER12345'), entry('PhoneApp', 'PhoneApp.app', 'PROJECT1234')]);
    expect(teamOf(output, { target: 'PhoneApp', product: 'PhoneApp.app', project: path.join(native, 'APP.xcodeproj') })).toBe('PROJECT1234');
  });

  it('uses the matching product and project to distinguish same-named targets', () => {
    const other = path.join(native, 'Auxiliary.xcodeproj');
    const output = JSON.stringify([entry('App', 'Auxiliary.app', 'OTHER12345', other), entry('App', 'PhoneApp.app')]);
    expect(teamOf(output, { target: 'App', product: 'PhoneApp.app' })).toBe('');
  });

  it('uses the scheme’s project when two projects have identical target and product names', async () => {
    const phoneProject = path.join(native, 'Phone.xcodeproj');
    await write(path.join(native, 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'RunPhone.xcscheme'), runnable('App', 'PhoneApp.app', 'Phone.xcodeproj'));
    await product('PhoneApp.app', 'com.test.phone');
    const auxiliary = entry('App', 'PhoneApp.app', 'OTHER12345');
    auxiliary.buildSettings.TARGET_BUILD_DIR = path.join(root, 'aux products');
    boundary.tryCapture.mockResolvedValue(JSON.stringify([auxiliary, entry('App', 'PhoneApp.app', '', phoneProject)]));
    const result = await opBuild(params, io);
    expect(result.bundleId).toBe('com.test.phone');
    expect(boundary.teams).toHaveBeenCalledOnce();
    expect(teamOf(JSON.stringify([auxiliary, entry('App', 'PhoneApp.app', '', phoneProject)]), { target: 'App', product: 'PhoneApp.app' })).toBeNull();
  });
});
