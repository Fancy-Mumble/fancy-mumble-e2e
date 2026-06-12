export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll an HTTP endpoint until it responds (any non-5xx status) or the
 * timeout elapses. Used to wait for tauri-driver's WebDriver endpoint to
 * come up before opening a session.
 */
export async function waitForHttp(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status >= 200 && res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`);
    }
    await delay(200);
  }
}
