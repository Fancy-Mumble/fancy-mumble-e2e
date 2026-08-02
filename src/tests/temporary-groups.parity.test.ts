import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MumbleWire, PERM_ENTER } from "../util/mumble-wire";
import {
  addUserToGroup,
  createChannel,
  disagreesWithWire,
  iceAvailable,
  removeChannel,
  removeUserFromGroup,
  setAcl,
  wireHost,
} from "../util/ice";

/**
 * Temporary group membership, against **murmur** — the gold standard.
 *
 * # What this pins down, and why it needed pinning
 *
 * A named ACL group holds *accounts*. An unregistered visitor has no account —
 * they go on the wire as account 0, which is also the SuperUser's id — so no
 * amount of editing an ACL table can put a guest in a group. murmur's answer is
 * `qsTemporary`: a membership keyed on a live **session**, granted by an
 * external authority over Ice and never by anything a client sends.
 *
 * That last clause is why this file exists rather than a unit test. The feature
 * has no client-facing message at all, so the only way to establish what murmur
 * actually does — as opposed to what its source appears to say — is to drive
 * the admin API it belongs to against a running server, and watch a real
 * connection be refused and then admitted.
 *
 * Starling has no Ice and never will (`GAP-ANALYSIS.md` S6); its equivalent is
 * `operator-api`. The Starling-side assertions of the same behaviour live in
 * `vendor/starling/crates/starling/src/e2e.rs`
 * (`an_external_authority_can_admit_a_guest_to_a_group_gated_channel` and
 * `a_session_scoped_grant_does_not_pass_to_the_next_holder_of_that_session`),
 * driven through that surface against a live Starling. This file is the
 * reference they were written against.
 *
 * # Running it
 *
 *   docker build -t fancy-e2e-ice:latest \
 *     --build-context slice=vendor/server/src/murmur fixtures/ice
 *   docker compose -f fixtures/docker-compose.e2e.yml up -d --wait
 *   node --import tsx --test src/tests/temporary-groups.parity.test.ts
 *
 * It skips itself when murmur's Ice port is not answering, because against a
 * Starling on 64738 every assertion here would be about a server that has no
 * Ice to drive.
 */

const skip = iceAvailable()
  ? false
  : "murmur's Ice admin port is not answering on 6502 — start the fixture with " +
    "`docker compose -f fixtures/docker-compose.e2e.yml up -d --wait` and build the Ice " +
    "client with `docker build -t fancy-e2e-ice:latest " +
    "--build-context slice=vendor/server/src/murmur fixtures/ice`";

describe("murmur: temporary group membership", { concurrency: 1, skip }, () => {
  const suffix = Date.now() % 1_000_000;
  const channelName = `e2e-tempgrp-${suffix}`;
  const GROUP = "vip";
  let channel: number;
  const connected: MumbleWire[] = [];

  /**
   * A guest connection, tracked so `after` can close it.
   *
   * Every one is checked against Ice before it is used. That is not paranoia:
   * the first run of this file talked to a Starling another session had left
   * bound to `127.0.0.1:64738`, which shadows the container's published port —
   * and it did not look like a mistake, because a guest is refused entry to a
   * channel that does not exist just as surely as to one that is locked. One
   * assertion even passed. A parity suite whose two halves address different
   * servers must fail loudly on the first connection, not report findings.
   */
  async function guest(name: string): Promise<MumbleWire> {
    const client = await MumbleWire.login(wireHost(), 64738, name);
    connected.push(client);
    const wrong = disagreesWithWire(name, client.session);
    assert.equal(wrong, undefined, wrong);
    return client;
  }

  /**
   * The table under test: `Enter` denied to everybody, granted back to a named
   * group that starts empty. What an operator writes when an external authority
   * is going to decide who gets in.
   */
  function gateOnGroup(): void {
    setAcl(
      channel,
      [
        { group: "all", deny: PERM_ENTER },
        { group: GROUP, allow: PERM_ENTER },
      ],
      [{ name: GROUP }],
    );
  }

  before(() => {
    channel = createChannel(channelName);
    gateOnGroup();
  });

  after(async () => {
    for (const client of connected) client.close();
    if (channel) removeChannel(channel);
  });

  it("refuses an unregistered guest, and says so rather than going quiet", async () => {
    const alice = await guest(`e2e-tg-a-${suffix}`);
    const answer = await alice.enter(channel);

    assert.equal(answer.admitted, false, "a channel gated on a group must not admit a guest");
    assert.equal(
      answer.permission,
      PERM_ENTER,
      "the refusal must name Enter, or the client cannot explain it to the user",
    );
  });

  it("admits the guest once an external authority puts that session in the group", async () => {
    const alice = await guest(`e2e-tg-b-${suffix}`);
    assert.equal((await alice.enter(channel)).admitted, false, "shut before the grant");

    addUserToGroup(channel, alice.session, GROUP);

    const answer = await alice.enter(channel);
    assert.deepEqual(
      answer,
      { admitted: true, channel },
      "a session-scoped grant is the only thing that can admit an unregistered user",
    );
  });

  it("grants nothing to anybody else's session", async () => {
    const alice = await guest(`e2e-tg-c-${suffix}`);
    const bob = await guest(`e2e-tg-d-${suffix}`);

    addUserToGroup(channel, alice.session, GROUP);

    assert.equal((await alice.enter(channel)).admitted, true);
    assert.equal(
      (await bob.enter(channel)).admitted,
      false,
      "the grant named one session and must reach exactly that one",
    );
  });

  it("survives an ACL rewrite that still declares the group", async () => {
    // The trap for a reimplementation. murmur stashes every group's temporary
    // members before deleting the old group objects and restores them while
    // looping over the new ones (`Messages.cpp:2842`, `:2900`) — so an operator
    // pressing Save in the ACL editor does not silently revoke every temporary
    // membership in the channel. A whole-table replace that forgot this would
    // pass every other test in this file.
    const alice = await guest(`e2e-tg-e-${suffix}`);
    addUserToGroup(channel, alice.session, GROUP);
    assert.equal((await alice.enter(channel)).admitted, true);

    // Move them out again so the next `enter` is a fresh question, then rewrite
    // the table with the same contents — which is what Save sends.
    assert.equal((await alice.enter(0)).admitted, true, "back to the root");
    gateOnGroup();

    assert.equal(
      (await alice.enter(channel)).admitted,
      true,
      "editing the ACL table must not revoke a temporary membership",
    );
  });

  it("is taken away again by the matching removal", async () => {
    const alice = await guest(`e2e-tg-f-${suffix}`);
    addUserToGroup(channel, alice.session, GROUP);
    assert.equal((await alice.enter(channel)).admitted, true);
    assert.equal((await alice.enter(0)).admitted, true, "back to the root");

    removeUserFromGroup(channel, alice.session, GROUP);

    assert.equal(
      (await alice.enter(channel)).admitted,
      false,
      "a revoked membership must stop admitting",
    );
  });

  it("does not pass to whoever holds that session id next", async () => {
    // Why clearing this on disconnect is a requirement and not tidiness: murmur
    // re-queues a departing session's id for reuse (`Server.cpp:1904`), so a
    // grant outliving its holder is inherited by the next arrival — silently,
    // and carrying whatever the group was granted.
    //
    // The pool is `max_users * 2` and FIFO, so a specific id will not come back
    // round within a test. What *is* observable is that the grant does not
    // survive its session: after the holder leaves and a fresh guest connects,
    // nobody is in the group.
    const alice = await guest(`e2e-tg-g-${suffix}`);
    addUserToGroup(channel, alice.session, GROUP);
    assert.equal((await alice.enter(channel)).admitted, true);
    const departed = alice.session;
    alice.close();

    // Grant to the same id again *after* it has gone. murmur refuses it — the
    // session is not a live user — which is itself the evidence that the id no
    // longer names anybody.
    assert.throws(
      () => addUserToGroup(channel, departed, GROUP),
      "granting to a departed session must be refused, not silently recorded",
    );

    const bob = await guest(`e2e-tg-h-${suffix}`);
    assert.equal(
      (await bob.enter(channel)).admitted,
      false,
      "a later guest must not inherit a grant made to an earlier one",
    );
  });
});
