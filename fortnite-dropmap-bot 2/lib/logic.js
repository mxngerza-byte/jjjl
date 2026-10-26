'use strict';
/**
 * Pure game logic: teams, drop claims, fill squads, hosted sessions.
 * No Discord code in here so it can be unit-tested (see test/logic.test.js).
 */
const MAX_TEAM = 3;               // trios
const MAX_GAMES = 6;
const GAME_MS = 30 * 60 * 1000;   // 30 minutes between games

function defaults() {
  return {
    roleId: null,
    channels: { register: null, drop: null, fill: null },
    panels: { register: null, drop: null, fill: null },
    open: { registration: true, fill: true, dropmap: true },
    players: {},   // userId -> { epic, platform, region, team: teamKey|null }
    teams: {},     // teamKey -> { name, members: [userId] }
    claims: {},    // regionId -> [teamKey]  (1 team = claimed/black, 2+ = contested/red)
    fills: {},     // messageId -> fill request
    session: null, // { total, current, nextAt, roster: [userId], hostId }
  };
}

function ensureGuild(g) {
  const d = defaults();
  for (const k of Object.keys(d)) if (!(k in g)) g[k] = d[k];
  g.open = { ...d.open, ...g.open };
  g.channels = { ...d.channels, ...g.channels };
  g.panels = { ...d.panels, ...g.panels };
  return g;
}

/* ------------------------------ teams ------------------------------ */
// Strip @ (so a team can't be named @everyone / <@&role>) and markdown characters.
const cleanTeamName = (s) => String(s || '').replace(/[@`*_~|>\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
const teamKey = (name) => cleanTeamName(name).toLowerCase();
const teamOf = (g, userId) => {
  const k = g.players[userId]?.team;
  return k && g.teams[k] ? { key: k, ...g.teams[k] } : null;
};

function deleteTeam(g, key) {
  delete g.teams[key];
  unclaim(g, key);
  for (const p of Object.values(g.players)) if (p.team === key) p.team = null;
}

function leaveTeam(g, userId) {
  const p = g.players[userId];
  if (!p || !p.team) return false;
  const key = p.team;
  const t = g.teams[key];
  p.team = null;
  if (t) {
    t.members = t.members.filter((u) => u !== userId);
    if (!t.members.length) deleteTeam(g, key);
  }
  return true;
}

function setTeam(g, userId, rawName) {
  const p = g.players[userId];
  if (!p) return { ok: false, error: 'Register first.' };
  const name = cleanTeamName(rawName);
  if (!name) return { ok: false, error: 'Team name can\'t be empty.' };
  const key = teamKey(name);
  if (p.team === key) return { ok: true, team: { key, ...g.teams[key] }, unchanged: true };
  const existing = g.teams[key];
  if (existing && existing.members.length >= MAX_TEAM) {
    return { ok: false, error: `Team **${existing.name}** already has ${MAX_TEAM} players.` };
  }
  leaveTeam(g, userId);
  g.teams[key] ||= { name, members: [] };
  g.teams[key].members.push(userId);
  p.team = key;
  return { ok: true, team: { key, ...g.teams[key] } };
}

/* ------------------------------ claims ----------------------------- */
function unclaim(g, key) {
  for (const [rid, arr] of Object.entries(g.claims)) {
    const left = arr.filter((k) => k !== key);
    if (left.length) g.claims[rid] = left; else delete g.claims[rid];
  }
}

/** A team picks a region. Returns { status: 'claimed' | 'contested' | 'already', others: [teamKey] } */
function claim(g, key, regionId) {
  const cur = g.claims[regionId] || [];
  if (cur.includes(key)) return { status: 'already', others: cur.filter((k) => k !== key) };
  unclaim(g, key);                       // a team only holds one spot
  const others = g.claims[regionId] || [];
  g.claims[regionId] = [...others, key];
  return { status: others.length ? 'contested' : 'claimed', others };
}

/**
 * Can this person claim right now?  hasRole = they hold the Registered role.
 * -> 'ok' | 'not_registered' | 'not_in_game' | 'no_team'
 */
function actorStatus(g, hasRole, userId) {
  if (!g.roleId || !hasRole || !g.players[userId]) return 'not_registered';
  if (g.session && !g.session.roster.includes(userId)) return 'not_in_game';
  if (!teamOf(g, userId)) return 'no_team';
  return 'ok';
}

const ACTOR_ERRORS = {
  not_registered: 'Register first in the register channel.',
  not_in_game: 'Register for the current game first.',
  no_team: 'You\'re not on a team yet. Register with a team name, use /team set, or find teammates in the fill channel.',
};

/** Shared by the Discord menu and the web map. */
function claimFor(g, userId, hasRole, regionId, validIds) {
  if (!g.open.dropmap) return { ok: false, code: 'locked', error: 'The drop map is locked.' };
  const st = actorStatus(g, hasRole, userId);
  if (st !== 'ok') return { ok: false, code: st, error: ACTOR_ERRORS[st] };
  if (!validIds.includes(regionId)) return { ok: false, code: 'bad_region', error: 'That spot doesn\'t exist.' };
  const team = teamOf(g, userId);
  const res = claim(g, team.key, regionId);
  return { ok: true, ...res, team };
}

function releaseFor(g, userId, hasRole) {
  if (!g.open.dropmap) return { ok: false, code: 'locked', error: 'The drop map is locked.' };
  const st = actorStatus(g, hasRole, userId);
  if (st !== 'ok') return { ok: false, code: st, error: ACTOR_ERRORS[st] };
  unclaim(g, teamOf(g, userId).key);
  return { ok: true };
}

const regionState = (g, regionId) => {
  const n = (g.claims[regionId] || []).length;
  return n === 0 ? 'free' : n === 1 ? 'claimed' : 'contested';
};
const resetClaims = (g) => { g.claims = {}; };

/* ------------------------------ fill (trios) ----------------------- */
/** Open a request. If the host already has teammates they are the "base" of the squad. */
function createFill(g, hostId, notes = '') {
  if (Object.values(g.fills).some((f) => f.hostId === hostId)) {
    return { ok: false, error: 'You already have an open fill request. Close it first.' };
  }
  const team = teamOf(g, hostId);
  if (team && team.members.length >= MAX_TEAM) {
    return { ok: false, error: 'Your team is already full (3/3).' };
  }
  const base = team ? [...team.members] : [hostId];
  return { ok: true, fill: { hostId, base, members: [...base], notes: String(notes || '').slice(0, 300), closed: false, teamName: null } };
}

function joinFill(g, fill, userId) {
  if (fill.closed) return { ok: false, error: 'This request is closed.' };
  if (fill.members.includes(userId)) return { ok: false, error: 'You\'re already in this squad.' };
  if (fill.members.length >= MAX_TEAM) return { ok: false, error: 'This squad is full.' };
  if (teamOf(g, userId)) return { ok: false, error: 'You\'re already on a team. Use `/team leave` first.' };
  fill.members.push(userId);
  return { ok: true, full: fill.members.length >= MAX_TEAM };
}

function leaveFill(fill, userId) {
  if (!fill.members.includes(userId)) return { ok: false, error: 'You\'re not in this squad.' };
  if (fill.base.includes(userId)) return { ok: false, error: 'You\'re part of the original team. The host can **Close** the request instead.' };
  fill.members = fill.members.filter((u) => u !== userId);
  return { ok: true };
}

/** Squad is full: put everyone on one team. Returns the team name. */
function finalizeFill(g, fill) {
  const host = teamOf(g, fill.hostId);
  let name;
  if (host) {
    name = host.name;
  } else {
    const base = cleanTeamName(`${g.players[fill.hostId]?.epic || 'Squad'}'s Trio`);
    name = base;
    for (let n = 2; g.teams[teamKey(name)]; n++) name = cleanTeamName(`${base.slice(0, 21)} ${n}`);
  }
  for (const u of fill.members) {
    if (g.players[u]) setTeam(g, u, name);
  }
  fill.closed = true;
  fill.teamName = name;
  return name;
}

/* ------------------------------ hosted games ----------------------- */
function startSession(g, total, hostId, now = Date.now()) {
  if (g.session) return { ok: false, error: 'A session is already running. Use `/host stop` first.' };
  if (!Number.isInteger(total) || total < 1 || total > MAX_GAMES) {
    return { ok: false, error: `Choose between 1 and ${MAX_GAMES} games.` };
  }
  resetClaims(g);
  g.session = { total, current: 1, nextAt: now + GAME_MS, roster: [], hostId };
  return { ok: true, session: g.session };
}

/** Called when a game's 30 minutes are up. */
function advanceSession(g, now = Date.now()) {
  const s = g.session;
  if (!s) return { result: 'none' };
  if (s.current >= s.total) {
    const total = s.total;
    g.session = null;
    return { result: 'finished', total };
  }
  s.current += 1;
  s.roster = [];
  s.nextAt = now + GAME_MS;
  resetClaims(g);
  return { result: 'next', current: s.current, total: s.total, nextAt: s.nextAt };
}

const addToRoster = (g, userId) => {
  if (g.session && !g.session.roster.includes(userId)) g.session.roster.push(userId);
};

module.exports = {
  MAX_TEAM, MAX_GAMES, GAME_MS,
  defaults, ensureGuild,
  cleanTeamName, teamKey, teamOf, setTeam, leaveTeam, deleteTeam,
  unclaim, claim, regionState, resetClaims, actorStatus, claimFor, releaseFor,
  createFill, joinFill, leaveFill, finalizeFill,
  startSession, advanceSession, addToRoster,
};
