"""Synthetic XAR/PBZX/CPIO integration proof; contains no Apple SDK content."""
import hashlib,json,lzma,os,pathlib,plistlib,re,stat,struct,subprocess,sys,tempfile,zlib

SCRIPT=sys.stdin.read()
VERSION=int(re.search(r'^VERSION=(\d+)$',SCRIPT,re.M).group(1))
APP='Xcode.app'
SDK=APP+'/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.2.sdk'
SWIFT=APP+'/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift'

def records(extra=()):
    return [
        (APP+'/Contents/version.plist',plistlib.dumps({'CFBundleShortVersionString':'26.2'}),stat.S_IFREG|0o644,1,1),
        (SDK+'/SDKSettings.plist',plistlib.dumps({'Version':'26.2'}),stat.S_IFREG|0o644,2,1),
        (SDK+'/System/Library/Frameworks/UIKit.framework/Headers/UIKit.h',b'/* synthetic UIKit header */\n',stat.S_IFREG|0o644,3,1),
        (SWIFT+'/iphoneos',b'',stat.S_IFDIR|0o755,4,1),
        (SWIFT+'/shims',b'',stat.S_IFDIR|0o755,5,1),
        (SWIFT+'/shims/RuntimeShims.h',b'/* synthetic shim */\n',stat.S_IFREG|0o644,6,1),
        (APP+'/Contents/Developer/Platforms/MacOSX.platform/not-imported',b'not selected',stat.S_IFREG|0o600,7,1),
        *extra,
    ]

def placeholder(size):
    """What Apple's archives hold at a linked file's other links."""
    return (b'NULLcanary'+b'\0'*size)[:size]

def cpio(entries,kind='odc',bad_crc=False):
    output=bytearray()
    for name,data,mode,inode,nlink in [*entries,('TRAILER!!!',b'',0,0,1)]:
        encoded=name.encode()+b'\0'
        if kind=='odc':
            values=[(1,6),(inode,6),(mode,6),(0,6),(0,6),(nlink,6),(0,6),(0,11),(len(encoded),6),(len(data),11)]
            output.extend(b'070707'+''.join(format(value,'0'+str(width)+'o') for value,width in values).encode()+encoded+data)
        else:
            check=(sum(data)+(1 if bad_crc and data else 0))&0xffffffff if kind=='crc' else 0
            values=[inode,mode,0,0,nlink,0,len(data),1,0,0,0,len(encoded),check]
            output.extend((b'070702' if kind=='crc' else b'070701')+''.join(format(value,'08x') for value in values).encode()+encoded)
            output.extend(b'\0'*((-len(output))%4)); output.extend(data); output.extend(b'\0'*((-len(output))%4))
    return bytes(output)

def archive(path,entries=None,kind='odc',raw=False,bad_crc=False,content_corrupt=False,toc_corrupt=False,unsafe_toc=False,zero_final=False):
    plain=cpio(records() if entries is None else entries,kind,bad_crc)
    chunk_size=512
    if zero_final: plain+=b'\0'*((-len(plain))%chunk_size)
    content=b'pbzx'+struct.pack('>Q',chunk_size)
    for offset in range(0,len(plain),chunk_size):
        chunk=plain[offset:offset+chunk_size]
        stored=chunk if raw else lzma.compress(chunk)
        content+=struct.pack('>QQ',len(chunk),len(stored))+stored
    if zero_final: content+=struct.pack('>QQ',0,0)
    digest=hashlib.sha256(content).hexdigest()
    xml=('<xar><toc><checksum style="sha256"><offset>0</offset><size>32</size></checksum><file><name>Content</name><data><offset>32</offset><length>'+str(len(content))+'</length><size>'+str(len(content))+'</size><encoding style="application/octet-stream"/><archived-checksum style="sha256">'+digest+'</archived-checksum><extracted-checksum style="sha256">'+digest+'</extracted-checksum></data></file></toc></xar>').encode()
    if unsafe_toc: xml=b'<!DOCTYPE xar [<!ENTITY x "bad">]>'+xml
    compressed=zlib.compress(xml)
    header=struct.pack('>4sHHQQI',b'xar!',28,1,len(compressed),len(xml),3)
    toc_digest=hashlib.sha256(compressed).digest()
    if toc_corrupt: toc_digest=b'!'*32
    if content_corrupt: content=content[:-1]+bytes([content[-1]^1])
    path.write_bytes(header+compressed+toc_digest+content)

def main():
    with tempfile.TemporaryDirectory(prefix='capmac-sdk-proof-') as name:
        root=pathlib.Path(name); helper=root/'sdk.py'; helper.write_text(SCRIPT)
        def run(label,resume=False,**options):
            file=root/(label+'.xip'); archive(file,**options)
            env=dict(os.environ,XDG_DATA_HOME=str(root/('data-'+label)))
            if resume:
                payload=file.read_bytes(); compressed_size=struct.unpack('>Q',payload[8:16])[0]
                toc_hash=hashlib.sha256(payload[28:28+compressed_size]).hexdigest()
                identity=hashlib.sha256((str(VERSION)+':'+toc_hash+':'+str(len(payload))).encode()).hexdigest()[:32]
                stage=pathlib.Path(env['XDG_DATA_HOME'])/'capmac/apple-sdk'/('import-'+identity); stage.mkdir(parents=True)
                (stage/'capmac-staging.json').write_text(json.dumps({'version':VERSION,'identity':identity}))
                (stage/'interrupted-output').write_bytes(b'partial previous import')
            result=subprocess.run([sys.executable,str(helper),str(file)],capture_output=True,text=True,env=env)
            return file,env,result
        # Odc compressed chunks split headers and contents; selected links may
        # refer to data outside the selected platforms, before or after them.
        extra=[
            (APP+'/Contents/Other/source',b'cross-selection hardlink',stat.S_IFREG|0o640,100,3),
            (SDK+'/usr/lib/one.a',b'',stat.S_IFREG|0o640,100,3),
            (SDK+'/usr/lib/two.a',b'',stat.S_IFREG|0o640,100,3),
            (SWIFT+'/iphoneos/late.a',b'',stat.S_IFREG|0o644,101,2),
            (APP+'/Contents/Other/later',b'content on later hardlink',stat.S_IFREG|0o644,101,2),
            (SDK.rsplit('/',1)[0]+'/iPhoneOS.sdk',b'iPhoneOS26.2.sdk',stat.S_IFLNK|0o777,102,1),
            (SDK+'/usr/lib/alias.a',b'one.a',stat.S_IFLNK|0o777,103,1),
        ]
        file,env,result=run('odc',entries=records(extra))
        assert result.returncode==0,result.stderr
        imported=json.loads(result.stdout); sdk=pathlib.Path(imported['sdkPath']); swift=pathlib.Path(imported['swiftResourcePath'])
        assert imported['xcodeVersion']=='26.2'
        assert (sdk/'usr/lib/one.a').read_bytes()==b'cross-selection hardlink'
        assert (sdk/'usr/lib/one.a').stat().st_ino==(sdk/'usr/lib/two.a').stat().st_ino
        assert stat.S_IMODE((sdk/'usr/lib/one.a').stat().st_mode)==0o640
        assert (sdk/'usr/lib/alias.a').is_symlink() and (sdk/'usr/lib/alias.a').read_bytes()==b'cross-selection hardlink'
        assert (swift/'iphoneos/late.a').read_bytes()==b'content on later hardlink'
        cached=sdk.parents[6]
        assert not list(cached.rglob('not-imported')) and not list(cached.rglob('source'))
        marker=next((root/'data-odc').rglob('capmac-import.json')); before=marker.stat().st_mtime_ns
        second=subprocess.run([sys.executable,str(helper),str(file)],capture_output=True,text=True,env=env)
        assert second.returncode==0,second.stderr
        assert json.loads(second.stdout)==imported and marker.stat().st_mtime_ns==before and 'previously imported' in second.stderr
        os.utime(file,None)
        touched=subprocess.run([sys.executable,str(helper),str(file)],capture_output=True,text=True,env=env)
        assert touched.returncode==0 and json.loads(touched.stdout)==imported,touched.stderr
        # As in Apple's archives, a linked file's contents come at its first link, often outside
        # the import, and its other links hold a same-size placeholder. odc's 6-digit inode
        # numbers repeat: here an unrelated empty linked file shares the number.
        every=[
            (APP+'/Contents/Developer/Platforms/AppleTVSimulator.platform/Visibility.h',b'real linked header',stat.S_IFREG|0o644,200,3),
            (SDK+'/usr/lib/a.h',placeholder(18),stat.S_IFREG|0o644,200,3),
            (SDK+'/usr/lib/b.h',placeholder(18),stat.S_IFREG|0o644,200,3),
            (SDK+'/usr/lib/c.dylib',b'linked contents',stat.S_IFREG|0o644,201,2),
            (SWIFT+'/iphoneos/c.dylib',placeholder(15),stat.S_IFREG|0o644,201,2),
            (SDK+'/usr/lib/empty',b'',stat.S_IFREG|0o600,200,2),
            (SDK+'/usr/lib/empty2',b'',stat.S_IFREG|0o600,200,2),
        ]
        _,_,result=run('odc-placeholders',entries=records(every))
        assert result.returncode==0,result.stderr
        every_sdk=pathlib.Path(json.loads(result.stdout)['sdkPath']); every_swift=pathlib.Path(json.loads(result.stdout)['swiftResourcePath'])
        assert (every_sdk/'usr/lib/a.h').read_bytes()==b'real linked header' and (every_sdk/'usr/lib/b.h').stat().st_ino==(every_sdk/'usr/lib/a.h').stat().st_ino
        assert (every_swift/'iphoneos/c.dylib').read_bytes()==b'linked contents' and (every_swift/'iphoneos/c.dylib').stat().st_ino==(every_sdk/'usr/lib/c.dylib').stat().st_ino
        assert (every_sdk/'usr/lib/empty').read_bytes()==b'' and (every_sdk/'usr/lib/empty2').read_bytes()==b''
        assert stat.S_IMODE((every_sdk/'usr/lib/empty').stat().st_mode)==0o600
        for item in every_sdk.parents[6].rglob('*'):
            assert not (item.is_file() and item.read_bytes().startswith(b'NULLcanary')),item
        # Swift's resources link "clang" to clang's version folder, whose headers come along; a link
        # to other Xcode files is left out (with a note), and clang's other libraries stay out.
        clang=APP+'/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang/21'
        linked=[
            (clang,b'',stat.S_IFDIR|0o755,300,1),
            (clang+'/include/stddef.h',b'/* synthetic builtin header */\n',stat.S_IFREG|0o644,301,1),
            (clang+'/lib/darwin/libclang_rt.osx.a',b'not imported',stat.S_IFREG|0o644,302,1),
            (SWIFT+'/clang',b'../clang/21',stat.S_IFLNK|0o777,303,1),
            (SWIFT+'/pm',b'../../../share/pm',stat.S_IFLNK|0o777,304,1),
        ]
        _,_,result=run('links',entries=records(linked))
        assert result.returncode==0,result.stderr
        linked_swift=pathlib.Path(json.loads(result.stdout)['swiftResourcePath'])
        assert (linked_swift/'clang').is_symlink() and (linked_swift/'clang/include/stddef.h').read_bytes()==b'/* synthetic builtin header */\n'
        assert not (linked_swift/'pm').is_symlink() and 'Leaving out a link' in result.stderr
        assert not list(linked_swift.parent.rglob('libclang_rt.osx.a'))
        # Xcode 26 keeps Swift's shims in the SDK instead of the toolchain.
        moved=[entry for entry in records() if '/shims' not in entry[0]]+[(SDK+'/usr/lib/swift/shims/SwiftStdint.h',b'/* synthetic */\n',stat.S_IFREG|0o644,400,1)]
        _,_,result=run('sdk-shims',entries=moved)
        assert result.returncode==0,result.stderr
        # Both new ASCII variants and raw PBZX chunks are accepted.
        for kind in ('newc','crc'):
            _,_,result=run(kind,kind=kind,raw=True)
            assert result.returncode==0,result.stderr
        _,_,result=run('zero-final',raw=True,zero_final=True,resume=True)
        assert result.returncode==0 and 'interrupted import' in result.stderr,result.stderr
        bad_cases={
            'toc-checksum':{'toc_corrupt':True},
            'content-checksum':{'content_corrupt':True,'raw':True},
            'crc':{'kind':'crc','bad_crc':True},
            'xml-entity':{'unsafe_toc':True},
            'traversal':{'entries':records([('../escape',b'x',stat.S_IFREG|0o644,500,1)])},
            'control':{'entries':records([(SDK+'/bad\nname',b'x',stat.S_IFREG|0o644,500,1)])},
            'symlink-escape':{'entries':records([(SDK+'/bad',b'../../../../../../../../../../outside',stat.S_IFLNK|0o777,500,1)])},
            'symlink-parent':{'entries':records([(SDK+'/alias',b'usr',stat.S_IFLNK|0o777,500,1),(SDK+'/alias/file',b'bad',stat.S_IFREG|0o644,501,1)])},
            'duplicate':{'entries':records([(SDK+'/SDKSettings.plist',b'bad',stat.S_IFREG|0o644,500,1)])},
            # A placeholder needs its linked file's contents, from exactly one file.
            'link-missing':{'entries':records([(SDK+'/usr/lib/lost.h',placeholder(12),stat.S_IFREG|0o644,600,2)])},
            'link-ambiguous':{'entries':records([(APP+'/Contents/Other/x.h',b'first record',stat.S_IFREG|0o644,601,3),(APP+'/Contents/Other/y.h',b'other record',stat.S_IFREG|0o644,601,3),(SDK+'/usr/lib/z.h',placeholder(12),stat.S_IFREG|0o644,601,3)])},
            'placeholder-alone':{'entries':records([(SDK+'/usr/lib/alone.h',placeholder(12),stat.S_IFREG|0o644,602,1)])},
        }
        rejected=[]
        for label,options in bad_cases.items():
            _,_,result=run('bad-'+label,**options)
            assert result.returncode!=0,label+' unexpectedly succeeded'
            assert not list((root/('data-bad-'+label)).rglob('capmac-import.json')),label+' published a corrupt cache'
            assert not list((root/('data-bad-'+label)).rglob('import-*')),label+' left staging data'
            rejected.append(label)
        assert not (root/'escape').exists()
        print(json.dumps({'odc':True,'newc':True,'crc':True,'rawChunks':True,'hardlinks':True,'odcPlaceholders':True,'clangLink':True,'sdkShims':True,'symlinks':True,'modes':True,'selective':True,'idempotent':True,'interruptedRetry':True,'zeroFinalChunk':True,'rejected':rejected}))

main()
