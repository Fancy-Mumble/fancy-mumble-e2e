import { execFileSync } from "node:child_process";
import { By, until, type WebDriver } from "selenium-webdriver";
import { byTid, TID } from "../selectors";

const AUDIT_CONTAINER = process.env.E2E_SERVER_CONTAINER ?? "fancy-e2e-mumble";

/**
 * Count rows the audit plugin has actually persisted, optionally for one
 * category. Reads the plugin's SQLite store inside the container (copied out,
 * since the image has no sqlite3 CLI) rather than the client query surface, so
 * an assertion can't be satisfied by a UI-only artefact.
 */
export function auditStoreCount(category?: string): number {
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
  timeout = 15000,
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

  /** Click the tab and wait for the tab root to mount. */
  async open(): Promise<void> {
    const tab = await this.d.wait(until.elementLocated(this.tabButton()), 10000);
    await tab.click();
    await this.d.wait(until.elementLocated(byTid(TID.auditTab)), 15000);
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
  async waitForRows(min = 1, timeout = 15000): Promise<number> {
    await this.d.wait(
      async () => (await this.d.findElements(byTid(TID.auditRow))).length >= min,
      timeout,
      `audit table never showed >= ${min} rows`,
    );
    return (await this.d.findElements(byTid(TID.auditRow))).length;
  }

  /** Wait for a result row whose text contains `text`. */
  async waitForRowContaining(text: string, timeout = 15000): Promise<void> {
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
    await this.d.wait(until.elementLocated(byTid(TID.auditChainCard)), 15000);
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
