import { describe, expect, it, vi } from 'vitest';
import { installTerminalInputFocusReporting } from './terminalInputFocus';

function fixture() {
  const documentState: Pick<Document, 'readyState' | 'activeElement' | 'hasFocus'> = {
    readyState: 'loading', activeElement: null, hasFocus: () => true,
  };
  const documentTarget = Object.assign(new EventTarget(), documentState);
  const windowTarget = new EventTarget();
  const report = vi.fn();
  // SAFETY: The doubles expose the document/window focus APIs used by the reporter.
  const dispose = installTerminalInputFocusReporting(documentTarget as Document, windowTarget as Window, report);
  // SAFETY: The element double implements the selector matching read by the reporter.
  const terminal = Object.assign(new EventTarget(), { matches: (selector: string) => selector === 'textarea.xterm-helper-textarea' }) as Element;
  return { documentTarget, windowTarget, report, dispose, terminal };
}

describe('document terminal input focus reporting', () => {
  it('reports initial terminal focus only after DOM readiness', () => {
    const f = fixture();
    expect(f.report).not.toHaveBeenCalled();
    f.documentTarget.activeElement = f.terminal;
    f.documentTarget.dispatchEvent(new Event('DOMContentLoaded'));
    expect(f.report).toHaveBeenLastCalledWith(true);
    f.dispose();
  });

  it('follows focus into terminals, dialogs and embedded webviews', async () => {
    const f = fixture();
    f.documentTarget.activeElement = f.terminal;
    f.documentTarget.dispatchEvent(new Event('focusin'));
    expect(f.report).toHaveBeenLastCalledWith(true);
    // SAFETY: A nonterminal element is represented by a nonmatching selector result.
    f.documentTarget.activeElement = Object.assign(new EventTarget(), { matches: () => false }) as Element;
    f.documentTarget.dispatchEvent(new Event('focusin'));
    expect(f.report).toHaveBeenLastCalledWith(false);
    f.documentTarget.activeElement = f.terminal;
    f.documentTarget.dispatchEvent(new Event('focusin'));
    f.documentTarget.dispatchEvent(new Event('focusout'));
    f.documentTarget.activeElement = null;
    await Promise.resolve();
    expect(f.report).toHaveBeenLastCalledWith(false);
    f.dispose();
  });

  it('clears focus on window blur and rereads it on refocus', () => {
    const f = fixture();
    f.documentTarget.activeElement = f.terminal;
    f.windowTarget.dispatchEvent(new Event('focus'));
    expect(f.report).toHaveBeenLastCalledWith(true);
    f.windowTarget.dispatchEvent(new Event('blur'));
    expect(f.report).toHaveBeenLastCalledWith(false);
    f.windowTarget.dispatchEvent(new Event('focus'));
    expect(f.report).toHaveBeenLastCalledWith(true);
    f.dispose();
  });

  it('removes listeners and ignores pending focusout updates after disposal', async () => {
    const f = fixture();
    f.documentTarget.dispatchEvent(new Event('focusout'));
    f.dispose();
    f.documentTarget.dispatchEvent(new Event('focusin'));
    f.windowTarget.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(f.report).not.toHaveBeenCalled();
  });
});
