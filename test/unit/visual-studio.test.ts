import { describe, expect, it } from 'vitest';
import { windowsCommandLine } from '../../packages/core/src/engine/visual-studio.js';

describe('Visual Studio’s installer', () => {
  it('gets its arguments as one Windows command line (PowerShell’s Start-Process would split a path with spaces)', () => {
    expect(windowsCommandLine(['modify', '--installPath', 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community', '--passive']))
      .toBe('modify --installPath "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community" --passive');
  });

  it('keeps quotes and a trailing backslash as the C runtime reads them', () => {
    expect(windowsCommandLine(['has "quotes"'])).toBe('"has \\"quotes\\""');
    expect(windowsCommandLine(['ends with backslash\\'])).toBe('"ends with backslash\\\\"');
    expect(windowsCommandLine([''])).toBe('""');
  });
});
