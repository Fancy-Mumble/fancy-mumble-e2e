// TEMP diagnostic (delete after): launch the app, click the share toggle to
// raise the native getDisplayMedia picker, and screenshot it so we can design
// the pyautogui driver. Run:
//   E2E_NATIVE_DRIVER=.tools/msedgedriver.exe node --import tsx scripts/inspect-picker.mts
import { spawnSync } from "node:child_process";
import path from "node:path";
import { By } from "selenium-webdriver";
import { TauriApp } from "../src/app";
import { config } from "../src/config";
import { TID } from "../src/selectors";
import { CheckerboardWindow } from "../src/util/checkerboard";

const OUT = path.join(process.cwd(), ".tmp", "picker.png");

const board = await CheckerboardWindow.launch({ title: `inspect-board-${Date.now() % 10000}`, phase: 0, x: 60, y: 60 });
const app = await TauriApp.launch({ instance: 0 });
try {
  await app.connect.connect(config.serverHost, `inspector-${Date.now() % 10000}`, { port: config.serverPort });
  await app.chat.waitLoaded(config.connectTimeout);
  const toggle = await app.driver.findElement(By.css(`[data-testid="${TID.screenShareToggle}"]`));
  await toggle.click();
  console.log("clicked share toggle; waiting for native picker...");
  await new Promise((r) => setTimeout(r, 3000));
  const r = spawnSync("python", ["-c",
    `from PIL import ImageGrab; ImageGrab.grab().save(r'${OUT.replace(/\\/g, "/")}'); print('saved')`,
  ], { encoding: "utf8" });
  console.log("screenshot:", (r.stdout || "") + (r.stderr || ""));
  await new Promise((r) => setTimeout(r, 1000));
} finally {
  await app.close();
  board.close();
}
