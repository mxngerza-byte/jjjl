require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder,
  MessageFlags, Events,
} = require('discord.js');
const L = require('./lib/logic');
const { createWeb } = require('./lib/web');
const { regions } = require('./config/regions.json');

const EPHEMERAL = MessageFlags.Ephemeral;
const P = PermissionFlagsBits;
const EVERYONE_PING = { parse: ['everyone'] };
const REGION_IDS = regions.map((r) => r.id);

/* ------------------------------------------------------------------ */
/*  Config (works locally and on Railway)                             */
/* ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (
  process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)
).replace(/\/+$/, '');
// On Railway, attach a Volume: it sets RAILWAY_VOLUME_MOUNT_PATH so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const mapUrl = (guildId) => `${BASE_URL}/g/${guildId}`;

/* ------------------------------------------------------------------ */
/*  Storage (JSON file, fine for a single server)                     */
/* ------------------------------------------------------------------ */
let db = { guilds: {} };

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    db.guilds ||= {};
  } catch { /* first run */ }
}
function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}
const G = (guildId) => L.ensureGuild((db.guilds[guildId] ||= {}));

const teamName = (g, key) => g.teams[key]?.name || key;

/* ------------------------------------------------------------------ */
/*  Panels                                                            */
/* ------------------------------------------------------------------ */
function registerPanel(g) {
  const s = g.session;
  const open = g.open.registration;
  const mode = L.modeOf(g);
  const embed = new EmbedBuilder()
    .setColor(open ? 0x7b4dff : 0x808080)
    .setTitle(`${s ? `📝 Registration — Game ${s.current} of ${s.total}` : '📝 Player Registration'} · ${mode.label}`)
    .setDescription(
      !open
        ? '🔒 **Registration is closed.**'
        : mode.size === 1
          ? 'Press **Register** to unlock the drop map. Your Discord name is your player name, nothing to type.\nThis event is **solos**: you play on your own.'
          : 'Press **Register** to unlock the drop map. Your Discord name is your player name, nothing to type.\n' +
            `${mode.label}: team captains @ their teammates right after registering (max ${mode.size} players per team).\n` +
            'No team? Use the fill channel.',
    );
  if (s) {
    embed.addFields({ name: 'Registered for this game', value: `${s.roster.length} player(s)`, inline: true });
    embed.addFields({ name: 'Next game', value: `<t:${Math.floor(s.nextAt / 1000)}:R>`, inline: true });
  }
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('reg:open').setLabel('Register').setStyle(ButtonStyle.Primary).setDisabled(!open),
    )],
  };
}

function fillPanel(g) {
  const open = g.open.fill;
  const mode = L.modeOf(g);
  const solos = mode.size === 1;
  return {
    embeds: [new EmbedBuilder().setColor(open ? 0x2ecc71 : 0x808080).setTitle(`🔎 Fill Finder (${mode.label.toLowerCase()})`)
      .setDescription(!open
        ? '🔒 **The fill channel is closed.**'
        : solos
          ? 'This event is **solos**, so there is nothing to fill. Everyone plays on their own.'
          : `Need teammates? Post a request and others can join with one click. When the ${mode.one.toLowerCase()} is full, the bot puts everyone on one team and a thread is created for them.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fill:new').setLabel('Post a fill request').setStyle(ButtonStyle.Success).setDisabled(!open || solos),
    )],
  };
}

const linkRow = (guildId) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setLabel('Open the interactive map').setStyle(ButtonStyle.Link).setURL(mapUrl(guildId)),
);

/** The drop-map channel holds ONE message: the link to the interactive map (no embed, no menus). */
function dropPanel(g, guildId, text) {
  const sess = g.session;
  const title = g.open.dropmap
    ? `🗺️ **Drop map${sess ? ` — Game ${sess.current} of ${sess.total}` : ''}**`
    : '🔒 **The drop map is locked.**';
  return {
    content: `${text || title}\n${mapUrl(guildId)}`,
    embeds: [],                      // also clears the old embed if this edits an earlier panel
    components: [linkRow(guildId)],
    allowedMentions: { parse: [] },
  };
}

/** Edit the stored panel message in place, or (re)post it. */
async function upsertPanel(guild, key, payload, { repost = false } = {}) {
  const g = G(guild.id);
  const ch = g.channels[key] && guild.channels.cache.get(g.channels[key]);
  if (!ch) return null;
  if (g.panels[key]) {
    try {
      const old = await ch.messages.fetch(g.panels[key]);
      if (!repost) return await old.edit(payload);
      await old.delete();
    } catch (err) {
      if (err.code !== 10008) throw err; // only "Unknown Message" means: post a fresh panel
    }
  }
  const sent = await ch.send(payload);
  g.panels[key] = sent.id;
  save();
  return sent;
}

const refreshRegister = (guild, opts) => upsertPanel(guild, 'register', registerPanel(G(guild.id)), opts);
const refreshFill = (guild, opts) => upsertPanel(guild, 'fill', fillPanel(G(guild.id)), opts);
const refreshDrop = (guild, opts) => upsertPanel(guild, 'drop', dropPanel(G(guild.id), guild.id), opts);

// Claims are only shown on the web map now, so a claim needs no Discord refresh.
// (Kept as a no-op because the web server and team commands still call it.)
function scheduleDropRefresh() {}

/** (Re)posts the link message in the drop-map channel, replacing the previous one. */
async function postDropLink(guild, text) {
  await upsertPanel(guild, 'drop', dropPanel(G(guild.id), guild.id, text), { repost: true });
}

/* ------------------------------------------------------------------ */
/*  Fill requests                                                     */
/* ------------------------------------------------------------------ */
function fillEmbed(g, f) {
  const roster = f.members.map((u, i) => {
    const p = g.players[u];
    const known = p && p.platform && p.platform !== '?' && p.region && p.region !== '?';
    return `${i === 0 ? '👑' : '•'} <@${u}>${p ? ` — \`${p.epic}\`${known ? ` (${p.platform} / ${p.region})` : ''}` : ''}`;
  });
  const size = f.size || L.teamSize(g);
  const status = f.closed
    ? (f.teamName ? `✅ Team formed: ${f.teamName}` : '🔒 Closed')
    : `🔎 Looking for ${size - f.members.length} more`;
  const e = new EmbedBuilder()
    .setColor(f.closed ? (f.teamName ? 0xf5a623 : 0x808080) : 0x2ecc71)
    .setTitle(`${L.modeOf(g).one} fill — ${status}`)
    .addFields({ name: `Team (${f.members.length}/${size})`, value: roster.join('\n') });
  if (f.notes) e.addFields({ name: 'Notes', value: f.notes.slice(0, 1000) });
  return e;
}

const fillButtons = (f) => [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('fill:join').setLabel('Join').setStyle(ButtonStyle.Success).setDisabled(f.closed || f.members.length >= (f.size || L.MAX_TEAM)),
  new ButtonBuilder().setCustomId('fill:leave').setLabel('Leave').setStyle(ButtonStyle.Secondary).setDisabled(f.closed),
  new ButtonBuilder().setCustomId('fill:close').setLabel('Close').setStyle(ButtonStyle.Danger).setDisabled(f.closed),
)];

async function getThread(guild, messageId) {
  return guild.channels.cache.get(messageId) || (await guild.channels.fetch(messageId).catch(() => null));
}

async function closeAllFills(guild) {
  const g = G(guild.id);
  const ch = g.channels.fill && guild.channels.cache.get(g.channels.fill);
  if (!ch) { g.fills = {}; save(); return; }
  for (const [msgId, f] of Object.entries(g.fills)) {
    f.closed = true;
    try {
      const msg = await ch.messages.fetch(msgId);
      await msg.edit({ embeds: [fillEmbed(g, f)], components: fillButtons(f) });
      const th = await getThread(guild, msgId);
      if (th?.isThread()) await th.setArchived(true);
    } catch { /* message already deleted */ }
  }
  g.fills = {};
  save();
}

/* ------------------------------------------------------------------ */
/*  Open / close switches                                             */
/* ------------------------------------------------------------------ */
async function setOpen(guild, key, value) {
  const g = G(guild.id);
  g.open[key] = value;
  save();
  if (key === 'registration') await refreshRegister(guild);
  if (key === 'dropmap') {
    if (value) await postDropLink(guild, '🗺️ **The drop map is open!** Tap your team\'s spot:');
    else await refreshDrop(guild);
  }
  if (key === 'fill') {
    if (!value) await closeAllFills(guild);
    const ch = g.channels.fill && guild.channels.cache.get(g.channels.fill);
    if (ch && g.roleId) await ch.permissionOverwrites.edit(g.roleId, { SendMessagesInThreads: value }).catch(() => {});
    await refreshFill(guild);
  }
}

/* ------------------------------------------------------------------ */
/*  Hosted games (up to 6, 30 minutes each)                           */
/* ------------------------------------------------------------------ */
const timers = new Map();

function scheduleSession(client, guildId) {
  clearTimeout(timers.get(guildId));
  timers.delete(guildId);
  const g = G(guildId);
  if (!g.session) return;
  const ms = Math.max(1000, g.session.nextAt - Date.now());
  timers.set(guildId, setTimeout(() => advanceGame(client, guildId).catch(console.error), ms));
}

async function postNewRegistration(guild, text) {
  const g = G(guild.id);
  const ch = g.channels.register && guild.channels.cache.get(g.channels.register);
  if (!ch) return;
  if (g.panels.register) { try { await (await ch.messages.fetch(g.panels.register)).delete(); } catch {} }
  const sent = await ch.send({ content: text, allowedMentions: EVERYONE_PING, ...registerPanel(g) });
  g.panels.register = sent.id;
  save();
}

async function openEverything(guild) {
  const g = G(guild.id);
  g.open = { registration: true, fill: true, dropmap: true };
  await closeAllFills(guild);
  const ch = g.channels.fill && guild.channels.cache.get(g.channels.fill);
  if (ch && g.roleId) await ch.permissionOverwrites.edit(g.roleId, { SendMessagesInThreads: true }).catch(() => {});
}

async function advanceGame(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  const g = G(guildId);
  if (!guild || !g.session) return;
  const res = L.advanceSession(g);
  save();

  if (res.result === 'next') {
    await openEverything(guild);
    await postNewRegistration(
      guild,
      `@here **Game ${res.current} of ${res.total}** — registration is open! The drop map has been reset. Next game <t:${Math.floor(res.nextAt / 1000)}:R>.`,
    );
    await refreshFill(guild);
    await postDropLink(guild, `🗺️ **Game ${res.current} map is ready.** Register, then tap your team's spot:`);
    scheduleSession(client, guildId);
  } else if (res.result === 'finished') {
    g.open = { registration: false, fill: false, dropmap: false };
    await closeAllFills(guild);
    await refreshRegister(guild);
    await refreshDrop(guild);
    await refreshFill(guild);
    const ch = g.channels.register && guild.channels.cache.get(g.channels.register);
    if (ch) await ch.send(`All **${res.total}** games are done. Thanks for playing! Registration, fill and the drop map are now closed.`);
    save();
  }
}

/* ------------------------------------------------------------------ */
/*  Slash command definitions                                         */
/* ------------------------------------------------------------------ */
const toggle = (name, verb) => {
  const b = new SlashCommandBuilder().setName(name).setDescription(`${verb} registration, the fill channel or the drop map`)
    .setDefaultMemberPermissions(P.ManageGuild);
  for (const [sub, label] of [['registration', 'registration'], ['fill', 'the fill channel'], ['dropmap', 'the drop map']]) {
    b.addSubcommand((s) => s.setName(sub).setDescription(`${verb} ${label}`));
  }
  return b;
};

const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Create the Registered role plus register, drop-map and fill channels')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addRoleOption((o) => o.setName('role').setDescription('Use an existing role instead of creating one')),
  toggle('open', 'Open'),
  toggle('close', 'Close'),
  new SlashCommandBuilder().setName('host').setDescription('Run a series of games, 30 minutes apart')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) => s.setName('start').setDescription('Start hosting; a new registration + @here goes out every 30 minutes')
      .addIntegerOption((o) => o.setName('games').setDescription('How many games (1-6)').setRequired(true)
        .setMinValue(1).setMaxValue(L.MAX_GAMES)))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the running session'))
    .addSubcommand((s) => s.setName('status').setDescription('Show the current game and time to the next one')),
  new SlashCommandBuilder().setName('team').setDescription('Manage your team')
    .addSubcommand((s) => s.setName('set').setDescription('Join or create a team')
      .addStringOption((o) => o.setName('name').setDescription('Team name').setRequired(true).setMaxLength(24)))
    .addSubcommand((s) => s.setName('leave').setDescription('Leave your team'))
    .addSubcommand((s) => s.setName('view').setDescription('Show your team')),
  new SlashCommandBuilder().setName('dropmap').setDescription('Drop map admin')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) => s.setName('link').setDescription('Post the interactive map link in the drop-map channel'))
    .addSubcommand((s) => s.setName('reset').setDescription('Clear every claim (new match)'))
    .addSubcommand((s) => s.setName('refresh').setDescription('Re-post the drop map panel')),
  new SlashCommandBuilder().setName('mode').setDescription('Choose the event format: solos, duos, trios or squads')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addStringOption((o) => o.setName('type').setDescription('Players per team').setRequired(true).addChoices(
      { name: 'Solos (1 per team)', value: 'solos' }, { name: 'Duos (2 per team)', value: 'duos' },
      { name: 'Trios (3 per team)', value: 'trios' }, { name: 'Squads (4 per team)', value: 'squads' })),
  new SlashCommandBuilder().setName('end').setDescription('End the event')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) => s.setName('scrims').setDescription('Remove the Registered role from everyone, close every channel and reset teams')),
  new SlashCommandBuilder().setName('unregister').setDescription('Remove a player\'s registration, team seat and role')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addUserOption((o) => o.setName('user').setDescription('Player to unregister').setRequired(true)),
].map((c) => c.toJSON());

/* ------------------------------------------------------------------ */
/*  Handlers                                                          */
/* ------------------------------------------------------------------ */
const reply = (i, content) => i.reply({ content, flags: EPHEMERAL });
const hasRegisteredRole = (i, g) => !!(g.roleId && i.member.roles.cache.has(g.roleId));

/** null if this member may take part right now, otherwise the message to show. */
function participantError(i, g) {
  if (!hasRegisteredRole(i, g)) return `You need to register first in <#${g.channels.register}>.`;
  if (g.session && !g.session.roster.includes(i.user.id)) {
    return `Register for Game ${g.session.current} of ${g.session.total} first in <#${g.channels.register}>.`;
  }
  return null;
}

async function handleSetup(i) {
  await i.deferReply({ flags: EPHEMERAL });
  const guild = i.guild;
  const g = G(guild.id);
  const me = guild.members.me;
  if (!me.permissions.has([P.ManageRoles, P.ManageChannels])) {
    return i.editReply('I need **Manage Roles** and **Manage Channels** permissions to run setup.');
  }

  let role = i.options.getRole('role') || (g.roleId && guild.roles.cache.get(g.roleId));
  role ||= await guild.roles.create({ name: 'Registered Player', color: 0x7b4dff, reason: 'Dropmap bot setup' });
  g.roleId = role.id;
  const warn = role.comparePositionTo(me.roles.highest) >= 0
    ? '\n⚠️ Move my bot role **above** the registered role in Server Settings → Roles, or I can\'t hand it out.' : '';

  const bot = {
    id: me.id,
    allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory,
      P.CreatePublicThreads, P.SendMessagesInThreads, P.ManageThreads, P.MentionEveryone],
  };
  const spec = {
    register: ['register', [
      { id: guild.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.CreatePublicThreads] }, bot]],
    drop: ['drop-map', [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: role.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.CreatePublicThreads] }, bot]],
    fill: ['fill', [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: role.id, allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads], deny: [P.SendMessages, P.CreatePublicThreads] }, bot]],
  };

  let category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === 'FORTNITE SCRIMS');
  category ||= await guild.channels.create({ name: 'FORTNITE SCRIMS', type: ChannelType.GuildCategory });

  for (const [key, [name, overwrites]] of Object.entries(spec)) {
    let ch = g.channels[key] && guild.channels.cache.get(g.channels[key]);
    if (ch) await ch.permissionOverwrites.set(overwrites);
    else ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites });
    g.channels[key] = ch.id;
  }
  g.open = { registration: true, fill: true, dropmap: true };
  save();
  await refreshRegister(guild, { repost: true });
  await refreshFill(guild, { repost: true });
  await refreshDrop(guild, { repost: true });
  return i.editReply(
    `Setup complete.\nRole: <@&${role.id}>\nChannels: <#${g.channels.register}>, <#${g.channels.drop}>, <#${g.channels.fill}>\n` +
    `Interactive map: ${mapUrl(guild.id)}\n` +
    `Run \`/host start games:3\` to run a series, or use \`/open\` and \`/close\` manually.${warn}`,
  );
}

async function handleToggle(i, value) {
  const g = G(i.guild.id);
  if (!g.roleId) return reply(i, 'Run `/setup` first.');
  const key = i.options.getSubcommand();
  await i.deferReply({ flags: EPHEMERAL });
  await setOpen(i.guild, key, value);
  const label = { registration: 'Registration', fill: 'The fill channel', dropmap: 'The drop map' }[key];
  const link = key === 'dropmap' && value ? `\nLink posted in <#${g.channels.drop}>: ${mapUrl(i.guild.id)}` : '';
  return i.editReply(`${label} is now **${value ? 'open' : 'closed'}**.${link}`);
}

async function handleHost(i, client) {
  const g = G(i.guild.id);
  const sub = i.options.getSubcommand();

  if (sub === 'start') {
    if (!g.roleId) return reply(i, 'Run `/setup` first.');
    const res = L.startSession(g, i.options.getInteger('games'), i.user.id);
    if (!res.ok) return reply(i, res.error);
    await i.deferReply({ flags: EPHEMERAL });
    save();
    await openEverything(i.guild);
    const s = g.session;
    await postNewRegistration(
      i.guild,
      `@here **Game 1 of ${s.total}** — registration is open! Each game runs 30 minutes; a fresh registration goes out when it's over.`,
    );
    await refreshFill(i.guild);
    await postDropLink(i.guild, '🗺️ **Game 1 map is ready.** Register, then tap your team\'s spot:');
    scheduleSession(client, i.guild.id);
    return i.editReply(`Hosting **${s.total}** game(s) of **${L.modeOf(g).label}**. Game 2's registration (+ @here) goes out <t:${Math.floor(s.nextAt / 1000)}:R>.`);
  }

  if (sub === 'stop') {
    if (!g.session) return reply(i, 'No session is running.');
    g.session = null;
    clearTimeout(timers.get(i.guild.id));
    timers.delete(i.guild.id);
    save();
    await i.deferReply({ flags: EPHEMERAL });
    await refreshRegister(i.guild); await refreshDrop(i.guild);
    return i.editReply('Session stopped. Panels stay as they are; use `/close` to lock things.');
  }

  const s = g.session;
  if (!s) return reply(i, 'No session is running.');
  return reply(i, `Game **${s.current} of ${s.total}** · ${s.roster.length} registered · ` +
    `${s.current < s.total ? 'next registration' : 'session ends'} <t:${Math.floor(s.nextAt / 1000)}:R>`);
}

/* ------------------------------------------------------------------ */
/*  Team roles + captain picks teammates                              */
/* ------------------------------------------------------------------ */
/** Snapshot of a player's team before a change: { key, roleId } or null. */
const teamSnapshot = (g, userId) => { const t = L.teamOf(g, userId); return t ? { key: t.key, roleId: t.roleId || null } : null; };

/** The team's Discord role (named after the team). Created on first use; null if the bot can't create it. */
async function ensureTeamRole(guild, g, key) {
  const t = g.teams[key];
  if (!t) return null;
  let role = t.roleId && guild.roles.cache.get(t.roleId);
  if (!role) {
    try {
      role = await guild.roles.create({ name: t.name, permissions: [], mentionable: false, reason: 'Scrims team role' });
      t.roleId = role.id;
      save();
    } catch { return null; }
  }
  return role;
}

/** After a player's team changed: drop the old team's role (deleting it if the team is gone), add the new one. */
async function updateTeamRoles(guild, g, userId, before) {
  const member = await guild.members.fetch(userId).catch(() => null);
  const now = L.teamOf(g, userId);
  if (before && before.roleId && (!now || now.key !== before.key)) {
    if (member) await member.roles.remove(before.roleId, 'Left the team').catch(() => {});
    if (!g.teams[before.key]) await guild.roles.delete(before.roleId, 'Team no longer exists').catch(() => {});
  }
  const roleId = now && g.teams[now.key] && g.teams[now.key].roleId;
  if (member && roleId && (!before || !now || before.key !== now.key)) await member.roles.add(roleId, 'Joined the team').catch(() => {});
}

/** Deletes every team role (used when teams are wiped by /end scrims or /mode). */
async function deleteAllTeamRoles(guild, g, reason) {
  for (const t of Object.values(g.teams)) {
    if (t.roleId) await guild.roles.delete(t.roleId, reason).catch(() => {});
  }
}

/** A player's name = their Discord display name (server nickname, else global name, else username). */
const epicOf = (member) => String(member.displayName || member.user?.username || 'Player').replace(/[`\\]/g, '').trim().slice(0, 32) || 'Player';

/** After a captain registers: how many more teammates can he pick? null = don't ask (solos, not the captain, team full). */
function captainPrompt(g, userId) {
  const size = L.teamSize(g);
  if (size < 2) return null;
  const team = L.teamOf(g, userId);
  if (!team) return { key: null, remaining: size - 1 };            // no team yet: they can start one
  if (team.members[0] !== userId) return null;                     // a teammate, not the captain
  const remaining = size - team.members.length;
  return remaining > 0 ? { key: team.key, name: team.name, remaining } : null;
}

const pickRow = (p) => new ActionRowBuilder().addComponents(
  new UserSelectMenuBuilder().setCustomId(p.key ? `team:pick:${p.key}` : 'team:new').setPlaceholder('@ your teammates')
    .setMinValues(1).setMaxValues(Math.min(p.remaining, 25)),
);

async function handleUserSelect(i) {
  const isNew = i.customId === 'team:new';
  if (!isNew && !i.customId.startsWith('team:pick:')) return;
  const g = G(i.guild.id);
  const outOfDate = () => i.update({ content: 'That menu is out of date. Press **Register** again to pick teammates.', components: [] });
  let key = isNew ? null : i.customId.slice('team:pick:'.length);
  let team = key && g.teams[key];
  if (isNew ? (!g.players[i.user.id] || L.teamOf(g, i.user.id)) : (!team || team.members[0] !== i.user.id)) return outOfDate();
  if (!g.open.registration) return i.update({ content: 'Registration is closed.', components: [] });
  await i.deferUpdate();

  let createdTeam = false;
  if (isNew) {
    // the captain's team is named after him, e.g. "Alex's Trio" (made unique if needed)
    const base = L.cleanTeamName(`${g.players[i.user.id].epic}'s ${L.modeOf(g).one}`) || 'Team';
    let name = base;
    for (let n = 2; g.teams[L.teamKey(name)]; n++) name = L.cleanTeamName(`${base.slice(0, 21)} ${n}`);
    const r = L.setTeam(g, i.user.id, name);
    if (!r.ok) return i.editReply({ content: r.error, components: [] });
    key = L.teamKey(name); team = g.teams[key]; createdTeam = true;
  }

  const added = []; const skipped = [];
  for (const id of i.values) {
    if (id === i.user.id) continue;
    const member = await i.guild.members.fetch(id).catch(() => null);
    if (!member) { skipped.push(`<@${id}> (not in this server)`); continue; }
    if (member.user.bot) { skipped.push(`<@${id}> (bots can't play)`); continue; }
    const cur = L.teamOf(g, id);
    if (cur && cur.key !== key) { skipped.push(`<@${id}> (already on team ${cur.name})`); continue; }
    const created = !g.players[id];
    if (created) g.players[id] = { epic: epicOf(member), platform: '?', region: '?', team: null };
    const r = L.setTeam(g, id, team.name);
    if (!r.ok) { if (created) delete g.players[id]; skipped.push(`<@${id}> (team is full)`); continue; }
    L.addToRoster(g, id);
    added.push(member);
  }
  if (createdTeam && !added.length) {                              // nobody could be added: don't leave a team of one behind
    L.leaveTeam(g, i.user.id);
    save();
    return i.editReply({ content: `No teammates were added${skipped.length ? `: ${skipped.join(', ')}` : ''}. Press **Register** to try again.`, components: [], allowedMentions: { parse: [] } });
  }
  save();

  // roles: Registered for the new teammates, the team-name role for the whole team
  const role = await ensureTeamRole(i.guild, g, key);
  let roleFail = 0;
  for (const m of added) await m.roles.add(g.roleId, 'Added by their team captain').catch(() => { roleFail++; });
  if (role) {
    for (const uid of g.teams[key].members) {
      const m = uid === i.user.id ? i.member : await i.guild.members.fetch(uid).catch(() => null);
      if (m) await m.roles.add(role, 'Team role').catch(() => { roleFail++; });
    }
  }

  const now = g.teams[key];
  const lines = [`**${now.name}** is now ${now.members.length}/${L.teamSize(g)}.`];
  if (added.length) lines.push(`Added: ${added.map((m) => `<@${m.id}>`).join(' ')}. They got the Registered role${role ? ` and <@&${role.id}>` : ''}.`);
  if (!role) lines.push('⚠️ I couldn\'t create the team role. Check that I have **Manage Roles**.');
  if (roleFail) lines.push(`⚠️ I couldn't give ${roleFail} role(s). Move my bot role **above** the registered and team roles.`);
  if (skipped.length) lines.push(`Skipped: ${skipped.join(', ')}.`);
  if (added.length) lines.push('They play under their Discord names.');
  await i.editReply({ content: lines.join('\n'), components: [], allowedMentions: { parse: [] } });
  refreshRegister(i.guild).catch(() => {});
}

async function handleTeam(i) {
  const g = G(i.guild.id);
  const sub = i.options.getSubcommand();
  if (!g.players[i.user.id]) return reply(i, `Register first in <#${g.channels.register}>.`);

  if (L.teamSize(g) === 1 && sub !== 'view') {
    return reply(i, 'This event is **solos**, so you play on your own and there are no teams to manage.');
  }
  if (sub === 'set') {
    const before = teamSnapshot(g, i.user.id);
    const r = L.setTeam(g, i.user.id, i.options.getString('name'));
    if (!r.ok) return reply(i, r.error);
    save();
    updateTeamRoles(i.guild, g, i.user.id, before).catch(console.error);
    scheduleDropRefresh(i.guild);
    return reply(i, `You're on team **${r.team.name}** (${r.team.members.length}/${L.teamSize(g)}).`);
  }
  if (sub === 'leave') {
    const before = teamSnapshot(g, i.user.id);
    if (!L.leaveTeam(g, i.user.id)) return reply(i, 'You\'re not on a team.');
    save();
    updateTeamRoles(i.guild, g, i.user.id, before).catch(console.error);
    scheduleDropRefresh(i.guild);
    return reply(i, 'You left your team.');
  }
  const t = L.teamOf(g, i.user.id);
  if (!t) return reply(i, 'You\'re not on a team. Use `/team set` or the fill channel.');
  return reply(i, `**${t.name}** (${t.members.length}/${L.teamSize(g)}): ${t.members.map((u) => `<@${u}>`).join(' ')}`);
}

async function handleDropAdmin(i) {
  const g = G(i.guild.id);
  const sub = i.options.getSubcommand();
  await i.deferReply({ flags: EPHEMERAL });
  if (sub === 'link') {
    await postDropLink(i.guild, '🗺️ **Interactive drop map:**');
    return i.editReply(`Link posted: ${mapUrl(i.guild.id)}`);
  }
  if (sub === 'reset') {
    L.resetClaims(g); save();
    await refreshDrop(i.guild);
    return i.editReply('All claims cleared.');
  }
  await refreshDrop(i.guild, { repost: true });
  return i.editReply('Panel re-posted.');
}

async function handleMode(i) {
  const g = G(i.guild.id);
  const type = i.options.getString('type');
  if (type === g.mode) return reply(i, `Already running **${L.modeOf(g).label}**. Nothing changed.`);
  await i.deferReply({ flags: EPHEMERAL });
  await closeAllFills(i.guild);               // open fill requests no longer fit the new team size
  await deleteAllTeamRoles(i.guild, g, 'Event mode changed');
  const r = L.setMode(g, type);
  if (!r.ok) return i.editReply(r.error);
  save();
  await refreshRegister(i.guild);
  await refreshFill(i.guild);
  await refreshDrop(i.guild);
  return i.editReply(
    `Mode set to **${r.mode.label}** (${r.mode.size} per team). Teams, claims and fill requests were cleared.\n` +
    (r.mode.size === 1
      ? `${r.players} registered player(s) now each have their own solo team.`
      : `${r.players} registered player(s) are still registered and need to join or create a team again (team name or the fill channel).`),
  );
}

async function handleEnd(i) {
  const g = G(i.guild.id);
  if (!g.roleId) return reply(i, 'Run `/setup` first.');
  await i.deferReply({ flags: EPHEMERAL });
  const guild = i.guild;

  // 1) stop any running session, then close registration, fill and the drop map
  clearTimeout(timers.get(guild.id));
  timers.delete(guild.id);
  g.session = null;
  g.open = { registration: false, fill: false, dropmap: false };
  await closeAllFills(guild);
  const fillCh = g.channels.fill && guild.channels.cache.get(g.channels.fill);
  if (fillCh) await fillCh.permissionOverwrites.edit(g.roleId, { SendMessagesInThreads: false }).catch(() => {});

  // 2) take the Registered role away from everyone who has it
  //    (registered players from our records + anyone the bot can see holding the role)
  const ids = new Set(Object.keys(g.players));
  const role = guild.roles.cache.get(g.roleId);
  if (role) for (const id of role.members.keys()) ids.add(id);
  let removed = 0; let gone = 0; const failed = [];
  for (const id of ids) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) { gone++; continue; }                         // left the server
    if (!member.roles.cache.has(g.roleId)) continue;           // already without the role
    try { await member.roles.remove(g.roleId, 'Scrims ended'); removed++; } catch { failed.push(id); }
  }

  // 3) reset the event. Anyone whose role could not be removed stays on record so /end scrims can be run again.
  const keep = Object.fromEntries(failed.filter((id) => g.players[id]).map((id) => [id, { ...g.players[id], team: null }]));
  await deleteAllTeamRoles(guild, g, 'Scrims ended');
  g.players = keep; g.teams = {}; g.claims = {}; g.fills = {};
  save();

  // 4) show the closed state on every panel
  await refreshRegister(guild);
  await refreshDrop(guild);
  await refreshFill(guild);
  const regCh = g.channels.register && guild.channels.cache.get(g.channels.register);
  if (regCh) await regCh.send({ content: 'The scrims have ended. Thanks for playing! Registration, fill and the drop map are closed.', allowedMentions: { parse: [] } }).catch(() => {});

  return i.editReply(
    `Scrims ended. Removed the role from **${removed}** player(s); registration, fill and the drop map are closed; teams and claims are cleared.` +
    (gone ? `\n${gone} registered player(s) have left the server.` : '') +
    (failed.length
      ? `\n⚠️ Couldn't remove the role from ${failed.length} player(s): ${failed.map((id) => `<@${id}>`).join(' ')}. ` +
        'Move my bot role **above** the registered role, then run `/end scrims` again.'
      : ''),
  );
}

async function handleUnregister(i) {
  const g = G(i.guild.id);
  const user = i.options.getUser('user');
  const before = teamSnapshot(g, user.id);
  L.leaveTeam(g, user.id);
  delete g.players[user.id];
  if (g.session) g.session.roster = g.session.roster.filter((u) => u !== user.id);
  save();
  try {
    const member = await i.guild.members.fetch(user.id);
    if (g.roleId) await member.roles.remove(g.roleId);
  } catch { /* left the server or role issue */ }
  await i.deferReply({ flags: EPHEMERAL });
  await updateTeamRoles(i.guild, g, user.id, before);
  await refreshDrop(i.guild); await refreshRegister(i.guild);
  return i.editReply(`Unregistered <@${user.id}>.`);
}

/** One-click registration: the player's Discord name is used as their player name, nothing to type. */
async function handleRegister(i) {
  const g = G(i.guild.id);
  if (!g.roleId) return reply(i, 'An admin needs to run `/setup` first.');
  if (!g.open.registration) return reply(i, 'Registration is closed.');
  await i.deferReply({ flags: EPHEMERAL });

  const epic = epicOf(i.member);
  const existing = g.players[i.user.id];
  g.players[i.user.id] = existing ? { ...existing, epic } : { epic, platform: '?', region: '?', team: null };
  const teamBefore = teamSnapshot(g, i.user.id);
  const size = L.teamSize(g);
  let teamNote = '';
  if (size === 1) {
    const r = L.soloTeam(g, i.user.id);
    teamNote = r.ok ? ` You play solo as **${r.team.name}**.` : ` ${r.error}`;
  } else {
    const t = L.teamOf(g, i.user.id);
    if (t) teamNote = ` Team: **${t.name}** (${t.members.length}/${size}).`;
  }
  L.addToRoster(g, i.user.id);
  save();
  try {
    await i.member.roles.add(g.roleId);
  } catch {
    return i.editReply('I registered you but couldn\'t give you the role. Ask an admin to move my bot role above the registered role.');
  }
  await updateTeamRoles(i.guild, g, i.user.id, teamBefore);
  refreshRegister(i.guild).catch(() => {});

  const prompt = captainPrompt(g, i.user.id);
  const n = prompt ? `${prompt.remaining} teammate${prompt.remaining === 1 ? '' : 's'}` : '';
  const ask = !prompt ? ''
    : prompt.key
      ? `\n\n**Team captain:** @ up to ${n} below. They'll get the Registered role and a **${prompt.name}** role.`
      : `\n\n**Got a team?** @ up to ${n} below and I'll create your team for you (they get the Registered role and a team role). ` +
        'Otherwise ignore this: a captain can add you, or use the fill channel.';
  return i.editReply({
    content:
      `You're registered as **${epic}**${g.session ? ` for Game ${g.session.current}/${g.session.total}` : ''}.${teamNote}\n` +
      `You can now see <#${g.channels.drop}> and <#${g.channels.fill}>. Interactive map: ${mapUrl(i.guild.id)}${ask}`,
    components: prompt ? [pickRow(prompt)] : [],
  });
}

async function handleButton(i) {
  const g = G(i.guild.id);
  const id = i.customId;

  if (id === 'reg:open') return handleRegister(i);

  if (id === 'drop:clear') {
    const r = L.releaseFor(g, i.user.id, hasRegisteredRole(i, g));
    if (!r.ok) return reply(i, r.error);
    save();
    return i.update(dropPanel(g, i.guild.id));
  }

  if (id === 'fill:new') {
    if (!g.open.fill) return reply(i, 'The fill channel is closed.');
    if (L.teamSize(g) === 1) return reply(i, 'This event is **solos**, so there is nothing to fill.');
    const err = participantError(i, g); if (err) return reply(i, err);
    return i.showModal(new ModalBuilder().setCustomId('fill:modal').setTitle(`Post a fill request (${L.modeOf(g).label.toLowerCase()})`).addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('notes').setLabel('Notes (optional)')
          .setPlaceholder('Playstyle, drop spot, mic required…')
          .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300)),
    ));
  }

  if (id.startsWith('fill:')) {
    const fill = g.fills[i.message.id];
    if (!fill) return reply(i, 'This request is no longer active.');
    if (!g.open.fill) return reply(i, 'The fill channel is closed.');
    const err = participantError(i, g); if (err) return reply(i, err);

    if (id === 'fill:join') {
      const r = L.joinFill(g, fill, i.user.id);
      if (!r.ok) return reply(i, r.error);
      let formed = null;
      if (r.full) { formed = L.finalizeFill(g, fill); delete g.fills[i.message.id]; }
      save();
      await i.update({ embeds: [fillEmbed(g, fill)], components: fillButtons(fill) });
      const th = await getThread(i.guild, i.message.id);
      if (th?.isThread()) {
        await th.members.add(i.user.id).catch(() => {});
        await th.send({
          content: formed
            ? `${L.modeOf(g).one} complete! ${fill.members.map((u) => `<@${u}>`).join(' ')} are now team **${formed}**. Good luck!`
            : `<@${i.user.id}> joined.`,
          allowedMentions: { users: fill.members },
        }).catch(() => {});
      }
      if (formed) scheduleDropRefresh(i.guild);
      return;
    }

    if (id === 'fill:leave') {
      const r = L.leaveFill(fill, i.user.id);
      if (!r.ok) return reply(i, r.error);
      save();
      await i.update({ embeds: [fillEmbed(g, fill)], components: fillButtons(fill) });
      const th = await getThread(i.guild, i.message.id);
      if (th?.isThread()) {
        await th.members.remove(i.user.id).catch(() => {});
        await th.send({ content: `<@${i.user.id}> left.`, allowedMentions: { parse: [] } }).catch(() => {});
      }
      return;
    }

    if (id === 'fill:close') {
      if (fill.hostId !== i.user.id && !i.memberPermissions.has(P.ManageMessages)) {
        return reply(i, 'Only the host or a moderator can close this.');
      }
      fill.closed = true;
      delete g.fills[i.message.id];
      save();
      await i.update({ embeds: [fillEmbed(g, fill)], components: fillButtons(fill) });
      const th = await getThread(i.guild, i.message.id);
      if (th?.isThread()) await th.setArchived(true).catch(() => {});
    }
  }
}

async function handleSelect(i) {
  const g = G(i.guild.id);
  if (!i.customId.startsWith('drop:select')) return;
  const regionId = i.values[0];
  const r = L.claimFor(g, i.user.id, hasRegisteredRole(i, g), regionId, REGION_IDS);
  if (!r.ok) {
    const hint = r.code === 'not_registered' || r.code === 'not_in_game' ? ` (<#${g.channels.register}>)` : '';
    return reply(i, r.error + hint);
  }
  save();
  const region = regions.find((x) => x.id === regionId);
  await i.update(dropPanel(g, i.guild.id));
  const msg = r.status === 'already' ? `Your team already holds **${region.name}**.`
    : r.status === 'contested'
      ? `**${r.team.name}** is contesting **${region.name}** against ${r.others.map((k) => teamName(g, k)).join(', ')} 🟥`
      : `**${r.team.name}** claimed **${region.name}** ⬛`;
  return i.followUp({ content: msg, flags: EPHEMERAL });
}

async function handleModal(i) {
  const g = G(i.guild.id);

  if (i.customId === 'reg:modal') {                                // an old registration form that was still open
    return reply(i, 'Registration is now one click. Press **Register** in the register channel.');
  }

  if (i.customId === 'fill:modal') {
    if (!g.open.fill) return reply(i, 'The fill channel is closed.');
    const err = participantError(i, g); if (err) return reply(i, err);
    const r = L.createFill(g, i.user.id, i.fields.getTextInputValue('notes').trim());
    if (!r.ok) return reply(i, r.error);
    await i.deferReply({ flags: EPHEMERAL });
    const msg = await i.channel.send({ embeds: [fillEmbed(g, r.fill)], components: fillButtons(r.fill) });
    g.fills[msg.id] = r.fill;
    save();
    try {
      const th = await msg.startThread({ name: `${L.modeOf(g).one} fill - ${g.players[i.user.id]?.epic || i.user.username}`.slice(0, 100), autoArchiveDuration: 1440 });
      await th.members.add(i.user.id);
    } catch { /* threads are a bonus */ }
    return i.editReply('Your fill request is posted.');
  }
}

/* ------------------------------------------------------------------ */
/*  Boot                                                              */
/* ------------------------------------------------------------------ */
async function start() {
  if (!process.env.DISCORD_TOKEN) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }
  load();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const web = createWeb({
    client, G, save,
    onChange: scheduleDropRefresh,
    baseUrl: BASE_URL,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    secret: process.env.SESSION_SECRET ||
      crypto.createHash('sha256').update(`dropmap:${process.env.DISCORD_TOKEN}`).digest('hex'),
  });
  const port = await web.listen(PORT);
  console.log(`Web server on port ${port}, public URL ${BASE_URL}`);
  if (!process.env.DISCORD_CLIENT_SECRET) {
    console.warn('DISCORD_CLIENT_SECRET is not set: the interactive map page cannot log players in yet.');
  }

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);
    if (process.env.GUILD_ID) await c.application.commands.set(commands, process.env.GUILD_ID);
    else await c.application.commands.set(commands);
    console.log('Slash commands registered');
    for (const guildId of Object.keys(db.guilds)) if (G(guildId).session) scheduleSession(c, guildId);
  });

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (!i.guild) return;
      if (i.isChatInputCommand()) {
        switch (i.commandName) {
          case 'setup': return await handleSetup(i);
          case 'open': return await handleToggle(i, true);
          case 'close': return await handleToggle(i, false);
          case 'host': return await handleHost(i, client);
          case 'team': return await handleTeam(i);
          case 'dropmap': return await handleDropAdmin(i);
          case 'mode': return await handleMode(i);
          case 'end': return await handleEnd(i);
          case 'unregister': return await handleUnregister(i);
        }
      } else if (i.isButton()) return await handleButton(i);
      else if (i.isUserSelectMenu()) return await handleUserSelect(i);
      else if (i.isStringSelectMenu()) return await handleSelect(i);
      else if (i.isModalSubmit()) return await handleModal(i);
    } catch (err) {
      console.error(err);
      const payload = { content: 'Something went wrong. Please try again.', flags: EPHEMERAL };
      if (i.isRepliable()) {
        if (i.deferred || i.replied) i.followUp(payload).catch(() => {});
        else i.reply(payload).catch(() => {});
      }
    }
  });

  process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
  client.login(process.env.DISCORD_TOKEN);
}

start();
