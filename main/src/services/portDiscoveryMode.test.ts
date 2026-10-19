import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { supportsPassivePortDiscovery } from '../../../shared/types/listeningPorts';
import { bindPortDiscoveryMode, readPortDiscoveryMode } from './portDiscoveryMode';
import { vi } from 'vitest';

describe('port discovery mode', () => {
  it.each([undefined, 'active', 'passive'])('accepts %s', value => {
    expect(readPortDiscoveryMode(value)).toBe(value ?? 'active');
  });

  it.each([null, '', 'other', true, 1])('rejects invalid value %s', value => {
    expect(() => readPortDiscoveryMode(value)).toThrowError(expect.objectContaining({
      code: 'INVALID_PORT_DISCOVERY_MODE',
      next: expect.stringContaining('active'),
    }));
  });

  it.each([
    ['darwin', true], ['linux', true], ['win32', false], ['freebsd', false], [undefined, false],
  ])('reports Passive support for %s', (platform, supported) => {
    expect(supportsPassivePortDiscovery(platform)).toBe(supported);
  });

  it('delivers a saved change to the monitor synchronously through config-updated', () => {
    const config = new EventEmitter();
    const setMode = vi.fn();
    const unbind = bindPortDiscoveryMode(config, { setMode });
    config.emit('config-updated', { portDiscoveryMode: 'passive' });
    expect(setMode).toHaveBeenCalledWith('passive');
    unbind();
    config.emit('config-updated', { portDiscoveryMode: 'active' });
    expect(setMode).toHaveBeenCalledTimes(1);
  });
});
