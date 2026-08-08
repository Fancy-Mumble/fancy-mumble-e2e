import type { TauriApp } from "../app";
import { delay } from "./wait";

/**
 * Wait until every member is actually in end-to-end mode on the channel they
 * just joined.
 *
 * Replaces `delay(8000) // let sender-key distribution settle`, which is the
 * worst shape a wait can have: too slow when the system is healthy, and still
 * too short when it is loaded, so the same line both wasted eight seconds per
 * run and produced failures that read as crypto bugs. It also asserted
 * nothing - a client that never entered E2E mode at all waited out the sleep
 * and failed later, somewhere less informative.
 *
 * The badge is the client's own statement that the bridge is loaded and the
 * channel is signal_v1, so waiting for it on every member is both the fast
 * path and a stronger precondition than the sleep ever was.
 *
 * `settleMs` remains because the badge says a member is *ready to* exchange
 * keys, not that the distribution round-trip has landed everywhere; it is a
 * short tail, not the whole wait.
 */
export async function settleSignalKeys(
  members: readonly TauriApp[],
  settleMs = 1000,
): Promise<void> {
  await Promise.all(members.map((member) => member.chat.waitForE2EBadge()));
  await delay(settleMs);
}
