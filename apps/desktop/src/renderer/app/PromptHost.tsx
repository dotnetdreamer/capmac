import { useState, type CSSProperties } from 'react';
import type { PromptRequest } from '../../shared/contract';
import { t, tidy } from '../../shared/i18n';
import { usePrompts } from '../state/app';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Feedback';
import { PasswordField, TextField } from '../ui/Form';
import { Icon } from '../ui/Icon';
import { Rich } from '../ui/Rich';

const PASSWORD_TITLES: Record<string, (mac: string) => string> = {
  pair: t.prompts.signIn,
  keychain: t.prompts.keychain,
  sudo: t.prompts.admin,
  signing: () => t.prompts.signing,
  apple: () => t.prompts.apple,
};

const PASSWORD_WHY: Record<string, string> = {
  pair: t.prompts.signInWhy,
  keychain: t.prompts.keychainWhy,
  sudo: t.prompts.adminWhy,
  signing: t.prompts.signingWhy,
  apple: t.prompts.appleWhy,
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
      onSubmit={() => (value || prompt.purpose === 'signing') && answer(prompt.id, true, value)}
      footer={
        <>
          <Button type="submit" variant="accent" disabled={!value && prompt.purpose !== 'signing'}>
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
  const link = prompt.link;
  // Waiting on something else (a sign-in in the browser): the buttons are ways out, none is the next step.
  const waiting = prompt.waiting;
  return (
    <Dialog
      open
      size={fingerprint || link || waiting ? 'md' : 'sm'}
      icon={fingerprint ? 'shield' : prompt.danger ? 'warning' : waiting ? 'globe' : undefined}
      title={tidy(prompt.message)}
      onClose={() => answer(prompt.id, true, false)}
      footer={
        <>
          {/* The web page the question is about (Apple's website for a certificate, …). */}
          {link && (
            <Button icon="open" onClick={() => void window.capmac.invoke('app:open-external', { url: link.url })}>
              {link.label}
            </Button>
          )}
          <Button
            variant={waiting ? 'standard' : prompt.danger ? 'danger' : 'accent'}
            icon={waiting ? 'refresh' : undefined}
            onClick={() => answer(prompt.id, true, true)}
            data-autofocus={link || waiting ? undefined : true}
          >
            {prompt.confirmLabel ?? t.common.continue}
          </Button>
          <Button onClick={() => answer(prompt.id, true, false)}>{prompt.cancelLabel ?? t.common.cancel}</Button>
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
      {waiting && (
        // Focus rests here, not on a button: a stray Enter mustn't restart or cancel.
        <div className="prompt-waiting" role="status" tabIndex={-1} data-autofocus>
          <Spinner size={16} />
          <span>{tidy(waiting)}</span>
        </div>
      )}
    </Dialog>
  );
}

function ChoosePrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'choose' }> }) {
  const answer = usePrompts((s) => s.answer);
  // Choices that need explaining (who makes the certificate, …) show as cards, each with its hint below.
  const described = Boolean(prompt.detail) || prompt.items.some((item) => (item.hint?.length ?? 0) > 40);
  return (
    <Dialog
      open
      size={described ? 'md' : undefined}
      title={tidy(prompt.message)}
      onClose={() => answer(prompt.id, false)}
      footer={<Button onClick={() => answer(prompt.id, false)}>{t.common.cancel}</Button>}
    >
      {prompt.detail && <p className="muted selectable" style={{ whiteSpace: 'pre-wrap' }}>{tidy(prompt.detail)}</p>}
      {described ? (
        <div className="choose-cards" role="list" aria-label={tidy(prompt.message)}>
          {prompt.items.map((item, index) => (
            <button
              key={index}
              type="button"
              role="listitem"
              className="choose-card"
              style={{ '--i': index } as CSSProperties}
              onClick={() => answer(prompt.id, true, index)}
              data-autofocus={index === 0 ? true : undefined}
            >
              <span className="choose-card__text">
                <span className="choose-card__label">{tidy(item.label)}</span>
                {item.hint && <span className="choose-card__hint">{tidy(item.hint)}</span>}
              </span>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
        </div>
      ) : (
        <div className="choose-list" role="listbox" aria-label={tidy(prompt.message)}>
          {prompt.items.map((item, index) => (
            <button key={index} type="button" role="option" aria-selected={false} className="choose-list__item" onClick={() => answer(prompt.id, true, index)}>
              <span>{item.label}</span>
              {item.hint && <span className="faint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** Apple's sign-in asks its email and verification code with these; other text prompts show the engine's question. */
function textPromptLook(prompt: Extract<PromptRequest, { kind: 'text' }>) {
  if (prompt.purpose === 'apple-email') {
    return { title: t.prompts.appleEmail, why: t.prompts.appleEmailWhy, label: t.prompts.appleEmailLabel, icon: 'lock' as const, input: { type: 'email', autoComplete: 'username' } };
  }
  if (prompt.purpose === 'apple-code') {
    return { title: t.prompts.appleCode, why: tidy(prompt.message), label: t.prompts.appleCodeLabel, icon: 'shield' as const, input: { inputMode: 'numeric' as const, autoComplete: 'one-time-code' } };
  }
  return { title: tidy(prompt.message), why: undefined, label: undefined, icon: undefined, input: {} };
}

function TextPrompt({ prompt }: { prompt: Extract<PromptRequest, { kind: 'text' }> }) {
  const answer = usePrompts((s) => s.answer);
  const [value, setValue] = useState(prompt.defaultValue ?? '');
  const look = textPromptLook(prompt);
  // Apple's sign-in needs an answer; other questions take an empty one.
  const needed = Boolean(prompt.purpose);
  return (
    <Dialog
      open
      size="sm"
      icon={look.icon}
      title={look.title}
      onClose={() => answer(prompt.id, false)}
      onSubmit={() => (value.trim() || !needed) && answer(prompt.id, true, value)}
      footer={
        <>
          <Button type="submit" variant="accent" disabled={needed && !value.trim()}>
            {needed ? t.common.continue : t.common.ok}
          </Button>
          <Button onClick={() => answer(prompt.id, false)}>{t.common.cancel}</Button>
        </>
      }
    >
      {look.why && <p className="muted">{look.why}</p>}
      <TextField label={look.label} value={value} placeholder={prompt.placeholder} onChange={(e) => setValue(e.target.value)} data-autofocus {...look.input} />
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
