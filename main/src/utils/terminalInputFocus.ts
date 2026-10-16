export function installTerminalInputFocusReporting(
  document: Document,
  window: Window,
  report: (focused: boolean) => void,
  reportRecording?: (focused: boolean) => void,
): () => void {
  let disposed = false;
  let recordingFocused = false;
  const reportRecordingFocus = () => {
    if (disposed || !reportRecording) return;
    const focused = document.hasFocus() && document.activeElement?.matches('[data-shortcut-recording="true"]') === true;
    if (focused !== recordingFocused) {
      recordingFocused = focused;
      reportRecording(focused);
    }
  };
  const reportFocus = () => {
    if (!disposed) report(document.hasFocus() && document.activeElement?.matches('textarea.xterm-helper-textarea') === true);
    reportRecordingFocus();
  };
  const reportBlur = () => {
    report(false);
    if (recordingFocused) {
      recordingFocused = false;
      reportRecording?.(false);
    }
  };
  const afterFocusOut = () => queueMicrotask(reportFocus);
  const observer = reportRecording ? new MutationObserver(reportRecordingFocus) : undefined;
  observer?.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-shortcut-recording'] });
  document.addEventListener('focusin', reportFocus, true);
  document.addEventListener('focusout', afterFocusOut, true);
  window.addEventListener('focus', reportFocus);
  window.addEventListener('blur', reportBlur);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportFocus, { once: true });
  else reportFocus();
  return () => {
    disposed = true;
    observer?.disconnect();
    if (recordingFocused) reportRecording?.(false);
    document.removeEventListener('focusin', reportFocus, true);
    document.removeEventListener('focusout', afterFocusOut, true);
    document.removeEventListener('DOMContentLoaded', reportFocus);
    window.removeEventListener('focus', reportFocus);
    window.removeEventListener('blur', reportBlur);
  };
}
