/** Python helpers are transported over stdin/argv, never interpolated into shell commands. */
export const COPY_RESOURCE = String.raw`import filecmp,pathlib,plistlib,shutil,sys
source=pathlib.Path(sys.argv[1]); root=pathlib.Path(sys.argv[2]).resolve(); destination=root/sys.argv[3]
if not destination.resolve().is_relative_to(root): raise SystemExit('Resource destination escapes its product directory')
if not source.exists(): raise SystemExit('Native resource is missing: '+str(source))
native_sources={'.xcassets','.storyboard','.xib','.xcdatamodel','.xcdatamodeld','.xcstrings','.metal','.xcmappingmodel','.mlmodel','.mlpackage'}
if source.is_dir():
 for item in source.rglob('*'):
  if item.suffix.lower() in native_sources: raise SystemExit('Uncompiled native resource inside '+str(source)+': '+str(item)+'; include its resource-bundle target in the build graph')
def merge(a,b):
 if isinstance(a,dict) and isinstance(b,dict):
  result=dict(a)
  for key,value in b.items(): result[key]=merge(result[key],value) if key in result else value
  return result
 if isinstance(a,list) and isinstance(b,list):
  result=list(a)
  for value in b:
   identity=next((key for key in ['NSPrivacyAccessedAPIType','NSPrivacyCollectedDataType'] if isinstance(value,dict) and key in value),None)
   match=next((i for i,item in enumerate(result) if identity and isinstance(item,dict) and item.get(identity)==value[identity]),None)
   if match is not None: result[match]=merge(result[match],value)
   elif value not in result: result.append(value)
  return result
 if isinstance(a,bool) and isinstance(b,bool): return a or b
 if a==b: return a
 raise SystemExit('Conflicting privacy manifest values while copying native resources')
def identical(a,b):
 if a.is_file() and b.is_file(): return filecmp.cmp(a,b,shallow=False)
 if a.is_dir() and b.is_dir():
  left={p.name:p for p in a.iterdir()}; right={p.name:p for p in b.iterdir()}
  return left.keys()==right.keys() and all(identical(p,right[name]) for name,p in left.items())
 return False
destination.parent.mkdir(parents=True,exist_ok=True)
if destination.exists():
 if source.name=='PrivacyInfo.xcprivacy' and source.is_file():
  with destination.open('rb') as f: previous=plistlib.load(f)
  with source.open('rb') as f: incoming=plistlib.load(f)
  with destination.open('wb') as f: plistlib.dump(merge(previous,incoming),f)
 elif source.resolve()==destination.resolve() or identical(source,destination): pass
 else: raise SystemExit('Native resource already exists: '+str(destination))
elif source.is_dir(): shutil.copytree(source,destination,symlinks=False)
else: shutil.copy2(source,destination)
`;

export const MERGE_RESOURCE_PLIST = String.raw`import pathlib,plistlib,sys
target=pathlib.Path(sys.argv[1]); partial=pathlib.Path(sys.argv[2])
if not partial.is_file(): raise SystemExit('The resource compiler did not write its partial Info.plist: '+str(partial))
with partial.open('rb') as f: additions=plistlib.load(f)
if not isinstance(additions,dict): raise SystemExit('Resource compiler partial Info.plist must be a dictionary')
if target.exists():
 with target.open('rb') as f: result=plistlib.load(f)
else: result={}
def merge(a,b):
 if isinstance(a,dict) and isinstance(b,dict):
  result=dict(a)
  for key,value in b.items(): result[key]=merge(result[key],value) if key in result else value
  return result
 return b
target.parent.mkdir(parents=True,exist_ok=True)
with target.open('wb') as f: plistlib.dump(merge(result,additions),f)
`;

/** Routes Apple's command names to real Linux implementations; unknown tools fail. */
export const TOOL_ROUTER = String.raw`#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys
def fail(message):
 print('error: CapMac WSL: '+message,file=sys.stderr); raise SystemExit(1)
manifest=json.loads((pathlib.Path(__file__).resolve().parent/'tools.json').read_text())
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
if name=='xcrun':
 find=False
 while args:
  arg=args[0]
  if arg in ['--sdk','-sdk']:
   if len(args)<2: fail('xcrun --sdk needs an SDK name')
   if args[1] not in ['iphoneos',manifest['sdkPath']]: fail('Only the configured physical iPhoneOS SDK is supported: '+args[1])
   args=args[2:]
  elif arg in ['--find','-f']: find=True; args=args[1:]
  elif arg in ['--show-sdk-path','--show-sdk-version','--show-sdk-platform-path']:
   key={'--show-sdk-path':'sdkPath','--show-sdk-version':'sdkVersion','--show-sdk-platform-path':'platformPath'}[arg]
   value=manifest.get(key)
   if not value: fail('The extracted SDK does not provide '+arg)
   print(value); raise SystemExit(0)
  elif arg in ['--run','-r','--no-cache','--kill-cache']: args=args[1:]
  elif arg.startswith('-'): fail('Unsupported xcrun option '+arg)
  else: break
 if not args: fail('xcrun needs a tool name')
 name=args.pop(0)
 if find:
  tool=manifest['tools'].get(name)
  if not tool and not (name=='xcodebuild' and manifest.get('xcodeVersion')): fail('No Linux replacement for '+name+'. Install/configure the real tool; build phases are not skipped.')
  # Returning the router keeps CocoaPods' subsequent direct invocation portable.
  print(str(pathlib.Path(__file__).absolute().parent/name)); raise SystemExit(0)
if name=='xcodebuild':
 # These values describe the supplied SDK's original Xcode distribution.
 # Build operations are deliberately rejected: there is no Xcode on WSL.
 if args==['-version']:
  version=manifest.get('xcodeVersion')
  if not version: fail('No verified Xcode version metadata accompanies this SDK')
  print('Xcode '+version+'\nBuild version '+manifest.get('xcodeBuild','')); raise SystemExit(0)
 if args==['-showsdks']:
  version=manifest.get('sdkVersion')
  if not version: fail('No SDK version metadata accompanies this SDK')
  print('iOS SDKs:\n\tiOS '+version+' -sdk iphoneos'+version); raise SystemExit(0)
 fail('xcodebuild build operations require a real WSL implementation; only -version and -showsdks metadata queries are available')
tool=manifest['tools'].get(name)
if not tool: fail('No Linux replacement for '+name+'. Install/configure the real tool; build phases are not skipped.')
if name=='ibtool' and manifest.get('portableIbtool'):
 # Apple's --sdk affects available IB plugins; the portable compiler validates
 # its own explicitly supported classes. Diagnostic flags carry no output data.
 cleaned=[]; index=0
 while index<len(args):
  arg=args[index]
  if arg=='--sdk': index+=2; continue
  if arg in ['--notices','--reference-external-strings-file']: index+=1; continue
  cleaned.append(arg); index+=1
 args=cleaned
 # CocoaPods puts --compile before --sdk/--target-device, whereas the Python
 # compiler accepts options before its action. Preserve all semantic options.
 if '--compile' in args:
  index=args.index('--compile')
  if len(args)<index+3: fail('ibtool --compile needs a destination and source')
  destination,source=args[index+1:index+3]
  options=args[:index]+args[index+3:]
  if source.endswith('.storyboard'):
   parent=str(pathlib.Path(destination).parent)
   result=subprocess.run([tool,*options,source,'--compilation-directory',parent])
   if result.returncode: raise SystemExit(result.returncode)
   actual=pathlib.Path(parent)/(pathlib.Path(source).stem+'.storyboardc')
   target=pathlib.Path(destination)
   if actual!=target:
    if target.exists(): fail('Storyboard output already exists: '+str(target))
    actual.rename(target)
   raise SystemExit(0)
  args=options+['--compile',destination,source]
if name=='momc' and manifest.get('portableMomc') and len(args)>=2 and pathlib.Path(args[-1]).suffix in ['.mom','.momd']:
 target=pathlib.Path(args[-1]); source=pathlib.Path(args[-2]); target.parent.mkdir(parents=True,exist_ok=True)
 result=subprocess.run([tool,*args[:-1],str(target.parent)])
 if result.returncode: raise SystemExit(result.returncode)
 actual=target.parent/(source.stem+('.momd' if source.suffix=='.xcdatamodeld' else '.mom'))
 if actual!=target:
  if target.exists(): fail('Core Data output already exists: '+str(target))
  actual.rename(target)
 raise SystemExit(0)
if name=='actool':
 result=subprocess.run([tool,*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 sys.stdout.buffer.write(result.stdout); sys.stderr.buffer.write(result.stderr)
 if b'warning: skipped by the Linux actool:' in result.stdout+result.stderr: fail('The asset compiler omitted unsupported assets; refusing to produce an incomplete application')
 raise SystemExit(result.returncode)
os.execv(tool,[tool,*args])
`;

/** Ubuntu packages may provide llvm-lipo-21 without an unversioned llvm-lipo. */
export const LLVM_TOOL_RESOLVER = String.raw`def resolve_llvm_tool(explicit,name,swiftbin='',fallbacks=()):
 import os,pathlib,re,shutil
 if explicit: return shutil.which(explicit)
 if swiftbin:
  sibling=pathlib.Path(swiftbin)/name
  if sibling.is_file() and os.access(sibling,os.X_OK): return str(sibling)
 versions=[]
 for order,directory in enumerate(os.get_exec_path()):
  folder=pathlib.Path(directory)
  if not folder.is_absolute() or not folder.is_dir(): continue
  try: children=list(folder.iterdir())
  except OSError: continue
  for candidate in children:
   match=re.fullmatch(re.escape(name)+r'-(\d+)(?:\.(\d+))?',candidate.name)
   if match and candidate.is_file() and os.access(candidate,os.X_OK): versions.append((int(match[1]),int(match[2] or 0),-order,str(candidate)))
 if versions: return max(versions)[3]
 for candidate in [name,*fallbacks]:
  resolved=shutil.which(candidate)
  if resolved: return resolved
 return None
`;

export const RUN_SCRIPT_PHASE = LLVM_TOOL_RESOLVER + String.raw`import json,os,pathlib,plistlib,re,shutil,subprocess,sys
request=json.load(sys.stdin); phase=request['phase']; context=request['context']; configured=request['tools']
build=pathlib.Path(context['buildDirectory']); product=pathlib.Path(context['productDirectory']); project=pathlib.Path(context['projectRoot'])
bin_dir=build/'script-tools'; bin_dir.mkdir(parents=True,exist_ok=True)
def resolve(explicit,candidates):
 if explicit: return shutil.which(explicit)
 return next((p for candidate in candidates if (p:=shutil.which(candidate))),None)
swiftc=resolve(configured.get('swiftcPath'),['swiftc'])
swiftbin=str(pathlib.Path(swiftc).parent) if swiftc else ''
tools={
 'actool':resolve(configured.get('actoolPath'),['actool']),
 'ibtool':resolve(configured.get('ibtoolPath'),['ibtool']),
 'momc':resolve(configured.get('momcPath'),['momc']),
 'xcstringstool':resolve(configured.get('xcstringsPath'),['xcstringstool']),
 'clang':resolve(configured.get('clangPath'),[swiftbin+'/clang','clang']),
 'clang++':resolve(None,[swiftbin+'/clang++','clang++']),
 'swiftc':swiftc,
 'swift':resolve(None,[swiftbin+'/swift','swift']),
 'ar':resolve_llvm_tool(configured.get('archivePath'),'llvm-ar',swiftbin),
 'ranlib':resolve_llvm_tool(None,'llvm-ranlib',swiftbin),
 'lipo':resolve_llvm_tool(configured.get('lipoPath'),'llvm-lipo',swiftbin,['lipo']),
 'strip':resolve_llvm_tool(configured.get('stripPath'),'llvm-strip',swiftbin),
 'nm':resolve_llvm_tool(None,'llvm-nm',swiftbin),
 'otool':resolve_llvm_tool(None,'llvm-otool',swiftbin,['otool']),
 'install_name_tool':resolve_llvm_tool(None,'llvm-install-name-tool',swiftbin,['install_name_tool']),
 'ld':resolve(configured.get('linkerPath'),['ld64.lld']),
}
sdk=pathlib.Path(context['sdkPath']); sdk_version=None
for name in ['SDKSettings.plist','SDKSettings.json']:
 p=sdk/name
 if p.exists():
  with p.open('rb') as f: metadata=plistlib.load(f) if name.endswith('.plist') else json.load(f)
  sdk_version=metadata.get('Version') or metadata.get('DefaultProperties',{}).get('PLATFORM_VERSION'); break
platform=next((p for p in sdk.parents if p.name.endswith('.platform')),None)
settings=context['settings']; xcode_version=settings.get('CAPMAC_XCODE_VERSION'); xcode_build=settings.get('XCODE_PRODUCT_BUILD_VERSION','')
xcode_settings={}
contents=next((p for p in sdk.parents if p.name=='Contents' and p.parent.name.endswith('.app')),None)
if contents and (contents/'version.plist').exists():
 with (contents/'version.plist').open('rb') as f: metadata=plistlib.load(f)
 xcode_version=xcode_version or metadata.get('CFBundleShortVersionString')
 xcode_build=xcode_build or metadata.get('ProductBuildVersion','')
if not xcode_version and settings.get('XCODE_VERSION_ACTUAL','').isdigit():
 value=int(settings['XCODE_VERSION_ACTUAL']); xcode_version=str(value//100)+'.'+str((value%100)//10)+(('.'+str(value%10)) if value%10 else '')
if xcode_version:
 numbers=[int(v) for v in re.findall(r'\d+',xcode_version)]
 if numbers:
  xcode_settings={'XCODE_VERSION_ACTUAL':str(numbers[0]*100+(numbers[1] if len(numbers)>1 else 0)*10+(numbers[2] if len(numbers)>2 else 0)),
   'XCODE_VERSION_MAJOR':str(numbers[0]*100),'XCODE_VERSION_MINOR':str(numbers[0]*100+(numbers[1] if len(numbers)>1 else 0)*10),'XCODE_PRODUCT_BUILD_VERSION':xcode_build}
def portable(tool):
 try: return bool(tool and 'Linux' in pathlib.Path(tool).read_text()[:500] and pathlib.Path(tool).read_text().startswith('#!'))
 except (UnicodeError,OSError): return False
manifest={'tools':tools,'sdkPath':str(sdk),'sdkVersion':sdk_version,'platformPath':str(platform) if platform else None,'portableIbtool':portable(tools.get('ibtool')),'portableMomc':portable(tools.get('momc')),'xcodeVersion':xcode_version,'xcodeBuild':xcode_build}
(bin_dir/'tools.json').write_text(json.dumps(manifest))
router=bin_dir/'tool-router.py'; router.write_text(request['router']); router.chmod(0o755)
for name in ['xcrun','xcodebuild',*tools]:
 link=bin_dir/name
 if link.exists() or link.is_symlink():
  if not link.is_symlink() or os.readlink(link)!='tool-router.py': raise SystemExit('Refusing to replace a non-generated script tool: '+str(link))
 else: link.symlink_to('tool-router.py')
env=dict(os.environ); env.update(xcode_settings); env.update(settings)
full=product.name; built=str(product.parent); target_temp=settings.get('TARGET_TEMP_DIR',str(build/'Intermediates'/context['targetName']))
derived=settings.get('DERIVED_FILE_DIR',str(pathlib.Path(target_temp)/'DerivedSources')); pathlib.Path(derived).mkdir(parents=True,exist_ok=True)
env.update({
 'SRCROOT':str(project),'SOURCE_ROOT':str(project),'PROJECT_DIR':str(project),
 'SDKROOT':str(sdk),'SDK_DIR':str(sdk),'PLATFORM_NAME':'iphoneos','EFFECTIVE_PLATFORM_NAME':'-iphoneos',
 'PLATFORM_DIR':str(platform) if platform else '',
 'TARGET_NAME':context['targetName'],'TARGETNAME':context['targetName'],
 'CONFIGURATION':settings.get('CONFIGURATION','Debug'),'ARCHS':'arm64','CURRENT_ARCH':'arm64','VALID_ARCHS':'arm64',
 'ONLY_ACTIVE_ARCH':'YES','ACTION':'build','SKIP_INSTALL':settings.get('SKIP_INSTALL','YES'),
 'BUILD_DIR':settings.get('BUILD_DIR',str(build)),'BUILD_ROOT':settings.get('BUILD_ROOT',str(build)),
 'BUILT_PRODUCTS_DIR':settings.get('BUILT_PRODUCTS_DIR',built),
 'CONFIGURATION_BUILD_DIR':settings.get('CONFIGURATION_BUILD_DIR',built),
 'TARGET_BUILD_DIR':settings.get('TARGET_BUILD_DIR',built),
 'TARGET_TEMP_DIR':target_temp,'TEMP_DIR':settings.get('TEMP_DIR',target_temp),'DERIVED_FILE_DIR':derived,
 'DERIVED_FILES_DIR':settings.get('DERIVED_FILES_DIR',derived),
 'DERIVED_SOURCES_DIR':settings.get('DERIVED_SOURCES_DIR',derived),'PROJECT_TEMP_DIR':settings.get('PROJECT_TEMP_DIR',str(build/'Intermediates')),
 'FULL_PRODUCT_NAME':full,'WRAPPER_NAME':full,'WRAPPER_EXTENSION':product.suffix.lstrip('.'),
 'CONTENTS_FOLDER_PATH':settings.get('CONTENTS_FOLDER_PATH',full),
 'UNLOCALIZED_RESOURCES_FOLDER_PATH':settings.get('UNLOCALIZED_RESOURCES_FOLDER_PATH',full),
 'FRAMEWORKS_FOLDER_PATH':settings.get('FRAMEWORKS_FOLDER_PATH',full+'/Frameworks'),
 'EXECUTABLE_NAME':settings.get('EXECUTABLE_NAME',product.stem),
 'EXECUTABLE_FOLDER_PATH':settings.get('EXECUTABLE_FOLDER_PATH',full),
 'EXECUTABLE_PATH':settings.get('EXECUTABLE_PATH',full+'/'+settings.get('EXECUTABLE_NAME',product.stem)),
 'INFOPLIST_PATH':settings.get('INFOPLIST_PATH',full+'/Info.plist'),
 'PODS_ROOT':settings.get('PODS_ROOT',str(project/'Pods')),
 'PODS_PODFILE_DIR_PATH':settings.get('PODS_PODFILE_DIR_PATH',str(project)),
 'PODS_BUILD_DIR':settings.get('PODS_BUILD_DIR',str(build)),
 'PODS_CONFIGURATION_BUILD_DIR':settings.get('PODS_CONFIGURATION_BUILD_DIR',built),
 'PODS_XCFRAMEWORKS_BUILD_DIR':settings.get('PODS_XCFRAMEWORKS_BUILD_DIR',str(build/'XCFrameworkIntermediates')),
 'IPHONEOS_DEPLOYMENT_TARGET':settings.get('IPHONEOS_DEPLOYMENT_TARGET','15.0'),
 'DEPLOYMENT_TARGET_SETTING_NAME':'IPHONEOS_DEPLOYMENT_TARGET',
 'TARGETED_DEVICE_FAMILY':settings.get('TARGETED_DEVICE_FAMILY','1,2'),
 'TOOLCHAIN_DIR':settings.get('TOOLCHAIN_DIR',str(pathlib.Path(swiftbin).parent) if swiftbin else ''),
 'CODE_SIGNING_ALLOWED':'NO','CODE_SIGNING_REQUIRED':'NO','EXPANDED_CODE_SIGN_IDENTITY':'',
 'CAPMAC_BUILD_BACKEND':'wsl','CAPMAC_SCRIPT_TOOLS':str(bin_dir),
 'PATH':str(bin_dir)+os.pathsep+env.get('PATH',''),
})
if sdk_version: env['SDK_VERSION']=str(sdk_version)
for setting,tool in [('CC','clang'),('CXX','clang++'),('LD','ld'),('AR','ar'),('STRIP','strip'),('SWIFT_EXEC','swiftc')]:
 if tools.get(tool): env[setting]=tools[tool]
variable=re.compile(r'\$\(([^)]+)\)|\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)')
def expand(value):
 for _ in range(16):
  updated=variable.sub(lambda m: env.get(next(g for g in m.groups() if g is not None),m.group(0)),value)
  if updated==value: return updated
  value=updated
 raise SystemExit('Cyclic build setting in script input/output path')
for collection,prefix in [('inputPaths','SCRIPT_INPUT_FILE'),('outputPaths','SCRIPT_OUTPUT_FILE'),('inputFileListPaths','SCRIPT_INPUT_FILE_LIST'),('outputFileListPaths','SCRIPT_OUTPUT_FILE_LIST')]:
 values=phase.get(collection,[]); env[prefix+'_COUNT']=str(len(values))
 for index,value in enumerate(values): env[prefix+'_'+str(index)]=expand(value)
script=phase['script'].replace('\r\n','\n')
# macOS /bin/sh supports the bash arrays in CocoaPods' generated scripts. Linux
# /bin/sh commonly means dash; invoke those known scripts with bash explicitly.
script=re.sub(r'(?m)^(\s*)("\$\{PODS_ROOT\}/Target Support Files/[^"\n]+\.sh")\s*$',r'\1/bin/bash \2',script)
script=script.replace('/usr/bin/xcrun',str(bin_dir/'xcrun'))
script=script.replace('/usr/bin/xcodebuild',str(bin_dir/'xcodebuild'))
script=script.replace('/usr/bin/lipo',str(bin_dir/'lipo'))
shell=phase.get('shellPath') or '/bin/sh'
if shell in ['/bin/sh','/bin/bash','sh','bash']: shell='/bin/bash'
if not shutil.which(shell): raise SystemExit('Build phase shell is unavailable in WSL: '+shell)
result=subprocess.run([shell,'-e','-c',script,'capmac:'+phase['name']],cwd=str(project),env=env)
if result.returncode and 'XCODE_VERSION_MAJOR' not in env:
 print('note: This SDK lacks Xcode version metadata. If the failing SDK script reads XCODE_VERSION_MAJOR, supply the extracted Xcode Contents/version.plist or that verified build setting.',file=sys.stderr)
raise SystemExit(result.returncode)
`;

/** Exact-source patch: preserve controller-only scenes and UIImageView launch roots. */
export const PATCH_IBTOOL = String.raw`def patch_ibtool(path):
 import hashlib
 expected='d82372508c7b5ca2cd58ff48eba7f65a40a1ac5b1d8b1d884d1ad53112d19786'
 raw=path.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=expected: raise SystemExit('The pinned ibtool source changed; refusing to apply an unverified resource compiler patch')
 text=raw.decode('utf-8')
 edits=[
  ('''CONTENT_MODES = {"scaleToFill": 0, "center": 4, "left": 7, "scaleAspectFit": 1,''',
   '''CONTENT_MODES = {"scaleToFill": 0, "center": 4, "left": 7, "scaleAspectFit": 1, "scaleAspectFill": 2,'''),
  ('''    """An inline sRGB <color red= green= blue= alpha=>. Only components exact in float32 are
    supported: Apple's golden (MainInterface.storyboard, all zero) stores no -Double values for them."""''',
   '''    """Inline sRGB color, retaining Double components when float32 loses precision."""'''),
  ('''    if any(struct.unpack("<f", struct.pack("<f", v))[0] != v for v in comps):
        raise XibError(f"<color> {comps} needs -Double components, not derived yet ({where})")
''', ''''''),
  ('''    for k, v in zip(("UIRed", "UIGreen", "UIBlue", "UIAlpha"), comps):
        c.add(k, *b.float32(v))''',
   '''    for k, v in zip(("UIRed", "UIGreen", "UIBlue", "UIAlpha"), comps):
        c.add(k, *b.float32(v))
        if struct.unpack("<f", struct.pack("<f", v))[0] != v:
            c.add(k + "-Double", *b.float64(v))'''),
  ('''    if view is None or not view.get("id") or not vc_el.get("id"):
        raise XibError(f"scene view controller has no keyed view ({vc_el.get('id')})")
    return f"{vc_el.get('id')}-view-{view.get('id')}"''',
   '''    if not vc_el.get("id"):
        raise XibError("scene view controller has no id")
    if view is None:
        return None  # A programmatic controller's loadView supplies its view.
    if not view.get("id"):
        raise XibError(f"scene view controller has no keyed view ({vc_el.get('id')})")
    return f"{vc_el.get('id')}-view-{view.get('id')}"'''),
  ('''"vc": vc_el, "nibName_sort": _view_nib_name(vc_el)}''',
   '''"vc": vc_el, "nibName_sort": _view_nib_name(vc_el) or ""}'''),
  ('''    swapper.add("UINibName", *b.ref(b.string(_view_nib_name(vc_el))))''',
   '''    view_nib_name = _view_nib_name(vc_el)
    if view_nib_name is not None:
        swapper.add("UINibName", *b.ref(b.string(view_nib_name)))'''),
  ('''        if view_el is None or not view_el.get("id"):
            raise XibError(f"{where}: viewController has no keyed view")''',
   '''        if view_el is None:
            if vc_el.tag != "viewController" or not vc_el.get("id"):
                raise XibError(f"{where}: programmatic scene requires a viewController with an id")
            if vc_el.get("id") in embedded and not vc_el.get("storyboardIdentifier"):
                continue
            arch, vc_name = _scene_vc_nib(vc_el, where, resources, named)
            with open(os.path.join(out_dir, vc_name + ".nib"), "wb") as f:
                f.write(arch)
            identifiers[vc_name] = vc_name
            id_to_name[vc_el.get("id")] = vc_name
            continue
        if not view_el.get("id"):
            raise XibError(f"{where}: viewController has no keyed view")'''),
  ('''        elif view_el.tag in ("view", "collectionView"):
            varch = _scene_view_nib(vc_el, view_el, where, resources, named, DEVICE_SIZES.get(device))''',
   '''        elif view_el.tag in ("view", "collectionView", "imageView"):
            varch = _scene_view_nib(vc_el, view_el, where, resources, named, DEVICE_SIZES.get(device))'''),
  ('''def _scene_image_view(sb, el, where, resources, named, id_map):
    """Storyboard imageView: no UIOpaque (FeedCell header golden); tint before
    DoesNotTranslate; image and preferredSymbolConfiguration last."""
    b = sb.b
    (bx, by, bw, bh), (cx, cy) = _bounds_center(el)
    o = b.new("UIImageView")
    if el.get("id"):
        id_map[el.get("id")] = o
    o.add("UIBounds", *b.geom(bx, by, bw, bh))
    o.add("UICenter", *b.geom(cx, cy))''',
   '''def _scene_image_view(sb, el, where, resources, named, id_map):
    """Storyboard imageView, including Capacitor's image-backed launch root."""
    b = sb.b
    (bx, by, bw, bh), (cx, cy) = _bounds_center(el)
    o = b.new("UIImageView")
    if el.get("id"):
        id_map[el.get("id")] = o
    o.add("UIBounds", *b.geom(bx, by,bw,bh))
    o.add("UICenter", *b.geom(cx,cy))
    background = el.find("color[@key='backgroundColor']")
    if background is not None:
        o.add("UIBackgroundColor", *b.ref(build_color_el(b, background, where, resources, named)))'''),
 ]
 for old,new in edits:
  if text.count(old)!=1: raise SystemExit('The pinned ibtool patch context did not match exactly')
  text=text.replace(old,new,1)
 compile(text,str(path),'exec')
 path.write_text(text,encoding='utf-8',newline='\n')
`;

export const INSTALL_RESOURCE_TOOLS = PATCH_IBTOOL + String.raw`import json,os,pathlib,re,shutil,subprocess,sys,tempfile
revision=sys.argv[1]; swift=sys.argv[2]
if len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision): raise SystemExit('Invalid pinned resource tool revision')
for tool in ['git',swift]:
 if not shutil.which(tool): raise SystemExit('Install '+tool+' in this WSL distribution before installing resource compilers')
for tool,package in [('rsvg-convert','librsvg2-bin'),('pdfinfo','poppler-utils'),('pdftocairo','poppler-utils'),('heif-convert','libheif-examples')]:
 if not shutil.which(tool): raise SystemExit('Resource image support requires '+package+' inside WSL. Run capmac wsl setup to install the managed prerequisites.')
version=subprocess.check_output([swift,'--version'],text=True,stderr=subprocess.STDOUT)
match=re.search(r'Swift version (\d+)\.(\d+)',version)
if not match or (int(match[1]),int(match[2]))<(6,2): raise SystemExit('The standalone asset compiler requires Linux Swift 6.2 or later; install a Swift toolchain matching the supplied Apple SDK')
root=pathlib.Path(os.environ.get('XDG_DATA_HOME',str(pathlib.Path.home()/'.local/share')))/'capmac'/'resource-tools'
root.mkdir(parents=True,exist_ok=True); installed=root/(revision+'-capmac2'); bindir=installed/'bin'
names={'actoolPath':'actool','ibtoolPath':'ibtool','momcPath':'momc','xcstringsPath':'xcstringstool'}
def installed_ok():
 return (installed/'revision').is_file() and (installed/'revision').read_text().strip()==revision and all((bindir/name).is_file() and os.access(bindir/name,os.X_OK) for name in names.values()) and (installed/'LICENSE').is_file()
if not installed_ok():
 if installed.exists(): raise SystemExit('Incomplete resource tools at '+str(installed)+'. Move this exact generated revision directory aside and retry setup.')
 staging=pathlib.Path(tempfile.mkdtemp(prefix='install-',dir=root)); source=staging/'source'; output=staging/'installed'; binaries=output/'bin'
 try:
  def run(argv): subprocess.run(argv,check=True,stdout=sys.stderr,stderr=sys.stderr)
  run(['git','clone','--config','core.autocrlf=false','--filter=blob:none','--no-checkout','https://github.com/joshuaswarren/omarchy-apple-dev.git',str(source)])
  run(['git','-C',str(source),'checkout','--detach',revision])
  actual=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
  if actual!=revision: raise SystemExit('Resource source revision verification failed')
  package=source/'tools/darwin-tools'
  run([swift,'build','--package-path',str(package),'-c','release','--product','actool'])
  binaries.mkdir(parents=True)
  shutil.copy2(package/'.build/release/actool',binaries/'actool')
  for name in ['ibtool','momc','xcstringstool','nibarchive.py','keyorder.py','xcstrings_symbols.py']:
   shutil.copy2(source/'tools'/name,binaries/name)
  patch_ibtool(binaries/'ibtool')
  for name in names.values(): (binaries/name).chmod(0o755)
  shutil.copy2(source/'LICENSE',output/'LICENSE')
  notices=output/'THIRD_PARTY_NOTICES'; notices.mkdir()
  for checkout in sorted((package/'.build/checkouts').iterdir()):
   if not checkout.is_dir(): continue
   for notice in checkout.iterdir():
    if notice.is_file() and notice.name.lower().startswith(('license','licence','copying','copyright')):
     destination=notices/checkout.name; destination.mkdir(exist_ok=True); shutil.copy2(notice,destination/notice.name)
  (output/'SOURCE').write_text('https://github.com/joshuaswarren/omarchy-apple-dev\n'+revision+'\nCapMac patch 1: controller-only storyboard scenes and UIImageView launch roots.\nStandalone resource helpers only; xtool is not installed or used.\n')
  (output/'revision').write_text(revision+'\n')
  run([str(binaries/'actool'),'--version'])
  run([str(binaries/'ibtool'),'--version'])
  run([str(binaries/'xcstringstool'),'--help'])
  # Compile Python entrypoints without writing __pycache__ into the installed tools.
  for name in ['ibtool','momc','xcstringstool','nibarchive.py','keyorder.py','xcstrings_symbols.py']:
   compile((binaries/name).read_bytes(),str(binaries/name),'exec')
  output.rename(installed)
 finally:
  # Only this process's mkdtemp child of the checked tool cache is removed.
  if staging.resolve().parent!=root.resolve(): raise SystemExit('Unsafe resource setup staging directory')
  shutil.rmtree(staging)
if not installed_ok(): raise SystemExit('Resource compiler installation verification failed')
print(json.dumps({key:str(bindir/name) for key,name in names.items()}))
`;
