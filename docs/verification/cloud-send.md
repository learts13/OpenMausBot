# Send to My Cloud

What it covers: Settings → MausBot Cloud's **This computer and My Cloud**
(Send everything, Keep My Cloud up to date, Choose what goes), My Cloud's
strip (**Bring them over**), the switcher's send line, and Settings → Logins'
**Also use on My Cloud**, which is the same send for one login.

## Two real servers

```sh
pnpm exec vitest run server/cloud-send.e2e.test.ts server/cloud-send.test.ts
node --test electron/cloud-send.node-test.mjs
```

`scripts/testing/cloud-send-fixture.ts` starts this computer's server as the
desktop app starts it (its private utility-process port over Node's IPC) and a
Cloud home paired the way the Admin pairs it, with main's own wiring
(`electron/cloud-send-main.mjs`) between them through a fake `ipcMain`. Temp
homes, a synthetic Claude CLI and a fake 1Password SDK; no network. The e2e
checks:

- a bot (instructions, picture, skill, notes), a login kept to it, 1Password
  and About me reach My Cloud, the bot with its own id and conversation id;
- a bot whose switch is off stays here, and a login kept to it reaches no bot
  there (narrowed);
- a change here goes, a change made on My Cloud is kept until **Use this
  computer's**, and something removed on My Cloud is not brought back until its
  switch is turned on again;
- a password changed here goes on the next send;
- My Cloud's page is told bot names and counts only, never a login's site;
- every send signs its session out, and no answer or log carries a secret;
- **Bring newer chats** adds a sent bot's chats to My Cloud.

## The real renderer

```sh
node --experimental-strip-types scripts/verify-cloud-send.ts
```

It seeds the same two servers (Ember with instructions, a picture, two skills
and notes, two logins and 1Password here; a Chief and nine bots on My Cloud),
mounts the app twice through the isolated Vite preview, and prints both pages:
this computer's, opened on Settings → MausBot Cloud, and My Cloud's. Only the
desktop's main-process bridges are stand-ins (`scripts/testing/cloud-send-preview.tsx`);
Send to My Cloud's call main's real wiring through `/__send`. The switcher's
native menu is drawn from main's own template, since a page can't show a native
menu. Drive either page with any browser automation; nothing reaches the
user's app, data or a real Cloud.
