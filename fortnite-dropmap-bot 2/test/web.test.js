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

/* ---------------- captain avatars ---------------- */
const CDN = 'https://cdn.discordapp.com';
const AV_OPTS = { extension: 'png', size: 128 };

function avatarSetup({ memberFor, userFor } = {}) {
  const g = L.ensureGuild({});
  g.roleId = 'role1';
  for (const [id, epic, team] of [['cap1', 'Cap1', 'Alpha'], ['mate1', 'Mate1', 'Alpha'], ['cap2', 'Cap2', 'Bravo'], ['cap3', 'Cap3', 'Charlie']]) {
    g.players[id] = { epic, platform: 'PC', region: 'EU', team: null };
    L.setTeam(g, id, team);                       // first to join = members[0] = captain
  }
  const calls = { asked: [] };
  const mk = (id) => ({
    roles: { cache: { has: () => true } },
    displayAvatarURL: (o) => { calls.opts = o; return `${CDN}/avatars/${id}/hash.png?size=128`; },
  });
  const guild = {
    id: GID, name: 'Test Server',
    members: { fetch: async (id) => { calls.asked.push(id); return memberFor ? memberFor(id, mk) : mk(id); } },
  };
  const web = createWeb({
    client: { user: { id: 'bot' }, guilds: { cache: new Map([[GID, guild]]) }, users: { fetch: async (id) => (userFor ? userFor(id, mk) : null) } },
    G: () => g, save() {}, onChange() {}, baseUrl: 'http://localhost', clientSecret: 'x', secret: 'testsecret',
  });
  return { g, web, calls };
}
const getState = async (base, web, id) => (await (await fetch(`${base}/api/g/${GID}/state`, { headers: { Cookie: cookie(web, id) } })).json()).state;
const regionOf = (state, id) => state.regions.find((r) => r.id === id);

test('avatars: claimed region carries the captain (members[0]) avatar, requested as 128px png', async () => {
  const { g, web, calls } = avatarSetup();
  L.claim(g, 'alpha', ids[0]);
  await withServer(web, async (base) => {
    const st = await getState(base, web, 'cap1');
    assert.deepEqual(regionOf(st, ids[0]).claimants, [{ team: 'Alpha', avatar: `${CDN}/avatars/cap1/hash.png?size=128` }]);
    assert.deepEqual(calls.opts, AV_OPTS);
    assert.ok(!JSON.stringify(st).includes('mate1'), 'only the captain is looked up, no other member ids leak');
    assert.deepEqual(regionOf(st, ids[1]).claimants, []);            // free region: no avatar
  });
});

test('avatars: contested region lists every claiming team in order', async () => {
  const { g, web } = avatarSetup();
  L.claim(g, 'alpha', ids[2]); L.claim(g, 'bravo', ids[2]); L.claim(g, 'charlie', ids[2]);
  await withServer(web, async (base) => {
    const r = regionOf(await getState(base, web, 'cap1'), ids[2]);
    assert.equal(r.state, 'contested');
    assert.deepEqual(r.claimants.map((c) => c.team), ['Alpha', 'Bravo', 'Charlie']);
    assert.ok(r.claimants.every((c) => c.avatar && c.avatar.startsWith(CDN)));
    assert.deepEqual(r.teams, ['Alpha', 'Bravo', 'Charlie']);       // existing fields unchanged
  });
});

test('avatars: missing member, missing avatar function and bad URLs all degrade to null (no errors)', async () => {
  const { g, web } = avatarSetup({
    memberFor: (id, mk) => {
      if (id === 'cap1') return null;                                              // left the server
      if (id === 'cap2') return { roles: { cache: { has: () => true } } };         // no displayAvatarURL at all
      return { roles: { cache: { has: () => true } }, displayAvatarURL: () => 'http://evil.example/x.png' }; // non-Discord URL
    },
    userFor: (id) => (id === 'cap1' ? null : undefined),
  });
  L.claim(g, 'alpha', ids[0]); L.claim(g, 'bravo', ids[1]); L.claim(g, 'charlie', ids[2]);
  await withServer(web, async (base) => {
    const st = await getState(base, web, 'cap2');
    for (const id of [ids[0], ids[1], ids[2]]) {
      assert.equal(regionOf(st, id).claimants[0].avatar, null);
      assert.equal(regionOf(st, id).state, 'claimed');
    }
  });
});

test('avatars: falls back to the user object when the guild member is gone', async () => {
  const { g, web } = avatarSetup({
    memberFor: (id, mk) => (id === 'cap1' ? null : mk(id)),
    userFor: (id) => ({ displayAvatarURL: () => `${CDN}/avatars/${id}/user.png` }),
  });
  L.claim(g, 'alpha', ids[0]);
  await withServer(web, async (base) => {
    const st = await getState(base, web, 'cap2');
    assert.equal(regionOf(st, ids[0]).claimants[0].avatar, `${CDN}/avatars/cap1/user.png`);
  });
});

test('avatars: lookups are cached between polls and a slow lookup cannot stall the state endpoint', async () => {
  const { g, web, calls } = avatarSetup();
  L.claim(g, 'alpha', ids[0]);
  await withServer(web, async (base) => {
    await getState(base, web, 'cap2');
    const before = calls.asked.filter((x) => x === 'cap1').length;
    await getState(base, web, 'cap2'); await getState(base, web, 'cap2');
    assert.equal(calls.asked.filter((x) => x === 'cap1').length, before, 'captain fetched once, then cached');
  });
  const slow = avatarSetup({ memberFor: (id, mk) => (id === 'cap1' ? new Promise(() => {}) : mk(id)) });
  L.claim(slow.g, 'alpha', ids[0]);
  await withServer(slow.web, async (base) => {
    const t0 = Date.now();
    const st = await getState(base, slow.web, 'cap2');
    assert.ok(Date.now() - t0 < 4000, 'returned despite a hung lookup');
    assert.equal(regionOf(st, ids[0]).claimants[0].avatar, null);
  });
});

test('avatars: claim and release responses still return a full state with claimants', async () => {
  const { web } = avatarSetup();
  await withServer(web, async (base) => {
    const r = await post(base, `/api/g/${GID}/claim`, cookie(web, 'cap1'), { regionId: ids[3] });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(regionOf(d.state, ids[3]).claimants[0].team, 'Alpha');
    await new Promise((res) => setTimeout(res, 800));
    const rel = await (await post(base, `/api/g/${GID}/release`, cookie(web, 'cap1'), {})).json();
    assert.deepEqual(regionOf(rel.state, ids[3]).claimants, []);
  });
});

test('web: state includes the event mode label', async () => {
  const { g, web } = setup();
  await withServer(web, async (base) => {
    const get = async () => (await (await fetch(`${base}/api/g/${GID}/state`, { headers: { Cookie: cookie(web, 'u1') } })).json()).state.mode;
    assert.equal(await get(), 'Trios');
    g.mode = 'solos';
    assert.equal(await get(), 'Solos');
  });
});
