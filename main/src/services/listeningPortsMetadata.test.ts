import { describe, expect, it } from 'vitest';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { decodeListeningPortsSnapshot } from '../../../shared/types/listeningPorts';

const port = { port: 5173, pid: null, process: 'callback', group: 'other', kind: 'tcp' };

describe('listening port snapshot metadata', () => {
  it('preserves unchecked and phone decorations across a boundary', () => {
    const snapshot = {
      host: 'host', discoveryMode: 'passive', phone: { state: 'on', filesUrl: 'https://example.test/files' },
      ports: [{ ...port, probeStatus: 'unchecked', phoneUrl: 'https://example.test/preview', forwardingError: {
        code: 'PORT_CHECK_FAILED', message: 'Could not check the port.', next: 'Retry forwarding.',
      } }],
    };
    expect(decodeListeningPortsSnapshot(snapshot)).toEqual(snapshot);
  });

  it('still decodes old snapshots', () => {
    expect(decodeListeningPortsSnapshot({ host: 'host', ports: [port] })).toEqual({ host: 'host', ports: [port] });
  });

  it('rejects invalid metadata', () => {
    expect(decodeListeningPortsSnapshot({ host: 'host', discoveryMode: 'invalid', ports: [port] })).toBeNull();
    expect(decodeListeningPortsSnapshot({ host: 'host', ports: [{ ...port, probeStatus: 'web' }] })).toBeNull();
  });

  it('keeps the passive wire shape readable by an old decoder', () => {
    const oldSchema = boundary.object({ host: boundary.string, ports: boundary.array(boundary.object({
      port: boundary.number, pid: boundary.nullable(boundary.number), process: boundary.string,
      group: boundary.enumeration('pane-terminal', 'other', 'system', 'pane'), kind: boundary.enumeration('web', 'tcp'),
    })) });
    expect(decodeBoundary({ host: 'host', discoveryMode: 'passive', ports: [{ ...port, probeStatus: 'unchecked' }] }, oldSchema))
      .toEqual({ host: 'host', ports: [port] });
  });
});
