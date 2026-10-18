import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LOGIN_HANDOFF_REQUEST, LOGIN_HANDOFF_RESULT, receiveLoginHandoff, totpAddress, type LoginHandoffResult } from "./login-handoff.ts";
import { LoginStore } from "./login-store.ts";
import { parseTotpKey } from "./totp.ts";

// Obvious fakes only.
const PASSWORD = "fake-handoff-Passw0rd";
const TOKEN = "ops_fake-handoff-token";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omb-login-handoff-"));
  dirs.push(dir);
  const store = new LoginStore({ dataDir: dir });
  const posted: LoginHandoffResult[] = [];
  const ask = (message: unknown) => receiveLoginHandoff(message, store, (reply) => { posted.push(reply); return true; });
  return { store, posted, ask };
}

describe("the private login handoff to the desktop's main process", () => {
  it("hands one saved login as the Cloud's own Logins route takes it, its 2FA key as an address that parses back the same", () => {
    const { store, posted, ask } = setup();
    const totp = parseTotpKey("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60")!;
    const login = store.create({ site: "example.com", hosts: ["accounts.example.com", "login.example.com"], exactHost: true, username: "alice", password: PASSWORD, totp, source: "settings", bots: ["pepper"] });
    expect(ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0001", what: { kind: "login", id: login.id } })).toBe(true);
    expect(posted).toEqual([{ type: LOGIN_HANDOFF_RESULT, requestId: "request-0001", ok: true,
      login: { site: "accounts.example.com", exactHost: true, username: "alice", password: PASSWORD, totp: totpAddress(totp), bots: ["pepper"] } }]);
    expect(parseTotpKey((posted[0] as { login: { totp: string } }).login.totp)).toEqual(totp);
  });

  it("hands the 1Password token with its vaults' bots, and says plainly when there is nothing to hand", () => {
    const { store, posted, ask } = setup();
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0002", what: { kind: "1password" } });
    store.setOnePasswordToken(TOKEN);
    store.setOnePasswordGrant("v1", ["pepper"]);
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0003", what: { kind: "1password" } });
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0004", what: { kind: "login", id: "gone" } });
    expect(posted).toEqual([
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0002", ok: false, error: "1Password is not connected on this computer." },
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0003", ok: true, onePassword: { token: TOKEN, grants: { v1: ["pepper"] } } },
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0004", ok: false, error: "This login is no longer saved on this computer." },
    ]);
  });

  it("answers nothing to a malformed ask, and leaves every other private message to its own handler", () => {
    const { store, posted, ask } = setup();
    store.setOnePasswordToken(TOKEN);
    for (const malformed of [
      { type: LOGIN_HANDOFF_REQUEST, requestId: "x", what: { kind: "1password" } },
      { type: LOGIN_HANDOFF_REQUEST, requestId: "request-0005", what: { kind: "everything" } },
      { type: LOGIN_HANDOFF_REQUEST, requestId: "request-0006", what: { kind: "login", id: "../../etc" } },
      { type: LOGIN_HANDOFF_REQUEST, requestId: "request-0007" },
    ]) expect(ask(malformed)).toBe(true);
    expect(posted).toEqual([]);
    for (const other of [null, "text", [], { type: "openmausbot:phone-secret-save-result" }, { type: LOGIN_HANDOFF_RESULT, requestId: "request-0008" }]) expect(ask(other)).toBe(false);
  });
});
