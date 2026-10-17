#!/usr/bin/env python3
"""CapMac: everything Flutter's Xcode scripts make for an iPhone build, made on Linux.

On a Mac, Flutter's Xcode build phases (xcode_backend.sh) compile the Dart code
and assemble App.framework and Flutter.framework, and `flutter pub get` makes
the Swift packages of the plugins. Here the same comes from Flutter's Linux
tools, Dart's iPhone compiler (built from source by dart-ios-compiler.sh) and
Google's iPhone engine; CapMac's Xcode importer and compiler then build the
Runner project as they build any app.

Reads its job as JSON on stdin; prints `capmac-step: <title>` as it goes, and
`capmac-result: <json>` at the end.
"""
import base64
import json
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import sys

job = json.load(sys.stdin)
source = job['source']  # the project as on Windows (its sync root), as WSL sees it
work = pathlib.Path(job['work'])  # CapMac's copy of it in WSL, kept between builds
app_rel = job.get('appRel', '')  # the Flutter app inside it (POSIX, '' at the root)
flutter = pathlib.Path(job['flutter'])  # Flutter's Linux SDK root
compiler = job['compiler']  # Dart's iPhone gen_snapshot
engine = pathlib.Path(job['engine'])  # Flutter's iPhone engine for the mode (ios-release, ios-profile)
mode = job.get('mode', 'release')
target = job.get('target', 'lib/main.dart')
strip = job.get('strip', 'llvm-strip')
flavor = job.get('flavor')
defines = job.get('dartDefines', {})

env = dict(os.environ, FLUTTER_SUPPRESS_ANALYTICS='true', PUB_ENVIRONMENT='capmac', CI='true',
           PATH=f"{flutter / 'bin'}:{os.environ.get('PATH', '')}",
           # Flutter asks git for its own version: the SDK may belong to another user id (as unpacked).
           GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='safe.directory', GIT_CONFIG_VALUE_0=str(flutter))
bin_flutter = str(flutter / 'bin' / 'flutter')
NOISE = re.compile(r'Woah! You appear to be trying to run flutter as root|We strongly recommend running the flutter tool without superuser|^\s*/\s*$|^\s*📎\s*$')


def step(title):
    print(f'capmac-step: {title}', flush=True)


def fail(message):
    print(f'capmac-error: {message}', flush=True)
    raise SystemExit(1)


def run(argv, cwd=None, quiet=False):
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail = []
    for line in process.stdout:
        line = line.rstrip('\n')
        if NOISE.search(line):
            continue
        tail = (tail + [line])[-40:]
        if not quiet:
            print(line, flush=True)
    if process.wait():
        if quiet:
            print('\n'.join(tail), flush=True)
        fail(f'{os.path.basename(argv[0])} {argv[1] if len(argv) > 1 else ""} stopped with exit code {process.returncode}')


# 1. CapMac's copy of the project: its own build caches (.dart_tool, build) stay
# between builds; what Flutter makes for one machine never comes from Windows.
step('Copying the project into WSL')
work.mkdir(parents=True, exist_ok=True)
src = work / 'src'
src.mkdir(exist_ok=True)
anchor = '/' + app_rel.strip('/') + '/' if app_rel.strip('/') else '/'
excludes = ['.git', '.dart_tool', 'build', '.capmac', 'Pods', '.symlinks', 'ephemeral', 'xcuserdata', 'DerivedData',
            'Generated.xcconfig', 'flutter_export_environment.sh', 'GeneratedPluginRegistrant.*', '.flutter-plugins',
            '.flutter-plugins-dependencies', '*.iml', '.idea', 'node_modules'] + [anchor + name for name in ['android', 'linux', 'macos', 'web', 'windows']]
run(['rsync', '-a', '--delete', *[f'--exclude={pattern}' for pattern in excludes], source.rstrip('/') + '/', str(src) + '/'], quiet=True)
app = src / app_rel if app_rel else src
ios = app / 'ios'
if not (ios / 'Runner.xcodeproj').is_dir():
    fail('The Flutter app has no ios/Runner.xcodeproj')

# 2. Packages, as `flutter pub get` gets them on any machine.
step('Getting the app’s Dart packages (flutter pub get)')
run([bin_flutter, 'pub', 'get'], cwd=app)

pubspec = (app / 'pubspec.yaml').read_text()
version = re.search(r'^version:\s*["\']?([0-9A-Za-z.\-]+)(?:\+([0-9A-Za-z.\-]+))?', pubspec, re.M)
build_name = job.get('buildName') or (version.group(1) if version else '1.0.0')
build_number = job.get('buildNumber') or (version.group(2) if version and version.group(2) else build_name)
pbxproj = (ios / 'Runner.xcodeproj' / 'project.pbxproj').read_text()
targets = [tuple(int(part) for part in value.split('.')) for value in re.findall(r'IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);', pbxproj)]
minimum = '.'.join(str(part) for part in max(targets + [(15, 0)]))

# 3. Generated.xcconfig, which `flutter pub get` writes only on a Mac.
(ios / 'Flutter').mkdir(exist_ok=True)
(ios / 'Flutter' / 'Generated.xcconfig').write_text('\n'.join([
    '// This is a generated file; do not edit or check into version control.',
    f'FLUTTER_ROOT={flutter}',
    f'FLUTTER_APPLICATION_PATH={app}',
    f'FLUTTER_FRAMEWORK_SWIFT_PACKAGE_PATH={ios}/Flutter/ephemeral/Packages/.packages/FlutterFramework',
    'COCOAPODS_PARALLEL_CODE_SIGN=true',
    f'FLUTTER_TARGET={target}',
    'FLUTTER_BUILD_DIR=build',
    f'FLUTTER_BUILD_NAME={build_name}',
    f'FLUTTER_BUILD_NUMBER={build_number}',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386',
    'EXCLUDED_ARCHS[sdk=iphoneos*]=armv7',
    'DART_OBFUSCATION=false',
    'TRACK_WIDGET_CREATION=false',
    'TREE_SHAKE_ICONS=true',
    'PACKAGE_CONFIG=.dart_tool/package_config.json',
    '']))

# 4. The plugins as Swift packages, laid out as Flutter lays them out on a Mac.
GENERATED = '//\n// Generated file. Do not edit.\n//\n'
packages = ios / 'Flutter' / 'ephemeral' / 'Packages'
shutil.rmtree(packages, ignore_errors=True)
links = packages / '.packages'
(links / 'FlutterFramework' / 'Sources' / 'FlutterFramework').mkdir(parents=True)
(links / 'FlutterFramework' / 'Sources' / 'FlutterFramework' / 'FlutterFramework.swift').write_text(GENERATED)
(links / 'FlutterFramework' / 'Package.swift').write_text('''// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.
//
// Generated file. Do not edit.
//

import PackageDescription

let package = Package(
    name: "FlutterFramework",
    products: [
        .library(name: "FlutterFramework", targets: ["FlutterFramework"])
    ],
    dependencies: [

    ],
    targets: [
        .target(
            name: "FlutterFramework"
        )
    ]
)
''')
dependencies_file = app / '.flutter-plugins-dependencies'
plugins = json.loads(dependencies_file.read_text()).get('plugins', {}).get('ios', []) if dependencies_file.is_file() else []
package_lines, product_lines, missing = [], [], []
for plugin in plugins:
    if plugin.get('dev_dependency') or not plugin.get('native_build', True):
        continue
    name = plugin['name']
    root = pathlib.Path(plugin['path'])
    folder = root / ('darwin' if plugin.get('shared_darwin_source') else 'ios') / name
    if not (folder / 'Package.swift').is_file():
        missing.append(name)
        continue
    link = links / root.name.rstrip('/')
    link.symlink_to(folder)
    package_lines.append(f'        .package(name: "{name}", path: "../.packages/{link.name}")')
    product_lines.append(f'                .product(name: "{name.replace("_", "-")}", package: "{name}")')
if missing:
    fail('These plugins have no Swift package, which building on this PC needs: ' + ', '.join(missing) + '. Update them, or build on a Mac')
package_lines.append('        .package(name: "FlutterFramework", path: "../.packages/FlutterFramework")')
product_lines.append('                .product(name: "FlutterFramework", package: "FlutterFramework")')
generated = packages / 'FlutterGeneratedPluginSwiftPackage'
(generated / 'Sources' / 'FlutterGeneratedPluginSwiftPackage').mkdir(parents=True)
(generated / 'Sources' / 'FlutterGeneratedPluginSwiftPackage' / 'FlutterGeneratedPluginSwiftPackage.swift').write_text(GENERATED)
(generated / 'Package.swift').write_text('''// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.
//
// Generated file. Do not edit.
//

import PackageDescription

let package = Package(
    name: "FlutterGeneratedPluginSwiftPackage",
    platforms: [
        .iOS("%s")
    ],
    products: [
        .library(name: "FlutterGeneratedPluginSwiftPackage", type: .static, targets: ["FlutterGeneratedPluginSwiftPackage"])
    ],
    dependencies: [
%s
    ],
    targets: [
        .target(
            name: "FlutterGeneratedPluginSwiftPackage",
            dependencies: [
%s
            ]
        )
    ]
)
''' % (minimum, ',\n'.join(package_lines), ',\n'.join(product_lines)))

# 5. The Dart code (kernel) and the assets, with Flutter's own build system.
step(f'Compiling the Dart code ({mode})')
out = work / 'flutter-ios'
shutil.rmtree(out, ignore_errors=True)
(out / 'App.framework').mkdir(parents=True)
assets = out / 'App.framework' / 'flutter_assets'
encoded = ','.join(base64.b64encode(f'{key}={value}'.encode()).decode() for key, value in defines.items())
before = {str(path): path.stat().st_mtime for path in (app / '.dart_tool' / 'flutter_build').glob('*/app.dill')}
run([bin_flutter, 'assemble', '-dTargetPlatform=ios', f'-dBuildMode={mode}', '-dTreeShakeIcons=true', '-dTrackWidgetCreation=false',
     f'-dTargetFile={target}', *([f'-dFlavor={flavor}'] if flavor else []), *([f'-dDartDefines={encoded}'] if encoded else []),
     f'--output={assets}', f'--depfile={out / "assets.d"}', 'copy_flutter_bundle'], cwd=app)
kernels = sorted((app / '.dart_tool' / 'flutter_build').glob('*/app.dill'), key=lambda path: path.stat().st_mtime)
kernel = next((path for path in reversed(kernels) if before.get(str(path)) != path.stat().st_mtime), kernels[-1] if kernels else None)
if not kernel:
    fail('Flutter made no kernel (app.dill)')
(assets / '.last_build_id').unlink(missing_ok=True)

# Shaders: Flutter's bundle step compiles them for Android; an iPhone runs Metal ones.
impellerc = flutter / 'bin' / 'cache' / 'artifacts' / 'engine' / 'linux-x64' / 'impellerc'
depfile = (out / 'assets.d').read_text().replace('\\ ', '\0')
inputs = [item.replace('\0', ' ') for item in depfile.split(':', 1)[1].split()] if ':' in depfile else []
for shader in [path for path in assets.rglob('*') if path.is_file() and path.suffix in ('.frag', '.glsl')]:
    relative = shader.relative_to(assets).parts
    candidates = [item for item in inputs if item.endswith('/' + shader.name)]
    if not candidates:
        fail(f'No source found for the shader {shader.name}')
    def common(item):
        parts, count = pathlib.PurePosixPath(item).parts, 0
        while count < min(len(parts), len(relative)) and parts[-1 - count] == relative[-1 - count]:
            count += 1
        return count
    original = max(candidates, key=common)
    run([str(impellerc), '--runtime-stage-metal', '--iplr', f'--sl={shader}', f'--spirv={shader}.spirv', f'--input={original}',
         '--input-type=frag', f'--include={os.path.dirname(original)}', f'--include={impellerc.parent / "shader_lib"}'], quiet=True)
    pathlib.Path(f'{shader}.spirv').unlink(missing_ok=True)

# 6. App.framework: the Dart code compiled for the iPhone, as Flutter's Xcode script makes it.
step('Compiling the Dart code for the iPhone (AOT)')
binary = out / 'App.framework' / 'App'
run([compiler, '--deterministic', '--snapshot_kind=app-aot-macho-dylib', f'--macho={binary}', f'--macho-object={out / "app.o"}',
     f'--macho-min-os-version={minimum}', '--macho-rpath=@executable_path/Frameworks,@loader_path/Frameworks',
     '--macho-install-name=@rpath/App.framework/App', str(kernel)], quiet=True)
(out / 'app.o').unlink(missing_ok=True)
run([strip, '-x', str(binary)], quiet=True)
info_file = ios / 'Flutter' / 'AppFrameworkInfo.plist'
info = plistlib.loads(info_file.read_bytes()) if info_file.is_file() else {
    'CFBundleDevelopmentRegion': 'en', 'CFBundleExecutable': 'App', 'CFBundleIdentifier': 'io.flutter.flutter.app',
    'CFBundleInfoDictionaryVersion': '6.0', 'CFBundleName': 'App', 'CFBundlePackageType': 'FMWK',
    'CFBundleShortVersionString': '1.0', 'CFBundleSignature': '????', 'CFBundleVersion': '1.0'}
info['MinimumOSVersion'] = minimum
(out / 'App.framework' / 'Info.plist').write_bytes(plistlib.dumps(info))

# 7. Flutter.framework: Google's engine for iPhones.
framework = engine / 'Flutter.xcframework' / 'ios-arm64' / 'Flutter.framework'
if not (framework / 'Flutter').is_file():
    fail(f'Flutter’s iPhone engine is missing at {framework}')
shutil.copytree(framework, out / 'Flutter.framework', symlinks=True)

print('capmac-result: ' + json.dumps({'app': str(app), 'ios': str(ios), 'frameworks': str(out), 'minimum': minimum,
                                       'buildName': build_name, 'buildNumber': build_number}), flush=True)
