import { Instance } from "cs_script/point_script";

// ===== 調整用パラメータ =====
const BOT_COUNT  = 5;
const STEP_SIZE  = 20;    // 1 歩あたりの距離（ユニット。プレイヤーの幅は約 32）
const MIN_STEPS  = 2;
const MAX_STEPS  = 6;
const MOVE_SPEED = 150;   // 移動速度（ユニット/秒）
const PAUSE      = 0.5;   // 移動と移動の間に止まる秒数
const LEASH      = 160;   // スポーン地点から離れられる最大距離。超えたら引き返す
const TICK       = 1 / 64;

const cmds = [
  "sv_cheats 1",                       // bot_stop / bot_dont_shoot に必要
  "mp_do_warmup_period 0", "mp_warmuptime 0",
  "mp_team_intro_time 0", "mp_freezetime 0",
  "mp_ignore_round_win_conditions 1", "mp_roundtime 60",
  "mp_respawn_on_death_t 1", "mp_respawn_on_death_ct 1",
  // プレイヤーは T、bot は全員 CT
  "mp_force_assign_teams 1", "mp_humanteam t",
  "mp_autoteambalance 0", "mp_limitteams 0",
  "bot_join_team ct", "bot_quota_mode normal", `bot_quota ${BOT_COUNT}`,
  "mp_randomspawn 3",                  // CT（bot）だけランダムにスポーン
  // bot は撃たず、自分では動かない（移動は下のスクリプトで制御）
  "bot_dont_shoot 1", "bot_stop 1",
  // エイム練習用の定番設定
  "sv_infinite_ammo 1", "mp_buy_anywhere 1", "mp_buytime 9999",
  "mp_startmoney 16000",
  // 死んだ bot は手榴弾・キットを落とさない。銃は落とす（落ちた銃は aim_gacha.js がすぐ消す）。
  // mp_death_drop_gun 0 は使わない：これを 0 にすると、プレイヤー以外が出した銃（抽選 AK・展示 AK）まで
  // 出した直後にゲームが消してしまう
  "mp_death_drop_gun 1", "mp_death_drop_grenade 0", "mp_death_drop_defuser 0",
  // Hammer に置いた銃（抽選 AK の型 gacha_ak_src）を消さない
  "mp_weapons_allow_map_placed 1",
  // ナイフも落とせるようにする（抽選ナイフを持ち替えさせるのに使う）
  "mp_drop_knife_enable 1",
  // 床に落ちた銃の自動削除を切る（抽選 AK・展示 AK が消えないように）
  "weapon_auto_cleanup_time 0", "weapon_max_before_cleanup 0",
  // ラウンドを一度リスタート：設定を反映させ、インベントリ読み込み後にプレイヤーを再スポーンさせる（しないと購入した銃が公式デフォルトスキンになる）。
  // ショーケースの壁はラウンドのクリーンアップ後に aim_gacha.js が並べ直すので影響なし。
  "mp_restartgame 1",
];

// ===== API アダプター層：コンソールに「関数ではない」系のエラーが出たら、ここだけ直す =====
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
const setVel = (p, v) => p.Teleport({ velocity: v });   // 速度だけ渡し、座標は変えない

// ===== 移動ロジック =====
const states = new Map();
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const dist2D  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function newState(p, t) {
  const pos = getPos(p);
  const rad = (getYaw(p) * Math.PI) / 180;
  return {
    home: { ...pos }, last: { ...pos },
    ax: -Math.sin(rad), ay: Math.cos(rad),   // bot から見た「左」方向
    dir: { x: 0, y: 0 }, remaining: 0, pauseUntil: t + PAUSE,
  };
}

function startMove(s) {
  let side = Math.random() < 0.5 ? 1 : -1;            // 1=左, -1=右
  const dist = randInt(MIN_STEPS, MAX_STEPS) * STEP_SIZE;
  const offset = (s.last.x - s.home.x) * s.ax + (s.last.y - s.home.y) * s.ay;
  if (Math.abs(offset + side * dist) > LEASH) side = -side;   // 離れすぎたら逆方向へ
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
    const vz = getVel(p).z;           // 垂直速度は保持して重力を正常に保つ
    let s = states.get(k);

    // 初登場、またはリスポーン直後（位置が急に変わった）→ 現在位置を新しい起点にする
    if (!s || dist2D(pos, s.last) > 64) {
      s = newState(p, t);
      s.stuck = 0;
      states.set(k, s);
    }

    // 実際に歩いた距離だけ残り距離を減らす
    if (s.remaining > 0) {
      const moved = (pos.x - s.last.x) * s.dir.x + (pos.y - s.last.y) * s.dir.y;
      s.remaining -= Math.max(moved, 0);
      s.stuck = moved < 0.5 ? s.stuck + 1 : 0;
      if (s.remaining <= 0 || s.stuck > 8) {    // 歩き終わった、または壁に引っかかった
        s.remaining = 0;
        s.pauseUntil = t + PAUSE;
      }
    }
    s.last = { ...pos };

    if (s.remaining <= 0) {
      if (t >= s.pauseUntil) startMove(s);
      else { setVel(p, { x: 0, y: 0, z: vz }); continue; }   // 停止中はブレーキをかける
    }

    setVel(p, { x: s.dir.x * MOVE_SPEED, y: s.dir.y * MOVE_SPEED, z: vz });
  }

  for (const k of [...states.keys()]) if (!seen.has(k)) states.delete(k);
  Instance.SetNextThink(t + TICK);
}

// ===== bot のランダムスポーン範囲 =====
// bot がスポーンしたら、範囲内のランダムな床の上へテレポートする。
// 範囲の決め方（上が優先）：
//   1. ゲーム中にコンソールで決めた範囲（下の bot_area_a / bot_area_b。マップを読み直すと消える）
//   2. Hammer に info_target を 2 つ置き、名前を bot_area_a / bot_area_b にする（向かい合う角）
// どちらもなければ、今まで通り CT スポーン地点に出る。
// 範囲はゲーム中にコンソールでも決められる（aim_gacha.js の管理コマンド、ログイン後）：
//   area a / area b   今立っている位置を角にする（その場で反映）
//   area off          範囲を使わない
//   area              今の範囲を表示
const AREA_ENT_A   = "bot_area_a";
const AREA_ENT_B   = "bot_area_b";
const BOT_GAP      = 64;    // bot 同士の最低間隔（ユニット）
const SPAWN_TRIES  = 30;    // 場所探しの試行回数。全部ダメならスポーン地点のまま
const HULL = { mins: { x: -16, y: -16, z: 0 }, maxs: { x: 16, y: 16, z: 72 } };   // プレイヤーの当たり判定

let areaOff = false;
/** コンソールで決めた範囲（マップを読み直すと消える） */
let cmdArea = null;

function currentArea() {
  if (areaOff) return null;
  if (cmdArea && cmdArea.a !== cmdArea.b) return cmdArea;
  const a = Instance.FindEntityByName(AREA_ENT_A), b = Instance.FindEntityByName(AREA_ENT_B);
  if (a && b) return { a: a.GetAbsOrigin(), b: b.GetAbsOrigin() };
  return null;
}

// 範囲内のランダムな地点から真下に当たり判定を落とし、立てる床を探す
function randomSpot(area, self) {
  const minX = Math.min(area.a.x, area.b.x), maxX = Math.max(area.a.x, area.b.x);
  const minY = Math.min(area.a.y, area.b.y), maxY = Math.max(area.a.y, area.b.y);
  const top = Math.max(area.a.z, area.b.z) + 64, bottom = Math.min(area.a.z, area.b.z) - 64;
  const others = getBotPawns().filter((p) => p !== self).map(getPos);

  for (let i = 0; i < SPAWN_TRIES; i++) {
    const x = minX + Math.random() * (maxX - minX), y = minY + Math.random() * (maxY - minY);
    const tr = Instance.TraceBox({ ...HULL, start: { x, y, z: top }, end: { x, y, z: bottom }, ignorePlayers: true });
    if (!tr.didHit || tr.startedInSolid) continue;     // 床がない／壁の中
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
  else Instance.Msg("[aim] bot の置き場所が範囲内に見つからなかった（範囲が狭い／床がない？）");
}

// スポーン直後はゲーム側が位置を決めるので、少し待ってから動かす
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
  if (!area) { Instance.Msg("[aim] bot スポーン範囲：なし（CT スポーン地点に出る）"); return; }
  Instance.Msg(`[aim] bot スポーン範囲：${fmtPos(area.a)} 〜 ${fmtPos(area.b)}`);
}

function setCorner(key) {
  const p = humanPawn();
  if (!p) return;
  const pos = getPos(p);
  areaOff = false;
  cmdArea = cmdArea ? { ...cmdArea, [key]: pos } : { a: pos, b: pos };
  if (cmdArea.a === cmdArea.b) {
    Instance.Msg(`[aim] 角 ${key} を ${fmtPos(pos)} にした。もう一方の角で area ${key === "a" ? "b" : "a"} を打つ`);
    return;
  }
  printArea();
  // 角が両方決まったので、今いる bot をすぐ範囲内へ並べ直す
  for (const b of getBotPawns()) moveBotIntoArea(b);
}

// コンソールコマンドは aim_gacha.js の管理コマンド（パスワード付き）から RunScriptInput で呼ばれる
Instance.OnScriptInput("bot_area_a", () => setCorner("a"));
Instance.OnScriptInput("bot_area_b", () => setCorner("b"));
Instance.OnScriptInput("bot_area_off", () => { areaOff = true; printArea(); });
Instance.OnScriptInput("bot_area", () => printArea());

// ===== 起動 =====
Instance.OnActivate(() => {
  for (const c of cmds) Instance.ServerCommand(c);
  Instance.SetThink(think);
  Instance.SetNextThink(now() + 1);
  printArea();
});

// プレイヤーを T に入れるのは上の mp_force_assign_teams 1 + mp_humanteam t に任せ、スクリプトの JoinTeam は使わない：
// プレイヤーがアクティブになった直後に強制でチームを変えると、インベントリ読み込みより先になり、購入した銃が公式デフォルトスキンになる。