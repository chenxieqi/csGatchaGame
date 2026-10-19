import { Instance } from "cs_script/point_script";

// ===== 調整用パラメータ =====
const BOT_COUNT  = 10;
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

// ===== 起動 =====
Instance.OnActivate(() => {
  for (const c of cmds) Instance.ServerCommand(c);
  Instance.SetThink(think);
  Instance.SetNextThink(now() + 1);
});

// プレイヤーを T に入れるのは上の mp_force_assign_teams 1 + mp_humanteam t に任せ、スクリプトの JoinTeam は使わない：
// プレイヤーがアクティブになった直後に強制でチームを変えると、インベントリ読み込みより先になり、購入した銃が公式デフォルトスキンになる。