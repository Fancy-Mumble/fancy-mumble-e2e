import { execFileSync } from "node:child_process";

/**
 * murmur's Ice admin surface, for the parity tests.
 *
 * # Why a container and not a library
 *
 * Ice's Python mapping is a compiled extension, and `slice2py` has to run
 * against `vendor/server/src/murmur/MumbleServer.ice` to produce stubs at all -
 * a build step and a native dependency, on every machine that runs the suite,
 * for a handful of admin calls. The fixture is already Docker, so the client is
 * too: `fixtures/ice/` is a five-line image that installs ZeroC Ice and
 * compiles the server's own slice, and each call below runs one throwaway
 * container against it.
 *
 * That also keeps the slice honest. It is copied from the server submodule at
 * image-build time rather than vendored, so a change to the interface shows up
 * as a build or a marshalling failure instead of silently drifting - which is
 * the failure mode `vendor/channelviewer/sync-slice.sh` exists to warn about.
 *
 * # Why any of this is needed
 *
 * Some of what murmur can do has no client-facing message at all. Temporary
 * group membership is the case these tests are about: nothing a Mumble client
 * sends can create one, so the only way to establish murmur's behaviour - the
 * behaviour Starling is being measured against - is to drive the admin API the
 * feature actually belongs to.
 */

const IMAGE = process.env.E2E_ICE_IMAGE ?? "fancy-e2e-ice:latest";
/** Reached over the host network; the fixture publishes 6502 (see the compose). */
const ENDPOINT = process.env.E2E_ICE_ENDPOINT ?? "tcp -h 127.0.0.1 -p 6502";

/** The preamble every snippet runs: connect, and bind `server` to server 1. */
const PREAMBLE = `
import json, sys, Ice
Ice.loadSlice('-I/usr/share/ice/slice /ice/MumbleServer.ice')
import MumbleServer
props = Ice.createProperties()
# The fixture's murmur speaks encoding 1.0; the default 1.1 fails to unmarshal
# its structs, and does so as a truncated read rather than as a version error.
props.setProperty('Ice.Default.EncodingVersion', '1.0')
props.setProperty('Ice.MessageSizeMax', '65536')
init = Ice.InitializationData()
init.properties = props
def emit(value):
    sys.stdout.write('<<<' + json.dumps(value) + '>>>')
with Ice.initialize(init) as ic:
    meta = MumbleServer.MetaPrx.checkedCast(ic.stringToProxy('Meta:${ENDPOINT}'))
    server = meta.getBootedServers()[0]
`;

/**
 * Run one Python snippet against the server's Ice interface.
 *
 * The snippet is indented into the `with` block above and may call `emit(...)`
 * once to return a value. Output is framed rather than parsed whole because Ice
 * writes its own warnings to stdout on occasion, and a stray line would
 * otherwise turn a working call into a JSON error.
 */
function ice<T = void>(snippet: string): T | undefined {
  const body = snippet
    .split("\n")
    .map((line) => (line.trim() === "" ? line : `    ${line}`))
    .join("\n");

  const out = execFileSync(
    "docker",
    ["run", "--rm", "--network", "host", IMAGE, "python3", "-c", PREAMBLE + body],
    { encoding: "utf8", timeout: 60000 },
  );

  const framed = /<<<([\s\S]*?)>>>/.exec(out);
  return framed ? (JSON.parse(framed[1]!) as T) : undefined;
}

/**
 * A boolean as Python spells it.
 *
 * Interpolating a JavaScript one produces `true`, which Python reads as an
 * undefined name - a loud failure here, but only because these snippets are
 * short. Everything crossing this boundary goes through a converter for that
 * reason.
 */
function py(value: boolean): string {
  return value ? "True" : "False";
}

/** Whether murmur's Ice interface is reachable at all. */
export function iceAvailable(): boolean {
  try {
    return ice<boolean>("emit(server.isRunning())") === true;
  } catch {
    return false;
  }
}

/** Create a channel under `parent`, returning its id. */
export function createChannel(name: string, parent = 0): number {
  return ice<number>(`emit(server.addChannel(${JSON.stringify(name)}, ${parent}))`)!;
}

export function removeChannel(id: number): void {
  ice(`
try:
    server.removeChannel(${id})
except Exception:
    pass
`);
}

/** One entry of a channel's ACL table. */
export interface AclEntry {
  applyHere?: boolean;
  applySubs?: boolean;
  userid?: number;
  group?: string;
  allow?: number;
  deny?: number;
}

/** One group declared on a channel. */
export interface GroupDecl {
  name: string;
  inherit?: boolean;
  inheritable?: boolean;
  add?: number[];
  remove?: number[];
}

/**
 * Replace a channel's ACL table.
 *
 * Wholesale, as the interface documents and as a client's editor does - which
 * is the reason one of these tests exists at all: the replacement must not take
 * temporary memberships with it.
 */
export function setAcl(
  channel: number,
  acls: AclEntry[],
  groups: GroupDecl[],
  inherit = true,
): void {
  const acl = acls.map(
    (entry) =>
      `MumbleServer.ACL(${py(entry.applyHere ?? true)}, ${py(entry.applySubs ?? true)}, False, ` +
      `${entry.userid ?? -1}, ${JSON.stringify(entry.group ?? "")}, ` +
      `${entry.allow ?? 0}, ${entry.deny ?? 0})`,
  );
  const group = groups.map(
    (decl) =>
      `MumbleServer.Group(${JSON.stringify(decl.name)}, False, ${py(decl.inherit ?? true)}, ` +
      `${py(decl.inheritable ?? true)}, ${JSON.stringify(decl.add ?? [])}, ` +
      `${JSON.stringify(decl.remove ?? [])}, [])`,
  );
  ice(`server.setACL(${channel}, [${acl.join(", ")}], [${group.join(", ")}], ${py(inherit)})`);
}

/**
 * Add a live *session* to a group on a channel, for as long as it stays
 * connected.
 *
 * murmur's `qsTemporary`. Note what it is keyed on: a session, not an account -
 * which makes it the only way to put an **unregistered** user into a named
 * group, since permanent membership is recorded by account id and a guest has
 * none.
 */
export function addUserToGroup(channel: number, session: number, group: string): void {
  ice(`server.addUserToGroup(${channel}, ${session}, ${JSON.stringify(group)})`);
}

export function removeUserFromGroup(channel: number, session: number, group: string): void {
  ice(`server.removeUserFromGroup(${channel}, ${session}, ${JSON.stringify(group)})`);
}

/** The sessions currently connected, by name. */
export function sessionsByName(): Record<string, number> {
  return ice<Record<string, number>>(
    "emit({u.name: u.session for u in server.getUsers(False).values()})",
  )!;
}

/**
 * The address a *wire* client must dial to reach the same server this Ice
 * connection administers.
 *
 * Not simply `config.serverHost`, and the reason is a trap that has already
 * cost one wrong-looking test run. The compose publishes murmur on `0.0.0.0` /
 * `::`, which Docker serves through a proxy process - but a process bound
 * specifically to `127.0.0.1:64738` wins that address, and a Starling left
 * running by another session is exactly such a process. A client dialling
 * loopback then talks to *that* while this file administers murmur, and the two
 * halves of a parity test are silently pointed at different servers.
 *
 * Overridable with `E2E_MURMUR_HOST` for the case where neither default works.
 */
export function wireHost(): string {
  return process.env.E2E_MURMUR_HOST ?? "127.0.0.1";
}

/**
 * Prove that a wire connection and this Ice connection see the same server.
 *
 * Returns the reason they do not, or `undefined` when they agree. Worth doing
 * explicitly rather than trusting the addresses: when they disagree, every
 * assertion in a parity suite still *runs*, and some of them still pass - a
 * guest is refused entry to a channel that does not exist just as surely as to
 * one that is locked.
 */
export function disagreesWithWire(name: string, session: number): string | undefined {
  const seen = sessionsByName();
  if (seen[name] === session) return undefined;
  return (
    `the client dialled ${wireHost()}:64738 and got session ${session} as "${name}", but murmur's ` +
    `Ice interface does not see it (it sees ${JSON.stringify(seen)}). Something other than the ` +
    `compose fixture is answering that address - a stray server bound to 127.0.0.1 shadows the ` +
    `container's published port. Point E2E_MURMUR_HOST at an address that reaches the container ` +
    `(the host's LAN IP works), or stop the other listener.`
  );
}
