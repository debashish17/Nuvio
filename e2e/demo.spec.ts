import { expect, test, type Page } from "@playwright/test";
import { ACCESS_CODE } from "../playwright.config.js";

/**
 * What a judge does on a clean clone: open the simulator, enter the access code, press Play demo
 * then Play all; and the MCP Apps transfer view, with the step-up code typed into it.
 */

async function enter(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#gateCode").fill(ACCESS_CODE);
  await page.locator("#gateForm button[type=submit]").click();
  await expect(page.locator("#pStatus")).toContainText("connected");
  // The browser's voice paces Play all by speech; off, the demo runs as fast as replies come.
  const voice = page.locator("#sndBtn");
  if ((await voice.getAttribute("aria-pressed")) === "true") await voice.click();
}

test("Play all runs every demo beat in scripted mode, with the transfer views", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await enter(page);

  await page.locator("#demoBtn").click();
  await page.locator("#dAuto").click();
  await expect(page.locator(".you p")).toHaveCount(13, { timeout: 4 * 60_000 });
  await expect(page.locator("#demobar")).toBeHidden({ timeout: 60_000 });

  // Every line was in the script, and nothing failed.
  await expect(page.locator(".bot.err")).toHaveCount(0);
  await expect(page.locator("#modeNote.flash")).toHaveCount(0);
  expect(errors).toEqual([]);

  // The transfer tools showed the server's MCP Apps view, not the page's own cards.
  await expect(page.locator(".card.appview")).toHaveCount(5);
  await expect(page.locator(".card.consent:not(.cancel)")).toHaveCount(0);
  const receipt = page.frameLocator("iframe.appframe").nth(1);
  await expect(receipt.locator("section")).toHaveAttribute("aria-label", "Transfer NUV-240121");
});

test("a code typed into the MCP Apps view confirms, never through the model", async ({ page }) => {
  await enter(page);
  await page.locator("#msg").fill("Send 500 dirhams to Mum.");
  await page.locator("#bar").press("Enter");

  const view = page.frameLocator("iframe.appframe").last();
  await expect(view.locator("section")).toHaveAttribute("aria-label", "Confirm this transfer");
  // With the voice off the page still paces the caption (250 ms a word), so wait out the turn.
  await expect(page.locator("body")).not.toHaveClass(/busy/, { timeout: 60_000 });
  await view.getByRole("button", { name: "Confirm" }).click();
  await expect(view.locator("section")).toHaveAttribute(
    "aria-label",
    "Enter the code from your phone",
  );

  // The simulated phone shows the code; type a wrong one, then the right one, into the view.
  const sms = page
    .locator(".toast small")
    .filter({ hasText: /\b\d{6}\b/ })
    .last();
  await expect(sms).toBeVisible({ timeout: 15_000 });
  const code = /\b(\d{6})\b/.exec((await sms.textContent()) ?? "")?.[1] ?? "";
  expect(code).toMatch(/^\d{6}$/);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  await view.locator("#otp").fill(wrong);
  await expect(view.locator(".err")).toContainText("2 tries left");
  await view.locator("#otp").fill(code);
  await expect(view.locator("section")).toHaveAttribute("aria-label", /^Transfer NUV-\d+$/);

  // The view keeps tracking until the money is paid out (the ticker runs every second here).
  await expect(view.locator(".tag")).toHaveText("Paid out", { timeout: 30_000 });

  // The protocol panel shows the view's own confirm, with the code masked.
  const row = page.locator("#pFeed .row", { hasText: "code typed in the view" });
  await expect(row).toHaveCount(1);
  await expect(page.locator("#pFeed")).not.toContainText(code);
});

test("Space talks right after the access code and after a click, but not while typing", async ({
  page,
}) => {
  // A stand-in for Chrome's speech recognition: it listens until stopped and hears nothing.
  await page.addInitScript(() => {
    class FakeRecognition {
      onend: (() => void) | null = null;
      onresult = null;
      onerror = null;
      lang = "";
      interimResults = false;
      continuous = false;
      start() {}
      stop() {
        setTimeout(() => this.onend?.(), 0);
      }
    }
    Object.assign(globalThis, {
      SpeechRecognition: FakeRecognition,
      webkitSpeechRecognition: FakeRecognition,
    });
  });
  const orb = page.locator("#orbwrap");
  const talks = async () => {
    await page.keyboard.press("Space");
    await expect(orb).toHaveClass(/\btap\b/);
    await page.keyboard.press("Escape");
    await expect(orb).not.toHaveClass(/\b(tap|hold)\b/);
  };

  // Submitted with Enter, so the code field had the focus when the gate hid.
  await page.goto("/");
  await page.locator("#gateCode").fill(ACCESS_CODE);
  await page.locator("#gateCode").press("Enter");
  await expect(page.locator("#pStatus")).toContainText("connected");
  await talks();

  // Chrome leaves a clicked button focused; Space still talks and doesn't click it again.
  const proto = page.locator("#protoBtn");
  await proto.click();
  const pressed = await proto.getAttribute("aria-pressed");
  await talks();
  await expect(proto).toHaveAttribute("aria-pressed", pressed ?? "");

  // A button reached with Tab keeps Space.
  await proto.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(proto).not.toHaveAttribute("aria-pressed", pressed ?? "");
  await expect(orb).not.toHaveClass(/\b(tap|hold)\b/);

  // Typing in the message box types a space.
  await page.locator("#msg").click();
  await page.keyboard.press("Space");
  await expect(page.locator("#msg")).toHaveValue(" ");
  await expect(orb).not.toHaveClass(/\b(tap|hold)\b/);
});
