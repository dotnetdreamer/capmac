/** Build the pinned signer with independently scoped app and extension entitlements. */
import { CancelledError, UserError } from '../errors.js';
import type { WslExecutor, WslRunOptions } from './toolchain.js';

export const WSL_SCOPED_SIGNER_MARKER = 'CapMac scoped entitlements v1';
export const WSL_SIGNER_REVISION = '614caa8d1ca949e260e5746144aa52d27a4b08d6';

/** The original source is verified before any patch can change its behavior. */
export const PATCH_WSL_SIGNER = String.raw`def patch_signer(source):
 import hashlib
 bundle=source/'src/bundle.cpp'; main=source/'src/zsign.cpp'
 expected={'src/bundle.cpp':'9c488f55098c52aa2599c75452ff957264a5cfa282021edbe5bd8b9a3101ad55','src/zsign.cpp':'64922369263bcb10ff715dde702879cd3dad192a7a07932d9e336ea22fc97e08'}
 for name,digest in expected.items():
  if hashlib.sha256((source/name).read_bytes()).hexdigest()!=digest: raise SystemExit('The pinned signer source changed: '+name+'; refusing an unverified patch')
 helper=r'''
// CapMac confines each executable bundle to its own validated entitlement plist.
// Profiles still supply certificates, CMS signing data and embedded provisioning.
class CapMacEntitlementScope {
    ZSignAsset* asset;
    string previous;
    bool enabled;
    bool valid;
public:
    CapMacEntitlementScope(ZSignAsset* selected, const string& bundleId, bool executableBundle)
        : asset(selected), enabled(false), valid(true) {
        const char* manifestPath = getenv("CAPMAC_ZSIGN_ENTITLEMENTS_MAP");
        if (!manifestPath || !manifestPath[0]) return;
        if (!asset) { valid = false; return; }
        enabled = true;
        previous = asset->m_strEntitleData;
        asset->m_strEntitleData.clear();
        if (!executableBundle) return;
        string manifestData;
        jvalue manifest;
        if (!ZFile::ReadFile(manifestPath, manifestData) || !manifest.read(manifestData) || manifest.type() != jvalue::E_OBJECT) {
            ZLog::ErrorV("CapMac: cannot read the scoped entitlements manifest.\n");
            valid = false; return;
        }
        if (!manifest.has(bundleId) || manifest[bundleId].type() != jvalue::E_STRING || manifest[bundleId].as_string().empty()) {
            ZLog::ErrorV("CapMac: scoped entitlements missing for %s.\n", bundleId.c_str());
            valid = false; return;
        }
        string entitlements;
        jvalue parsed;
        if (!ZFile::ReadFile(manifest[bundleId].as_cstr(), entitlements) || !parsed.read_plist(entitlements) || parsed.type() != jvalue::E_OBJECT) {
            ZLog::ErrorV("CapMac: cannot read the entitlement plist for %s.\n", bundleId.c_str());
            valid = false; return;
        }
        // Normalize binary as well as XML input to the signer's expected XML.
        parsed.style_write_plist(asset->m_strEntitleData);
    }
    ~CapMacEntitlementScope() { if (enabled) asset->m_strEntitleData = previous; }
    bool ok() const { return valid; }
};

'''
 text=bundle.read_text()
 anchor='bool ZBundle::SignNode(jvalue& jvNode)'
 if text.count(anchor)!=1: raise SystemExit('Unexpected signer SignNode patch context')
 text=text.replace(anchor,helper+anchor,1)
 original='\t\t\t\tif (!macho.Sign(m_pSignAsset, m_bForceSign, "", "", "", "")) {'
 replacement='\t\t\t\tCapMacEntitlementScope capmacFileScope(m_pSignAsset, "", false);\n\t\t\t\tif (!capmacFileScope.ok()) return false;\n'+original
 if text.count(original)!=1: raise SystemExit('Unexpected loose Mach-O signer patch context')
 text=text.replace(original,replacement,1)
 original='\tif (!macho.Sign(m_pSignAsset, bForceSign, strBundleId, strInfoSHA1, strInfoSHA256, strCodeResData)) {'
 replacement='\tbool capmacExecutableBundle = ZFile::IsPathSuffix(strBaseFolder, ".app") || ZFile::IsPathSuffix(strBaseFolder, ".appex");\n\tCapMacEntitlementScope capmacBundleScope(m_pSignAsset, strBundleId, capmacExecutableBundle);\n\tif (!capmacBundleScope.ok()) return false;\n'+original
 if text.count(original)!=1: raise SystemExit('Unexpected bundle signer patch context')
 text=text.replace(original,replacement,1)
 bundle.write_text(text,encoding='utf-8',newline='\n')
 text=main.read_text(); original='\tZLog::Print("options:\\n");'
 if text.count(original)!=1: raise SystemExit('Unexpected signer usage patch context')
 text=text.replace(original,'\tZLog::Print("CapMac scoped entitlements v1\\n");\n'+original,1)
 main.write_text(text,encoding='utf-8',newline='\n')
`;

export const INSTALL_WSL_SIGNER = PATCH_WSL_SIGNER + String.raw`import json,os,pathlib,shutil,subprocess,sys,tempfile
revision=sys.argv[1]
if revision!='614caa8d1ca949e260e5746144aa52d27a4b08d6': raise SystemExit('Unverified signer revision')
for tool in ['git','make','g++','pkg-config']:
 if not shutil.which(tool): raise SystemExit('Install '+tool+' inside this WSL distribution before preparing the extension signer')
subprocess.run(['pkg-config','--exists','openssl'],check=True)
cache=pathlib.Path(os.environ.get('XDG_CACHE_HOME',str(pathlib.Path.home()/'.cache')))/'capmac'/'signers'; cache.mkdir(parents=True,exist_ok=True)
destination=cache/(revision+'-scoped-v1'); binary=destination/'capmac-zsign'; marker='CapMac scoped entitlements v1'
def verified():
 if not binary.is_file() or not os.access(binary,os.X_OK) or not (destination/'LICENSE').is_file(): return False
 probe=subprocess.run([str(binary),'--help'],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 return marker in probe.stdout
if not verified():
 if destination.exists(): raise SystemExit('Incomplete generated signer at '+str(destination)+'. Move that exact cache directory aside and retry.')
 temporary=pathlib.Path(tempfile.mkdtemp(prefix='prepare-',dir=cache)); source=temporary/'source'; installed=temporary/'installed'
 try:
  def run(argv): subprocess.run(argv,check=True,stdout=sys.stderr,stderr=sys.stderr)
  run(['git','clone','--config','core.autocrlf=false','--filter=blob:none','--no-checkout','https://github.com/zhlynn/zsign.git',str(source)])
  run(['git','-C',str(source),'checkout','--detach',revision])
  actual=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
  if actual!=revision: raise SystemExit('Signer source revision verification failed')
  patch_signer(source)
  run(['make','-C',str(source/'build/linux'),'-j',str(min(4,os.cpu_count() or 1))])
  installed.mkdir(); shutil.copy2(source/'bin/zsign',installed/'capmac-zsign'); (installed/'capmac-zsign').chmod(0o755)
  shutil.copy2(source/'LICENSE',installed/'LICENSE')
  (installed/'SOURCE').write_text('https://github.com/zhlynn/zsign\n'+revision+'\nCapMac patch: bundle-scoped entitlement selection; marker '+marker+'\n')
  probe=subprocess.run([str(installed/'capmac-zsign'),'--help'],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  if marker not in probe.stdout: raise SystemExit('The compiled signer lacks its scoped-entitlement capability marker')
  installed.rename(destination)
 finally:
  if temporary.resolve().parent!=cache.resolve(): raise SystemExit('Unsafe signer setup staging directory')
  shutil.rmtree(temporary)
if not verified(): raise SystemExit('Signer installation verification failed')
print(json.dumps({'signerPath':str(binary)}))
`;

/** Used only when a build contains separately provisioned executable bundles. */
export async function ensureWslSigner(executor: WslExecutor, hooks: Pick<WslRunOptions, 'signal' | 'onOutput'> = {}): Promise<string> {
  if (hooks.signal?.aborted) throw new CancelledError();
  const result = await executor.run(['python3', '-c', INSTALL_WSL_SIGNER, WSL_SIGNER_REVISION], { ...hooks, timeoutMs: 600_000, allowFailure: true });
  if (result.code !== 0) throw new UserError('Could not prepare the WSL signer for app extensions.', 'Install Git, make, g++, pkg-config and libssl-dev inside the selected WSL distribution.', (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-20));
  let parsed: { signerPath?: unknown };
  try { parsed = JSON.parse(result.stdout.trim()) as { signerPath?: unknown }; } catch { throw new UserError('The WSL signer installer returned invalid output.'); }
  if (typeof parsed.signerPath !== 'string' || !parsed.signerPath.startsWith('/') || /[\0\r\n]/.test(parsed.signerPath)) throw new UserError('The WSL signer installer returned an invalid executable path.');
  return parsed.signerPath;
}
