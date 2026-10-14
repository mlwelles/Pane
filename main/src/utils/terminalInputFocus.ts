export function installTerminalInputFocusReporting(
  document: Document,
  window: Window,
  report: (focused: boolean) => void,
): () => void {
  let disposed = false;
  const reportFocus = () => {
    if (!disposed) report(document.hasFocus() && document.activeElement?.matches('textarea.xterm-helper-textarea') === true);
  };
  const reportBlur = () => report(false);
  const afterFocusOut = () => queueMicrotask(reportFocus);
  document.addEventListener('focusin', reportFocus, true);
  document.addEventListener('focusout', afterFocusOut, true);
  window.addEventListener('focus', reportFocus);
  window.addEventListener('blur', reportBlur);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportFocus, { once: true });
  else reportFocus();
  return () => {
    disposed = true;
    document.removeEventListener('focusin', reportFocus, true);
    document.removeEventListener('focusout', afterFocusOut, true);
    document.removeEventListener('DOMContentLoaded', reportFocus);
    window.removeEventListener('focus', reportFocus);
    window.removeEventListener('blur', reportBlur);
  };
}
