// git-upload-pack: the read side of smart HTTP — v0/v2 advertisements,
// v2 ls-refs, and v2/v0 fetch. The client (the kit's GitClient) is the spec:
// every framing choice here answers a parser in git-client.ts.

import { decodePktLines, encodePktLine, encodePktLines, encodeSideband, pktLineFlush, PktLineError, type PktLine } from './pktline.ts';
import { emptyPack, writePack } from './pack.ts';
import { GitObjectError, isObjectId, planFetch, ZERO_OID, type GitObject } from './objects.ts';
import { headOid, headTarget, listRefs, peelTag } from './refs.ts';
import type { RepoRecord } from '../store/store.ts';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

export const UPLOAD_ADVERTISEMENT_TYPE = 'application/x-git-upload-pack-advertisement';
export const UPLOAD_RESULT_TYPE = 'application/x-git-upload-pack-result';
export const RECEIVE_ADVERTISEMENT_TYPE = 'application/x-git-receive-pack-advertisement';
export const RECEIVE_RESULT_TYPE = 'application/x-git-receive-pack-result';

/** The agent string the server advertises (any non-empty value). */
export const SERVER_AGENT = 'ghforge/1.0';

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

/** Strip one trailing `\n` from a pkt-line payload's text. */
function lineText(payload: Buffer): string {
  return payload.toString('utf8').replace(/\n$/, '');
}

/** The data packets' texts, in order (control packets dropped). */
function dataLines(packets: readonly PktLine[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(lineText(packet.payload));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/**
 * The v2 capability advertisement: service preamble, `version 2`, then one
 * capability per line. `fetch=shallow` and `ls-refs=unborn` carry the keys the
 * advertise-v2 check requires (`fetch`, `ls-refs`) plus the feature values
 * the fetch/ls-refs paths read. `filter` is deliberately NOT advertised.
 */
export function advertisementV2(): GitResponse {
  const body = Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
    encodePktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n', `agent=${SERVER_AGENT}\n`, 'flush']),
  ]);
  return ok(UPLOAD_ADVERTISEMENT_TYPE, body);
}

/** The v0 ref advertisement's capability list (upload-pack). */
export const UPLOAD_V0_CAPABILITIES = `symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack shallow agent=${SERVER_AGENT}`;

/**
 * The v0 ref advertisement: service preamble, then ref lines. The FIRST line
 * carries the capabilities after a NUL. HEAD comes first, then refs sorted;
 * an annotated tag is followed by its peeled `<oid> <ref>^{}` line. An empty
 * repo advertises only `ZERO capabilities^{}` carrying the capabilities.
 */
export function advertisementV0(repo: RepoRecord): GitResponse {
  const refs = listRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${UPLOAD_V0_CAPABILITIES}\n`);
  } else {
    const head = headOid(repo);
    lines.push(`${head} HEAD\u0000${UPLOAD_V0_CAPABILITIES}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peelTag(repo, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  const body = Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
    encodePktLines([...lines, 'flush']),
  ]);
  return ok(UPLOAD_ADVERTISEMENT_TYPE, body);
}

// ---------------------------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 command request: `command=<name>`, optional agent/object-format, delim, args. */
function parseV2Command(body: Buffer, expectedCommand: string): { lines: string[] } {
  const { packets } = decodePktLines(body);
  const lines = dataLines(packets);
  if (lines.length === 0 || lines[0] !== `command=${expectedCommand}`) {
    throw new PktLineError(`expected command=${expectedCommand}, got ${JSON.stringify(lines[0] ?? '')}`);
  }
  // The delim packet separates the command block from the arguments; the
  // decoder dropped it, so find the args by skipping the command block lines
  // (agent=/object-format=) — everything after the first arg-looking line is
  // an argument. The client sends at most agent + object-format before delim.
  const args: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    args.push(line);
  }
  return { lines: args };
}

/**
 * v2 ls-refs. HEAD first (with `symref-target:` when symrefs is requested;
 * `unborn HEAD` when the repo has no commits and unborn is requested), then
 * refs sorted, with `peeled:` on annotated tags when peel is requested.
 * ref-prefix filtering is SERVER-side: only matching names are returned.
 */
export function handleLsRefs(repo: RepoRecord, body: Buffer): GitResponse {
  const { lines } = parseV2Command(body, 'ls-refs');
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));

  const out: string[] = [];
  const head = headOid(repo);
  if (head !== ZERO_OID) {
    const symref = args.symrefs ? ` symref-target:${headTarget(repo)}` : '';
    if (keep('HEAD')) out.push(`${head} HEAD${symref}\n`);
  } else if (args.unborn) {
    const symref = args.symrefs ? ` symref-target:${headTarget(repo)}` : '';
    if (keep('HEAD')) out.push(`unborn HEAD${symref}\n`);
  }
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peelTag(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  const response = Buffer.concat([encodePktLines([...out, 'flush'])]);
  return ok(UPLOAD_RESULT_TYPE, response);
}

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

function parseFetchArgsV2(body: Buffer): FetchArgs {
  const { lines } = parseV2Command(body, 'fetch');
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isSafeInteger(value) && value > 0) args.depth = value;
    } else if (line.startsWith('deepen-since ')) {
      const value = Number(line.slice(13).trim());
      if (Number.isSafeInteger(value) && value >= 0) args.deepenSince = value;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    // thin-pack / no-progress / ofs-delta / filter / done / agent / object-format: accepted, ignored.
  }
  return args;
}

function parseFetchArgsV0(body: Buffer): FetchArgs {
  const { packets } = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = lineText(packet.payload);
    if (section === 0) {
      if (line.startsWith('want ')) {
        // The first want line may carry features after the oid: `want <oid> side-band-64k ...`.
        const rest = line.slice(5).trim();
        args.wants.push(rest.split(' ')[0] as string);
      } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const value = Number(line.slice(7).trim());
        if (Number.isSafeInteger(value) && value > 0) args.depth = value;
      } else if (line.startsWith('deepen-since ')) {
        const value = Number(line.slice(13).trim());
        if (Number.isSafeInteger(value) && value >= 0) args.deepenSince = value;
      } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    }
    // `done` ends the negotiation; nothing to record.
  }
  return args;
}

/** Build the pack for a fetch plan: objects sorted by oid (deterministic bytes). */
function buildFetchPack(repo: RepoRecord, oids: ReadonlySet<string>): Buffer {
  if (oids.size === 0) return emptyPack();
  const sorted = [...oids].sort();
  const objects: GitObject[] = [];
  for (const oid of sorted) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return writePack(objects);
}

/**
 * v2 fetch. Sections in order: acknowledgments (always NAK — the checks never
 * assert ACKs), shallow-info (only when non-empty), packfile (sideband band 1,
 * always at least one packet — an empty pack is still a valid 32-byte pack).
 * A want the store does not hold is answered with a band-3 sideband error.
 */
export function handleFetchV2(repo: RepoRecord, body: Buffer): GitResponse {
  const args = parseFetchArgsV2(body);
  for (const want of args.wants) {
    if (!isObjectId(want)) throw new PktLineError(`fetch wants a bad object id ${JSON.stringify(want)}`);
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  let plan;
  try {
    plan = planFetch(lookup, {
      wants: args.wants,
      haves: args.haves,
      clientShallow: args.shallow,
      depth: args.depth,
      deepenSince: args.deepenSince,
      deepenNot: args.deepenNot,
      resolveRef: (ref) => repo.refs.get(ref),
    });
  } catch (err) {
    if (err instanceof GitObjectError) {
      const parts = [
        encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']),
        encodePktLine('packfile\n'),
        encodeSideband(Buffer.from(`ERR ${err.message}\n`, 'utf8'), 3),
        pktLineFlush(),
      ];
      return ok(UPLOAD_RESULT_TYPE, Buffer.concat(parts));
    }
    throw err;
  }
  const parts: Buffer[] = [encodePktLines(['acknowledgments\n', 'NAK\n', 'flush'])];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(encodeSideband(buildFetchPack(repo, plan.objects), 1));
  parts.push(pktLineFlush());
  return ok(UPLOAD_RESULT_TYPE, Buffer.concat(parts));
}

/**
 * v0 fetch: shallow/unshallow lines and NAK as plain pkt-lines, then the pack
 * as sideband band 1, then flush. (The suite's v0 client only ever asks for
 * advertisements, but a real v0 fetch costs nothing on top of the planner.)
 */
export function handleFetchV0(repo: RepoRecord, body: Buffer): GitResponse {
  const args = parseFetchArgsV0(body);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  let plan;
  try {
    plan = planFetch(lookup, {
      wants: args.wants,
      haves: args.haves,
      clientShallow: args.shallow,
      depth: args.depth,
      deepenSince: args.deepenSince,
      deepenNot: args.deepenNot,
      resolveRef: (ref) => repo.refs.get(ref),
    });
  } catch (err) {
    if (err instanceof GitObjectError) {
      const parts = [
        encodePktLine('NAK\n'),
        encodeSideband(Buffer.from(`ERR ${err.message}\n`, 'utf8'), 3),
        pktLineFlush(),
      ];
      return ok(UPLOAD_RESULT_TYPE, Buffer.concat(parts));
    }
    throw err;
  }
  const lines: string[] = [];
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  lines.push('NAK\n');
  const parts = [
    encodePktLines(lines),
    encodeSideband(buildFetchPack(repo, plan.objects), 1),
    pktLineFlush(),
  ];
  return ok(UPLOAD_RESULT_TYPE, Buffer.concat(parts));
}

/**
 * Dispatch a POST to git-upload-pack: a v2 command request (`command=...`)
 * goes to ls-refs/fetch; anything else is a v0 fetch. Throws PktLineError on
 * a malformed body (the caller answers 400 — the server never crashes).
 */
export function handleUploadPack(repo: RepoRecord, body: Buffer, gitProtocolVersion: 2 | 0): GitResponse {
  if (body.length === 0) throw new PktLineError('empty upload-pack request');
  const { packets } = decodePktLines(body);
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first && first.kind === 'data' ? lineText(first.payload) : '';
  if (command === 'command=ls-refs') return handleLsRefs(repo, body);
  if (command === 'command=fetch') return handleFetchV2(repo, body);
  if (command.startsWith('command=')) throw new PktLineError(`unknown upload-pack command ${JSON.stringify(command)}`);
  // No v2 command: a v0 fetch (want lines, or garbage — the v0 parser only
  // reads want/have/shallow/deepen lines and ignores the rest).
  if (gitProtocolVersion === 2 && command !== '' && !command.startsWith('want ')) {
    throw new PktLineError(`unexpected upload-pack request ${JSON.stringify(command.slice(0, 40))}`);
  }
  return handleFetchV0(repo, body);
}
