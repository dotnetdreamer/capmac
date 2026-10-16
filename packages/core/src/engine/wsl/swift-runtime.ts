/** Embed only Swift runtime dylibs actually referenced by the built iOS Mach-O products. */
import type { WslExecutor, WslRunOptions, WslToolchainTools } from './toolchain.js';

export const EMBED_SWIFT_RUNTIMES = String.raw`import pathlib,plistlib,struct,sys
app=pathlib.Path(sys.argv[1]).resolve(); executable=app/sys.argv[2]
resources=pathlib.Path(sys.argv[3]) if sys.argv[3] else None
frameworks=app/'Frameworks'

def arm64(data,label):
 if data[:4] in [b'\xca\xfe\xba\xbe',b'\xca\xfe\xba\xbf',b'\xbe\xba\xfe\xca',b'\xbf\xba\xfe\xca']:
  endian='>' if data[:4] in [b'\xca\xfe\xba\xbe',b'\xca\xfe\xba\xbf'] else '<'
  wide=data[:4] in [b'\xca\xfe\xba\xbf',b'\xbf\xba\xfe\xca']
  if len(data)<8: raise SystemExit('Truncated universal Swift runtime: '+str(label))
  count=struct.unpack(endian+'I',data[4:8])[0]; size=32 if wide else 20; chosen=None
  if count>128 or 8+count*size>len(data): raise SystemExit('Invalid universal Mach-O: '+str(label))
  for index in range(count):
   offset=8+index*size; cpu,subtype=struct.unpack(endian+'II',data[offset:offset+8])
   start,length=struct.unpack(endian+('QQ' if wide else 'II'),data[offset+8:offset+(24 if wide else 16)])
   if start+length>len(data): raise SystemExit('Invalid universal Mach-O slice: '+str(label))
   if cpu==0x100000c and subtype&0xffffff==0: chosen=data[start:start+length]
  if chosen is None: raise SystemExit('No regular arm64 iOS slice in Swift runtime: '+str(label))
  data=chosen
 if len(data)<32 or data[:4]!=b'\xcf\xfa\xed\xfe' or struct.unpack('<I',data[4:8])[0]!=0x100000c:
  raise SystemExit('Expected arm64 Mach-O product: '+str(label))
 return data

def dependencies(binary):
 data=arm64(binary.read_bytes(),binary); count=struct.unpack('<I',data[16:20])[0]; offset=32; result=[]
 for _ in range(count):
  if offset+8>len(data): raise SystemExit('Truncated Mach-O load commands: '+str(binary))
  command,size=struct.unpack('<II',data[offset:offset+8])
  if size<8 or offset+size>len(data): raise SystemExit('Invalid Mach-O load command: '+str(binary))
  if command in [0xc,0x80000018,0x8000001f,0x20,0x80000023]:
   if size<24: raise SystemExit('Truncated Mach-O dylib command: '+str(binary))
   start=struct.unpack('<I',data[offset+8:offset+12])[0]
   if start<24 or start>=size: raise SystemExit('Invalid Mach-O dylib name: '+str(binary))
   raw=data[offset+start:offset+size].split(b'\0',1)[0]
   name=raw.decode('utf-8')
   if name.startswith('@rpath/libswift') and name.endswith('.dylib'):
    leaf=name[len('@rpath/'):]
    if pathlib.PurePosixPath(leaf).name!=leaf: raise SystemExit('Unsafe Swift runtime dependency: '+name)
    result.append((leaf,command==0x80000018))
  offset+=size
 return result

queue=[executable]
code_directories=[frameworks]
for extension in app.glob('PlugIns/*.appex'):
 with (extension/'Info.plist').open('rb') as f: info=plistlib.load(f)
 name=info.get('CFBundleExecutable',extension.stem)
 if not isinstance(name,str) or pathlib.PurePosixPath(name).name!=name: raise SystemExit('Invalid extension executable name: '+str(extension))
 queue.append(extension/name)
 code_directories.append(extension/'Frameworks')
for code_directory in code_directories:
 queue.extend(code_directory.rglob('*.dylib'))
 for framework in code_directory.rglob('*.framework'):
  info=framework/'Info.plist'; name=framework.stem
  if info.is_file():
   with info.open('rb') as f: name=plistlib.load(f).get('CFBundleExecutable',name)
  if not isinstance(name,str) or pathlib.PurePosixPath(name).name!=name: raise SystemExit('Invalid framework executable name: '+str(framework))
  binary=framework/name
  if binary.is_file(): queue.append(binary)
seen=set(); embedded=[]
while queue:
 binary=queue.pop(0)
 identity=binary.resolve()
 if identity in seen: continue
 seen.add(identity)
 for name,weak in dependencies(binary):
  destination=frameworks/name
  if destination.exists(): queue.append(destination); continue
  source=resources/'iphoneos'/name if resources else None
  if source is None or not source.is_file():
   if weak: continue
   raise SystemExit('Missing required Swift runtime '+name+' referenced by '+str(binary)+'. Supply matching extracted Darwin Swift iphoneos resources.')
  payload=arm64(source.read_bytes(),source)
  if struct.unpack('<I',payload[12:16])[0]!=6: raise SystemExit('Swift runtime must be a dynamic library: '+str(source))
  frameworks.mkdir(parents=True,exist_ok=True)
  if destination.is_symlink() or not destination.resolve().is_relative_to(app): raise SystemExit('Swift runtime destination escapes application bundle')
  destination.write_bytes(payload); destination.chmod(0o755); embedded.append(name); queue.append(destination)
for name in embedded: print('Embedded Swift runtime '+name)
`;

/** zsign's recursive final signing runs after this step, including copied runtimes. */
export async function embedWslSwiftRuntimes(executor: WslExecutor, tools: WslToolchainTools, appDirectory: string, executableName: string, hooks: Pick<WslRunOptions, 'signal' | 'onOutput'> = {}): Promise<void> {
  await executor.run(['python3', '-c', EMBED_SWIFT_RUNTIMES, appDirectory, executableName, tools.swiftResourcePath ?? ''], { ...hooks, timeoutMs: 120_000 });
}
