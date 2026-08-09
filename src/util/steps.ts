import { it, type TestContext } from "node:test";

/**
 * A drop-in `it` for suites whose tests are STEPS of one flow - each consuming
 * state a previous step created (a channel, a share, a registration).
 *
 * When a step fails, every later step in the chain used to fail too - not on
 * its own merits but by waiting out 15-20 s element timeouts against state the
 * flow never reached, each blaming a different selector. One cause, N reds,
 * and minutes of a sweep spent re-proving it. With a chain, a failed step
 * makes the rest skip immediately, with the failed step's name as the reason:
 * one red per cause, and every skip says exactly why it did not run.
 *
 * Only for strict chains. Tests that measure independent capabilities keep
 * plain `it`, even when they share a likely failure cause - a capability's
 * own red/green is a signal the scoreboard counts.
 */
export function stepChain(): (name: string, fn: (t: TestContext) => Promise<void>) => void {
  let failedStep: string | null = null;
  return (name, fn) => {
    it(name, async (t) => {
      if (failedStep) {
        t.skip(`not run: step "${failedStep}" failed, so the state this step drives does not exist`);
        return;
      }
      try {
        await fn(t);
      } catch (error) {
        failedStep = name;
        throw error;
      }
    });
  };
}
