/**
 * Objective-C call stubs for code Apple's compiler built. That compiler calls methods through
 * `_objc_msgSend$<selector>` stubs that the linker makes. ld64.lld 18 points thousands of the stubs it
 * makes for a large app at the wrong method name: Ludo's prebuilt Google Mobile Ads library then crashed
 * at launch with "+[NSNotificationCenter mAsync]: unrecognized selector" (its `defaultCenter` stub read
 * the tail of another name). The calls the compiler writes itself are right, so CapMac writes those
 * stubs the same way, links again, and checks every stub before the app is signed.
 */
import { UserError } from '../errors.js';
import type { WslCommandResult, WslRunOptions } from './toolchain.js';

/**
 * `prepare <binary> <assembly>`: when the linker made stubs, writes our own as assembly and prints how
 * many (else 0). `check <binary>`: every stub must load its own selector; prints the count, or fails.
 */
export const OBJC_STUBS = String.raw`import json,re,struct,sys
mode,binary=sys.argv[1],sys.argv[2]
data=open(binary,'rb').read()
if data[:4]!=b'\xcf\xfa\xed\xfe': raise SystemExit('Expected a 64-bit Mach-O file: '+binary)
segments=[]; sections={}; symtab=None; text=0; at=32
for _ in range(struct.unpack('<I',data[16:20])[0]):
 cmd,size=struct.unpack('<II',data[at:at+8])
 if cmd==0x19:
  vmaddr,vmsize,fileoff,filesize=struct.unpack('<QQQQ',data[at+24:at+56]); segments.append((vmaddr,fileoff,filesize))
  if data[at+8:at+24].rstrip(b'\0')==b'__TEXT': text=vmaddr
  for index in range(struct.unpack('<I',data[at+64:at+68])[0]):
   item=at+72+index*80; sections[data[item:item+16].rstrip(b'\0').decode()]=struct.unpack('<QQ',data[item+32:item+48])
 elif cmd==0x2: symtab=struct.unpack('<IIII',data[at+8:at+24])
 at+=size
def offset(address):
 for vmaddr,fileoff,filesize in segments:
  if vmaddr<=address<vmaddr+filesize: return fileoff+address-vmaddr
 raise SystemExit('An Objective-C stub points outside the file: '+hex(address))
stubs={}
if symtab:
 symoff,nsyms,stroff,_=symtab
 for index in range(nsyms):
  strx,kind,_,_,value=struct.unpack('<IBBHQ',data[symoff+index*16:symoff+index*16+16])
  if kind&0xe0 or kind&0x0e!=0x0e: continue
  name=data[stroff+strx:data.index(b'\0',stroff+strx)].decode('utf-8','replace')
  if name.startswith('_objc_msgSend$'): stubs[name[14:]]=value
def selector(address):
 # Every stub starts by loading its selector: adrp x1, page; ldr x1, [x1, offset].
 adrp,ldr=struct.unpack('<II',data[offset(address):offset(address)+8])
 if adrp&0x9f00001f!=0x90000001 or ldr&0xffc003ff!=0xf9400021: return None
 page=((adrp>>5&0x7ffff)<<2|adrp>>29&3)<<12
 if page&1<<32: page-=1<<33
 reference=(address&~0xfff)+page+(ldr>>10&0xfff)*8
 pointer=struct.unpack('<Q',data[offset(reference):offset(reference)+8])[0]&(1<<36)-1
 if pointer<text: pointer+=text
 start=offset(pointer)
 return data[start:data.index(b'\0',start)].decode('utf-8','replace')
if mode=='prepare':
 made=sections.get('__objc_stubs')
 names=sorted(name for name,address in stubs.items() if made and made[0]<=address<made[0]+made[1])
 if made and made[1] and not names: raise SystemExit('The linker made Objective-C stubs without their names, so CapMac cannot check them')
 for name in names:
  if not re.fullmatch('[A-Za-z0-9_:$]+',name): raise SystemExit('Unexpected Objective-C selector: '+name)
 lines=['.section __TEXT,__objc_methname,cstring_literals']+['Lcapmac_name%d: .asciz "%s"'%(index,name) for index,name in enumerate(names)]
 lines+=['.section __DATA,__objc_selrefs,literal_pointers,no_dead_strip','.p2align 3']+['Lcapmac_ref%d: .quad Lcapmac_name%d'%(index,index) for index in range(len(names))]
 lines.append('.section __TEXT,__text,regular,pure_instructions')
 for index,name in enumerate(names):
  symbol='"_objc_msgSend$'+name+'"'
  lines+=['.globl '+symbol,'.private_extern '+symbol,'.p2align 2',symbol+':',' adrp x1, Lcapmac_ref%d@PAGE'%index,' ldr x1, [x1, Lcapmac_ref%d@PAGEOFF]'%index,' b _objc_msgSend']
 lines.append('.subsections_via_symbols')
 if names: open(sys.argv[3],'w').write('\n'.join(lines)+'\n')
 print(len(names))
else:
 wrong=[[name,selector(address)] for name,address in sorted(stubs.items()) if selector(address)!=name]
 if wrong: print(json.dumps({'checked':len(stubs),'wrong':len(wrong),'examples':wrong[:5]})); sys.exit(1)
 print(len(stubs))
`;

/**
 * Links `link` (a full linker command without its output) into `output`, writing again any
 * Objective-C stubs the linker made. `work` holds the stubs' files, outside the app bundle.
 */
export async function linkWithObjCStubs(
  run: (argv: string[], extra?: WslRunOptions) => Promise<WslCommandResult>,
  link: string[], output: string, options: { clang: string; target: string; work: string },
): Promise<void> {
  await run([...link, '-o', output]);
  const assembly = `${options.work}/objc-stubs.s`;
  const object = `${options.work}/objc-stubs.o`;
  const made = Number((await run(['python3', '-c', OBJC_STUBS, 'prepare', output, assembly])).stdout.trim());
  if (!Number.isInteger(made)) throw new UserError('CapMac could not read the linked app’s Objective-C calls.');
  if (made > 0) {
    await run([options.clang, '-c', '-target', options.target, assembly, '-o', object]);
    await run([...link, object, '-o', output]);
  }
  const checked = await run(['python3', '-c', OBJC_STUBS, 'check', output], { allowFailure: true });
  if (checked.code !== 0) {
    throw new UserError('The linked app would call the wrong Objective-C methods.', 'This is a linker problem, not your code. Report it with the details below.', (checked.stdout || checked.stderr).trim().split(/\r?\n/).slice(-5));
  }
}
