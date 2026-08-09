# Handoff Notes — July 3 2026

## Current State

### What's running
- **MattiePA** (`mattiеpa35`) — online, port 3142, token `8192796605` → `@markshref_bot` ✅
- **claudeclaw** — online but broken, dead/invalid token `8205957809`, should be deleted

### One thing to do first
```
pm2 delete claudeclaw && pm2 save
```
That's all that's needed. MattiePA stays up untouched.

---

## What Was Discovered

### You only have one real Telegram bot
Both ClaudeClaw deployments were pointing at the same Telegram identity `@markshref_bot`. The "Marc Schreff bot" token (`8205957809`) is dead — Telegram's `getMe` returns nothing for it. The only valid token is `8192796605` which belongs to MattiePA.

### Why it looked broken
The claudeclaw process was crash-looping (332 restarts) because:
1. Its token is invalid — Telegram rejects it
2. It kept hitting `EADDRINUSE` on port 3141 in earlier restarts

MattiePA was actually working the whole time. It just appeared broken because both processes were logging the same username.

### What was fixed
Both ecosystem configs now have their tokens baked in explicitly:
- `C:\Users\mattieform\GitHub\claudeclaw-os\ecosystem.config.cjs` — token `8192796605`, port 3142
- `C:\Users\mattieform\GitHub\Claude Claud 2\ecosystem.config.cjs` — token `8205957809`, port 3141 (dead token, process should be deleted)

---

## If You Want a Second Real Bot
1. Open Telegram → message `@BotFather`
2. Send `/newbot`, follow prompts, get a fresh token
3. Put that token in `C:\Users\mattieform\GitHub\Claude Claud 2\.env` as `TELEGRAM_BOT_TOKEN=<new_token>`
4. Also add it to the ecosystem config env block
5. `pm2 start "C:\Users\mattieform\GitHub\Claude Claud 2\ecosystem.config.cjs"`

---

## Useful Commands
```
pm2 status                              # check both processes
pm2 logs mattiеpa35 --lines 20          # MattiePA live logs
pm2 delete claudeclaw && pm2 save       # remove the dead process
pm2 save                                # persist current state across reboots
```

---

## Pinecone GUI (separate work in progress)
The `pinecone_gui.py` in this workspace has ongoing bugs (crash on launch, stuck after adding files). Root causes identified but not fully resolved — the GUI rewrite introduced PanedWindow layout issues and a Unicode encoding problem on Windows. The bulk upload script (`pinecone_bulk.py`) is working correctly with the embedding speed improvements applied.
