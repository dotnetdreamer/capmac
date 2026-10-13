import { useState } from 'react';
import type { PromptRequest } from '../../shared/contract';
import { t, tidy } from '../../shared/i18n';
import { usePrompts } from '../state/app';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { PasswordField, TextField } from '../ui/Form';
import { Rich } from '../ui/Rich';

const PASSWORD_TITLES: Record<string, (mac: string) => string> = {
  pair: t.prompts.signIn,
  keychain: t.prompts.keychain,
  sudo: t.prompts.admin,
};

const PASSWORD_WHY: Record<string, string> = {
  pair: t.prompts.signInWhy,
  keychain: t.prompts.keychainWhy,
  sudo: t.prompts.adminWhy,
};

function PasswordPrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'password' }> }) {
  const answer = usePrompts((s) => s.answer);
  const [value, setValue] = useState('');
  const mac = prompt.mac ?? t.common.theMac;
  return (
    <Dialog
      open
      size="sm"
      icon="key"
      title={PASSWORD_TITLES[prompt.purpose]?.(mac) ?? t.prompts.macPassword}
      onClose={() => answer(prompt.id, false)}
      onSubmit={() => value && answer(prompt.id, true, value)}
      footer={
        <>
          <Button type="submit" variant="accent" disabled={!value}>
            {prompt.purpose === 'keychain' ? t.prompts.unlock : t.common.continue}
          </Button>
          <Button onClick={() => answer(prompt.id, false)}>{t.common.cancel}</Button>
        </>
      }
    >
      <p className="muted">{PASSWORD_WHY[prompt.purpose]}</p>
      <PasswordField label={prompt.user ? t.prompts.passwordFor(prompt.user) : t.prompts.password} value={value} onChange={(e) => setValue(e.target.value)} data-autofocus />
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
      title={tidy(prompt.message)}
      onClose={() => answer(prompt.id, true, false)}
      footer={
        <>
          <Button variant={prompt.danger ? 'danger' : 'accent'} onClick={() => answer(prompt.id, true, true)} data-autofocus>
            {prompt.confirmLabel ?? t.common.continue}
          </Button>
          <Button onClick={() => answer(prompt.id, true, false)}>{t.common.cancel}</Button>
        </>
      }
    >
      {fingerprint ? (
        <>
          <p className="muted">{t.prompts.hostKey}</p>
          <code className="fingerprint selectable">{fingerprint}</code>
          <p className="faint">
            <Rich text={t.prompts.hostKeyCheck} />
          </p>
        </>
      ) : (
        prompt.detail && <p className="muted selectable" style={{ whiteSpace: 'pre-wrap' }}>{tidy(prompt.detail)}</p>
      )}
    </Dialog>
  );
}

function ChoosePrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'choose' }> }) {
  const answer = usePrompts((s) => s.answer);
  return (
    <Dialog open title={tidy(prompt.message)} onClose={() => answer(prompt.id, false)} footer={<Button onClick={() => answer(prompt.id, false)}>{t.common.cancel}</Button>}>
      <div className="choose-list" role="listbox" aria-label={tidy(prompt.message)}>
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
      title={tidy(prompt.message)}
      onClose={() => answer(prompt.id, false)}
      onSubmit={() => answer(prompt.id, true, value)}
      footer={
        <>
          <Button type="submit" variant="accent">
            {t.common.ok}
          </Button>
          <Button onClick={() => answer(prompt.id, false)}>{t.common.cancel}</Button>
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
