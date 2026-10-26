'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/logic');
const { createWeb } = require('../lib/web');
const cfg = require('../config/regions.json');

const GID = '123456789012345678';
const ids = cfg.regions.map((r) => r.id);

function setup() {
  const g = L.ensureGuild({});
  g.roleId = 'role1';
  for (const [id, epic, team] of [['u1', 'A', 'Alpha'], ['u2', 'B', 'Bravo'], ['u3', 'C', null]]) {
    g.players[id] = { epic, platform: 'PC', region: 'EU', team: null };
    if (team) L.setTeam(g, id, team);
  }
  const members = { u1: ['role1'], u2: ['role1'], u3: ['role1'], u4: [] };
  const guild = {
    id: GID, name: 'Test Server',
    members: { fetch: async (id) => (members[id] ? { roles: { cache: { has: (r) => members[id].includes(r) } } } : null) },
  };
  const changes = [];
  const web = createWeb({
    client: { user: { id: 'bot' }, guilds: { cache: new Map([[GID, guild]]) } },
    G: () => g, save() {}, onChange: (gd) => changes.push(gd.id),
    baseUrl: 'http://localhost', clientSecret: 'x', secret: 'testsecret',
  });
  return { g, web, changes };
}

async function withServer(web, fn) {
  const port = await web.listen(0);
  try { await fn(`http://127.0.0.1:${port}`); } finally { await web.close(); }
}
const cookie = (web, id) => `session=${encodeURIComponent(web._pack({ id, name: id, exp: Date.now() + 1e6 }))}`;
const post = (base, p, ck, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body) });

test('all 27 boxes exist and are clickable; only printed names are labelled', () => {
  assert.equal(cfg.regions.length, 27);
  assert.equal(cfg.regions.filter((r) => r.label).length, 13);
  assert.ok(cfg.regions.filter((r) => !r.label).every((r) => /^Box \d+$/.test(r.name)));
});

test('web: pages, static files and login redirect', async () => {
  const { web } = setup();
  await withServer(web, async (base) => {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/static/map.jpg')).headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(base + '/static/regions.json')).status, 200);
    const r = await fetch(`${base}/g/${GID}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^\/login\?next=/);
    const page = await fetch(`${base}/g/${GID}`, { headers: { Cookie: cookie(web, 'u1') } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Drop Map/);
    assert.equal((await fetch(`${base}/api/g/${GID}/state`)).status, 401);
    const evil = await fetch(`${base}/login?next=${encodeURIComponent('https://evil.example')}`, { redirect: 'manual' });
    assert.equal(evil.status, 302);
  });
});

test('web: forged or tampered cookies are rejected', async () => {
  const { web } = setup();
  await withServer(web, async (base) => {
    const good = cookie(web, 'u1');
    const tampered = good.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal((await fetch(`${base}/api/g/${GID}/state`, { headers: { Cookie: tampered } })).status, 401);
    assert.equal((await fetch(`${base}/api/g/${GID}/state`, { headers: { Cookie: 'session=abc.def' } })).status, 401);
  });
});

test('web: claim -> black, rival -> red, release, validation', async () => {
  const { g, web, changes } = setup();
  await withServer(web, async (base) => {
    const u1 = cookie(web, 'u1'); const u2 = cookie(web, 'u2');
    let r = await post(base, `/api/g/${GID}/claim`, u1, { regionId: ids[0] });
    let d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.state.regions[0].state, 'claimed');
    assert.equal(d.state.regions[0].mine, true);

    await new Promise((res) => setTimeout(res, 800));
    r = await post(base, `/api/g/${GID}/claim`, u2, { regionId: ids[0] });
    d = await r.json();
    assert.equal(d.state.regions[0].state, 'contested');
    assert.deepEqual(d.state.regions[0].teams.sort(), ['Alpha', 'Bravo']);
    assert.ok(changes.length >= 2, 'discord panel refresh requested');

    await new Promise((res) => setTimeout(res, 800));
    r = await post(base, `/api/g/${GID}/release`, u2, {});
    assert.equal((await r.json()).state.regions[0].state, 'claimed');

    await new Promise((res) => setTimeout(res, 800));
    r = await post(base, `/api/g/${GID}/claim`, u1, { regionId: 'nope' });
    assert.equal(r.status, 400);
    await new Promise((res) => setTimeout(res, 800));
    g.open.dropmap = false;
    r = await post(base, `/api/g/${GID}/claim`, u1, { regionId: ids[1] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /locked/);
  });
});

test('web: people without role/team cannot claim; non-members rejected', async () => {
  const { web } = setup();
  await withServer(web, async (base) => {
    let r = await post(base, `/api/g/${GID}/claim`, cookie(web, 'u3'), { regionId: ids[0] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /team/i);
    r = await fetch(`${base}/api/g/${GID}/state`, { headers: { Cookie: cookie(web, 'u4') } });
    assert.equal((await r.json()).state.status, 'not_registered');
    r = await fetch(`${base}/api/g/${GID}/state`, { headers: { Cookie: cookie(web, 'ghost') } });
    assert.equal(r.status, 403);
  });
});

test('web: during a session, players not registered for the current game are refused', async () => {
  const { g, web } = setup();
  L.startSession(g, 2, 'host');
  await withServer(web, async (base) => {
    let r = await post(base, `/api/g/${GID}/claim`, cookie(web, 'u1'), { regionId: ids[0] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /current game/i);
    L.addToRoster(g, 'u1');
    await new Promise((res) => setTimeout(res, 800));
    r = await post(base, `/api/g/${GID}/claim`, cookie(web, 'u1'), { regionId: ids[0] });
    assert.equal(r.status, 200);
  });
});

test('web: rapid repeat actions are rate limited', async () => {
  const { web } = setup();
  await withServer(web, async (base) => {
    const u1 = cookie(web, 'u1');
    await post(base, `/api/g/${GID}/claim`, u1, { regionId: ids[0] });
    const r = await post(base, `/api/g/${GID}/claim`, u1, { regionId: ids[1] });
    assert.equal(r.status, 429);
  });
});
