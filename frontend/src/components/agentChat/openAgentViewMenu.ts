import type { MouseEvent } from 'react';

export function openAgentViewMenu(event: MouseEvent<HTMLElement>): void {
  const trigger = event.currentTarget.querySelector<HTMLButtonElement>('[data-agent-view-menu]');
  if (!trigger) return;
  event.preventDefault();
  trigger.focus();
  trigger.click();
}
