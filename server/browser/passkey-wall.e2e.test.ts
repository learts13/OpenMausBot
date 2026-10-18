// A sign-in that stops at a passkey, on real Chrome: fixture pages shaped like Google's sign-in, whose passkey step
// asks WebAuthn for a credential as Google's does. The bot's answers go through the runtime router, as on a server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BrowserRuntime } from "../browser-runtime.ts";
import { hostTimeout } from "../testing/host-timeout.ts";
import { FixtureServer } from "./cdp/testing/fixtures.ts";
import { CHROME } from "./cdp/testing/real-chrome.ts";
import { CHROME_ENGINE, RuntimeRouter, type ChromeEngine } from "./engines.ts";
import { passkeyAnnotation, passkeyNotice } from "./passkey-notice.ts";
import { startService, type RealService, type ToolResult } from "./testing/real-service.ts";

const suite = CHROME ? describe : describe.skip;

const GOOGLE = `<div role="img" aria-label="Google">Google</div>`;
const SIGN_IN = (body: string) => `<!doctype html><meta charset="utf-8"><title>Sign in - Google Accounts</title>${GOOGLE}${body}`;
/** WebAuthn needs a registrable RP ID, so these pages are served from localhost, not 127.0.0.1. */
const PASSKEY_STEP = SIGN_IN(`<h1>Verifying it’s you</h1><p>Complete sign-in using your passkey</p><p id="state">Waiting for your passkey…</p>
<a href="/v3/signin/challenge/selection">Try another way</a>
<script>
  const state = document.getElementById("state");
  navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "localhost", allowCredentials: [], userVerification: "required", timeout: 60000 } })
    .then(() => { state.textContent = "Signed in"; }, (error) => { state.textContent = "Passkey did not finish: " + error.name; });
</script>`);

suite("a passkey step in the bots' browser on real Chrome", () => {
  let fx: FixtureServer;
  let real: RealService;
  let router: RuntimeRouter;
  let bots = 0;
  const said = (result: unknown) => real.text(result as ToolResult);

  beforeAll(async () => {
    fx = await FixtureServer.start();
    fx.page("/v3/signin/identifier", SIGN_IN(`<h1>Sign in</h1><label>Email or phone <input id="email"></label><button onclick="location.href='/v3/signin/challenge/pk/presend'">Next</button><a href="#">Sign in with a passkey</a>`));
    fx.page("/v3/signin/challenge/pk/presend", PASSKEY_STEP);
    fx.page("/v3/signin/challenge/selection", SIGN_IN(`<h1>Choose how you want to sign in</h1><a href="/v3/signin/challenge/pwd">Enter your password</a><a href="#">Get a verification code at ••• 42</a>`));
    fx.page("/v3/signin/challenge/pwd", SIGN_IN(`<h1>Welcome</h1><label>Enter your password <input type="password"></label><button>Next</button>`));
    real = await startService();
    const agentBrowser = { agentRpc: () => Promise.reject(new Error("agent-browser is not part of this suite")) } as unknown as BrowserRuntime;
    router = new RuntimeRouter(agentBrowser, { service: real.service } as unknown as ChromeEngine, { annotate: passkeyAnnotation("cloud") });
  }, hostTimeout(240_000));

  afterAll(async () => {
    await real?.close();
    await fx?.close();
  });

  const browser = () => {
    const key = `bot:passkey-${++bots}`;
    const session = `passkey-${bots}`;
    const spec = { command: CHROME_ENGINE, args: [key], env: {} };
    return {
      call: (name: string, args: Record<string, unknown> = {}) => router.agentRpc(session, spec, "tools/call", { name, arguments: args }),
      read: (expression: string) => real.read<string>({ session, key }, expression),
    };
  };
  const at = (path: string) => fx.crossSiteUrl(path);

  it("says what works instead of retrying, and the passkey step never finishes in this browser", async () => {
    const bot = browser();
    const opened = said(await bot.call("agent_browser_open", { url: at("/v3/signin/challenge/pk/presend") }));
    expect(opened).toContain("Complete sign-in using your passkey");
    expect(opened.endsWith(passkeyNotice("google", "cloud"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const state = await bot.read("document.querySelector('#state').textContent");
    console.info(`passkey step after 3 s in this browser: ${state}`);
    expect(state).not.toBe("Signed in");
    expect(said(await bot.call("agent_browser_snapshot")).endsWith(passkeyNotice("google", "cloud"))).toBe(true);
  }, hostTimeout(60_000));

  it("from the email step, the passkey step's own page carries the notice, and Try another way still works while the passkey waits", async () => {
    const bot = browser();
    const identifier = said(await bot.call("agent_browser_open", { url: at("/v3/signin/identifier") }));
    expect(identifier).toContain("Sign in with a passkey");
    expect(identifier).not.toContain(passkeyNotice("google", "cloud"));
    await bot.call("agent_browser_fill", { selector: "#email", text: "person@example.test" });
    await bot.call("agent_browser_click", { selector: "button" });
    expect(said(await bot.call("agent_browser_snapshot"))).toContain(passkeyNotice("google", "cloud"));
    expect(await bot.read("document.querySelector('#state').textContent")).toBe("Waiting for your passkey…");
    const another = said(await bot.call("agent_browser_click", { selector: "text=Try another way" }));
    expect(another).toContain("/v3/signin/challenge/selection");
    expect(another).not.toContain(passkeyNotice("google", "cloud"));
    const choices = said(await bot.call("agent_browser_snapshot"));
    expect(choices).toContain("Enter your password");
    expect(choices).not.toContain(passkeyNotice("google", "cloud"));
    await bot.call("agent_browser_click", { selector: "text=Enter your password" });
    expect(said(await bot.call("agent_browser_snapshot"))).not.toContain(passkeyNotice("google", "cloud"));
  }, hostTimeout(60_000));
});
