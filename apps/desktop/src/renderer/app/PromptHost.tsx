import { useState } from 'react';
import type { PromptRequest } from '../../shared/contract';
import { usePrompts } from '../state/app';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { PasswordField, TextField } from '../ui/Form';

const PASSWORD_TITLES: Record<string, (mac: string) => string> = {
  pair: (mac) => `Sign in to ${mac}`,
  keychain: (mac) => `Unlock the keychain on ${mac}`,
  sudo: (mac) => `Administrator password for ${mac}`,
};

const PASSWORD_WHY: Record<string, string> = {
  pair: 'capmac uses it once to install its own SSH key. It is never stored.',
  keychain: 'Code signing over SSH needs the login keychain unlocked. capmac does not store your password.',
  sudo: 'This fix runs one command with sudo on the Mac. capmac does not store your password.',
};

function PasswordPrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'password' }> }) {
  const answer = usePrompts((s) => s.answer);
  const [value, setValue] = useState('');
  const mac = prompt.mac ?? 'the Mac';
  return (
    <Dialog
      open
      size="sm"
      icon="key"
      title={PASSWORD_TITLES[prompt.purpose]?.(mac) ?? 'Mac password'}
      onClose={() => answer(prompt.id, false)}
      onSubmit={() => value && answer(prompt.id, true, value)}
      footer={
        <>
          <Button type="submit" variant="accent" disabled={!value}>
            {prompt.purpose === 'keychain' ? 'Unlock' : 'Continue'}
          </Button>
          <Button onClick={() => answer(prompt.id, false)}>Cancel</Button>
        </>
      }
    >
      <p className="muted">{PASSWORD_WHY[prompt.purpose]}</p>
      <PasswordField label={prompt.user ? `Password for ${prompt.user}` : 'Password'} value={value} onChange={(e) => setValue(e.target.value)} data-autofocus />
    </Dialog>
  );
}

function ConfirmPrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'confirm' }> }) {
  const answer = usePrompts((s) => s.answer);
  const fingerprint = prompt.detail?.match(/SHA256:\S+/)?.[0];
  return (
    <Dialog
      open
      size={fingerprint ? 'md' : 'sm'}
      icon={fingerprint ? 'shield' : prompt.danger ? 'warning' : undefined}
      title={prompt.message}
      onClose={() => answer(prompt.id, true, false)}
      footer={
        <>
          <Button variant={prompt.danger ? 'danger' : 'accent'} onClick={() => answer(prompt.id, true, true)} data-autofocus>
            {prompt.confirmLabel ?? 'Continue'}
          </Button>
          <Button onClick={() => answer(prompt.id, true, false)}>Cancel</Button>
        </>
      }
    >
      {fingerprint ? (
        <>
          <p className="muted">This is the first time capmac connects to this Mac. Its SSH host key fingerprint is:</p>
          <code className="fingerprint selectable">{fingerprint}</code>
          <p className="faint">To double-check, run this in Terminal on the Mac: <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code></p>
        </>
      ) : (
        prompt.detail && <p className="muted selectable" style={{ whiteSpace: 'pre-wrap' }}>{prompt.detail}</p>
      )}
    </Dialog>
  );
}

function ChoosePrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'choose' }> }) {
  const answer = usePrompts((s) => s.answer);
  return (
    <Dialog open title={prompt.message} onClose={() => answer(prompt.id, false)} footer={<Button onClick={() => answer(prompt.id, false)}>Cancel</Button>}>
      <div className="choose-list" role="listbox" aria-label={prompt.message}>
        {prompt.items.map((item, index) => (
          <button key={index} type="button" role="option" aria-selected={false} className="choose-list__item" onClick={() => answer(prompt.id, true, index)}>
            <span>{item.label}</span>
            {item.hint && <span className="faint">{item.hint}</span>}
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function TextPrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'text' }> }) {
  const answer = usePrompts((s) => s.answer);
  const [value, setValue] = useState(prompt.defaultValue ?? '');
  return (
    <Dialog
      open
      size="sm"
      title={prompt.message}
      onClose={() => answer(prompt.id, false)}
      onSubmit={() => answer(prompt.id, true, value)}
      footer={
        <>
          <Button type="submit" variant="accent">
            OK
          </Button>
          <Button onClick={() => answer(prompt.id, false)}>Cancel</Button>
        </>
      }
    >
      <TextField value={value} placeholder={prompt.placeholder} onChange={(e) => setValue(e.target.value)} data-autofocus />
    </Dialog>
  );
}

/** Answers the engine's questions (passwords, confirmations) with dialogs, one at a time. */
export function PromptHost() {
  const prompt = usePrompts((s) => s.queue[0]);
  if (!prompt) return null;
  switch (prompt.kind) {
    case 'password':
      return <PasswordPrompt key={prompt.id} prompt={prompt} />;
    case 'confirm':
      return <ConfirmPrompt key={prompt.id} prompt={prompt} />;
    case 'choose':
      return <ChoosePrompt key={prompt.id} prompt={prompt} />;
    case 'text':
      return <TextPrompt key={prompt.id} prompt={prompt} />;
  }
}
