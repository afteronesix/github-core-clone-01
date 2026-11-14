// The pkt-line codec (git's framing): 4-hex-length prefix (the length includes the
// 4 header bytes), `0000` flush, `0001` delim, `0002` response-end, max 65520 bytes
// a packet (git's LARGE_PACKET_MAX). The server reads whole request bodies, so the
// decoder works on a complete Buffer and reports where it stopped — receive-pack
// needs the bytes after the command list's flush (the pack follows unframed).

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** The sideband payload cap the server chunks pack bytes at (well under the max). */
export const SIDEBAND_CHUNK = 32768;

/** One decoded pkt-line. */
export type PktLine =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Thrown when a pkt-line stream is malformed; the caller answers 400, never crashes. */
export class PktLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktLineError';
  }
}

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new PktLineError(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet, `0000`. */
export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet, `0001`. */
export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a mixed sequence; `'flush'`/`'delim'`/`'response-end'` are the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPktLines {
  readonly packets: PktLine[];
  /** Offset just past the last packet consumed (the start of any trailing raw bytes). */
  readonly consumed: number;
}

/**
 * Decode pkt-lines from `buffer` starting at `start`, stopping at the first flush
 * (when `stopAtFlush` is set) or at the end of the buffer. Returns the packets and
 * the offset consumed, so a caller can take trailing raw bytes (a pack) afterwards.
 * Throws PktLineError on a malformed header or a truncated packet.
 */
export function decodePktLines(buffer: Buffer, start = 0, stopAtFlush = false): DecodedPktLines {
  const packets: PktLine[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new PktLineError(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    }
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new PktLineError(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) {
      throw new PktLineError(`invalid pkt-line length ${length}`);
    }
    if (offset + length > buffer.length) {
      throw new PktLineError(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly PktLine[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

/**
 * Frame `data` as sideband packets on `band` (1 = data, 2 = progress), each payload
 * chunked to SIDEBAND_CHUNK bytes plus the 1 band byte. Returns the pkt-line stream.
 */
export function encodeSideband(data: Buffer, band: 1 | 2): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_CHUNK));
    const framed = Buffer.allocUnsafe(chunk.length + 1);
    framed[0] = band;
    chunk.copy(framed, 1);
    parts.push(encodePktLine(framed));
  }
  return Buffer.concat(parts);
}
