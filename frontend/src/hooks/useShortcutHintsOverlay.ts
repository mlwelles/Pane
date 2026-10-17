import { useState, useEffect, useRef, useCallback } from 'react';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../stores/configStore';
import { isTerminalInputTarget } from '../utils/terminalKeyHandling';

const HOLD_DELAY_MS = 300;

interface ShortcutHintsOverlayState {
  isVisible: boolean;
}

export function useShortcutHintsOverlay(): ShortcutHintsOverlayState {
  const keyboardShortcutsEnabled = useConfigStore((state) => areKeyboardShortcutsEnabled(state.config));
  const terminalKeyboardPreset = useConfigStore(state => state.config?.terminalKeyboardPreset ?? 'standard');
  const [isVisible, setIsVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isShowingRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (isShowingRef.current) {
      isShowingRef.current = false;
      setIsVisible(false);
    }
  }, []);

  useEffect(() => {
    cancel();
    if (!keyboardShortcutsEnabled) {
      return;
    }

    const isModifierKey = (key: string) =>
      key === 'Meta' || key === 'Control' || key === 'Alt';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (terminalKeyboardPreset === 'readline-friendly' && isTerminalInputTarget(e.target)) {
        cancel();
        return;
      }
      if (e.repeat) return;

      // Non-modifier key pressed — cancel/dismiss
      if (!isModifierKey(e.key)) {
        cancel();
        return;
      }

      // Both ctrl/cmd AND alt must be held
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (!ctrlOrMeta || !e.altKey) return;

      // Suppress when modal is open
      if (document.querySelector('[aria-modal="true"]')) return;

      // Already showing or timer pending
      if (isShowingRef.current || timerRef.current) return;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (terminalKeyboardPreset === 'readline-friendly' && isTerminalInputTarget(document.activeElement)) return;
        isShowingRef.current = true;
        setIsVisible(true);
      }, HOLD_DELAY_MS);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isModifierKey(e.key)) cancel();
    };

    const handleBlur = () => cancel();
    const handleFocus = () => {
      if (terminalKeyboardPreset === 'readline-friendly' && isTerminalInputTarget(document.activeElement)) cancel();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focusin', handleFocus);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focusin', handleFocus);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [cancel, keyboardShortcutsEnabled, terminalKeyboardPreset]);

  return { isVisible };
}
