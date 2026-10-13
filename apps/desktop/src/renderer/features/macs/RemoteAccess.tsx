import { useEffect, useState, type ReactNode } from 'react';
import { shortKey, signalUrlProblem } from '@capmac/core/shared/remote';
import type { MacSummary, RelayChoice, RouteChoice } from '../../../shared/contract';
import { timeAgo } from '../../lib/format';
import { RELAY_HINT, RELAY_LABEL, revokePc, ROUTE_HINT, ROUTE_LABEL, routeText, setOptions, testConnection, turnOff, turnOn, useRemote } from '../../state/remote';
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
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const saved = await useRemote.getState().setServer(value.trim());
      if (saved.url) onSaved(saved.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      size="sm"
      icon="globe"
      title="Your signaling server"
      onClose={onClose}
      onSubmit={() => void save()}
      footer={
        <>
          <Button type="submit" variant="accent" busy={busy}>
            Continue
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p>
        Remote access goes through a small server of your own: it introduces this PC to the Mac, and relays the connection when the two networks can’t connect directly. It never sees inside the connection.{' '}
        <a href={DEPLOY_GUIDE_URL} onClick={(e) => {
          e.preventDefault();
          void window.capmac.invoke('app:open-external', { url: DEPLOY_GUIDE_URL });
        }}>How to deploy it</a>
      </p>
      <TextField label="Server address" placeholder="wss://signal.example.com" value={value} onChange={(e) => {
        setValue(e.target.value);
        setError(null);
      }} error={error} hint="CapMac remembers it (Settings › Remote access)." data-autofocus />
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
    <Dialog open={open} size="md" icon="key" title={`PCs that can reach ${mac.label}`} onClose={onClose} footer={<Button onClick={onClose} data-autofocus>Close</Button>}>
      <p className="faint">Each PC has its own key. Remove one you no longer use: it can no longer reach the Mac over the internet (on the Mac’s network, SSH still works).</p>
      {entry?.status === 'loading' && !entry.report ? (
        <div className="mac-remote__loading">
          <Spinner size={16} /> Asking the Mac…
        </div>
      ) : entry?.status === 'error' ? (
        <p className="mac-remote__warn">{entry.error?.message}</p>
      ) : (
        <ul className="mac-remote__pcs">
          {pcs.map((pc) => (
            <li key={pc.key}>
              <Icon name="desktop" size={20} />
              <div className="mac-remote__pc">
                <div className="mac-remote__pc-name">
                  <span className="truncate">{pc.name}</span>
                  {pc.current && <Badge tone="accent">This PC</Badge>}
                </div>
                <div className="mac-remote__pc-meta">
                  <span className="mono">{shortKey(pc.key)}</span> · added {timeAgo(Date.parse(pc.addedAt))}
                </div>
              </div>
              {!pc.current && (
                <Button size="sm" variant="subtle" icon="delete" busy={removing === pc.key} onClick={() => {
                  setRemoving(pc.key);
                  void revokePc(mac, pc.key, pc.name).finally(() => setRemoving(null));
                }}>
                  Remove
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
  let status: ReactNode;
  let tone: 'ok' | 'warn' | 'idle' = 'idle';
  if (!remote.enabled) {
    status = 'Off. Turn it on to build and run on this Mac when you are away from its network.';
  } else if (isConnected && mac.route) {
    tone = doorState && doorState !== 'online' ? 'warn' : 'ok';
    const rtt = mac.route !== 'lan' && mac.rttMs !== null ? ` · ${mac.rttMs} ms` : '';
    const online = doorState === 'online'
      ? ` The Mac is online at ${door?.status?.server ?? remote.signalUrl}.`
      : doorState
        ? ` The Mac cannot reach the signaling server right now${door?.status?.error ? ` (${door.status.error})` : ''}.`
        : '';
    status = <>Connected {routeText(mac.route)}{rtt}.{online}</>;
  } else {
    status = 'On. When the Mac is not on this network, CapMac connects over the internet.';
  }
  const movable = remote.enabled && server?.url && remote.signalUrl && server.url !== remote.signalUrl;

  return (
    <section className="mac-remote" aria-label="Remote access">
      <div className="mac-remote__row">
        <span className={`mac-remote__icon mac-remote__icon--${tone}`}>
          <Icon name="globe" size={18} />
        </span>
        <div className="mac-remote__text">
          <div className="mac-remote__title">Reach this Mac from anywhere</div>
          <div className={`mac-remote__desc${tone === 'warn' ? ' mac-remote__warn' : ''}`}>{status}</div>
        </div>
        <Toggle label={`Reach ${mac.label} from anywhere`} checked={remote.enabled} loading={busy === 'toggle'} disabled={busy !== null} onChange={toggle} />
      </div>
      {remote.enabled && (
        <div className="mac-remote__options">
          <div className="mac-remote__option">
            <span className="mac-remote__label">Connection</span>
            <Select<RouteChoice>
              label="Connection"
              value={remote.route}
              width={230}
              onChange={(route) => void setOptions(mac, { route })}
              options={(['auto', 'lan', 'internet'] as const).map((value) => ({ value, label: ROUTE_LABEL[value], hint: ROUTE_HINT[value] }))}
            />
          </div>
          <div className="mac-remote__option">
            <span className="mac-remote__label">Keep this Mac awake</span>
            <Toggle
              label="Keep this Mac awake"
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
            <span className="mac-remote__label">Relay</span>
            <Select<RelayChoice>
              label="Relay"
              value={remote.relay}
              width={230}
              onChange={(relay) => void setOptions(mac, { relay })}
              options={(['allow', 'never', 'always'] as const).map((value) => ({ value, label: RELAY_LABEL[value], hint: RELAY_HINT[value] }))}
            />
          </div>
          <div className="mac-remote__actions">
            <Button size="sm" icon="plugConnected" busy={busy === 'test'} disabled={busy !== null} onClick={() => {
              setBusy('test');
              void testConnection(mac).finally(() => setBusy(null));
            }}>
              Test over the internet
            </Button>
            <Button size="sm" icon="key" onClick={() => setShowPcs(true)}>
              PCs{entry?.report ? ` (${entry.report.pcs.length})` : ''}
            </Button>
            {movable && (
              <Button size="sm" icon="sync" busy={busy === 'move'} disabled={busy !== null} onClick={() => {
                setBusy('move');
                void setOptions(mac, { signalUrl: server!.url! }).finally(() => setBusy(null));
              }}>
                Move to {new URL(server!.url!.replace(/^ws/, 'http')).host}
              </Button>
            )}
            <span className="mac-remote__fine faint">{remote.keepAwake ? 'A MacBook with its lid closed and no display sleeps anyway.' : 'It runs while you are logged in on the Mac.'}</span>
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
          title={confirmOff === 'unreachable' ? `${mac.label} can’t be reached` : `Turn off remote access for ${mac.label}?`}
          onClose={() => setConfirmOff(null)}
          footer={
            confirmOff === 'unreachable' ? (
              <>
                <Button variant="danger" onClick={() => void disable(true)}>
                  Turn off on this PC
                </Button>
                <Button onClick={() => setConfirmOff(null)} data-autofocus>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button variant="accent" onClick={() => void disable(false)}>
                  Turn off
                </Button>
                <Button onClick={() => setConfirmOff(null)} data-autofocus>
                  Cancel
                </Button>
              </>
            )
          }
        >
          {confirmOff === 'unreachable' ? (
            <p>CapMac could not tell the Mac. Turn remote access off on this PC only? The Mac still lists this PC until you turn it off from its network.</p>
          ) : (
            <p>This PC will reach {mac.label} only on its network. The Mac stops letting this PC in over the internet{remote.keepAwake ? ', and can sleep again' : ''}.</p>
          )}
        </Dialog>
      )}
    </section>
  );
}
