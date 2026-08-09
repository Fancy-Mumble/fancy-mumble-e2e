import { execFileSync } from "node:child_process";
import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID } from "../selectors";
import { config } from "../config";
import { isStarling } from "../util/suite-server";

const AUDIT_CONTAINER = process.env.E2E_SERVER_CONTAINER ?? "fancy-e2e-mumble";

/**
 * Count entries the server has actually persisted, optionally for one category.
 *
 * Reads the *server's* record rather than the client query surface, so an
 * assertion here cannot be satisfied by a UI-only artefact - that separation is
 * the point of this helper and is why it does not go through the audit tab.
 *
 * Two servers, two ways in:
 *
 * - **Starling** has no plugin and no `/data/audit-log.sqlite`; its entries
 *   live in the `audit` service's own store, whose file moves with the data
 *   directory a run happens to get. The operator API's `GET /v1/log` is the
 *   supported way to read it, needs no filesystem access at all, and is the
 *   same surface an operator would use.
 * - **murmur** keeps the mumble-audit plugin's SQLite store in a known path
 *   inside the container, which is what the original path did.
 */
export function auditStoreCount(category?: string): number {
  return isStarling() ? auditCountViaOperatorApi(category) : auditCountViaContainer(category);
}

/**
 * `GET /v1/log`, counted.
 *
 * Synchronous for the same reason `setSuperUserPassword` is: the callers are
 * `before`/`it` bodies that already are, and `fetch` has no synchronous form,
 * so the request runs in a child Node process this one waits for.
 */
function auditCountViaOperatorApi(category?: string): number {
  const request = `
    const [url, token, category] = process.argv.slice(1);
    const query = new URLSearchParams({ limit: "500" });
    if (category) query.set("category", category);
    const response = await fetch(url + "/v1/log?" + query, {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) process.exit(1);
    const entries = await response.json();
    process.stdout.write(String(Array.isArray(entries) ? entries.length : 0));
  `;

  try {
    return Number(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          request,
          config.operatorApiUrl,
          config.operatorToken,
          category ?? "",
        ],
        { encoding: "utf8", timeout: 15000 },
      ).trim(),
    );
  } catch {
    // Unreachable or unauthorised. Zero rather than a throw, because every
    // caller is a poll with a deadline: a server still starting up would
    // otherwise fail the test on its first tick instead of being waited for.
    return 0;
  }
}

/** The mumble-audit plugin's store, copied out of the container. */
function auditCountViaContainer(category?: string): number {
  const tmp = `${process.env.TEMP ?? "/tmp"}/e2e-audit-count-${process.pid}.sqlite`;
  execFileSync("docker", ["cp", `${AUDIT_CONTAINER}:/data/audit-log.sqlite`, tmp]);
  const where = category ? ` WHERE category = '${category.replace(/'/g, "''")}'` : "";
  const out = execFileSync(
    process.env.E2E_PYTHON ?? "py",
    [
      "-c",
      `import sqlite3;print(sqlite3.connect(r'${tmp}').execute("SELECT count(*) FROM server_audit${where}").fetchone()[0])`,
    ],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}

/** Poll {@link auditStoreCount} until `category` has at least `min` rows. */
export async function waitForAuditCategory(
  category: string,
  min = 1,
  timeout = config.waitTimeout,
): Promise<number> {
  const deadline = Date.now() + timeout;
  let count = 0;
  for (;;) {
    count = auditStoreCount(category);
    if (count >= min || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (count < min) {
    throw new Error(`audit category "${category}" never reached ${min} row(s) (saw ${count})`);
  }
  return count;
}

/**
 * Page object for the admin "Audit log" tab (AuditLogTab.tsx, client PR
 * feat/audit-log-client): the viewer half (query input, KPI tiles, results
 * table, live tail) and the configuration half (per-part toggles +
 * chain-status card). The tab only renders against a server reporting
 * fancy >= 0.4.2 for a user holding Write on root.
 */
export class AuditPage {
  constructor(private readonly d: WebDriver) {}

  /** Whether the "Audit log" tab button is present in the admin panel. */
  async tabButtonPresent(timeout = 10000): Promise<boolean> {
    try {
      await this.d.wait(until.elementLocated(this.tabButton()), timeout);
      return true;
    } catch {
      return false;
    }
  }

  private tabButton(): By {
    return By.xpath("//button[contains(normalize-space(.), 'Audit')]");
  }

  /**
   * Click the tab and wait for the tab root to mount.
   *
   * A retried click gated on the tab root, not a single click gated on nothing,
   * for the reason `openRolesTab` already documents next door. The admin panel
   * is a dialog that animates in, so the tab button is *located* a few hundred
   * milliseconds before it is *interactable*: the naive form throws
   * `ElementNotInteractableError` immediately and takes the two tests after it
   * down with it, having proved nothing about the server. Retrying until the
   * pane mounts costs one attribute read when the click lands first time.
   */
  async open(): Promise<void> {
    await this.d.wait(
      async () => {
        if ((await this.d.findElements(byTid(TID.auditTab))).length > 0) return true;
        const [tab] = await this.d.findElements(this.tabButton());
        if (!tab) return false;
        try {
          await tab.click();
        } catch {
          // Located but mid-animation, or detached by a re-render between the
          // find and the click. Either way the next pass re-finds it.
          return false;
        }
        return (await this.d.findElements(byTid(TID.auditTab))).length > 0;
      },
      config.waitTimeout,
      "the Audit log tab never opened",
    );
  }

  /** Type a DSL query (replacing any present text) and run it. */
  async runQuery(dsl: string): Promise<void> {
    const input = await this.d.wait(until.elementLocated(byTid(TID.auditQueryInput)), 10000);
    await input.click();
    await input.clear();
    if (dsl) await input.sendKeys(dsl);
    const run = await this.d.wait(until.elementLocated(byTid(TID.auditRunQuery)), 5000);
    await run.click();
  }

  /** Wait until at least `min` result rows are rendered. */
  async waitForRows(min = 1, timeout = config.waitTimeout): Promise<number> {
    await this.d.wait(
      async () => (await this.d.findElements(byTid(TID.auditRow))).length >= min,
      timeout,
      `audit table never showed >= ${min} rows`,
    );
    return (await this.d.findElements(byTid(TID.auditRow))).length;
  }

  /** Wait for a result row whose text contains `text`. */
  async waitForRowContaining(text: string, timeout = config.waitTimeout): Promise<void> {
    const { xpathLiteral } = await import("../util/xpath");
    await this.d.wait(
      until.elementLocated(
        By.xpath(
          `//*[@data-testid="${TID.auditRow}"][contains(normalize-space(string(.)), ${xpathLiteral(text)})]`,
        ),
      ),
      timeout,
      `no audit row containing "${text}" appeared`,
    );
  }

  /** The inline query error text, or null. */
  async queryError(): Promise<string | null> {
    const els = await this.d.findElements(byTid(TID.auditQueryError));
    return els.length ? (await els[0].getText()).trim() : null;
  }

  /** Switch to the Configuration half and wait for the chain card. */
  async openConfig(): Promise<void> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.auditConfigHalf)), 10000);
    await btn.click();
    await this.d.wait(until.elementLocated(byTid(TID.auditChainCard)), config.waitTimeout);
  }

  /** Click "verify chain" and return the chain card's text afterwards. */
  async verifyChain(settleMs = 4000): Promise<string> {
    const btn = await this.d.wait(until.elementLocated(byTid(TID.auditVerifyChain)), 10000);
    await btn.click();
    await new Promise((r) => setTimeout(r, settleMs));
    const card = await this.d.findElement(byTid(TID.auditChainCard));
    return (await card.getText()).trim();
  }
}
