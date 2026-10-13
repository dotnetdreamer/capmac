import { useEffect, useState } from 'react';
import { shortKey, signalUrlProblem } from '@capmac/core/shared/remote';
import type { MacSummary, RelayChoice, RouteChoice } from '../../../shared/contract';
import { t, tidy } from '../../../shared/i18n';
import { timeAgo } from '../../lib/format';
import { revokePc, setOptions, testConnection, turnOff, turnOn, useRemote } from '../../state/remote';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Badge, Spinner } from '../../ui/Feedback';
import { Select, TextField, Toggle } from '../../ui/Form';
import { Icon } from '../../ui/Icon';

export const DEPLOY_GUIDE_URL = 'https://github.com/dotnetdreamer/capmac/blob/main/services/signal/deploy/README.md';

const connected = (mac: MacSummary) => mac.state === 'connected' || mac.state === 'restored';

/** Asks for the signaling server (needed once, before the first Mac goes remote). */
export function ServerDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (url: string) => void }) {
  const current = useRemote((s) => s.server);
  const [value, setValue] = useState(current?.url ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(current?.url ?? '');
      setError(null);
    }
  }, [open, current?.url]);
  const save = async () => {
    const problem = signalUrlProblem(value);
    if (problem) {
      setError(tidy(problem));
      return;
    }
    setBusy(true);
    try {
      const saved = await useRemote.getState().setServer(value.trim());
      if (saved.url) onSaved(saved.url);
    } catch (err) {
      setError(tidy((err as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      size="sm"
      icon="globe"
      title={t.remote.server.title}
      onClose={onClose}
      onSubmit={() => void save()}
      footer={
        <>
          <Button type="submit" variant="accent" busy={busy}>
            {t.common.continue}
          </Button>
          <Button onClick={onClose}>{t.common.cancel}</Button>
        </>
      }
    >
      <p>{t.remote.server.body}</p>
      <p>
        <a href={DEPLOY_GUIDE_URL} onClick={(e) => {
          e.preventDefault();
          void window.capmac.invoke('app:open-external', { url: DEPLOY_GUIDE_URL });
        }}>{t.remote.server.howTo}</a>
      </p>
      <TextField label={t.remote.server.address} placeholder={t.remote.server.placeholder} value={value} onChange={(e) => {
        setValue(e.target.value);
        setError(null);
      }} error={error} hint={t.remote.server.hint} data-autofocus />
    </Dialog>
  );
}

function PcsDialog({ mac, open, onClose }: { mac: MacSummary; open: boolean; onClose: () => void }) {
  const entry = useRemote((s) => s.reports[mac.name]);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    if (open) void useRemote.getState().loadReport(mac.name);
  }, [open, mac.name]);
  const pcs = entry?.report?.pcs ?? [];
  return (
    <Dialog open={open} size="md" icon="key" title={t.remote.pcsTitle(mac.label)} onClose={onClose} footer={<Button onClick={onClose} data-autofocus>{t.common.close}</Button>}>
      <p className="faint">{t.remote.pcsBody}</p>
      {entry?.status === 'loading' && !entry.report ? (
        <div className="mac-remote__loading">
          <Spinner size={16} /> {t.common.askingMac}
        </div>
      ) : entry?.status === 'error' ? (
        <p className="mac-remote__warn">{tidy(entry.error?.message)}</p>
      ) : (
        <ul className="mac-remote__pcs">
          {pcs.map((pc) => (
            <li key={pc.key}>
              <Icon name="desktop" size={20} />
              <div className="mac-remote__pc">
                <div className="mac-remote__pc-name">
                  <span className="truncate">{pc.name}</span>
                  {pc.current && <Badge tone="accent">{t.remote.thisPc}</Badge>}
                </div>
                <div className="mac-remote__pc-meta">
                  <span className="mono">{shortKey(pc.key)}</span> · {t.remote.added(timeAgo(Date.parse(pc.addedAt)))}
                </div>
              </div>
              {!pc.current && (
                <Button size="sm" variant="subtle" icon="delete" busy={removing === pc.key} onClick={() => {
                  setRemoving(pc.key);
                  void revokePc(mac, pc.key, pc.name).finally(() => setRemoving(null));
                }}>
                  {t.common.remove}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** The Remote access part of a Mac's card: the switch, its status, and its options. */
export function RemoteAccess({ mac }: { mac: MacSummary }) {
  const remote = mac.remote;
  const server = useRemote((s) => s.server);
  const entry = useRemote((s) => s.reports[mac.name]);
  const [busy, setBusy] = useState<null | 'toggle' | 'awake' | 'test' | 'move'>(null);
  const [askServer, setAskServer] = useState(false);
  const [confirmOff, setConfirmOff] = useState<null | 'ask' | 'unreachable'>(null);
  const [showPcs, setShowPcs] = useState(false);
  const isConnected = connected(mac);

  useEffect(() => {
    void useRemote.getState().loadServer();
  }, []);
  // What the Mac's door says, once connected (refreshed when the route changes).
  useEffect(() => {
    if (remote.enabled && isConnected) void useRemote.getState().loadReport(mac.name);
  }, [remote.enabled, isConnected, mac.name, mac.route]);

  const enable = async () => {
    setBusy('toggle');
    await turnOn(mac);
    setBusy(null);
  };
  const toggle = (on: boolean) => {
    if (on) {
      if (!server?.url) setAskServer(true);
      else void enable();
    } else {
      setConfirmOff('ask');
    }
  };
  const disable = async (localOnly: boolean) => {
    setBusy('toggle');
    const result = await turnOff(mac, localOnly);
    setBusy(null);
    setConfirmOff(result === 'unreachable' ? 'unreachable' : null);
  };

  const door = entry?.report?.door;
  const doorState = door?.status?.state;
  let status: string;
  let tone: 'ok' | 'warn' | 'idle' = 'idle';
  if (!remote.enabled) {
    status = t.remote.statusOff;
  } else if (isConnected && mac.route) {
    tone = doorState && doorState !== 'online' ? 'warn' : 'ok';
    const connected = t.remote.statusConnected(mac.route, mac.route !== 'lan' ? mac.rttMs : null);
    const reach = doorState === 'online' ? t.remote.macOnline : doorState ? t.remote.macOffline(tidy(door?.status?.error)) : null;
    status = reach ? `${connected}. ${reach}` : connected;
  } else {
    status = t.remote.statusOn;
  }
  const movable = remote.enabled && server?.url && remote.signalUrl && server.url !== remote.signalUrl;

  return (
    <section className="mac-remote" aria-label={t.remote.label}>
      <div className="mac-remote__row">
        <span className={`mac-remote__icon mac-remote__icon--${tone}`}>
          <Icon name="globe" size={18} />
        </span>
        <div className="mac-remote__text">
          <div className="mac-remote__title">{t.remote.title}</div>
          <div className={`mac-remote__desc${tone === 'warn' ? ' mac-remote__warn' : ''}`}>{status}</div>
        </div>
        <Toggle label={t.remote.toggle(mac.label)} checked={remote.enabled} loading={busy === 'toggle'} disabled={busy !== null} onChange={toggle} />
      </div>
      {remote.enabled && (
        <div className="mac-remote__options">
          <div className="mac-remote__option">
            <span className="mac-remote__label">{t.remote.connection}</span>
            <Select<RouteChoice>
              label={t.remote.connection}
              value={remote.route}
              width={230}
              onChange={(route) => void setOptions(mac, { route })}
              options={(['auto', 'lan', 'internet'] as const).map((value) => ({ value, label: t.route.choice[value], hint: t.route.choiceHint[value] }))}
            />
          </div>
          <div className="mac-remote__option">
            <span className="mac-remote__label">{t.remote.keepAwake}</span>
            <Toggle
              label={t.remote.keepAwake}
              checked={remote.keepAwake}
              loading={busy === 'awake'}
              disabled={busy !== null}
              onChange={(keepAwake) => {
                setBusy('awake');
                void setOptions(mac, { keepAwake }).finally(() => setBusy(null));
              }}
            />
          </div>
          <div className="mac-remote__option">
            <span className="mac-remote__label">{t.remote.relay}</span>
            <Select<RelayChoice>
              label={t.remote.relay}
              value={remote.relay}
              width={230}
              onChange={(relay) => void setOptions(mac, { relay })}
              options={(['allow', 'never', 'always'] as const).map((value) => ({ value, label: t.route.relay[value], hint: t.route.relayHint[value] }))}
            />
          </div>
          <div className="mac-remote__actions">
            <Button size="sm" icon="plugConnected" busy={busy === 'test'} disabled={busy !== null} onClick={() => {
              setBusy('test');
              void testConnection(mac).finally(() => setBusy(null));
            }}>
              {t.remote.test}
            </Button>
            <Button size="sm" icon="key" onClick={() => setShowPcs(true)}>
              {t.remote.pcs(entry?.report?.pcs.length)}
            </Button>
            {movable && (
              <Button size="sm" icon="sync" busy={busy === 'move'} disabled={busy !== null} onClick={() => {
                setBusy('move');
                void setOptions(mac, { signalUrl: server!.url! }).finally(() => setBusy(null));
              }}>
                {t.remote.moveTo(new URL(server!.url!.replace(/^ws/, 'http')).host)}
              </Button>
            )}
            <span className="mac-remote__fine faint">{remote.keepAwake ? t.remote.awakeNote : t.remote.loggedInNote}</span>
          </div>
        </div>
      )}
      <ServerDialog
        open={askServer}
        onClose={() => setAskServer(false)}
        onSaved={() => {
          setAskServer(false);
          void enable();
        }}
      />
      <PcsDialog mac={mac} open={showPcs} onClose={() => setShowPcs(false)} />
      {confirmOff && (
        <Dialog
          open
          size="sm"
          icon={confirmOff === 'unreachable' ? 'wifiOff' : 'globe'}
          title={confirmOff === 'unreachable' ? t.remote.unreachableTitle(mac.label) : t.remote.offTitle(mac.label)}
          onClose={() => setConfirmOff(null)}
          footer={
            confirmOff === 'unreachable' ? (
              <>
                <Button variant="danger" onClick={() => void disable(true)}>
                  {t.remote.turnOffHere}
                </Button>
                <Button onClick={() => setConfirmOff(null)} data-autofocus>
                  {t.common.cancel}
                </Button>
              </>
            ) : (
              <>
                <Button variant="accent" onClick={() => void disable(false)}>
                  {t.remote.turnOff}
                </Button>
                <Button onClick={() => setConfirmOff(null)} data-autofocus>
                  {t.common.cancel}
                </Button>
              </>
            )
          }
        >
          {confirmOff === 'unreachable' ? (
            <p>{t.remote.unreachableBody}</p>
          ) : (
            <p>{t.remote.offBody(mac.label, remote.keepAwake)}</p>
          )}
        </Dialog>
      )}
    </section>
  );
}
