// git-receive-pack: the write side of smart HTTP — the v0 advertisement and
// the push exchange. Unpack FIRST, then apply refs: a refused update still
// reports `unpack ok`, and only the fast-forward refs move.

import { decodePktLines, encodePktLine, encodePktLines, encodeSideband, pktLineFlush, PktLineError, type PktLine } from './pktline.ts';
import { readPack } from './pack.ts';
import { GitObjectError, isObjectId, ZERO_OID } from './objects.ts';
import { checkFastForward, deleteRef, headOid, isRefTarget, listRefs, peelTag, setRef } from './refs.ts';
import { RECEIVE_ADVERTISEMENT_TYPE, RECEIVE_RESULT_TYPE, SERVER_AGENT, type GitResponse } from './upload-pack.ts';
import type { RepoRecord } from '../store/store.ts';

/** The receive-pack v0 capability list. `report-status-v2` is NOT advertised. */
export const RECEIVE_V0_CAPABILITIES = `report-status side-band-64k delete-refs ofs-delta agent=${SERVER_AGENT}`;

/**
 * The receive-pack v0 advertisement: service preamble, then ref lines, the
 * first carrying the capabilities after a NUL. An empty repo advertises only
 * `ZERO capabilities^{}` with the capabilities.
 */
export function advertisementReceivePack(repo: RepoRecord): GitResponse {
  const refs = listRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${RECEIVE_V0_CAPABILITIES}\n`);
  } else {
    const head = headOid(repo);
    lines.push(`${head} HEAD\u0000${RECEIVE_V0_CAPABILITIES}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peelTag(repo, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  const body = Buffer.concat([
    encodePktLine('# service=git-receive-pack\n'),
    pktLineFlush(),
    encodePktLines([...lines, 'flush']),
  ]);
  return { status: 200, contentType: RECEIVE_ADVERTISEMENT_TYPE, body };
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface ParsedPush {
  readonly commands: PushCommand[];
  /** True when the client asked for sideband framing of the report. */
  readonly sideband: boolean;
  /** The pack bytes after the command list's flush (empty for delete-only pushes). */
  readonly pack: Buffer;
}

/** Parse a receive-pack body: pkt-line command list, flush, then raw pack bytes. */
function parsePush(body: Buffer): ParsedPush {
  const { packets, consumed } = decodePktLines(body, 0, true);
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        const caps = text.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length !== 3) throw new PktLineError(`bad push command ${JSON.stringify(text.slice(0, 80))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) {
      throw new PktLineError(`push command has a bad object id: ${JSON.stringify(text.slice(0, 80))}`);
    }
    if (!ref.startsWith('refs/')) throw new PktLineError(`push command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new PktLineError('push has no commands');
  return { commands, sideband, pack: body.subarray(consumed) };
}

/**
 * Frame the report-status stream: pkt-lined report lines, inside sideband
 * band 1 when the client asked for it (it always does — the advertisement
 * carries side-band-64k), then a flush. Without sideband the report is the
 * pkt-line stream directly.
 */
function frameReport(lines: readonly string[], sideband: boolean): Buffer {
  const report = encodePktLines(lines);
  if (!sideband) return Buffer.concat([report, pktLineFlush()]);
  return Buffer.concat([encodeSideband(report, 1), pktLineFlush()]);
}

/**
 * Handle a push. Unpack first (a thin pack resolves bases from the repo's
 * store); on unpack failure report `unpack <detail>` and touch no refs.
 * Then judge each command in order: a missing new object is `ng <ref>
 * missing object`, a non-fast-forward is `ng <ref> non-fast-forward`
 * (that exact reason — the suite asserts it), and only the accepted
 * commands move refs. HTTP 200 even for refused refs.
 */
export function handleReceivePack(repo: RepoRecord, body: Buffer): GitResponse {
  const parsed = parsePush(body);

  // Unpack first. A delete-only push carries no pack at all; a push with no
  // new objects carries the valid 32-byte empty pack.
  if (parsed.pack.length > 0) {
    let unpacked;
    try {
      unpacked = readPack(parsed.pack, {
        resolveBase: (oid) => repo.objects.get(oid),
      });
      if (!unpacked.checksumOk) {
        throw new GitObjectError('pack trailer does not match its bytes', 'pack-checksum');
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const report = frameReport([`unpack ${detail}\n`], parsed.sideband);
      return { status: 200, contentType: RECEIVE_RESULT_TYPE, body: report };
    }
    for (const [oid, object] of unpacked.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  const reportLines: string[] = ['unpack ok\n'];
  for (const command of parsed.commands) {
    if (command.newOid !== ZERO_OID && !isRefTarget(repo, command.newOid)) {
      reportLines.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    const verdict = checkFastForward(repo, command.ref, command.oldOid, command.newOid);
    if (!verdict.ok) {
      reportLines.push(`ng ${command.ref} ${verdict.reason}\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) deleteRef(repo, command.ref);
    else setRef(repo, command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  return { status: 200, contentType: RECEIVE_RESULT_TYPE, body: frameReport(reportLines, parsed.sideband) };
}

/** True when a body parses as a push at all (used only by tests, not the router). */
export function isPushBody(body: Buffer): boolean {
  try {
    parsePush(body);
    return true;
  } catch {
    return false;
  }
}
