import { describe, it, before, after } from "node:test";
import { TauriApp } from "../app";
import { config } from "../config";

/**
 * Link preview round-trip: posting a URL makes the client send a
 * FancyLinkPreviewRequest, which the server forwards to the fancy-link-preview
 * plugin; the plugin fetches the page and returns a FancyLinkPreviewResponse
 * embed that renders as a preview card under the message.
 *
 * Uses https://example.com because the plugin is SSRF-guarded (it refuses
 * loopback/private hosts), and its <title> "Example Domain" is stable. Requires
 * the fancy-link-preview plugin enabled (fixtures/mumble-server.ini) and
 * outbound network from the server container.
 */
describe("link preview: server-generated embed for a posted URL", () => {
  let app: TauriApp;

  before(async () => {
    app = await TauriApp.launch({ instance: 0 });
    await app.connect.connect(config.serverHost, `e2e-Link-${Date.now() % 100000}`, {
      port: config.serverPort,
    });
    await app.chat.waitLoaded();
  });

  after(async () => {
    await Promise.allSettled([app?.close()]);
  });

  it("renders a preview embed for a posted public URL", async () => {
    await app.chat.sendMessage("look at this https://example.com");
    await app.chat.waitForText("https://example.com"); // message delivered

    // The plugin fetches the page; its <title> is "Example Domain", which only
    // appears via the rendered preview card (the inline link shows the URL text,
    // not the title) - so this asserts the full request -> fetch -> embed path.
    await app.chat.waitForText("Example Domain", 30000);
  });
});
