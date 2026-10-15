import { describe, expect, it } from 'vitest';
import { SoundControl } from '../../packages/core/src/electron-hook/sound.js';

/** A page of the app: `muted` is what plays on the Mac. */
class Page {
  static next = 1;
  id = Page.next++;
  muted = false;
  destroyed = false;
  setAudioMuted(muted: boolean) {
    this.muted = muted;
  }
  isAudioMuted() {
    return this.muted;
  }
  isDestroyed() {
    return this.destroyed;
  }
}

function control(mode: 'off' | 'mac' | 'pc', electron: object = {}) {
  const pages: Page[] = [];
  const notes: string[] = [];
  const sound = new SoundControl(electron, mode, { pages: () => pages, onPackets: () => undefined, note: (m) => notes.push(m) });
  const open = () => {
    const page = new Page();
    pages.push(page);
    sound.track(page);
    return page;
  };
  return { sound, open, notes };
}

describe('where an Electron app’s sound plays', () => {
  it('is off by default on the Mac, while the app still sees its own setting', () => {
    const { open } = control('off');
    const page = open();
    expect(page.muted).toBe(true);
    expect(page.isAudioMuted()).toBe(false);
  });

  it('plays on the Mac when asked, and keeps the app’s own muting', () => {
    const { sound, open } = control('off');
    const page = open();
    sound.setMode('mac');
    expect(page.muted).toBe(false);
    page.setAudioMuted(true);
    expect(page.muted).toBe(true);
    expect(page.isAudioMuted()).toBe(true);
    sound.setMode('off');
    sound.setMode('mac');
    // The app muted it: it stays muted.
    expect(page.muted).toBe(true);
    page.setAudioMuted(false);
    expect(page.muted).toBe(false);
    // Windows opened later follow the setting.
    expect(open().muted).toBe(false);
  });

  it('keeps the Mac quiet when the sound plays on the PC, and says so when this Electron cannot send it', () => {
    const { sound, open, notes } = control('mac');
    const page = open();
    sound.setMode('pc');
    expect(page.muted).toBe(true);
    expect(sound.canSendToPc).toBe(false);
    expect(notes.join('\n')).toMatch(/Electron 30/);
    sound.setListeners(1);
    expect(page.muted).toBe(true);
  });

  it('can send it to the PC with Electron 30’s WebContentsView', () => {
    const { sound } = control('off', { WebContentsView: class {}, session: { fromPartition: () => ({}) } });
    expect(sound.canSendToPc).toBe(true);
  });
});
