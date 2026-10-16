/** Bump when the import's output changes: setup then extracts the SDK again. */
export const SDK_IMPORT_VERSION = 3;

/**
 * Independent Python standard-library implementation of the documented archive formats.
 * Format references (no source copied): Apple's BSD-licensed xar, and saagarjha/unxip.
 * https://github.com/apple-oss-distributions/xar
 * https://github.com/saagarjha/unxip/blob/main/unxip.swift
 */
export const IMPORT_XCODE_SDK = String.raw`import bisect,collections,fcntl,hashlib,json,lzma,os,pathlib,plistlib,re,shutil,stat,struct,sys,tempfile,time,xml.etree.ElementTree as ET,zlib
VERSION=${SDK_IMPORT_VERSION}
MAX_TOC=32*1024*1024
MAX_CHUNK=64*1024*1024
MAX_TOTAL=1024*1024*1024*1024
BLOCK=1024*1024
def fail(message): raise ValueError(message)
def exact(handle,count):
 data=handle.read(count)
 if len(data)!=count: fail('Truncated Xcode archive')
 return data
def number(node,path):
 text=node.findtext(path)
 if text is None or not re.fullmatch(r'[0-9]+',text.strip()): fail('Invalid XAR '+path)
 return int(text)
def digest_spec(node):
 if node is None: return None
 style=node.get('style','').lower().replace('-','')
 if style not in ('sha1','sha256','sha512'): fail('Unsupported XAR checksum '+style)
 text=(node.text or '').strip().lower()
 if not re.fullmatch('[0-9a-f]{'+str(hashlib.new(style).digest_size*2)+'}',text): fail('Invalid XAR checksum value')
 return style,text
def open_xar(handle):
 size=os.fstat(handle.fileno()).st_size
 magic,header_size,version,compressed_size,plain_size,algorithm=struct.unpack('>4sHHQQI',exact(handle,28))
 if magic!=b'xar!' or version!=1 or not 28<=header_size<=4096: fail('Not a supported Xcode XIP/XAR archive')
 if not 0<compressed_size<=MAX_TOC or not 0<plain_size<=MAX_TOC or header_size+compressed_size>size: fail('Invalid XAR table size')
 handle.seek(header_size); compressed=exact(handle,compressed_size)
 decoder=zlib.decompressobj(); plain=decoder.decompress(compressed,plain_size+1)
 if len(plain)!=plain_size or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail: fail('Corrupt XAR table of contents')
 if b'<!DOCTYPE' in plain.upper() or b'<!ENTITY' in plain.upper(): fail('XAR table contains an unsupported XML declaration')
 document=ET.fromstring(plain)
 if document.tag!='xar' or document.find('toc') is None: fail('Invalid XAR XML table')
 toc=document.find('toc'); heap=header_size+compressed_size
 checksum=toc.find('checksum'); algorithms={1:'sha1',3:'sha256',4:'sha512'}
 if algorithm not in algorithms or checksum is None or checksum.get('style','').lower().replace('-','')!=algorithms[algorithm]: fail('Missing or inconsistent XAR table checksum')
 checksum_offset=number(checksum,'offset'); checksum_size=number(checksum,'size'); toc_hash=hashlib.new(algorithms[algorithm],compressed).digest()
 if checksum_size!=len(toc_hash) or heap+checksum_offset+checksum_size>size: fail('Invalid XAR table checksum bounds')
 handle.seek(heap+checksum_offset)
 if exact(handle,checksum_size)!=toc_hash: fail('XAR table checksum mismatch')
 matches=[node for node in toc.findall('file') if node.findtext('name')=='Content']
 if len(matches)!=1: fail('XIP must contain exactly one Content stream')
 data=matches[0].find('data')
 if data is None: fail('XIP has no Content data')
 offset=number(data,'offset'); length=number(data,'length'); unpacked=number(data,'size')
 encoding=data.find('encoding')
 if encoding is not None and encoding.get('style')!='application/octet-stream': fail('Unsupported outer XIP Content compression')
 if length<=12 or length!=unpacked or offset<0 or heap+offset+length>size: fail('Invalid XIP Content bounds')
 specs=[digest_spec(data.find(name)) for name in ('archived-checksum','extracted-checksum')]
 if not any(specs): fail('XIP Content has no integrity checksum')
 return {'offset':heap+offset,'length':length,'checksums':[item for item in specs if item], 'toc':hashlib.sha256(compressed).hexdigest(),'size':size}
class Pbzx:
 def __init__(self,handle,content):
  self.handle=handle; self.end=content['offset']+content['length']; self.hashes={name:hashlib.new(name) for name,_ in content['checksums']}; self.expected=content['checksums']; self.index=[]; self.buffer=b''; self.at=0; self.position=0; self.total=0; self.finished=False; self.last_report=0; self.last_percent=-1; self.start=content['offset']
  handle.seek(content['offset'])
  if self.take(4)!=b'pbzx': fail('Unsupported XIP Content: PBZX magic missing')
  self.chunk_size=struct.unpack('>Q',self.take(8))[0]
  if not 1<=self.chunk_size<=MAX_CHUNK: fail('Unsafe PBZX chunk size')
 def take(self,count):
  if count<0 or self.handle.tell()+count>self.end: fail('PBZX chunk exceeds its XAR stream')
  data=exact(self.handle,count)
  for value in self.hashes.values(): value.update(data)
  return data
 @staticmethod
 def decode(payload,decoded,chunk_size):
  if len(payload)==chunk_size or (len(payload)==decoded and not payload.startswith(b'\xfd7zXZ\x00')): output=payload
  else:
   decoder=lzma.LZMADecompressor(format=lzma.FORMAT_XZ,memlimit=256*1024*1024)
   output=decoder.decompress(payload,max_length=decoded+1)
   if not decoder.eof or decoder.unused_data: fail('Corrupt PBZX XZ chunk')
  if len(output)!=decoded: fail('PBZX decoded chunk size mismatch')
  return output
 def advance(self):
  if self.finished: return False
  decoded,stored=struct.unpack('>QQ',self.take(16))
  if not 0<=decoded<=self.chunk_size or not 0<=stored<=MAX_CHUNK+1024*1024 or (decoded and not stored): fail('Unsafe PBZX chunk lengths')
  offset=self.handle.tell(); payload=self.take(stored); output=self.decode(payload,decoded,self.chunk_size)
  self.index.append((self.total,offset,decoded,stored)); self.total+=decoded
  if self.total>MAX_TOTAL: fail('Xcode decompressed size exceeds the safety limit')
  self.buffer=output; self.at=0
  if decoded<self.chunk_size:
   self.finished=True
   if self.handle.tell()!=self.end: fail('Unexpected data after the final PBZX chunk')
   self.verify()
  # Each new percent, at most once a second: CapMac shows it as the step's progress bar.
  percent=(self.handle.tell()-self.start)*100//max(1,self.end-self.start)
  if percent!=self.last_percent and (self.finished or time.monotonic()-self.last_report>=1):
   print('Reading Xcode archive: '+str(percent)+'%',file=sys.stderr,flush=True); self.last_report=time.monotonic(); self.last_percent=percent
  return True
 def verify(self):
  for name,expected in self.expected:
   if self.hashes[name].hexdigest()!=expected: fail('XIP Content checksum mismatch')
 def read(self,count):
  parts=[]; remaining=count
  while remaining:
   if self.at==len(self.buffer) and not self.advance(): fail('Truncated CPIO stream')
   part=self.buffer[self.at:self.at+remaining]; self.at+=len(part); self.position+=len(part); remaining-=len(part); parts.append(part)
  return b''.join(parts)
 def consume(self,count,output=None,crc=False):
  checksum=0
  while count:
   data=self.read(min(BLOCK,count)); count-=len(data)
   if output is not None: output.write(data)
   if crc: checksum=(checksum+sum(data))&0xffffffff
  return checksum
 def finish(self):
  while True:
   if any(self.buffer[self.at:]): fail('Unexpected nonzero data after the CPIO trailer')
   self.position+=len(self.buffer)-self.at; self.at=len(self.buffer)
   if not self.advance(): break
  self.verify()
class RangeReader:
 def __init__(self,handle,stream): self.handle=handle; self.stream=stream; self.starts=[item[0] for item in stream.index]; self.cache=collections.OrderedDict()
 def copy(self,start,length,output):
  while length:
   index=bisect.bisect_right(self.starts,start)-1
   if index<0: fail('Invalid CPIO hardlink data offset')
   base,offset,decoded,stored=self.stream.index[index]
   if index not in self.cache:
    self.handle.seek(offset); self.cache[index]=Pbzx.decode(exact(self.handle,stored),decoded,self.stream.chunk_size)
    if len(self.cache)>2: self.cache.popitem(last=False)
   self.cache.move_to_end(index); data=self.cache[index]; local=start-base; count=min(length,len(data)-local)
   if count<=0: fail('Invalid CPIO hardlink data length')
   output.write(data[local:local+count]); start+=count; length-=count
class Contents:
 """A file's contents as they go by. Apple's archives keep a linked file's contents at its first
 link only; its other links hold a placeholder of the same size: "NULLcanary", then zeros."""
 MARK=b'NULLcanary'
 def __init__(self,output=None): self.output=output; self.head=b''; self.zeros=True; self.seen=0; self.crc=0
 def write(self,data):
  if self.output is not None: self.output.write(data)
  if len(self.head)<len(self.MARK): self.head+=data[:len(self.MARK)-len(self.head)]
  skip=max(0,len(self.MARK)-self.seen)
  if self.zeros and (not self.MARK.startswith(self.head) or data.count(0,skip)!=max(0,len(data)-skip)): self.zeros=False
  self.seen+=len(data); self.crc=zlib.crc32(data,self.crc)
 def placeholder(self): return self.seen>=len(self.MARK) and self.head==self.MARK and self.zeros
def archive_path(raw):
 try: name=raw.decode('utf-8')
 except UnicodeError: fail('Archive path is not UTF-8')
 if not name or any(ord(c)<32 or ord(c)==127 for c in name) or '\\' in name or name.startswith('/'): fail('Unsafe archive path')
 while name.startswith('./'): name=name[2:]
 if name=='.': return ()
 parts=tuple(name.split('/'))
 if any(part in ('','..','.') for part in parts): fail('Unsafe archive path: '+name)
 return parts
def wanted(parts):
 if not parts or not parts[0].endswith('.app'): return False
 tail='/'.join(parts[1:])
 # Swift's resources link "clang" to clang's own version folder, whose headers Swift compiles C with.
 return tail=='Contents/version.plist' or tail=='Contents/Developer/Toolchains/XcodeDefault.xctoolchain/Info.plist' or re.fullmatch(r'Contents/Developer/Platforms/iPhoneOS\.platform/Developer/SDKs/iPhoneOS[^/]*\.sdk(?:/.*)?',tail) is not None or re.fullmatch(r'Contents/Developer/Toolchains/XcodeDefault\.xctoolchain/usr/lib/clang/[^/]+(?:/include(?:/.*)?)?',tail) is not None or re.fullmatch(r'Contents/Developer/Toolchains/XcodeDefault\.xctoolchain/usr/lib/clang/[^/]+/lib/darwin/libclang_rt\.ios\.a',tail) is not None or tail=='Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift' or tail.startswith('Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/')
def safe_parent(root,parts):
 target=root
 for part in parts[:-1]:
  target=target/part
  if target.is_symlink(): fail('Archive entry would traverse a symlink: '+str(target))
  target.mkdir(exist_ok=True)
  if not target.is_dir(): fail('Archive parent is not a directory')
 return root.joinpath(*parts)
def symlink_target(parts,raw):
 """The link's target; None for a link to Xcode files this import leaves out (the link is left out too)."""
 try: target=raw.decode('utf-8')
 except UnicodeError: fail('Symlink target is not UTF-8')
 if not target or target.startswith('/') or '\\' in target or any(ord(c)<32 or ord(c)==127 for c in target): fail('Unsafe archive symlink')
 resolved=list(parts[:-1])
 for part in target.split('/'):
  if part in ('','.'): continue
  if part=='..':
   if not resolved: fail('Archive symlink escapes the extraction root')
   resolved.pop()
  else: resolved.append(part)
 if not wanted(tuple(resolved)): return None
 return target
def unpack_cpio(stream,root):
 entries=set(); directories=[]; links={}; selected_roots=set(); count=0; skipped=0
 while True:
  magic=stream.read(6); crc=False; expected_crc=0
  if magic==b'070707':
   widths=[6,6,6,6,6,6,6,11,6,11]; values=[]
   for width in widths:
    raw=stream.read(width)
    if not re.fullmatch(b'[0-7]{'+str(width).encode()+b'}',raw): fail('Invalid odc CPIO header')
    values.append(int(raw,8))
   dev,ino,mode,uid,gid,nlink,rdev,mtime,name_size,size=values; key=(dev,ino); align=1
  elif magic in (b'070701',b'070702'):
   raw=stream.read(104)
   if not re.fullmatch(b'[0-9a-fA-F]{104}',raw): fail('Invalid newc CPIO header')
   values=[int(raw[i:i+8],16) for i in range(0,104,8)]
   ino,mode,uid,gid,nlink,mtime,size,devmajor,devminor,rdevmajor,rdevminor,name_size,expected_crc=values; key=(devmajor,devminor,ino); align=4; crc=magic==b'070702'
  else: fail('Unsupported CPIO format (expected odc or newc)')
  if not 1<=name_size<=65536 or size>MAX_TOTAL: fail('Unsafe CPIO file size or name length')
  raw=stream.read(name_size)
  if raw[-1:]!=b'\x00' or b'\x00' in raw[:-1]: fail('Invalid CPIO path terminator')
  parts=archive_path(raw[:-1]); stream.read((-stream.position)%align)
  if parts==('TRAILER!!!',):
   if size: fail('Invalid CPIO trailer')
   stream.finish(); break
  count+=1
  if count>5000000: fail('Too many CPIO entries')
  selected=wanted(parts); kind=stat.S_IFMT(mode); target=None
  if selected:
   if parts in entries: fail('Duplicate selected archive path: '+'/'.join(parts))
   entries.add(parts); selected_roots.add(parts[0]); target=safe_parent(root,parts)
  if kind==stat.S_IFDIR:
   if size: fail('CPIO directory has unexpected contents')
   if selected:
    if target.is_symlink(): fail('Directory replaces an archive symlink')
    target.mkdir(exist_ok=True); directories.append((target,mode&0o777))
   checksum=0
  elif kind==stat.S_IFLNK:
   if size>65536: fail('Unsafe CPIO symlink size')
   data=stream.read(size); checksum=sum(data)&0xffffffff if crc else 0
   if selected:
    link=symlink_target(parts,data)
    if link is not None: target.symlink_to(link)
    else:
     entries.discard(parts); skipped+=1
     if skipped<=5: print('Leaving out a link to Xcode files CapMac does not import: '+'/'.join(parts[1:]),file=sys.stderr,flush=True)
  elif kind==stat.S_IFREG:
   start=stream.position; contents=Contents()
   if selected:
    with target.open('xb') as output: contents.output=output; checksum=stream.consume(size,contents,crc)
    target.chmod(mode&0o777)
   else: checksum=stream.consume(size,contents if nlink>1 else None,crc)
   if nlink>1:
    # Linked files: Apple's archives give the contents to the first link and placeholders to
    # the others; newc gives them to one link and leaves the others empty. Those are filled
    # from the contents at the end. Mode and time join the key: odc's 6-digit inode numbers
    # repeat in big archives.
    group=links.setdefault(key+(mode,mtime),{'sources':[],'full':{},'empty':[],'mode':mode&0o777})
    if size and not contents.placeholder():
     group['sources'].append((start,size,contents.crc))
     if selected: group['full'].setdefault(size,target)
    elif selected: group['empty'].append((target,size))
   elif selected and contents.placeholder(): fail('The Xcode archive has a placeholder instead of '+'/'.join(parts[1:]))
  else:
   if selected: fail('Unsupported special file inside the SDK')
   checksum=stream.consume(size,crc=crc)
  if crc and checksum!=expected_crc: fail('CPIO CRC checksum mismatch')
  stream.read((-stream.position)%align)
 # Fill linked files from their contents: a link to an imported copy, else read from the archive
 # (in archive order, so each compressed chunk is read once).
 fills=[]; joins=[]
 for group in links.values():
  first={}
  for target,size in group['empty']:
   found={(length,check):begin for begin,length,check in group['sources'] if not size or length==size}
   if len({check for _,check in found})>1: fail('Two linked files in the Xcode archive share one record: '+str(target.relative_to(root)))
   if not found:
    if size: fail('The Xcode archive is missing the contents of '+str(target.relative_to(root)))
    continue
   (length,_),begin=next(iter(found.items()))
   source=group['full'].get(length) or first.get(length)
   if source is None: first[length]=target; fills.append((begin,length,target,group['mode']))
   else: joins.append((source,target))
 ranges=RangeReader(stream.handle,stream)
 for begin,length,target,mode in sorted(fills,key=lambda fill:fill[0]):
  target.unlink()
  with target.open('xb') as output: ranges.copy(begin,length,output)
  target.chmod(mode)
 for source,target in joins:
  target.unlink(); os.link(source,target)
 for target,mode in reversed(directories): target.chmod(mode)
 if len(selected_roots)!=1: fail('Expected one Xcode application containing the SDK and Swift resources')
 return selected_roots.pop()
def inspect_resources(destination,app):
 if not isinstance(app,str) or '/' in app or '\\' in app or not app.endswith('.app') or any(ord(c)<32 or ord(c)==127 for c in app): fail('Invalid cached Xcode application name')
 base=destination/app/'Contents'; version=base/'version.plist'
 try: metadata=plistlib.loads(version.read_bytes())
 except Exception: fail('Xcode Contents/version.plist is missing or invalid')
 xcode=metadata.get('CFBundleShortVersionString')
 if not isinstance(xcode,str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,3}',xcode): fail('Xcode version metadata is invalid')
 sdk_directory=base/'Developer/Platforms/iPhoneOS.platform/Developer/SDKs'; sdk_alias=sdk_directory/'iPhoneOS.sdk'
 candidates=sorted([item for item in sdk_directory.glob('iPhoneOS*.sdk') if item.is_dir() and not item.is_symlink()])
 if sdk_alias.is_dir(): sdk=sdk_alias.resolve()
 elif len(candidates)==1: sdk=candidates[0]
 else: fail('Could not select one iPhoneOS SDK from Xcode')
 swift=base/'Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift'
 for directory in (sdk,swift):
  try: directory.resolve().relative_to(destination.resolve())
  except ValueError: fail('Imported resource path escapes its cache directory')
 if not (sdk/'SDKSettings.plist').is_file() or not (sdk/'System/Library/Frameworks/UIKit.framework/Headers/UIKit.h').is_file(): fail('The imported iPhoneOS SDK is incomplete')
 # Xcode 26 keeps Swift's shims in the SDK (usr/lib/swift/shims), where the compiler finds them too.
 if not (swift/'iphoneos').is_dir() or not ((swift/'shims').is_dir() or (sdk/'usr/lib/swift/shims').is_dir()): fail('Matching Darwin Swift iphoneos resources and shims are missing')
 for directory in (sdk,swift):
  for current,dirs,files in os.walk(directory,followlinks=False):
   for name in dirs+files:
    entry=pathlib.Path(current)/name
    if entry.is_symlink():
     resolved=entry.resolve()
     try: resolved.relative_to(destination)
     except ValueError: fail('Imported symlink escapes its cache directory')
     if not resolved.exists(): fail('Imported SDK/Swift symlink has a missing target: '+str(entry))
 result={'sdkPath':str(sdk),'swiftResourcePath':str(swift),'xcodeVersion':xcode}
 return result
def main():
 source=pathlib.Path(sys.argv[1]).expanduser()
 if not source.is_absolute() or not source.is_file(): fail('The Xcode .xip download is missing or incomplete: '+str(source))
 cache=pathlib.Path(os.environ.get('XDG_DATA_HOME',str(pathlib.Path.home()/'.local/share')))/'capmac/apple-sdk'; cache.mkdir(parents=True,exist_ok=True)
 with source.open('rb') as handle:
  original=os.fstat(handle.fileno()); content=open_xar(handle); identity=hashlib.sha256((str(VERSION)+':'+content['toc']+':'+str(content['size'])).encode()).hexdigest()[:32]; destination=cache/identity
  fingerprint={'size':original.st_size,'mtimeNs':original.st_mtime_ns}
  with (cache/(identity+'.lock')).open('a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   marker=destination/'capmac-import.json'
   if marker.is_file():
    try: saved=json.loads(marker.read_text())
    except Exception: fail('The cached SDK import metadata is invalid; move '+str(destination)+' aside and retry')
    if saved.get('version')==VERSION and saved.get('tocSha256')==content['toc']:
     result=inspect_resources(destination,saved.get('app',''))
     print('Using the previously imported Xcode '+result['xcodeVersion']+' resources',file=sys.stderr,flush=True); print(json.dumps(result)); return
    fail('The cached Xcode import has incompatible metadata; move '+str(destination)+' aside and retry')
   if destination.exists(): fail('Incomplete SDK cache at '+str(destination)+'; move that exact directory aside and retry')
   temporary=cache/('import-'+identity)
   if temporary.exists() or temporary.is_symlink():
    owner=temporary/'capmac-staging.json'
    if temporary.is_symlink() or temporary.resolve().parent!=cache.resolve() or not owner.is_file(): fail('Unrecognized SDK staging directory at '+str(temporary)+'; move that exact directory aside and retry')
    try: ownership=json.loads(owner.read_text())
    except Exception: fail('Invalid SDK staging ownership metadata at '+str(temporary))
    if ownership!={'version':VERSION,'identity':identity}: fail('SDK staging ownership does not match this archive')
    print('Removing an interrupted import before retrying.',file=sys.stderr,flush=True); shutil.rmtree(temporary)
   temporary.mkdir(); (temporary/'capmac-staging.json').write_text(json.dumps({'version':VERSION,'identity':identity}))
   try:
    print('Importing only the iPhoneOS SDK and Darwin Swift resources; this can take several minutes.',file=sys.stderr,flush=True)
    app=unpack_cpio(Pbzx(handle,content),temporary)
    current=os.fstat(handle.fileno())
    if current.st_size!=original.st_size or current.st_mtime_ns!=original.st_mtime_ns: fail('The Xcode download changed during import; wait for the download to finish')
    inspect_resources(temporary,app)
    (temporary/'capmac-staging.json').unlink()
    (temporary/'capmac-import.json').write_text(json.dumps({'version':VERSION,'archive':fingerprint,'app':app,'tocSha256':content['toc']}),encoding='utf-8')
    temporary.rename(destination)
    result=inspect_resources(destination,app); print(json.dumps(result))
   finally:
    if temporary.exists():
     if temporary.resolve().parent!=cache.resolve(): fail('Unsafe SDK staging cleanup path')
     shutil.rmtree(temporary)
try: main()
except (ValueError,OSError,ET.ParseError,lzma.LZMAError,zlib.error,struct.error) as error:
 print('Xcode SDK import failed: '+str(error),file=sys.stderr,flush=True); sys.exit(1)
`;
