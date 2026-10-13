import { useEffect, useMemo, useState } from 'react';
import { t, tidy } from '../../../shared/i18n';
import { both, macFor } from '../../state/actions';
import { toast } from '../../state/app';
import { call, errorInfo } from '../../state/engine';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { InfoBar, Spinner } from '../../ui/Feedback';
import { Select, Switch, TextField } from '../../ui/Form';

type ExportKind = 'development' | 'ad-hoc' | 'app-store' | 'enterprise';

const EXPORTS: ExportKind[] = ['development', 'ad-hoc', 'app-store', 'enterprise'];

export function BuildIpaDialog({ path, open, onClose }: { path: string; open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<ExportKind>('development');
  const [upload, setUpload] = useState(false);
  const [team, setTeam] = useState('');
  const [outDir, setOutDir] = useState(`${path}\\build\\ios`);
  const [busy, setBusy] = useState(false);
  const teamError = team && !/^[A-Z0-9]{10}$/.test(team) ? t.ipa.teamError : undefined;

  const submit = async () => {
    if (teamError) return;
    setBusy(true);
    try {
      await call('builds.ipa', { projectPath: path, mac: macFor(path) ?? undefined, exportKind: upload ? 'app-store' : kind, upload, outDir, team: team || undefined });
      onClose();
    } catch (err) {
      toast({ tone: 'critical', title: t.ipa.startFailed, body: both(errorInfo(err)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t.ipa.title}
      icon="box"
      onSubmit={() => void submit()}
      footer={
        <>
          <Button type="submit" variant="accent" busy={busy} disabled={Boolean(teamError)}>
            {upload ? t.ipa.buildAndUpload : t.ipa.build}
          </Button>
          <Button onClick={onClose}>{t.common.cancel}</Button>
        </>
      }
    >
      <p className="muted">{t.ipa.intro}</p>
      <div className="field">
        <span className="field__label">{t.ipa.distribution}</span>
        <Select value={upload ? 'app-store' : kind} onChange={(v) => setKind(v)} label={t.ipa.distribution} width={340} options={EXPORTS.map((value) => ({ value, ...t.ipa.kinds[value] }))} />
      </div>
      <Switch checked={upload} onChange={setUpload} label={t.ipa.upload} description={t.ipa.uploadDesc} />
      <TextField label={t.ipa.team} placeholder="ABCDE12345" value={team} onChange={(e) => setTeam(e.target.value.toUpperCase().trim())} error={teamError} hint={t.ipa.teamHint} />
      {!upload && (
        <TextField
          label={t.ipa.saveTo}
          value={outDir}
          onChange={(e) => setOutDir(e.target.value)}
          trailing={
            <button
              type="button"
              className="input__action"
              aria-label={t.ipa.chooseFolder}
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
      <InfoBar tone="info">{t.ipa.signing}</InfoBar>
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
      (err) => setError(tidy(errorInfo(err).message)),
    );
  }, [open, logPath, path]);
  const shown = useMemo(() => {
    if (!text) return '';
    const lines = text.split('\n');
    return lines.length > MAX_LINES ? `${t.buildLog.hidden(lines.length - MAX_LINES)}\n${lines.slice(-MAX_LINES).join('\n')}` : text;
  }, [text]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      className="log-dialog"
      title={t.buildLog.title}
      icon="document"
      footer={
        <>
          <Button
            icon="download"
            disabled={!text}
            onClick={async () => {
              const saved = await window.capmac.invoke('app:save-text', { text: text ?? '', name: logPath?.split('/').pop() ?? 'build.log' });
              if (saved) toast({ tone: 'success', title: t.buildLog.saved, body: saved });
            }}
          >
            {t.common.saveMenu}
          </Button>
          <Button icon="copy" disabled={!text} onClick={() => void navigator.clipboard.writeText(text ?? '').then(() => toast({ tone: 'success', title: t.buildLog.copied }))}>
            {t.common.copy}
          </Button>
          <Button variant="accent" onClick={onClose}>
            {t.common.close}
          </Button>
        </>
      }
    >
      <p className="faint mono log-dialog__path selectable">{logPath}</p>
      {error ? (
        <InfoBar tone="critical" title={t.buildLog.readFailed}>
          {error}
        </InfoBar>
      ) : text === null ? (
        <div className="log-dialog__loading">
          <Spinner size={20} /> {t.buildLog.loading}
        </div>
      ) : (
        <pre className="log-dialog__text selectable">{shown}</pre>
      )}
    </Dialog>
  );
}
