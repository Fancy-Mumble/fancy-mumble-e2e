import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";

/**
 * A driver for mumble-user-manager: the web backend that owns accounts.
 *
 * # Why the suite talks to it at all
 *
 * Registration and profile editing are the user manager's job, not the Mumble
 * client's. A user signs up on the website, clicks the link in their email,
 * and uploads a profile picture there; the backend then pushes the result to
 * Starling over the operator API. The Mumble client only ever *receives* the
 * outcome.
 *
 * Driving the client's own settings panel to set an avatar would therefore
 * test a path nobody uses, and — more to the point — it would not exercise the
 * chain that actually breaks: backend → operator API → account texture →
 * `UserState` → the other client's member list.
 *
 * # What has to be running
 *
 * `vendor/mumble-user-manager-backend/docker-compose.yml`, whose Starling is
 * the server on 64738 that the client dials. Bring it up with:
 *
 * ```
 * docker compose --env-file <env> up -d --wait
 * ```
 *
 * The env file needs `POSTGRES_PASSWORD`, `JWT_SECRET`, `STARLING_ADMIN_TOKEN`
 * and a `TURNSTILE_SECRET_KEY`. Use Cloudflare's always-passes test secret
 * (`1x0000000000000000000000000000000AA`) — login verifies a Turnstile token
 * server-side, so a real key would need a real browser challenge.
 */
export class UserManager {
  private constructor(
    private readonly api: string,
    private readonly mailpit: string,
  ) {}

  /**
   * Connect to a running stack, or return null if there is not one.
   *
   * Both halves are checked, because a missing mailpit fails much later and
   * much more confusingly — at "the confirmation email never arrived", which
   * reads like a backend bug rather than a missing container.
   */
  static async discover(): Promise<UserManager | null> {
    const { userManagerUrl: api, mailpitUrl: mailpit } = config;
    const ok = async (url: string) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    };

    if (!(await ok(`${api}/health`))) return null;
    if (!(await ok(`${mailpit}/api/v1/info`))) return null;
    return new UserManager(api, mailpit);
  }

  /** Where to point someone whose stack is not up, in a skip message. */
  static get requirement(): string {
    return `the mumble-user-manager stack (api ${config.userManagerUrl}, mailpit ${config.mailpitUrl})`;
  }

  /**
   * The whole happy path, as a new user would walk it: sign up, click the link
   * in the confirmation email, log in, claim the Mumble account, set a picture.
   *
   * Returned as one call because the steps are not independently interesting —
   * every one of them is a precondition for the next, and a test that stopped
   * halfway would be asserting against a half-made account.
   */
  async provision(username: string, avatar: string): Promise<ManagedAccount> {
    const email = `${username}@example.com`;
    const password = "E2ePassw0rd!x";

    await this.register(username, email, password);
    await this.confirmEmail(email);
    const jwt = await this.login(username, password);
    await this.createMumbleAccount(jwt, password);
    await this.setAvatar(jwt, avatar);

    return { username, email, password, jwt };
  }

  /** Create the web account. The Mumble account is a separate, later step. */
  async register(username: string, email: string, password: string): Promise<void> {
    await this.expectOk(
      await fetch(`${this.api}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, email, password, displayName: username }),
      }),
      "register",
    );
  }

  /**
   * Read the confirmation link out of the inbox and follow it.
   *
   * The email is what a real user acts on, so it is what this reads — rather
   * than lifting the token out of the database, which would pass even if the
   * mail were never sent or carried a broken link.
   */
  async confirmEmail(email: string): Promise<void> {
    const token = await this.verificationToken(email);
    await this.expectOk(
      await fetch(`${this.api}/api/auth/verify-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      "verify-email",
    );
  }

  /** Log in and keep the bearer token the rest of the flow needs. */
  async login(username: string, password: string): Promise<string> {
    const res = await fetch(`${this.api}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emailOrUsername: username,
        password,
        // Any non-empty token passes the always-passes test secret; the
        // backend still makes the siteverify call, so this needs the network.
        turnstileToken: "e2e.dummy.turnstile.token",
      }),
    });
    const body = await this.expectOk(res, "login");
    return body.accessToken as string;
  }

  /**
   * Claim the Mumble account: registers the name on Starling and links it.
   *
   * The web password becomes the Mumble password, which is how the client is
   * able to authenticate as this user afterwards.
   */
  async createMumbleAccount(jwt: string, password: string): Promise<void> {
    await this.expectOk(
      await fetch(`${this.api}/api/mumble/create`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ currentPassword: password }),
      }),
      "mumble/create",
    );
  }

  /**
   * Upload a profile picture, which the backend also pushes to Starling.
   *
   * The image must be a real one: the backend decodes and re-encodes it with
   * ImageSharp before pushing (Mumble caps texture size, so it may resize),
   * and a hand-assembled PNG with a bad CRC is rejected there — after the
   * upload has already returned 200, since the Mumble sync is best-effort.
   */
  async setAvatar(jwt: string, file: string): Promise<void> {
    const bytes = await readFile(file);
    const form = new FormData();
    form.append("avatar", new Blob([bytes], { type: "image/png" }), path.basename(file));

    await this.expectOk(
      await fetch(`${this.api}/api/auth/me/avatar`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
        body: form,
      }),
      "avatar upload",
    );
  }

  /**
   * The most recent verification link sent to an address.
   *
   * Polled: registration returns as soon as the row is written, and the email
   * goes out on a background send, so the inbox is routinely still empty when
   * the call returns.
   */
  private async verificationToken(email: string, timeout = 15000): Promise<string> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const res = await fetch(`${this.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
      const found = (await res.json()) as { messages?: { ID: string }[] };
      const id = found.messages?.[0]?.ID;

      if (id) {
        const message = (await (await fetch(`${this.mailpit}/api/v1/message/${id}`)).json()) as {
          Text?: string;
          HTML?: string;
        };
        // Stop at the first character that could not be part of a URL-encoded
        // token: the plain-text part wraps the link in prose, and the HTML part
        // puts it in an href.
        const link = `${message.Text ?? ""}${message.HTML ?? ""}`.match(
          /verify-email\?token=([A-Za-z0-9%._~-]+)/,
        );
        if (link) return decodeURIComponent(link[1]);
        throw new Error(`the confirmation email to ${email} carries no verify-email link`);
      }

      if (Date.now() > deadline) {
        throw new Error(`no confirmation email for ${email} after ${timeout}ms`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Fail with the backend's own message rather than a bare status.
   *
   * These calls fail for ordinary reasons — a name already taken, a password
   * the policy rejects — and the response says which. A test that reported
   * only "400" would send the reader to the container logs for something the
   * body already said.
   */
  private async expectOk(res: Response, what: string): Promise<Record<string, unknown>> {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

/** An account that exists on the website and on Starling, with a picture set. */
export interface ManagedAccount {
  username: string;
  email: string;
  /** Shared by the web login and the Mumble account, as the backend sets it. */
  password: string;
  jwt: string;
}
