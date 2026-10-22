import { Instance } from "cs_script/point_script";

// ===== Tuning =====
const BOT_COUNT  = 6;
const STEP_SIZE  = 20;    // distance of one step (units; a player is about 32 wide)
const MIN_STEPS  = 1;
const MAX_STEPS  = 8;
const MOVE_SPEED = 150;   // movement speed (units/second)
const PAUSE      = 0.5;   // seconds to stand still between moves
const LEASH      = 160;   // furthest a bot may get from its spawn spot; it turns back beyond that
const TICK       = 1 / 64;

const cmds = [
  "sv_cheats 1",                       // needed by bot_stop / bot_dont_shoot
  "mp_do_warmup_period 0", "mp_warmuptime 0",
  "mp_team_intro_time 0", "mp_freezetime 0",
  "mp_ignore_round_win_conditions 1", "mp_roundtime 60",
  "mp_respawn_on_death_t 1", "mp_respawn_on_death_ct 1",
  // The player is on T, every bot on CT
  "mp_force_assign_teams 1", "mp_humanteam t",
  "mp_autoteambalance 0", "mp_limitteams 0",
  "bot_join_team ct", "bot_quota_mode normal", `bot_quota ${BOT_COUNT}`,
  "mp_randomspawn 3",                  // random spawns for CT (the bots) only
  // Bots never shoot and don't move on their own (this script moves them)
  "bot_dont_shoot 1", "bot_stop 1",
  // Usual aim-training settings
  "sv_infinite_ammo 1", "mp_buy_anywhere 1", "mp_buytime 9999",
  "mp_startmoney 16000",
  // Dead bots drop no grenades or kits. They do drop their gun (aim_gacha.js removes it right away).
  // Don't use mp_death_drop_gun 0: it also makes the game delete guns that no player dropped
  // (rolled AKs, showcase AKs) right after they appear.
  "mp_death_drop_gun 1", "mp_death_drop_grenade 0", "mp_death_drop_defuser 0",
  // Keep the guns placed in Hammer (the template sources such as gacha_ak_src)
  "mp_weapons_allow_map_placed 1",
  // Knives can be dropped too (used to hand over gacha knives)
  "mp_drop_knife_enable 1",
  // No automatic cleanup of guns on the floor (so rolled and showcase guns stay)
  "weapon_auto_cleanup_time 0", "weapon_max_before_cleanup 0",
  // Restart the round once: applies the settings and respawns the player after the inventory has
  // loaded (otherwise bought guns get the default skin). The showcase walls are rebuilt by
  // aim_gacha.js after the round cleanup, so they are not affected.
  "mp_restartgame 1",
];

// ===== API adapter: if the console reports "is not a function" errors, fix them here only =====
const now     = () => Instance.GetGameTime();
const getPos  = (p) => p.GetAbsOrigin();
const getYaw  = (p) => p.GetEyeAngles().yaw;
const setPos  = (p, pos) => p.Teleport({ position: pos, velocity: { x: 0, y: 0, z: 0 } });
const keyOf   = (p) => p.GetPlayerController().GetPlayerSlot();
function getBotPawns() {
  return Instance.FindEntitiesByClass("player").filter((p) => {
    const c = p.GetPlayerController?.();
    return c && c.IsBot() && p.IsAlive();
  });
}
const getVel = (p) => p.GetAbsVelocity();
const setVel = (p, v) => p.Teleport({ velocity: v });   // velocity only, the position is unchanged

// ===== Movement =====
const states = new Map();
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const dist2D  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function newState(p, t) {
  const pos = getPos(p);
  const rad = (getYaw(p) * Math.PI) / 180;
  return {
    home: { ...pos }, last: { ...pos },
    ax: -Math.sin(rad), ay: Math.cos(rad),   // the bot's "left"
    dir: { x: 0, y: 0 }, remaining: 0, pauseUntil: t + PAUSE,
  };
}

function startMove(s) {
  let side = Math.random() < 0.5 ? 1 : -1;            // 1 = left, -1 = right
  let dist = randInt(MIN_STEPS, MAX_STEPS) * STEP_SIZE;
  const offset = (s.last.x - s.home.x) * s.ax + (s.last.y - s.home.y) * s.ay;
  // Stay within LEASH of the spawn spot: turn around if there isn't room, and shorten the move
  // if there still isn't
  const room = (sd) => LEASH - sd * offset;
  if (room(side) < dist && room(-side) > room(side)) side = -side;
  dist = Math.max(STEP_SIZE, Math.min(dist, room(side)));
  s.dir = { x: s.ax * side, y: s.ay * side };
  s.remaining = dist;
}

function think() {
  const t = now();
  const seen = new Set();

  for (const p of getBotPawns()) {
    const k = keyOf(p);
    seen.add(k);
    const pos = getPos(p);
    const vz = getVel(p).z;           // keep the vertical speed so gravity still works
    let s = states.get(k);

    // First seen, or just respawned (the position jumped): the current position is the new home
    if (!s || dist2D(pos, s.last) > 64) {
      s = newState(p, t);
      s.stuck = 0;
      states.set(k, s);
    }

    // Count down only the distance actually walked
    if (s.remaining > 0) {
      const moved = (pos.x - s.last.x) * s.dir.x + (pos.y - s.last.y) * s.dir.y;
      s.remaining -= Math.max(moved, 0);
      s.stuck = moved < 0.5 ? s.stuck + 1 : 0;
      if (s.remaining <= 0 || s.stuck > 8) {    // done, or stuck against a wall
        s.remaining = 0;
        s.pauseUntil = t + PAUSE;
      }
    }
    s.last = { ...pos };

    if (!botsMove) { s.remaining = 0; setVel(p, { x: 0, y: 0, z: vz }); continue; }   // stopped mode

    if (s.remaining <= 0) {
      if (t >= s.pauseUntil) startMove(s);
      else { setVel(p, { x: 0, y: 0, z: vz }); continue; }   // brake while pausing
    }

    setVel(p, { x: s.dir.x * MOVE_SPEED, y: s.dir.y * MOVE_SPEED, z: vz });
  }

  for (const k of [...states.keys()]) if (!seen.has(k)) states.delete(k);
  Instance.SetNextThink(t + TICK);
}

// ===== Random bot spawn area =====
// When a bot spawns it is teleported onto random floor inside the area.
// Where the area comes from (first one wins):
//   1. an area set in game with the admin console command (below; gone when the map reloads)
//   2. two info_targets in Hammer named bot_area_a / bot_area_b (opposite corners)
// With neither, bots spawn at the CT spawns as usual.
// In game (aim_gacha.js admin command, after logging in):
//   area a / area b   use where you stand as a corner (applies right away)
//   area off          don't use an area
//   area              show the current area
const AREA_ENT_A   = "bot_area_a";
const AREA_ENT_B   = "bot_area_b";
const FRONT_CHANCE = 0.65;  // chance to spawn in the half of the area nearer to the player
const BOT_GAP      = 64;    // minimum distance between bots (units)
const SPAWN_TRIES  = 30;    // tries to find a spot; if all fail, the bot stays at its spawn
const HULL = { mins: { x: -16, y: -16, z: 0 }, maxs: { x: 16, y: 16, z: 72 } };   // player collision box

let areaOff = false;
/** Area set with the console (gone when the map reloads) */
let cmdArea = null;

function currentArea() {
  if (areaOff) return null;
  if (cmdArea && cmdArea.a !== cmdArea.b) return cmdArea;
  const a = Instance.FindEntityByName(AREA_ENT_A), b = Instance.FindEntityByName(AREA_ENT_B);
  if (a && b) return { a: a.GetAbsOrigin(), b: b.GetAbsOrigin() };
  return null;
}

// Drop the player collision box straight down from a random point in the area to find floor
function randomSpot(area, self) {
  const minX = Math.min(area.a.x, area.b.x), maxX = Math.max(area.a.x, area.b.x);
  const minY = Math.min(area.a.y, area.b.y), maxY = Math.max(area.a.y, area.b.y);
  const top = Math.max(area.a.z, area.b.z) + 64, bottom = Math.min(area.a.z, area.b.z) - 64;
  const others = getBotPawns().filter((p) => p !== self).map(getPos);

  // FRONT_CHANCE of spawns go to the front half (nearer to the player), the rest to the back half.
  // "Depth" is the axis (X or Y) closer to the direction from the player to the area's center.
  const me = humanPawn();
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  let depthX = true, nearLow = true;   // the depth axis, and whether its low side is nearer to the player
  if (me) {
    const pp = getPos(me);
    depthX = Math.abs(cx - pp.x) >= Math.abs(cy - pp.y);
    nearLow = depthX ? pp.x < cx : pp.y < cy;
  }
  const pick = (lo, hi, depth) => {
    if (!depth || !me) return lo + Math.random() * (hi - lo);
    const front = Math.random() < FRONT_CHANCE;
    const mid = (lo + hi) / 2;
    const lowHalf = front === nearLow;   // if the near side is the low side, the front half is the low half
    return lowHalf ? lo + Math.random() * (mid - lo) : mid + Math.random() * (hi - mid);
  };

  for (let i = 0; i < SPAWN_TRIES; i++) {
    const x = pick(minX, maxX, depthX), y = pick(minY, maxY, !depthX);
    const tr = Instance.TraceBox({ ...HULL, start: { x, y, z: top }, end: { x, y, z: bottom }, ignorePlayers: true });
    if (!tr.didHit || tr.startedInSolid) continue;     // no floor / inside a wall
    const spot = { x, y, z: tr.end.z + 1 };
    if (others.some((o) => dist2D(o, spot) < BOT_GAP)) continue;
    return spot;
  }
  return null;
}

function moveBotIntoArea(p) {
  const area = currentArea();
  if (!area || !p.IsValid() || !p.IsAlive()) return;
  const spot = randomSpot(area, p);
  if (spot) setPos(p, spot);
  else Instance.Msg("[aim] no free spot for a bot in the spawn area (area too small, or no floor?)");
}

// Right after spawning the game places the bot itself, so wait a moment before moving it
Instance.OnPlayerReset(({ player }) => {
  const c = player.GetPlayerController();
  if (!c || !c.IsBot()) return;
  Instance.Delay(0.1).then(() => moveBotIntoArea(player));
});

function humanPawn() {
  for (const c of Instance.GetAllPlayerControllers()) {
    if (c.IsBot()) continue;
    const p = c.GetPlayerPawn();
    if (p) return p;
  }
  return undefined;
}

const fmtPos = (v) => `{ x: ${Math.round(v.x)}, y: ${Math.round(v.y)}, z: ${Math.round(v.z)} }`;

function printArea() {
  const area = currentArea();
  if (!area) { Instance.Msg("[aim] bot spawn area: none (bots use the CT spawns)"); return; }
  Instance.Msg(`[aim] bot spawn area: ${fmtPos(area.a)} - ${fmtPos(area.b)}`);
}

function setCorner(key) {
  const p = humanPawn();
  if (!p) return;
  const pos = getPos(p);
  areaOff = false;
  cmdArea = cmdArea ? { ...cmdArea, [key]: pos } : { a: pos, b: pos };
  if (cmdArea.a === cmdArea.b) {
    Instance.Msg(`[aim] corner ${key} set to ${fmtPos(pos)}; go to the other corner and run area ${key === "a" ? "b" : "a"}`);
    return;
  }
  printArea();
  // Both corners are set: move the current bots into the area right away
  for (const b of getBotPawns()) moveBotIntoArea(b);
}

// These are called with RunScriptInput by the admin console command (password-locked) in aim_gacha.js
Instance.OnScriptInput("bot_area_a", () => setCorner("a"));
Instance.OnScriptInput("bot_area_b", () => setCorner("b"));
Instance.OnScriptInput("bot_area_off", () => { areaOff = true; printArea(); });
Instance.OnScriptInput("bot_area", () => printArea());

// ===== Bots moving / stopped =====
// Button: OnPressed -> main_script -> RunScriptInput -> bot_move (each press switches moving / stopped)
// The state is shown on the point_worldtext bot_move_text (optional)
let botsMove = true;

function updateBotMoveText() {
  Instance.EntFireAtName({ name: "bot_move_text", input: "SetMessage", value: botsMove ? "MOVING" : "STOPPED" });
  // MOVING in blue, STOPPED in black
  Instance.EntFireAtName({ name: "bot_move_text", input: "SetTextColor", value: botsMove ? "60 120 255" : "0 0 0" });
}

Instance.OnScriptInput("bot_move", () => {
  botsMove = !botsMove;
  updateBotMoveText();
  Instance.Msg(`[aim] bots ${botsMove ? "moving" : "stopped"}`);
});

// ===== Number of bots =====
// Buttons: OnPressed -> main_script -> RunScriptInput -> bot_add (one more) / bot_remove (one fewer)
// 1 to 10 bots. The number is shown on the point_worldtext bot_count_text (optional)
const BOT_MIN = 1, BOT_MAX = 10;
let botCount = BOT_COUNT;

function updateBotCountText() {
  Instance.EntFireAtName({ name: "bot_count_text", input: "SetMessage", value: `${botCount}` });
}

function setBotCount(n) {
  botCount = Math.max(BOT_MIN, Math.min(BOT_MAX, n));
  Instance.ServerCommand(`bot_quota ${botCount}`);
  updateBotCountText();
  Instance.Msg(`[aim] bots: ${botCount}`);
}

Instance.OnScriptInput("bot_add", () => setBotCount(botCount + 1));
Instance.OnScriptInput("bot_remove", () => setBotCount(botCount - 1));

Instance.OnRoundStart(() => Instance.Delay(0.5).then(() => { updateBotMoveText(); updateBotCountText(); }));

// ===== Moving wall =====
// Hammer: make the wall a func_movelinear named moving_wall, with Move Distance and Start Position
// equal to WALL_DISTANCE / WALL_START below.
// Buttons: OnPressed -> main_script -> RunScriptInput -> wall_left / wall_right (WALL_STEP per press)
const WALL_NAME     = "moving_wall";
const WALL_DISTANCE = 1000;  // Hammer's Move Distance (units)
const WALL_START    = 0.5;   // Hammer's Start Position (0 = start, 1 = end)
const WALL_STEP     = 50;    // distance per press (units)

let wallPos = WALL_START;

function moveWall(sign) {
  wallPos = Math.max(0, Math.min(1, wallPos + sign * WALL_STEP / WALL_DISTANCE));
  Instance.EntFireAtName({ name: WALL_NAME, input: "SetPosition", value: String(wallPos) });
}

Instance.OnScriptInput("wall_left", () => moveWall(-1));
Instance.OnScriptInput("wall_right", () => moveWall(1));
// A round restart puts the wall back at its Start Position, so reset the remembered position too
Instance.OnRoundStart(() => { wallPos = WALL_START; });

// ===== Start =====
Instance.OnActivate(() => {
  for (const c of cmds) Instance.ServerCommand(c);
  Instance.SetThink(think);
  Instance.SetNextThink(now() + 1);
  printArea();
  updateBotMoveText();
  updateBotCountText();
});

// Putting the player on T is left to mp_force_assign_teams 1 + mp_humanteam t above; the script doesn't
// use JoinTeam: forcing the team right after the player becomes active happens before the inventory
// has loaded, and bought guns then get the default skin.
