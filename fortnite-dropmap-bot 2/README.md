# Fortnite Trios Drop Map Bot

Registration → role → **interactive web drop map** (every box on your map is clickable) + trio fill finder, with timed multi-game hosting. Built to run on Railway.

## How it plays

- **Register** (`#register`): one click. Press **Register** and the bot uses your **Discord display name** as your player name (nothing to type, no form). You get the **Registered Player** role, which unlocks `#drop-map` and `#fill`. Team size is set by `/mode` (solos 1, duos 2, trios 3, squads 4; default trios). Solos are auto-teamed.
  - **Team captain picks teammates:** in duos/trios/squads, right after registering, a player with no team sees a menu to @-select up to (team size - 1) teammates. The bot creates the team named after them (e.g. "Alex's Trio"), adds the picked teammates, gives them the **Registered Player** role, and gives the whole team a Discord role named after the team (no permissions). Picks are skipped if the person is a bot, not in the server, already on another team, or the team is full. Teammates can also just press **Register** themselves and be added by a captain, or use `/team set <name>` or the fill channel. Team roles are removed when the team empties, when you switch `/mode`, and on `/end scrims`. The bot needs **Manage Roles** and its role must sit above the Registered and team roles.
- **Drop map**: `/open dropmap` posts a **link** to the interactive map in `#drop-map`. Players open it, log in with Discord, tap a box, press **Drop here**.
  - A team picks a box → it turns **black** (claimed).
  - Another team picks the same box → it turns **red** (contested). If a team leaves, it goes back to black / unclaimed.
  - A team holds one box at a time; picking a new one moves them. Everyone's page updates live (every 3 seconds). The Discord drop-map channel holds just the link message, with no embed.
  - All 27 boxes are clickable. No names were added to your map: the 13 boxes that already have a printed name keep it, the other 14 are just **Box 1 … Box 14** (plain numbers, only used in Discord text and the selection bar).
- **Fill** (`#fill`): "Post a fill request" → others join with a button. When the trio is full the bot puts all three on one team and opens a thread. Duos can post too and only need one more.
- **Hosted games** (`/host start games:N`, 1–6): game 1 starts right away with a registration post, `@here` and the map link. Every **30 minutes** the bot resets the map and roster, closes old fill requests, and posts a **new registration + `@here`** plus a fresh map link. After the last game it closes everything.

## Commands

| Command | Who | What |
|---|---|---|
| `/setup [role]` | admin | Create/repair role, channels, permissions and panels |
| `/open registration` · `/close registration` | admin | Enable / disable the Register button |
| `/open fill` · `/close fill` | admin | Open / lock the fill channel (closing also closes all open requests) |
| `/open dropmap` · `/close dropmap` | admin | Unlock (**posts the map link**) / lock claiming |
| `/host start games:<1-6>` | admin | Start a session, 30 min per game |
| `/host status` · `/host stop` | admin | Check time to next game / end the session early |
| `/dropmap link` · `reset` · `refresh` | admin | Re-post the link / clear all claims / re-post the panel |
| `/mode type:<solos/duos/trios/squads>` | admin | Choose the format. Team size follows it (1/2/3/4 per team). Switching clears teams, claims and fill requests; in solos every registered player automatically gets their own team |
| `/end scrims` | admin | End the event: removes the Registered role from everyone, closes registration, fill and the drop map, stops any session and clears teams/claims |
| `/unregister <user>` | admin | Remove registration, team seat and role |
| `/team set <name>` · `leave` · `view` | players | Manage your trio |

While a session is running, players must register for the **current game** before they can claim a spot or use the fill channel.

## Deploy on Railway

1. Push this folder to a GitHub repo (the `.gitignore` already keeps `.env` and `data/` out).
2. Railway → **New Project → Deploy from GitHub repo**. It builds automatically (`railway.json` is included).
3. **Settings → Networking → Generate Domain.** You get a URL like `https://yourbot.up.railway.app`. The bot picks it up automatically (`RAILWAY_PUBLIC_DOMAIN`), no `BASE_URL` needed. Use `BASE_URL` only for a custom domain.
4. **Variables** tab, add:
   - `DISCORD_TOKEN`: the bot token
   - `DISCORD_CLIENT_SECRET`: Developer Portal → your app → OAuth2 → Client Secret
   - `GUILD_ID` (optional): your server ID, makes slash commands appear instantly
5. **Add a Volume** (right-click the service → Attach Volume, any mount path e.g. `/data`). Without it, team/registration data and a running session are lost on every redeploy. The bot uses the volume automatically.
6. **Discord Developer Portal → OAuth2 → Redirects → Add Redirect:**
   `https://YOUR-RAILWAY-DOMAIN/auth/callback` (exactly this, using your real domain). Without it, "Log in with Discord" on the map page fails.
7. Invite the bot: OAuth2 → URL Generator, scopes `bot` + `applications.commands`, permissions: Manage Roles, Manage Channels, View Channels, Send Messages, Embed Links, Read Message History, **Mention Everyone**, Create Public Threads, Send Messages in Threads, Manage Threads.
8. In Discord, drag the bot's role **above "Registered Player"** (Server Settings → Roles), then run `/setup`.

Run locally instead: `npm install`, copy `.env.example` to `.env`, `npm start`. The map page is then at `http://localhost:3000/g/<your server id>` (Discord only accepts the login redirect if you also add `http://localhost:3000/auth/callback`).

`npm test` runs the logic and web tests.

## Notes

- Players are identified by Discord login (identify scope only, no email). The server checks they are in your server, hold the Registered role, are on the current game's roster and on a team, so nobody can claim for another team.
- `@here` only pings members who are online and can see `#register`; the bot needs the Mention Everyone permission.
- Team names strip `@` and markdown so nobody can ping everyone through a team name.
- Regions live in `config/regions.json` (pixel polygons traced from the green outlines on `assets/map.jpg`). For a new map, replace the image and re-trace the shapes.
