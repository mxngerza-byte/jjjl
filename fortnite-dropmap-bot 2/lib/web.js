'use strict';
/**
 * Small web server: the interactive drop map page + JSON API.
 * Players log in with Discord (OAuth2 "identify"), the server checks they hold
 * the Registered role / are on the roster, and claims go through the same
 * logic as the Discord dropdown.  Built on Node's http module only.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./logic');
const cfg = require('../config/regions.json');

const ROOT = path.join(__dirname, '..');
const REGION_IDS = cfg.regions.map((r) => r.id);
const SESSION_MS = 7 * 24 * 3600 * 1000;

function createWeb(ctx) {
  // ctx: { client, G, save, onChange(guild), baseUrl, clientSecret, secret }
  const secure = ctx.baseUrl.startsWith('https://');
  const sign = (s) => crypto.createHmac('sha256', ctx.secret).update(s).digest('base64url');
  const pack = (obj) => { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${p}.${sign(p)}`; };
  const unpack = (tok) => {
    if (!tok) return null;
    const [p, sig] = String(tok).split('.');
    if (!p || !sig) return null;
    const a = Buffer.from(sig); const b = Buffer.from(sign(p));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const o = JSON.parse(Buffer.from(p, 'base64url').toString());
      return o.exp && o.exp < Date.now() ? null : o;
    } catch { return null; }
  };
  const parseCookies = (req) => Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
    }),
  );
  const setCookie = (res, name, value, maxAgeSec) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (secure) parts.push('Secure');
    res._cookies = [...(res._cookies || []), parts.join('; ')];
    res.setHeader('Set-Cookie', res._cookies);
  };

  const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(body);
  };
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
  const redirect = (res, to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
  const file = (res, rel, type, cache) => {
    try {
      send(res, 200, fs.readFileSync(path.join(ROOT, rel)), type, { 'Cache-Control': cache });
    } catch { send(res, 404, 'Not found'); }
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4096) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  const safeNext = (n) => (/^\/g\/\d{5,25}$/.test(n || '') ? n : '/');
  const lastAction = new Map();

  /* ---- captain avatars (public Discord CDN URLs only; never tokens or secrets) ---- */
  const AVATAR_OK = /^https:\/\/cdn\.discordapp\.com\//;
  const AVATAR_OPTS = { extension: 'png', size: 128 };
  const AVATAR_TTL = 10 * 60 * 1000;        // keep a found avatar for 10 minutes
  const AVATAR_MISS_TTL = 60 * 1000;        // retry a failed lookup after 1 minute
  const AVATAR_TIMEOUT = 2500;              // never let a slow lookup stall the 3s poll
  const avatarCache = new Map();            // "guildId:userId" -> { promise, exp }

  const avatarUrlOf = (obj) => {
    try {
      const url = typeof obj?.displayAvatarURL === 'function' ? obj.displayAvatarURL(AVATAR_OPTS) : null;
      return typeof url === 'string' && AVATAR_OK.test(url) ? url : null;
    } catch { return null; }
  };

  async function lookupAvatar(guild, userId) {
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      let url = avatarUrlOf(member);                       // server avatar if set, else the user's
      if (!url && ctx.client.users) {
        url = avatarUrlOf(await ctx.client.users.fetch(userId).catch(() => null));
      }
      return url;
    } catch { return null; }
  }

  function getAvatar(guild, userId) {
    const key = `${guild.id}:${userId}`;
    const now = Date.now();
    const hit = avatarCache.get(key);
    if (hit && hit.exp > now) return hit.promise;
    if (avatarCache.size > 1000) avatarCache.clear();
    const promise = Promise.race([
      lookupAvatar(guild, userId),
      new Promise((resolve) => setTimeout(() => resolve(null), AVATAR_TIMEOUT)),
    ]);
    const entry = { promise, exp: now + AVATAR_TTL };
    avatarCache.set(key, entry);
    promise.then((url) => { if (!url) entry.exp = Date.now() + AVATAR_MISS_TTL; });
    return promise;
  }

  async function buildState(guild, g, userId, hasRole) {
    // Snapshot everything from `g` first, so the awaits below can't mix two versions of the game state.
    const team = L.teamOf(g, userId);
    const base = {
      guildName: guild.name,
      open: g.open.dropmap,
      game: g.session ? { current: g.session.current, total: g.session.total, nextAt: g.session.nextAt } : null,
      status: L.actorStatus(g, hasRole, userId),
      team: team ? { name: team.name, members: team.members.map((u) => g.players[u]?.epic || 'player') } : null,
    };
    const rows = cfg.regions.map((r) => {
      const keys = g.claims[r.id] || [];
      return {
        id: r.id, name: r.name,
        state: keys.length === 0 ? 'free' : keys.length === 1 ? 'claimed' : 'contested',
        teams: keys.map((k) => g.teams[k]?.name || k),
        mine: !!team && keys.includes(team.key),
        // captain = first member of the team (logic.js has no explicit captain field)
        claimants: keys.map((k) => ({ team: g.teams[k]?.name || k, captainId: g.teams[k]?.members?.[0] || null })),
      };
    });

    const captainIds = [...new Set(rows.flatMap((r) => r.claimants.map((c) => c.captainId)).filter(Boolean))];
    const avatars = new Map(await Promise.all(captainIds.map(async (id) => [id, await getAvatar(guild, id)])));

    return {
      ...base,
      regions: rows.map(({ claimants, ...r }) => ({
        ...r,
        claimants: claimants.map((c) => ({ team: c.team, avatar: (c.captainId && avatars.get(c.captainId)) || null })),
      })),
    };
  }

  async function handleApi(req, res, gid, action) {
    const sess = unpack(parseCookies(req).session);
    if (!sess) return json(res, 401, { error: 'login' });
    const guild = ctx.client.guilds.cache.get(gid);
    if (!guild) return json(res, 404, { error: 'This server isn\'t using the bot.' });
    const member = await guild.members.fetch(sess.id).catch(() => null);
    if (!member) return json(res, 403, { error: 'You\'re not in this Discord server.' });
    const g = ctx.G(gid);
    const hasRole = !!(g.roleId && member.roles.cache.has(g.roleId));

    if (action === 'state') {
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
      return json(res, 200, { state: await buildState(guild, g, sess.id, hasRole) });
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
    const now = Date.now();
    if (now - (lastAction.get(sess.id) || 0) < 700) return json(res, 429, { error: 'Slow down a little.' });
    lastAction.set(sess.id, now);

    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'Bad request.' }); }

    if (action === 'claim') {
      const r = L.claimFor(g, sess.id, hasRole, String(body.regionId || ''), REGION_IDS);
      const state = await buildState(guild, g, sess.id, hasRole);
      if (!r.ok) return json(res, 400, { error: r.error, state });
      ctx.save();
      ctx.onChange(guild);
      const name = cfg.regions.find((x) => x.id === body.regionId).name;
      const message = r.status === 'already' ? `Your team already holds ${name}.`
        : r.status === 'contested' ? `Contesting ${name} against ${r.others.map((k) => g.teams[k]?.name || k).join(', ')}.`
        : `${r.team.name} claimed ${name}.`;
      return json(res, 200, { message, state: await buildState(guild, g, sess.id, hasRole) });
    }

    const r = L.releaseFor(g, sess.id, hasRole);
    if (!r.ok) return json(res, 400, { error: r.error, state: await buildState(guild, g, sess.id, hasRole) });
    ctx.save();
    ctx.onChange(guild);
    return json(res, 200, { message: 'Your team\'s spot is released.', state: await buildState(guild, g, sess.id, hasRole) });
  }

  async function oauthCallback(req, res, url) {
    const o = unpack(parseCookies(req).oauth);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!o || !state || o.state !== state || !code) return send(res, 400, 'Login expired or invalid. Go back and try the link again.');
    const clientId = ctx.client.user?.id;
    if (!clientId) return send(res, 503, 'The bot is still starting. Try again in a moment.');
    try {
      const tok = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, client_secret: ctx.clientSecret, grant_type: 'authorization_code',
          code, redirect_uri: `${ctx.baseUrl}/auth/callback`,
        }),
      });
      if (!tok.ok) return send(res, 502, 'Discord rejected the login. Check DISCORD_CLIENT_SECRET and the redirect URL.');
      const { access_token: accessToken } = await tok.json();
      const me = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!me.ok) return send(res, 502, 'Could not read your Discord profile.');
      const u = await me.json();
      setCookie(res, 'session', pack({ id: u.id, name: u.global_name || u.username, exp: Date.now() + SESSION_MS }), SESSION_MS / 1000);
      setCookie(res, 'oauth', '', 0);
      return redirect(res, safeNext(o.next));
    } catch (err) {
      console.error('OAuth error:', err);
      return send(res, 502, 'Login failed. Try again.');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, ctx.baseUrl);
      const p = url.pathname;

      if (p === '/' || p === '/healthz') return send(res, 200, 'Drop map bot is running.');
      if (p === '/static/map.jpg') return file(res, cfg.map.file, 'image/jpeg', 'public, max-age=3600');
      if (p === '/static/regions.json') return file(res, 'config/regions.json', 'application/json', 'public, max-age=300');

      if (p === '/login') {
        if (!ctx.clientSecret) return send(res, 500, 'The bot owner still needs to set DISCORD_CLIENT_SECRET.');
        if (!ctx.client.user) return send(res, 503, 'The bot is still starting. Try again in a moment.');
        const state = crypto.randomBytes(16).toString('hex');
        setCookie(res, 'oauth', pack({ state, next: safeNext(url.searchParams.get('next')), exp: Date.now() + 10 * 60 * 1000 }), 600);
        const q = new URLSearchParams({
          client_id: ctx.client.user.id, response_type: 'code', scope: 'identify', state,
          redirect_uri: `${ctx.baseUrl}/auth/callback`, prompt: 'none',
        });
        return redirect(res, `https://discord.com/oauth2/authorize?${q}`);
      }
      if (p === '/auth/callback') return await oauthCallback(req, res, url);
      if (p === '/logout') { setCookie(res, 'session', '', 0); return redirect(res, '/'); }

      let m = p.match(/^\/g\/(\d{5,25})$/);
      if (m) {
        if (!unpack(parseCookies(req).session)) return redirect(res, `/login?next=${encodeURIComponent(p)}`);
        return file(res, 'public/map.html', 'text/html; charset=utf-8', 'no-store');
      }
      m = p.match(/^\/api\/g\/(\d{5,25})\/(state|claim|release)$/);
      if (m) return await handleApi(req, res, m[1], m[2]);

      return send(res, 404, 'Not found');
    } catch (err) {
      console.error('Web error:', err);
      if (!res.headersSent) send(res, 500, 'Server error');
    }
  });

  return {
    server,
    listen: (port) => new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
    url: (guildId) => `${ctx.baseUrl}/g/${guildId}`,
    _pack: pack,
  };
}

module.exports = { createWeb };
