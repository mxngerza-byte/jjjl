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
