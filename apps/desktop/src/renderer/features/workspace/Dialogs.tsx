import { useEffect, useMemo, useState } from 'react';
import { macFor } from '../../state/actions';
import { toast } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { InfoBar, Spinner } from '../../ui/Feedback';
import { Select, Switch, TextField } from '../../ui/Form';

type ExportKind = 'development' | 'ad-hoc' | 'app-store' | 'enterprise';

const EXPORTS: Array<{ value: ExportKind; label: string; hint: string }> = [
  { value: 'development', label: 'Development', hint: 'your registered devices' },
  { value: 'ad-hoc', label: 'Ad hoc', hint: 'testers’ registered devices' },
  { value: 'app-store', label: 'App Store Connect', hint: 'TestFlight and the App Store' },
  { value: 'enterprise', label: 'Enterprise', hint: 'in-house distribution' },
];

export function BuildIpaDialog({ path, open, onClose }: { path: string; open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<ExportKind>('development');
  const [upload, setUpload] = useState(false);
  const [team, setTeam] = useState('');
  const [outDir, setOutDir] = useState(`${path}\\build\\ios`);
  const [busy, setBusy] = useState(false);
  const teamError = team && !/^[A-Z0-9]{10}$/.test(team) ? 'A Team ID is 10 letters and digits, like ABCDE12345.' : undefined;

  const submit = async () => {
    if (teamError) return;
    setBusy(true);
    try {
      await call('builds.ipa', { projectPath: path, mac: macFor(path) ?? undefined, exportKind: upload ? 'app-store' : kind, upload, outDir, team: team || undefined });
      onClose();
    } catch (err) {
      const e = errorInfo(err);
      toast({ tone: 'critical', title: 'Could not start the IPA build', body: e.hint ? `${e.message} ${e.hint}` : e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Build an .ipa"
      icon="box"
      onSubmit={() => void submit()}
      footer={
        <>
          <Button type="submit" variant="accent" busy={busy} disabled={Boolean(teamError)}>
            {upload ? 'Build and upload' : 'Build IPA'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p className="muted">Archives a Release build on the Mac, exports a signed .ipa and copies it to this PC.</p>
      <div className="field">
        <span className="field__label">Distribution</span>
        <Select value={upload ? 'app-store' : kind} onChange={(v) => setKind(v)} label="Distribution" width={340} options={EXPORTS.map((e) => ({ value: e.value, label: e.label, hint: e.hint }))} />
      </div>
      <Switch checked={upload} onChange={setUpload} label="Upload to TestFlight" description="Sends the build to App Store Connect instead of copying it here." />
      <TextField label="Team ID (optional)" placeholder="ABCDE12345" value={team} onChange={(e) => setTeam(e.target.value.toUpperCase().trim())} error={teamError} hint="Leave empty to use the team from the Xcode project or capmac.json." />
      {!upload && (
        <TextField
          label="Save to"
          value={outDir}
          onChange={(e) => setOutDir(e.target.value)}
          trailing={
            <button
              type="button"
              className="input__action"
              aria-label="Choose folder"
              onClick={async () => {
                const folder = await window.capmac.invoke('app:pick-folder');
                if (folder) setOutDir(folder);
              }}
            >
              …
            </button>
          }
        />
      )}
      <InfoBar tone="info">Signing over SSH needs the Mac’s login keychain unlocked. CapMac asks for your Mac password if needed and never stores it.</InfoBar>
    </Dialog>
  );
}

const MAX_LINES = 20_000;

export function BuildLogDialog({ path, logPath, open, onClose }: { path: string; logPath: string | null; open: boolean; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !logPath) return;
    setText(null);
    setError(null);
    call('logs.buildLog', { projectPath: path, mac: macFor(path) ?? undefined, path: logPath }).then(
      (r) => setText(r.text),
      (err) => setError(errorInfo(err).message),
    );
  }, [open, logPath, path]);
  const shown = useMemo(() => {
    if (!text) return '';
    const lines = text.split('\n');
    return lines.length > MAX_LINES ? `… ${lines.length - MAX_LINES} earlier lines not shown (save the log to see them all)\n${lines.slice(-MAX_LINES).join('\n')}` : text;
  }, [text]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      className="log-dialog"
      title="Build log"
      icon="document"
      footer={
        <>
          <Button
            icon="download"
            disabled={!text}
            onClick={async () => {
              const saved = await window.capmac.invoke('app:save-text', { text: text ?? '', name: logPath?.split('/').pop() ?? 'build.log' });
              if (saved) toast({ tone: 'success', title: 'Build log saved', body: saved });
            }}
          >
            Save…
          </Button>
          <Button icon="copy" disabled={!text} onClick={() => void navigator.clipboard.writeText(text ?? '').then(() => toast({ tone: 'success', title: 'Build log copied' }))}>
            Copy
          </Button>
          <Button variant="accent" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <p className="faint mono log-dialog__path selectable">{logPath}</p>
      {error ? (
        <InfoBar tone="critical" title="Could not read the build log">
          {error}
        </InfoBar>
      ) : text === null ? (
        <div className="log-dialog__loading">
          <Spinner size={20} /> Fetching the log from the Mac…
        </div>
      ) : (
        <pre className="log-dialog__text selectable">{shown}</pre>
      )}
    </Dialog>
  );
}
