import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TauriApp } from "../app";
import { config } from "../config";
import { setSuperUserPassword } from "../util/server";
import { delay } from "../util/wait";
import { stepChain } from "../util/steps";

/**
 * Hidden + expiring channels and private meeting rooms.
 *
 * 1. Visibility - a channel marked "hidden" is never sent to a user who lacks the
 *    SeeChannel permission: the server filters it (and its subtree) out of the
 *    channel tree. SuperUser sees it (Write implies SeeChannel); a plain guest
 *    does not. A normal sibling stays visible to everyone (the filter is
 *    selective, not all-hiding).
 * 2. Expiry - a channel with a short absolute lifetime is reaped by the server's
 *    ChannelReaper once the deadline passes; occupants are moved to the parent.
 * 3. Meeting room - creating a hidden channel with invitees grants each invitee
 *    SeeChannel|Enter|Traverse (and denies @all), so only invitees see and can
 *    join it; a non-invitee never learns it exists. Joining requires no password
 *    (entry is invitee-gated, not password-gated).
 * 4. Presence reveal - when an invitee moves into the hidden room, a non-invitee
 *    can no longer place them in a channel (the room is hidden), but the server
 *    still announces them as ONLINE (a channel-less "presence-hidden" state), so
 *    they remain in the roster and their messages stay attributed to them.
 *
 * Requires a server image + client built with the hidden/expiring-channel,
 * meeting-room (invitee_user_ids), and presence-reveal changes (mumble-server:dev).
 */
describe("channels: hidden, expiring + meeting rooms", () => {
  let admin: TauriApp;
  let bob: TauriApp;
  let carol: TauriApp;
  const sfx = Date.now() % 100000;
  const bobName = `e2e-bob-${sfx}`;
  const carolName = `e2e-carol-${sfx}`;
  const hiddenName = `Secret Room ${sfx}`;
  const publicName = `Public Room ${sfx}`;
  const expiringName = `Expiring Room ${sfx}`;
  const roomName = `Meeting ${sfx}`;

  before(async () => {
    setSuperUserPassword("testpassword");
    [admin, bob, carol] = await TauriApp.launchAll(
      { instance: 0 },
      { instance: 1 },
      { instance: 2 },
    );
    await Promise.all([
      admin.connect.connect(config.serverHost, "SuperUser", {
        port: config.serverPort,
        password: "testpassword",
      }),
      bob.connect.connect(config.serverHost, bobName, { port: config.serverPort }),
      carol.connect.connect(config.serverHost, carolName, { port: config.serverPort }),
    ]);
    await Promise.all([admin.chat.waitLoaded(), bob.chat.waitLoaded(), carol.chat.waitLoaded()]);
  });

  after(async () => {
    await Promise.allSettled([admin?.close(), bob?.close(), carol?.close()]);
  });

  it("hides a hidden channel from a user without SeeChannel, but not a normal one", async () => {
    await admin.sidebar.createSubChannel(0, publicName);
    await admin.sidebar.createSubChannel(0, hiddenName, { hidden: true });

    // Admin (SuperUser -> Write implies SeeChannel) sees both.
    await admin.sidebar.waitForChannel(publicName);
    await admin.sidebar.waitForChannel(hiddenName);
    const hiddenId = await admin.sidebar.channelIdByName(hiddenName);

    // Non-privileged users (bob, carol - both guests here) see the normal
    // channel...
    await carol.sidebar.waitForChannel(publicName);
    await bob.sidebar.waitForChannel(publicName);
    // ...but never the hidden one. Settle to let any (incorrect) late delivery land.
    await delay(2000);
    for (const [who, app] of [["carol", carol] as const, ["bob", bob] as const]) {
      assert.equal(
        await app.sidebar.hasChannel(hiddenName),
        false,
        `${who} (no SeeChannel) must not see the hidden channel by name`,
      );
      // Catch a "nameless" leak too: an entry carrying only the channel id.
      assert.equal(
        await app.sidebar.hasChannelId(hiddenId),
        false,
        `${who} (no SeeChannel) must not have the hidden channel id at all`,
      );
    }
  });

  it("auto-removes an expiring channel and moves occupants to the parent", async () => {
    await admin.sidebar.createSubChannel(0, expiringName, { expiryMode: 1, expirySeconds: 8 });
    await admin.sidebar.waitForChannel(expiringName);
    await admin.sidebar.joinChannel(expiringName);
    await admin.sidebar.waitForMembership(expiringName);

    // The reaper fires at the deadline; the channel disappears for everyone...
    await admin.sidebar.waitForChannelGone(expiringName, 25000);
    // ...and its occupant is relocated to the parent (still connected, not kicked).
    await admin.sidebar.waitForMembershipGone(expiringName, 10000);
  });

  it("keeps a sliding-expiry channel alive while used, then reaps it once idle", async () => {
    const slidingName = `Sliding Room ${sfx}`;
    // 12s idle window: deadline = last activity (join/leave) + 12s.
    await admin.sidebar.createSubChannel(0, slidingName, { expiryMode: 2, expirySeconds: 12 });
    await admin.sidebar.waitForChannel(slidingName);

    // Join ~5s in: this activity pushes the deadline out to (join + 12s).
    await delay(5000);
    await admin.sidebar.joinChannel(slidingName);

    // ~14s after creation - past the original 12s window, but kept alive because
    // the join extended it.
    await delay(9000);
    assert.equal(
      await admin.sidebar.hasChannel(slidingName),
      true,
      "a sliding-expiry channel must survive past its original window when recently active",
    );

    // No further activity -> reaped ~12s after the join, occupant moved to parent.
    await admin.sidebar.waitForChannelGone(slidingName, 25000);
    await admin.sidebar.waitForMembershipGone(slidingName, 10000);
  });

  // Tests 1-3 (visibility, both expiry modes) are independent capabilities and
  // stay plain `it`. From here on it is one flow: the meeting room created and
  // Bob registered in this step are what every later assertion drives.
  const step = stepChain();

  step("makes a meeting room joinable to invitees (no password), hidden from others", async () => {
    // Register bob so the SeeChannel ACL can target his user_id.
    await admin.chat.waitForMember(bobName);
    await admin.sidebar.registerUser(bobName);
    await admin.chat.waitForRegistered(bobName);

    // Carol initially sees bob in the lobby (root).
    await carol.chat.waitForMember(bobName);

    // Admin creates a hidden room inviting bob (not carol).
    await admin.sidebar.createSubChannel(0, roomName, { invitees: [bobName] });

    // Invitee bob sees the room; non-invitee carol never does.
    await bob.sidebar.waitForChannel(roomName);
    await delay(2000);
    assert.equal(
      await carol.sidebar.hasChannel(roomName),
      false,
      "a non-invitee must not see the private meeting room",
    );

    // Bob joins. Entry is invitee-gated (deny @all Enter, allow bob by id), so it
    // requires NO password - the channel-join password dialog must never appear.
    await bob.sidebar.joinChannel(roomName);
    await bob.sidebar.waitForMembership(roomName);
    assert.equal(
      await bob.sidebar.hasPasswordPrompt(),
      false,
      "joining an invitee-gated room (no password set) must not prompt for a password",
    );
  });

  step("reveals an invitee in a hidden room as online, but never inside a channel a non-invitee can see", async () => {
    // Continues the previous test: bob sits inside the hidden room.
    await bob.sidebar.waitForMembership(roomName);

    // Presence reveal: carol (no SeeChannel for the room) still sees bob ONLINE
    // in the roster - he did not vanish/disconnect...
    await carol.chat.waitForMember(bobName);
    // ...but he is never shown *under a channel* she can see (he is parked in the
    // sentinel channel), and the room itself stays hidden from her.
    assert.equal(
      await carol.sidebar.hasChannel(roomName),
      false,
      "the hidden room must stay invisible to a non-invitee",
    );
    assert.equal(
      await carol.sidebar.hasChannelViewMember(bobName),
      false,
      "bob must not appear under any channel carol can see while he is in the hidden room",
    );
    // The room's observer (admin) does see bob inside the tree.
    await admin.sidebar.waitForChannelViewMember(bobName);
  });

  step("places the user back under a visible channel when they leave the hidden room", async () => {
    // Bob leaves the hidden room by moving into a channel carol can see.
    await bob.sidebar.joinChannel(publicName);

    // The server re-announces bob in full to carol, so he reappears in her tree
    // under the public room (moving out of the sentinel channel).
    await carol.sidebar.waitForChannelViewMember(bobName);
    await admin.chat.waitForMember(bobName);
  });

  step("attributes a hidden-channel user's message to that user, not the Server", async () => {
    // Put bob back inside the hidden room. Carol can no longer place him in a
    // channel, but he stays online in her roster (presence reveal).
    await bob.sidebar.joinChannel(roomName);
    await bob.sidebar.waitForMembership(roomName);
    assert.equal(
      await carol.sidebar.hasChannelViewMember(bobName),
      false,
      "precondition: carol must not see bob under a channel while he is in the hidden room",
    );

    // Bob - in the hidden room - sends carol a direct message. The members tab
    // lists every user, so bob can still pick carol even while sitting in the room.
    const dmBody = `psst-${sfx}`;
    await bob.chat.sendDirectMessage(carolName, dmBody);

    // The server announces bob's identity (channel-less, parked in the sentinel)
    // ahead of the message, so the `actor` resolves on carol's client:
    //  - bob is resolvable and appears in carol's roster (lets her open the DM)
    await carol.chat.openDirectMessage(bobName);
    await carol.chat.waitForText(dmBody);
    //  - the delivered message is attributed to bob, never to the Server.
    await carol.chat.waitForMessageFrom(bobName);
    assert.equal(
      await carol.chat.hasMessageFrom("Server"),
      false,
      "a hidden-channel user's message must be shown as from that user, not the Server",
    );
  });

  step("shows a friend as online on the Friends page even while they sit in a hidden channel", async () => {
    // Bring bob back into a channel carol can see so she can pick him, then add
    // him as a friend (keyed by his TLS cert hash - he was registered earlier).
    await bob.sidebar.joinChannel(publicName);
    await carol.chat.waitForMember(bobName);
    await carol.chat.addFriend(bobName);

    // Bob moves into the hidden room carol cannot see; she can no longer place
    // him in the channel tree.
    await bob.sidebar.joinChannel(roomName);
    await bob.sidebar.waitForMembership(roomName);
    assert.equal(
      await carol.sidebar.hasChannelViewMember(bobName),
      false,
      "precondition: bob must be hidden from carol's channel tree",
    );

    // The Friends page resolves online state by cert hash over the live user
    // list. Because bob is revealed as a channel-less "presence-hidden" user
    // (not removed), he still shows ONLINE there - the whole point of the reveal.
    await carol.friends.open();
    await carol.friends.waitForFriendOnline(bobName);
  });
});
