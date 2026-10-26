'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/logic');

const mk = () => {
  const g = L.ensureGuild({});
  for (const [id, epic] of [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D'], ['e', 'E'], ['f', 'F'], ['x', 'X']]) {
    g.players[id] = { epic, platform: 'PC', region: 'EU', team: null };
  }
  return g;
};

test('teams are capped at 3 and names are case-insensitive', () => {
  const g = mk();
  assert.ok(L.setTeam(g, 'a', 'Alpha').ok);
  assert.ok(L.setTeam(g, 'b', ' alpha ').ok);
  assert.ok(L.setTeam(g, 'c', 'ALPHA').ok);
  const r = L.setTeam(g, 'd', 'alpha');
  assert.equal(r.ok, false);
  assert.equal(g.teams.alpha.members.length, 3);
});

test('team names cannot smuggle mentions or markdown', () => {
  const g = mk();
  const r = L.setTeam(g, 'a', '@everyone **<@&123>**');
  assert.ok(r.ok);
  assert.ok(!r.team.name.includes('@') && !r.team.name.includes('*'));
  assert.equal(L.setTeam(g, 'b', '@@@').ok, false);
});

test('leaving the last seat deletes the team and its claim', () => {
  const g = mk();
  L.setTeam(g, 'a', 'Solo');
  L.claim(g, 'solo', 'golden-grove');
  L.leaveTeam(g, 'a');
  assert.equal(g.teams.solo, undefined);
  assert.equal(L.regionState(g, 'golden-grove'), 'free');
});

test('claim -> black, second team -> red, leaving -> black again', () => {
  const g = mk();
  L.setTeam(g, 'a', 'One'); L.setTeam(g, 'b', 'Two'); L.setTeam(g, 'c', 'Three');
  assert.equal(L.claim(g, 'one', 'lifty-lodge').status, 'claimed');
  assert.equal(L.regionState(g, 'lifty-lodge'), 'claimed');
  assert.equal(L.claim(g, 'two', 'lifty-lodge').status, 'contested');
  assert.equal(L.regionState(g, 'lifty-lodge'), 'contested');
  assert.equal(L.claim(g, 'three', 'lifty-lodge').status, 'contested');
  assert.equal(L.claim(g, 'one', 'lifty-lodge').status, 'already');
  // team two moves away
  assert.equal(L.claim(g, 'two', 'wonkeeland').status, 'claimed');
  assert.deepEqual(g.claims['lifty-lodge'], ['one', 'three']);
  L.unclaim(g, 'three');
  assert.equal(L.regionState(g, 'lifty-lodge'), 'claimed');
});

test('a team only ever holds one spot', () => {
  const g = mk();
  L.setTeam(g, 'a', 'One');
  L.claim(g, 'one', 'lifty-lodge');
  L.claim(g, 'one', 'wonkeeland');
  assert.equal(L.regionState(g, 'lifty-lodge'), 'free');
  assert.equal(L.regionState(g, 'wonkeeland'), 'claimed');
});

test('fill: teamless trio forms a new team', () => {
  const g = mk();
  const { fill } = L.createFill(g, 'a', 'mic');
  assert.deepEqual(fill.members, ['a']);
  assert.equal(L.joinFill(g, fill, 'b').full, false);
  assert.equal(L.joinFill(g, fill, 'c').full, true);
  assert.equal(L.joinFill(g, fill, 'd').ok, false);
  const name = L.finalizeFill(g, fill);
  assert.equal(name, "A's Trio");
  assert.equal(g.teams[L.teamKey(name)].members.length, 3);
  assert.equal(L.teamOf(g, 'c').name, "A's Trio");
});

test('fill: duo needs one more and keeps its team name', () => {
  const g = mk();
  L.setTeam(g, 'a', 'Duo'); L.setTeam(g, 'b', 'Duo');
  const { fill } = L.createFill(g, 'a');
  assert.deepEqual(fill.base, ['a', 'b']);
  assert.equal(L.leaveFill(fill, 'b').ok, false);        // base members can't leave via fill
  assert.equal(L.joinFill(g, fill, 'c').full, true);
  assert.equal(L.finalizeFill(g, fill), 'Duo');
  assert.equal(g.teams.duo.members.length, 3);
});

test('fill: people already on a team cannot join; full team cannot host', () => {
  const g = mk();
  L.setTeam(g, 'x', 'Other');
  const { fill } = L.createFill(g, 'a');
  assert.equal(L.joinFill(g, fill, 'x').ok, false);
  L.setTeam(g, 'b', 'Full'); L.setTeam(g, 'c', 'Full'); L.setTeam(g, 'd', 'Full');
  assert.equal(L.createFill(g, 'b').ok, false);
});

test('fill: duplicate auto team names get a suffix', () => {
  const g = mk();
  g.teams[L.teamKey("A's Trio")] = { name: "A's Trio", members: ['x'] };
  const { fill } = L.createFill(g, 'a');
  L.joinFill(g, fill, 'b'); L.joinFill(g, fill, 'c');
  assert.equal(L.finalizeFill(g, fill), "A's Trio 2");
});

test('session: 1-6 games, 30 min each, claims & roster reset between games', () => {
  const g = mk();
  assert.equal(L.startSession(g, 0, 'h').ok, false);
  assert.equal(L.startSession(g, 7, 'h').ok, false);
  assert.equal(L.startSession(g, 2.5, 'h').ok, false);
  const t0 = 1_000_000;
  assert.ok(L.startSession(g, 3, 'h', t0).ok);
  assert.equal(L.startSession(g, 3, 'h').ok, false);     // already running
  assert.equal(g.session.nextAt, t0 + 30 * 60 * 1000);

  L.setTeam(g, 'a', 'One'); L.claim(g, 'one', 'lifty-lodge'); L.addToRoster(g, 'a'); L.addToRoster(g, 'a');
  assert.deepEqual(g.session.roster, ['a']);

  const t1 = t0 + L.GAME_MS;
  assert.deepEqual(L.advanceSession(g, t1), { result: 'next', current: 2, total: 3, nextAt: t1 + L.GAME_MS });
  assert.deepEqual(g.session.roster, []);
  assert.deepEqual(g.claims, {});
  assert.ok(g.teams.one, 'teams persist across games');

  assert.equal(L.advanceSession(g, t1 + L.GAME_MS).current, 3);
  assert.deepEqual(L.advanceSession(g, t1 + 2 * L.GAME_MS), { result: 'finished', total: 3 });
  assert.equal(g.session, null);
  assert.equal(L.advanceSession(g).result, 'none');
});

test('every region in regions.json has valid polygons and a unique id', () => {
  const cfg = require('../config/regions.json');
  const ids = new Set();
  for (const r of cfg.regions) {
    assert.ok(!ids.has(r.id)); ids.add(r.id);
    assert.ok(r.polygons.length >= 1);
    for (const p of r.polygons) {
      assert.ok(p.length >= 3);
      for (const [x, y] of p) assert.ok(x >= 0 && x <= cfg.map.width && y >= 0 && y <= cfg.map.height);
    }
  }
  assert.equal(cfg.regions.length, 27);
});

/* ---------------- event modes: solos / duos / trios / squads ---------------- */
const mkMode = (mode, n = 6) => {
  const g = L.ensureGuild({});
  if (mode) g.mode = mode;
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, n)) g.players[id] = { epic: id.toUpperCase(), platform: 'PC', region: 'EU', team: null };
  return g;
};

test('modes: default is trios and sizes are 1/2/3/4', () => {
  assert.equal(L.teamSize(L.ensureGuild({})), 3);
  assert.equal(L.teamSize(L.ensureGuild({ mode: 'bogus' })), 3);          // unknown value falls back to trios
  assert.deepEqual(['solos', 'duos', 'trios', 'squads'].map((m) => L.MODES[m].size), [1, 2, 3, 4]);
  const old = { roleId: 'r', players: {} };                               // a database from before modes existed
  assert.equal(L.ensureGuild(old).mode, 'trios');
});

test('modes: team cap follows the mode (duos 2, squads 4)', () => {
  const d = mkMode('duos');
  assert.ok(L.setTeam(d, 'a', 'T').ok); assert.ok(L.setTeam(d, 'b', 'T').ok);
  const r = L.setTeam(d, 'c', 'T');
  assert.equal(r.ok, false); assert.match(r.error, /2 players/);
  const s = mkMode('squads');
  for (const id of ['a', 'b', 'c', 'd']) assert.ok(L.setTeam(s, id, 'Sq').ok);
  assert.equal(L.setTeam(s, 'e', 'Sq').ok, false);
  assert.equal(s.teams.sq.members.length, 4);
});

test('modes: solos gives every player their own uniquely named team', () => {
  const g = mkMode('solos', 3);
  g.players.b.epic = 'A';                                                  // same Epic name as player a
  const a = L.soloTeam(g, 'a'); const b = L.soloTeam(g, 'b'); const c = L.soloTeam(g, 'c');
  assert.deepEqual([a.team.name, b.team.name, c.team.name], ['A', 'A 2', 'C']);
  assert.equal(L.setTeam(g, 'c', 'A').ok, false, 'a solo team cannot take a second player');
  assert.equal(L.soloTeam(g, 'a').unchanged, true, 'calling again keeps the existing team');
  g.players.a.epic = '@@@'; L.leaveTeam(g, 'a');
  assert.equal(L.soloTeam(g, 'a').team.name, 'Player', 'epic name with no usable characters falls back');
  assert.equal(L.soloTeam(g, 'nobody').ok, false);
});

test('modes: solo players can claim, and two solos on one spot are contested', () => {
  const g = mkMode('solos', 2); g.roleId = 'r';
  L.soloTeam(g, 'a'); L.soloTeam(g, 'b');
  assert.equal(L.claim(g, L.teamOf(g, 'a').key, 'lifty-lodge').status, 'claimed');
  assert.equal(L.claim(g, L.teamOf(g, 'b').key, 'lifty-lodge').status, 'contested');
});

test('modes: setMode clears teams, claims and fills but keeps registrations', () => {
  const g = mkMode('trios', 4);
  L.setTeam(g, 'a', 'One'); L.setTeam(g, 'b', 'One'); L.claim(g, 'one', 'lifty-lodge'); g.fills.m1 = { hostId: 'a' };
  const r = L.setMode(g, 'duos');
  assert.ok(r.ok); assert.equal(r.players, 4); assert.equal(g.mode, 'duos');
  assert.deepEqual(g.teams, {}); assert.deepEqual(g.claims, {}); assert.deepEqual(g.fills, {});
  assert.equal(Object.keys(g.players).length, 4);
  assert.ok(Object.values(g.players).every((p) => p.team === null));
  const s = L.setMode(g, 'solos');
  assert.equal(Object.keys(g.teams).length, 4, 'switching to solos teams everyone up automatically');
  assert.ok(Object.keys(g.players).every((id) => L.teamOf(g, id)?.members.length === 1));
  assert.equal(L.setMode(g, 'nope').ok, false); assert.equal(g.mode, 'solos');
});

test('modes: fill works for duos and squads, is refused in solos', () => {
  const d = mkMode('duos');
  const { fill } = L.createFill(d, 'a');
  assert.equal(fill.size, 2);
  assert.equal(L.joinFill(d, fill, 'b').full, true);
  assert.equal(L.joinFill(d, fill, 'c').ok, false);
  assert.equal(L.finalizeFill(d, fill), "A's Duo");
  assert.equal(d.teams["a's duo"].members.length, 2);

  const q = mkMode('squads');
  const f2 = L.createFill(q, 'a').fill;
  assert.equal(f2.size, 4);
  assert.equal(L.joinFill(q, f2, 'b').full, false); assert.equal(L.joinFill(q, f2, 'c').full, false);
  assert.equal(L.joinFill(q, f2, 'd').full, true);
  assert.equal(L.finalizeFill(q, f2), "A's Squad");

  const s = mkMode('solos');
  const r = L.createFill(s, 'a');
  assert.equal(r.ok, false); assert.match(r.error, /solos/);
});

test('modes: a squad team with 3 players can still ask for one more; a full one cannot host', () => {
  const g = mkMode('squads');
  for (const id of ['a', 'b', 'c']) L.setTeam(g, id, 'Three');
  const { fill } = L.createFill(g, 'a');
  assert.deepEqual(fill.base, ['a', 'b', 'c']);
  assert.equal(L.joinFill(g, fill, 'd').full, true);
  const full = mkMode('duos'); L.setTeam(full, 'a', 'F'); L.setTeam(full, 'b', 'F');
  assert.equal(L.createFill(full, 'a').ok, false);
});
