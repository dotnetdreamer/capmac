/** Import evaluated Swift package manifests without resolving or changing the user's lockfile. */
import { promises as fs } from 'node:fs';
import type { EngineContext } from '../context.js';
import { UserError } from '../errors.js';
import type { WslNativeGraph } from './native-compiler.js';
import type { WslExecutor, WslToolchainTools } from './toolchain.js';

export interface XcodePackageReference { path?: string; location?: string }
export interface XcodePackageProduct { name: string; path?: string; location?: string }
export interface WslXcodeGraph extends WslNativeGraph {
  swiftPackages?: XcodePackageReference[];
  projectFiles?: string[];
}

// Swift executes each Package.swift. JSON describes the actual manifest; source
// discovery, dependency conditions and binary verification use that description.
export const SWIFT_PACKAGE_IMPORT = String.raw`import hashlib,json,os,pathlib,plistlib,re,shutil,stat,subprocess,sys,tempfile,urllib.request,zipfile
r=json.load(sys.stdin); graph=r['graph']; configuration=graph['configuration']; workspace=pathlib.Path(graph['projectRoot']).resolve()
swift=r['swiftPath']; output=pathlib.Path(r['output']); sdk=r['sdkPath']; cache=pathlib.Path.home()/'.cache/capmac/swift-packages'; cache.mkdir(parents=True,exist_ok=True)
def fail(message): raise SystemExit('Swift packages: '+message)
def run(argv,cwd=None,env=None):
 result=subprocess.run(argv,cwd=cwd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if result.returncode: fail('Command failed: '+argv[0]+'\n'+result.stderr[-12000:])
 return result.stdout
def identity(value): return str(value).rstrip('/').rsplit('/',1)[-1].removesuffix('.git').lower()
def canonical(value): return str(value).rstrip('/').removesuffix('.git').lower()
def module_name(value):
 value=re.sub(r'[^A-Za-z0-9_]','_',value)
 return '_'+value if value[:1].isdigit() else value
locks={}
lockfiles=[]
for project in graph.get('projectFiles',[]):
 file=pathlib.Path(project)/'project.xcworkspace/xcshareddata/swiftpm/Package.resolved'
 if file.is_file(): lockfiles.append(file)
for root in [workspace]+[pathlib.Path(reference['path']) for reference in graph.get('swiftPackages',[]) if reference.get('path')]:
 file=root/'Package.resolved'
 if file.is_file() and file not in lockfiles: lockfiles.append(file)
for file in lockfiles:
 document=json.loads(file.read_text()); pins=document.get('pins',document.get('object',{}).get('pins',[]))
 for pin in pins:
  key=pin.get('identity') or identity(pin.get('repositoryURL','')); state=pin.get('state',{}); location=pin.get('location') or pin.get('repositoryURL')
  if key in locks and locks[key]['revision']!=state.get('revision'): fail('Conflicting locked revisions for '+key+' in '+str(file))
  locks[key]={'revision':state.get('revision'),'location':location,'version':state.get('version')}
packages={}; paths={}; aliases={}; native_targets=[]; target_cache={}; binary_cache={}
def checkout(location):
 key=identity(location); pin=locks.get(key)
 if not pin or not re.fullmatch(r'[0-9a-fA-F]{40}',pin.get('revision') or ''): fail('Package.resolved has no exact revision for '+key+'; resolve and commit it before this build')
 if canonical(location)!=canonical(pin['location']): fail('Manifest URL differs from the locked URL for '+key)
 if not str(location).startswith('https://'): fail('A locked package needs an HTTPS source URL: '+key)
 destination=cache/'sources'/key/pin['revision']; destination.parent.mkdir(parents=True,exist_ok=True)
 if not (destination/'.git').is_dir():
  temporary=pathlib.Path(tempfile.mkdtemp(prefix='fetch-',dir=destination.parent))
  try:
   run(['git','init','--quiet',str(temporary)])
   run(['git','-C',str(temporary),'remote','add','origin',location])
   run(['git','-C',str(temporary),'fetch','--quiet','--depth','1','origin',pin['revision']])
   run(['git','-C',str(temporary),'checkout','--quiet','--detach','FETCH_HEAD'])
   if run(['git','-C',str(temporary),'rev-parse','HEAD']).strip()!=pin['revision']: fail('Git checkout does not match Package.resolved: '+key)
   try: temporary.rename(destination)
   except FileExistsError: pass
  finally:
   if temporary.exists(): shutil.rmtree(temporary)
 if run(['git','-C',str(destination),'rev-parse','HEAD']).strip()!=pin['revision']: fail('Cached revision changed: '+key)
 if subprocess.run(['git','-C',str(destination),'diff','--quiet','HEAD','--']).returncode: fail('Cached package sources were modified: '+key)
 return destination,key
def dependency_reference(dependency,root):
 if 'fileSystem' in dependency:
  value=dependency['fileSystem'][0]
  return {'path':str((root/value['path']).resolve()),'alias':value.get('nameForTargetDependencyResolutionOnly') or value.get('identity')}
 if 'sourceControl' in dependency:
  value=dependency['sourceControl'][0]; location=value.get('location',{})
  if isinstance(location,str): url=location
  elif location.get('remote'): url=location['remote'][0]['urlString']
  elif location.get('local'): fail('Local source-control dependency '+str(location['local'][0])+' requires a locked Git checkout; use a filesystem package path or an HTTPS locked source')
  else: fail('Unsupported source-control location in '+str(root))
  return {'location':url,'alias':value.get('nameForTargetDependencyResolutionOnly') or value.get('identity')}
 # Older tools-version encodings use the same information directly.
 if dependency.get('url'): return {'location':dependency['url'],'alias':dependency.get('name')}
 if dependency.get('path'): return {'path':str((root/dependency['path']).resolve()),'alias':dependency.get('name')}
 fail('Unsupported Swift package dependency encoding in '+str(root))
def register(reference,parent=None):
 if reference.get('path'):
  root=pathlib.Path(reference['path']); root=(parent/root if parent and not root.is_absolute() else root).resolve()
  key='local:'+str(root)
 else: root,key=checkout(reference['location'])
 if str(root) in paths: return paths[str(root)]
 if not (root/'Package.swift').is_file(): fail('Package.swift is missing: '+str(root))
 print('Evaluating Swift package '+root.name,file=sys.stderr,flush=True)
 scratch=cache/'manifests'/hashlib.sha256(str(root).encode()).hexdigest()[:20]
 try: manifest=json.loads(run([swift,'package','--package-path',str(root),'--scratch-path',str(scratch),'dump-package'],env={**os.environ,'GIT_CEILING_DIRECTORIES':str(root.parent)}))
 except json.JSONDecodeError: fail('Swift did not return manifest JSON for '+str(root))
 package={'key':key,'root':root,'manifest':manifest,'dependencies':[]}
 packages[key]=package; paths[str(root)]=key
 aliases.setdefault(identity(manifest['name']),set()).add(key); aliases.setdefault(identity(root.name),set()).add(key)
 for dependency in manifest.get('dependencies',[]):
  ref=dependency_reference(dependency,root)
  package['dependencies'].append({'reference':ref,'alias':identity(ref.get('alias') or ref.get('location') or pathlib.Path(ref['path']).name)})
 return key
root_packages=[]
for reference in graph.get('swiftPackages',[]): root_packages.append(register(reference))
def active(condition):
 if not condition: return True
 platforms=condition.get('platformNames') or condition.get('platforms') or []
 if platforms and not any(str(p).lower() in ['ios','iphoneos'] for p in platforms): return False
 mode=condition.get('config') or condition.get('configuration')
 if isinstance(mode,dict): mode=mode.get('name') or mode.get('_0')
 if mode and str(mode).lower()!=('release' if configuration.lower()=='release' else 'debug'): return False
 return True
def product(package,name):
 matches=[p for p in package['manifest'].get('products',[]) if p['name']==name]
 if len(matches)!=1: fail('Product '+name+' is missing or ambiguous in '+package['manifest']['name'])
 return matches[0]
def dependency_package(package,name):
 key=identity(name)
 matches=[d for d in package['dependencies'] if d['alias']==key]
 if len(matches)!=1: fail('Dependency package '+name+' is missing or ambiguous in '+package['manifest']['name'])
 dependency=matches[0]
 if 'key' not in dependency: dependency['key']=register(dependency['reference'],package['root'])
 return packages[dependency['key']]
def inferred_product(package,name):
 direct=[d for d in package['dependencies'] if d['alias']==identity(name)]
 candidates=direct or package['dependencies']; matches=[]
 for dependency in candidates:
  if 'key' not in dependency: dependency['key']=register(dependency['reference'],package['root'])
  child=packages[dependency['key']]
  if any(p['name']==name for p in child['manifest'].get('products',[])): matches.append(child)
 if len(matches)!=1: fail('Missing or ambiguous product '+name+' in '+package['manifest']['name'])
 return matches[0]
def product_targets(package,name): return [build_target(package,target) for target in product(package,name).get('targets',[])]
def unpack_binary(target,package):
 if target.get('path'):
  value=(package['root']/target['path']).resolve(strict=True)
  if value.suffix!='.xcframework': fail('Binary target '+target['name']+' is not an XCFramework')
  return str(value)
 url=target.get('url',''); checksum=target.get('checksum','').lower()
 if not url.startswith('https://') or not re.fullmatch(r'[0-9a-f]{64}',checksum): fail('Binary target '+target['name']+' needs an HTTPS URL and SHA-256 checksum')
 destination=cache/'artifacts'/checksum; archive=cache/'archives'/(checksum+'.zip'); archive.parent.mkdir(parents=True,exist_ok=True)
 if not archive.is_file() or hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()!=checksum:
  temporary=archive.with_suffix('.download')
  try:
   print('Downloading verified binary '+target['name'],file=sys.stderr,flush=True)
   try:
    with urllib.request.urlopen(url,timeout=120) as response,temporary.open('wb') as handle: shutil.copyfileobj(response,handle)
   except urllib.error.URLError as error: fail('Cannot download locked binary '+target['name']+' from '+url+': '+str(error)+'. Supply the original SHA-256 '+checksum+' archive at '+str(archive)+'; the locked package will not be upgraded or substituted')
   with temporary.open('rb') as handle:
    if hashlib.file_digest(handle,'sha256').hexdigest()!=checksum: fail('Binary checksum mismatch: '+target['name'])
   temporary.replace(archive)
  finally: temporary.unlink(missing_ok=True)
 if not (destination/'.capmac-extracted').is_file():
  staging=pathlib.Path(tempfile.mkdtemp(prefix='extract-',dir=cache))
  try:
   with zipfile.ZipFile(archive) as zipped:
    links=[]
    for item in zipped.infolist():
     relative=pathlib.PurePosixPath(item.filename)
     if relative.is_absolute() or '..' in relative.parts: fail('Unsafe binary archive path: '+target['name'])
     output_file=staging/pathlib.Path(*relative.parts)
     if stat.S_ISLNK(item.external_attr>>16): links.append((output_file,zipped.read(item).decode())); continue
     if item.is_dir(): output_file.mkdir(parents=True,exist_ok=True); continue
     output_file.parent.mkdir(parents=True,exist_ok=True)
     with zipped.open(item) as source,output_file.open('wb') as handle: shutil.copyfileobj(source,handle)
     if item.external_attr>>16: output_file.chmod((item.external_attr>>16)&0o777)
    for filename,value in links:
     if not (filename.parent/value).resolve().is_relative_to(staging.resolve()): fail('Unsafe binary archive symlink: '+target['name'])
     filename.parent.mkdir(parents=True,exist_ok=True); filename.symlink_to(value)
   (staging/'.capmac-extracted').write_text(checksum)
   destination.parent.mkdir(parents=True,exist_ok=True)
   try: staging.rename(destination)
   except FileExistsError: pass
  finally:
   if staging.exists(): shutil.rmtree(staging)
 matches=[p for p in destination.rglob('*.xcframework') if p.name==target['name']+'.xcframework']
 if len(matches)!=1: fail('Archive must contain exactly one '+target['name']+'.xcframework')
 return str(matches[0])
def setting_value(value):
 if isinstance(value,dict):
  if '_0' in value: return value['_0']
  if 'value' in value: return value['value']
  return next(iter(value.values())) if value else None
 return value
def select_binary(framework):
 root=pathlib.Path(framework)
 with (root/'Info.plist').open('rb') as handle: info=plistlib.load(handle)
 matches=[item for item in info.get('AvailableLibraries',[]) if item.get('SupportedPlatform')=='ios' and not item.get('SupportedPlatformVariant') and 'arm64' in item.get('SupportedArchitectures',[])]
 if len(matches)!=1: fail('Binary target needs exactly one physical iOS arm64 slice: '+root.name)
 item=matches[0]; library=(root/item['LibraryIdentifier']/item['LibraryPath']).resolve(strict=True)
 if not library.is_relative_to(root.resolve()): fail('Binary library path escapes its XCFramework')
 return str(library)
def apply_settings(target,settings,root,configuration):
 for entry in target.get('settings',[]):
  if not active(entry.get('condition')): continue
  tool=entry.get('tool'); kind=entry.get('kind',{})
  if not kind: continue
  name,value=next(iter(kind.items())); value=setting_value(value)
  if name=='define':
   key='SWIFT_ACTIVE_COMPILATION_CONDITIONS' if tool=='swift' else 'GCC_PREPROCESSOR_DEFINITIONS'
   settings.setdefault(key,[]).append(str(value))
  elif name=='headerSearchPath': settings.setdefault('HEADER_SEARCH_PATHS',[]).append(str((root/str(value)).resolve()))
  elif name=='linkedFramework': settings.setdefault('OTHER_LDFLAGS',[]).extend(['-framework',str(value)])
  elif name=='linkedLibrary': settings.setdefault('OTHER_LDFLAGS',[]).append('-l'+str(value))
  elif name=='unsafeFlags':
   key={'swift':'OTHER_SWIFT_FLAGS','c':'OTHER_CFLAGS','cxx':'OTHER_CPLUSPLUSFLAGS','linker':'OTHER_LDFLAGS'}.get(tool)
   if not key: fail('Unknown Swift package build tool '+str(tool))
   settings.setdefault(key,[]).extend(value if isinstance(value,list) else [value])
  elif name in ['enableUpcomingFeature','enableExperimentalFeature']:
   settings.setdefault('OTHER_SWIFT_FLAGS',[]).extend(['-enable-upcoming-feature' if name=='enableUpcomingFeature' else '-enable-experimental-feature',str(value)])
  elif name in ['swiftLanguageMode','swiftLanguageVersion']: settings['SWIFT_VERSION']=str(value)
  elif name=='interoperabilityMode': settings.setdefault('OTHER_SWIFT_FLAGS',[]).append('-cxx-interoperability-mode='+('default' if str(value).lower()=='cxx' else str(value)))
  else: fail('Build setting '+name+' needs an implementation for '+target['name'])
def base_target(package,target,kind='staticLibrary'):
 name=target['name']; module=module_name(name); key=package['key']+'::'+name
 minimum=next((str(platform['version']) for platform in package['manifest'].get('platforms',[]) if platform.get('platformName')=='ios'),'15.0')
 return {'id':key,'name':name,'productType':kind,'productName':('lib'+module+'.a') if kind=='staticLibrary' else name,
  'moduleName':module,'dependencies':[],'sourceFiles':[],'publicHeaders':[],'privateHeaders':[],'resources':[],'frameworks':[],'scripts':[],
  'settings':{'SRCROOT':str(package['root']),'PROJECT_DIR':str(package['root']),'PRODUCT_MODULE_NAME':module,'PRODUCT_NAME':module,
   'DEVELOPMENT_LANGUAGE':package['manifest'].get('defaultLocalization') or 'en','IPHONEOS_DEPLOYMENT_TARGET':minimum,
   'SWIFT_ACTIVE_COMPILATION_CONDITIONS':['SWIFT_PACKAGE']+(['DEBUG'] if configuration.lower()!='release' else []),
   'GCC_PREPROCESSOR_DEFINITIONS':['SWIFT_PACKAGE=1']+(['DEBUG=1'] if configuration.lower()!='release' else []),
   'OTHER_SWIFT_FLAGS':['-package-name',module_name(package['key'] if not package['key'].startswith('local:') else package['manifest']['name'])],
   'SWIFT_VERSION':str((package['manifest'].get('swiftLanguageVersions') or ['6' if str(package['manifest'].get('toolsVersion',{}).get('_version','5')).startswith('6') else '5'])[-1])}}
def target_root(package,target):
 if target.get('path'): return (package['root']/target['path']).resolve(strict=True)
 for candidate in ['Sources/'+target['name'],'Source/'+target['name'],'src/'+target['name'],target['name']]:
  directory=package['root']/candidate
  if directory.is_dir(): return directory.resolve()
 regular=[t for t in package['manifest'].get('targets',[]) if t.get('type') in ['regular','executable']]
 if len(regular)==1 and (package['root']/'Sources').is_dir(): return (package['root']/'Sources').resolve()
 fail('Cannot locate source directory for '+package['manifest']['name']+'/'+target['name'])
def build_target(package,name):
 key=package['key']+'::'+name
 if key in target_cache: return target_cache[key]
 candidates=[target for target in package['manifest'].get('targets',[]) if target['name']==name]
 if len(candidates)!=1: fail('Target '+name+' is missing in '+package['manifest']['name'])
 target=candidates[0]; kind=target.get('type','regular')
 if kind in ['plugin','macro']: fail('Host build-tool target '+name+' needs host compilation before the iOS target graph')
 if target.get('pluginUsages') or target.get('plugins'): fail('Build-tool plugins for '+name+' must run before native source discovery')
 native=base_target(package,target,'aggregate' if kind in ['binary','system'] else 'staticLibrary'); target_cache[key]=native; native_targets.append(native)
 if kind=='binary': native['frameworks']=[{'path':select_binary(unpack_binary(target,package)),'embed':True}]; return native
 root=target_root(package,target); native['settings']['SRCROOT']=str(root)
 for dependency in target.get('dependencies',[]):
  dep_kind,parts=next(iter(dependency.items()))
  if not isinstance(parts,list): parts=[parts]
  condition=parts[-1] if parts and isinstance(parts[-1],dict) and ('platformNames' in parts[-1] or 'configuration' in parts[-1] or 'config' in parts[-1]) else None
  if not active(condition): continue
  if dep_kind=='product':
   if len(parts)>2 and parts[2]: fail('Swift module aliases for '+parts[0]+' require module renaming before compilation')
   child=dependency_package(package,parts[1]) if len(parts)>1 and parts[1] else None
   if child is None:
    child=inferred_product(package,parts[0])
   native['dependencies'].extend(item['id'] for item in product_targets(child,parts[0]))
  elif dep_kind in ['target','byName']:
   if any(t['name']==parts[0] for t in package['manifest'].get('targets',[])): native['dependencies'].append(build_target(package,parts[0])['id'])
   else:
    child=inferred_product(package,parts[0])
    native['dependencies'].extend(item['id'] for item in product_targets(child,parts[0]))
  else: fail('Unsupported dependency '+dep_kind+' in '+name)
 excludes=[(root/value).resolve() for value in target.get('exclude',[])]
 def excluded(file): return any(file==value or value in file.parents for value in excludes)
 resources=[]; resource_roots=[]
 for resource in target.get('resources',[]):
  file=(root/resource['path']).resolve(strict=True); resource_roots.append(file); rule=resource.get('rule',{})
  copy_rule=rule=='copy' or isinstance(rule,dict) and 'copy' in rule
  if file.is_dir() and not copy_rule and file.suffix not in ['.xcassets','.xcdatamodeld','.xcdatamodel']:
   def process_resource(item):
    if excluded(item): return
    if item.is_dir() and item.suffix not in ['.xcassets','.xcdatamodeld','.xcdatamodel']:
     for child in sorted(item.iterdir()): process_resource(child)
    else: resources.append({'source':str(item)})
   process_resource(file)
  else: resources.append({'source':str(file),'destination':file.name} if copy_rule else {'source':str(file)})
 supplied=target.get('sources'); roots=[root/value for value in supplied] if supplied is not None else [root]
 files=[]
 for source in roots:
  files.extend(source.rglob('*') if source.is_dir() else [source])
 files=sorted(set(file.resolve() for file in files if file.is_file() and not excluded(file) and not any(file==resource or resource in file.parents for resource in resource_roots)))
 native['sourceFiles']=[{'path':str(file)} for file in files if file.suffix.lower() in ['.swift','.m','.mm','.c','.cc','.cpp','.cxx','.s']]
 # publicHeadersPath "" (AppAuthCore) means the target folder itself; only a missing value means include/.
 public_path=target.get('publicHeadersPath'); include=(root/(public_path if public_path is not None else 'include')).resolve()
 headers=[file for file in files if file.suffix.lower() in ['.h','.hh','.hpp','.hxx']]
 native['publicHeaders']=[str(file) for file in headers if include==file.parent or include in file.parents]
 native['privateHeaders']=[str(file) for file in headers if str(file) not in native['publicHeaders']]
 native['settings']['HEADER_SEARCH_PATHS']=[str(root),str(include)]
 # SwiftPM keeps public headers in place and points its module map at them.
 if native['publicHeaders']: native['settings']['CAPMAC_PACKAGE_INCLUDE']=str(include)
 for modulemap in [include/'module.modulemap',root/'module.modulemap']:
  if modulemap.is_file(): native['settings']['MODULEMAP_FILE']=str(modulemap); break
 if package['manifest'].get('cLanguageStandard'): native['settings']['GCC_C_LANGUAGE_STANDARD']=package['manifest']['cLanguageStandard']
 if package['manifest'].get('cxxLanguageStandard'): native['settings']['CLANG_CXX_LANGUAGE_STANDARD']=package['manifest']['cxxLanguageStandard']
 apply_settings(target,native['settings'],root,configuration)
 if resources:
  bundle_name=module_name(package['manifest']['name']+'_'+name); bundle=base_target(package,{'name':name+'Resources'},'bundle')
  bundle['id']=key+'::resources'; bundle['productName']=bundle_name+'.bundle'; bundle['resources']=resources
  bundle['settings']['PRODUCT_BUNDLE_IDENTIFIER']='dev.capmac.resources.'+bundle_name.replace('_','-'); bundle['settings']['GENERATE_INFOPLIST_FILE']='YES'
  native_targets.append(bundle); native['dependencies'].append(bundle['id'])
  generated=pathlib.Path(r['generated'])/hashlib.sha256(key.encode()).hexdigest()[:16]; generated.mkdir(parents=True,exist_ok=True)
  if any(source['path'].endswith('.swift') for source in native['sourceFiles']):
   accessor=generated/'resource_bundle_accessor.swift'
   accessor.write_text('import Foundation\nprivate class CapMacBundleFinder {}\nextension Foundation.Bundle {\n static let module: Bundle = {\n let name = '+json.dumps(bundle_name+'.bundle')+'\n let candidates = [Bundle.main.resourceURL, Bundle(for: CapMacBundleFinder.self).resourceURL, Bundle.main.bundleURL]\n for candidate in candidates { if let url = candidate?.appendingPathComponent(name), let bundle = Bundle(url: url) { return bundle } }\n fatalError("Missing Swift package resource bundle: " + name)\n }()\n}\n')
   native['sourceFiles'].append({'path':str(accessor)})
  else:
   function=module_name(name)+'_SWIFTPM_MODULE_BUNDLE'; header=generated/'resource_bundle_accessor.h'; accessor=generated/'resource_bundle_accessor.m'
   header.write_text('#ifdef __OBJC__\n#import <Foundation/Foundation.h>\nNSBundle *'+function+'(void);\n#define SWIFTPM_MODULE_BUNDLE '+function+'()\n#endif\n')
   accessor.write_text('#import "resource_bundle_accessor.h"\nNSBundle *'+function+'(void) { NSString *name = @'+json.dumps(bundle_name)+'; NSURL *url = [[NSBundle mainBundle] URLForResource:name withExtension:@"bundle"]; NSBundle *bundle = url ? [NSBundle bundleWithURL:url] : nil; if (!bundle) { @throw [NSException exceptionWithName:@"MissingSwiftPackageBundle" reason:name userInfo:nil]; } return bundle; }\n')
   native['sourceFiles'].append({'path':str(accessor)}); native['settings']['GCC_PREFIX_HEADER']=str(header)
 if not native['sourceFiles'] and kind!='system': native['productType']='aggregate'
 return native
for native in graph['targets']:
 for reference in native.get('packageProducts',[]):
  if reference.get('path'): package=packages[paths[str(pathlib.Path(reference['path']).resolve())]]
  elif reference.get('location'): package=packages[identity(reference['location'])]
  else:
   candidates=[package for package in packages.values() if any(product['name']==reference['name'] for product in package['manifest'].get('products',[]))]
   if len(candidates)!=1: fail('Xcode product '+reference['name']+' is missing or ambiguous')
   package=candidates[0]
  native['dependencies'].extend(target['id'] for target in product_targets(package,reference['name']))
graph['targets'].extend(native_targets); by_id={target['id']:target for target in graph['targets']}
def closure(target,visited=None):
 visited=set() if visited is None else visited
 for key in target['dependencies']:
  if key in visited: continue
  visited.add(key); closure(by_id[key],visited)
 return visited
for target in graph['targets']:
 dependencies=[by_id[key] for key in closure(target)]
 for dependency in dependencies:
  if dependency['productType']=='aggregate':
   for framework in dependency.get('frameworks',[]):
    if framework.get('path','').endswith('.framework'):
     value=target['settings'].setdefault('FRAMEWORK_SEARCH_PATHS',[])
     if isinstance(value,str): value=__import__('shlex').split(value); target['settings']['FRAMEWORK_SEARCH_PATHS']=value
     value.append(str(pathlib.Path(framework['path']).parent))
 # Static SwiftPM targets are linked as a product closure, preserving the
 # product's transitive native symbols and its binary framework dependencies.
 if target['productType'] in ['application','appExtension','framework']:
  for dependency in dependencies:
   if dependency['productType']=='staticLibrary': target['frameworks'].append({'path':'$(BUILT_PRODUCTS_DIR)/'+dependency['productName'],'embed':False})
   elif dependency['productType']=='aggregate': target['frameworks'].extend(dependency.get('frameworks',[]))
  for dependency in dependencies:
   flags=dependency['settings'].get('OTHER_LDFLAGS',[])
   if isinstance(flags,str): flags=__import__('shlex').split(flags)
   existing=target['settings'].setdefault('OTHER_LDFLAGS',[])
   if isinstance(existing,str): existing=__import__('shlex').split(existing); target['settings']['OTHER_LDFLAGS']=existing
   existing.extend(flags)
 # Public header roots remain available while C modules import their own
 # directory structure and nested includes.
 for dependency in dependencies:
  if dependency['id'] in target_cache:
   target['settings'].setdefault('HEADER_SEARCH_PATHS',[])
   current=target['settings']['HEADER_SEARCH_PATHS']
   if isinstance(current,str): current=__import__('shlex').split(current); target['settings']['HEADER_SEARCH_PATHS']=current
   current.extend(dependency['settings'].get('HEADER_SEARCH_PATHS',[]))
 target['dependencies']=list(dict.fromkeys(target['dependencies']))
output.parent.mkdir(parents=True,exist_ok=True); output.write_text(json.dumps(graph,indent=2)+'\n')
print('Imported '+str(len(packages))+' locked Swift packages and '+str(len(native_targets))+' native targets',file=sys.stderr)
`;

export async function importSwiftPackages(graph: WslXcodeGraph, executor: WslExecutor,
  options: { outputPath: string; generatedDirectory: string; tools: WslToolchainTools }, ctx: EngineContext, signal: AbortSignal): Promise<WslNativeGraph> {
  const swiftPath = options.tools.swiftcPath.replace(/swiftc$/, 'swift');
  if (swiftPath === options.tools.swiftcPath) throw new UserError('The Swift package importer needs the swift executable alongside swiftc.');
  const [output, generated] = await Promise.all([executor.path(options.outputPath, signal), executor.path(options.generatedDirectory, signal)]);
  await executor.run(['python3', '-c', SWIFT_PACKAGE_IMPORT], { signal, timeoutMs: 60 * 60_000,
    stdin: JSON.stringify({ graph, output, generated, swiftPath, sdkPath: options.tools.sdkPath }),
    onOutput: (text, stream) => ctx.emit({ type: 'tool-output', text, stream }) });
  return JSON.parse(await fs.readFile(options.outputPath, 'utf8')) as WslNativeGraph;
}
