import { Instance, BaseModelEntity, CSGearSlot, CSMoveType, CSPlayerPawn, CSWeaponBase, PointTemplate } from "cs_script/point_script";

// Collected skins, coins, kills and the rate-up level are saved to the addon's save data
// and survive map reloads. Rates set by console commands are not saved.

const COST = 1; // coins per roll

// Hammer entities used by this script
const AK_TEMPLATE = "gacha_ak_template"; // point_template whose template is a weapon_ak47
const DROP_POINT  = "gacha_drop_point";  // info_target where the AK drops

// Skin test: limit rolls to these skins (empty = every skin can drop).
/** @type {string[]} */
const TEST_SKINS = [];
// While testing, every rarity is equally likely so all five colors show up quickly.
const TEST_EQUAL_WEIGHTS = false;

// Drop rates live in `rates` below (Common gets whatever is left).
// Rarities with no skins yet are skipped when rolling.
// prefix matches the texture filenames: {prefix}_AK_{name}.png, and is the short name (R, SR...)
// color is used for both the result text and the dropped AK's glow.
/** @type {{ id: string, prefix: string, color: Rgb }[]} */
const RARITIES = [
    { id: "Common",     prefix: "c",  color: { r: 255, g: 255, b: 255 } }, // white
    { id: "Rare",       prefix: "r",  color: { r: 60,  g: 220, b: 60  } }, // green
    { id: "Super Rare", prefix: "sr", color: { r: 60,  g: 120, b: 255 } }, // blue
    { id: "Ultra Rare", prefix: "ur", color: { r: 255, g: 210, b: 0   } }, // yellow
    { id: "Legendary",  prefix: "l",  color: { r: 255, g: 50,  b: 50  } }, // red
];

// ---------------------------------------------------------------------------
// Drop rates and the rate-up button
//
// Starting rates: R 10%, SR 5%, UR 1%, L 0.5%, Common the rest (83.5%).
//
// Each rate-up costs coins and belongs to a stage. A stage has one focus rarity
// that climbs from wherever it is to the stage target over the stage's steps. It climbs
// geometrically, multiplying by the same factor every step:
//
//     k = (target / start) ^ (1 / steps)      rate after step i = start * k^i
//
// so every step adds a bit more than the one before. The other rarities rise
// by a fixed share of the focus rarity's gain on that step:
//
//     gain(other) = gain(focus) * share(other)
//
//   stage  cost             steps  focus      shares of the focus gain
//   1      40               5      R  -> 20%  SR 0.5   UR 0.25  L 0.1
//   2      50 (Lv 11: 100)  6      SR -> 20%  UR 0.5   L 0.25   R 0.15
//   3      120              7      UR -> 20%  L 0.5    SR 0.25  R 0.1
//   4      220              12     L  -> 20%  UR 0.3   SR 0.15  R 0.05
//
// Levels 1-10 are cheap (450 coins in all) so the first rate-ups come quickly.
// Stage 4's shares are smaller than the others' so the total stays under 100%.
// After all 30 steps (4030 coins): R 23.16%, SR 24.41%, UR 23.08%, L 20%, Common 9.35%
// (Common never goes below COMMON_FLOOR anyway).
// ---------------------------------------------------------------------------

/** @type {Record<string, number>} */
const BASE_RATES = { "Rare": 10, "Super Rare": 5, "Ultra Rare": 1, "Legendary": 0.5 };

/** cost: coins per step, or one number per step */
/** @type {{ cost: number | number[], steps: number, focus: string, target: number, share: Record<string, number> }[]} */
const BOOST_STAGES = [
    { cost: 40,  steps: 5,  focus: "Rare",       target: 20, share: { "Super Rare": 0.5, "Ultra Rare": 0.25, "Legendary": 0.1 } },
    { cost: [50, 50, 50, 50, 50, 100], steps: 6, focus: "Super Rare", target: 20, share: { "Ultra Rare": 0.5, "Legendary": 0.25,  "Rare": 0.15 } },
    { cost: 120, steps: 7,  focus: "Ultra Rare", target: 20, share: { "Legendary": 0.5,  "Super Rare": 0.25, "Rare": 0.1 } },
    { cost: 220, steps: 12, focus: "Legendary",  target: 20, share: { "Ultra Rare": 0.3, "Super Rare": 0.15, "Rare": 0.05 } },
];

/** Every rate-up step in order: its cost, stage and how much each rarity gains. */
const BOOST_STEPS = (() => {
    /** @type {{ cost: number, stage: number, gains: Record<string, number> }[]} */
    const steps = [];
    const r = { ...BASE_RATES };
    BOOST_STAGES.forEach((st, si) => {
        const start = r[st.focus];
        const k = Math.pow(st.target / start, 1 / st.steps);
        for (let i = 1; i <= st.steps; i++) {
            const gain = start * Math.pow(k, i) - r[st.focus];
            /** @type {Record<string, number>} */
            const gains = { [st.focus]: gain };
            for (const [id, share] of Object.entries(st.share)) gains[id] = gain * share;
            for (const [id, g] of Object.entries(gains)) r[id] += g;
            steps.push({ cost: Array.isArray(st.cost) ? st.cost[i - 1] : st.cost, stage: si + 1, gains });
        }
    });
    return steps;
})();

/** Current rates in percent (no Common: it is the rest) */
let rates = { ...BASE_RATES };
let boostLevel = 0;

/** Rates after the first `level` rate-up steps. Resets any rates set by console. */
/** @param {number} level */
function setBoostLevel(level) {
    boostLevel = Math.max(0, Math.min(BOOST_STEPS.length, Math.floor(level)));
    rates = { ...BASE_RATES };
    for (const step of BOOST_STEPS.slice(0, boostLevel)) {
        for (const [id, g] of Object.entries(step.gains)) rates[id] += g;
    }
}

// Common never drops below this share: late rate-ups squeeze the other rarities down
// proportionally instead, so Common skins can still be collected at max level.
const COMMON_FLOOR = 8;

/** @param {string} rarityId */
function rateOf(rarityId) {
    const others = Object.values(rates).reduce((a, b) => a + b, 0);
    const common = 100 - others;
    if (common >= COMMON_FLOOR) return rarityId === "Common" ? Math.max(0, common) : rates[rarityId] ?? 0;
    if (rarityId === "Common") return COMMON_FLOOR;
    return (rates[rarityId] ?? 0) * (100 - COMMON_FLOOR) / others;
}

/** @param {number} v */
function pct(v) {
    return `${Number(v.toFixed(2))}%`;
}

function ratesLine() {
    return RARITIES.map((r) => `${r.prefix.toUpperCase()} ${pct(rateOf(r.id))}`).join("   ");
}

function boostLine() {
    const max = BOOST_STEPS.length;
    if (boostLevel >= max) return `Rate Up Lv ${max}/${max}  MAX`;
    const next = BOOST_STEPS[boostLevel];
    return `Rate Up Lv ${boostLevel}/${max}  (stage ${next.stage})
Next: ${next.cost} coins`;
}

function updateRatesText() {
    setText("rates_text", ratesLine());
    setText("boost_text", boostLine());
}

/** @typedef {{ r: number, g: number, b: number }} Rgb */
const WHITE = { r: 255, g: 255, b: 255 };

// Generated from maps/skin_texture: {c|r|sr|ur|l}_AK_{name}.png
/** @type {Record<string, string[]>} */
const SKINS = {
    "Common": ["American_Comic", "Analog_Film", "Anime_Cel_Painting", "ASCII_Art", "Chibi_Kawaii", "Claymation", "Collage", "Cyberpunk", "Dieselpunk", "Generative_Art", "Glitch_Art", "Impasto", "Line_Art", "Papercraft", "Pastel_Symmetry", "Silhouette", "Sketch", "Swiss_Style", "Toon_Studio", "Vintage_Poster", "Watercolor"],
    "Rare": ["Film_Noir", "Meadow_Breeze", "Memphis_Design", "Neumorphism", "Retro_Futurism", "Solarpunk", "Storybook_Illustration", "Violet_Protocol"],
    "Super Rare": ["Apex_Rush", "Cel_Shading_Toon_Shading", "Cottagecore", "Dark_Fantasy", "Etching", "fish", "Guochao", "Lovecraftian", "Macro", "pixel", "Post_Apocalyptic", "Synthwave", "Taisho_Roman", "Twilight_Sky", "Wafuu"],
    "Ultra Rare": ["Atlas_Odyssey_n", "Cappuccino_n", "Hand_Painted", "Jade_Cipher", "pink_days_n", "Skeuomorphism", "Steampunk", "Y2K"],
    "Legendary": ["Biopunk", "Gothic_Horror", "Lomography", "Woodcut_Linocut"],
};

// Skins of the other weapons, "{weapon}:{Style}"; kept in sync by gen_gacha_weapon.py
/** @type {Record<string, string[]>} */
const WEAPON_SKINS = {
    "Common": ["deagle:AmberLotus", "deagle:CopperOwlOrnament", "deagle:ElectricFalconOrnament", "deagle:JadeCarpOrnament", "deagle:LavenderMirageOrnament", "m4a1_s:CandyGhost", "m4a1_s:OceanRelief", "m4a1_s:RustRaven", "usp_s:MoonRabbit", "usp_s:NeonSwallow"],
    "Rare": ["awp:CoralOrbitOrnament", "awp:IceKitsuneOrnament", "awp:MintOrbit", "awp:PolarVector", "deagle:CopperKraken", "deagle:IvorySignal", "deagle:PopThunder", "m4a4:CobaltVector", "usp_s:MintCircuit", "usp_s:OceanFade", "usp_s:ToxicFern"],
    "Super Rare": ["awp:CinnabarCraneOrnament", "awp:FrostViper", "deagle:EmberOrbit", "m4a1_s:CopperSerpent", "m4a1_s:MoonRabbit", "m4a1_s:PorcelainCircuit", "m4a1_s:RubyCanopy", "m4a4:AstralRelic", "m4a4:AzureFang", "m4a4:RoseSentinel", "usp_s:SilverSerpent", "usp_s:SolarDust", "usp_s:VioletWraith"],
    "Ultra Rare": ["awp:AuroraFade", "awp:CobaltFlux", "awp:NightCandy", "awp:OpalCircuit", "deagle:DaydreamPearl", "deagle:RoseAlloy", "m4a1_s:CandyChrome", "m4a4:DawnBlush", "m4a4:PaperCrane_n", "usp_s:EmeraldPrism"],
    "Legendary": ["awp:SilverUndertow", "awp:TidalPatina", "deagle:GoldenBlaze", "m4a1_s:Cathedral_Outlined", "m4a4:DarkLycoris", "m4a4:VioletDrift_FullFlow"],
};

// The other weapons join the same rarity lists (kept out of the SKINS block above,
// which gen_gacha_ak.ps1 rewrites)
for (const [rarityId, list] of Object.entries(WEAPON_SKINS)) {
    if (SKINS[rarityId]) SKINS[rarityId].push(...list);
}

/** Per weapon: entity class, the gear slot it goes in, the name shown in game */
/** @type {Record<string, { cls: string, slot: CSGearSlot, name: string }>} */
const WEAPON_INFO = {
    ak47: { cls: "weapon_ak47", slot: CSGearSlot.RIFLE, name: "AK-47" },
    m4a4: { cls: "weapon_m4a1", slot: CSGearSlot.RIFLE, name: "M4A4" },
    m4a1_s: { cls: "weapon_m4a1_silencer", slot: CSGearSlot.RIFLE, name: "M4A1-S" },
    awp: { cls: "weapon_awp", slot: CSGearSlot.RIFLE, name: "AWP" },
    deagle: { cls: "weapon_deagle", slot: CSGearSlot.PISTOL, name: "Desert Eagle" },
    usp_s: { cls: "weapon_usp_silencer", slot: CSGearSlot.PISTOL, name: "USP-S" },
};

/** "m4a4:DarkLycoris" -> "m4a4"; AK skins have no prefix */
/** @param {string} skin */
function weaponOf(skin) {
    const i = skin.indexOf(":");
    return i < 0 ? "ak47" : skin.slice(0, i);
}

/** @param {string} skin */
function styleOf(skin) {
    const i = skin.indexOf(":");
    return i < 0 ? skin : skin.slice(i + 1);
}

/**
 * Model id of a skin, e.g. "c_ak_cyberpunk" or "l_m4a4_darklycoris".
 * @param {{ prefix: string }} rarity
 * @param {string} skin
 */
function modelIdOf(rarity, skin) {
    const w = weaponOf(skin);
    return w === "ak47" ? `${rarity.prefix}_ak_${skin.toLowerCase()}` : `${rarity.prefix}_${w}_${styleOf(skin).toLowerCase()}`;
}

/** @param {string} id */
function isAkId(id) {
    return /^[a-z]+_ak_/.test(id);
}

/** @param {string} id */
function modelPathOf(id) {
    return isAkId(id) ? `maps/gacha_ak/${id}.vmdl` : `maps/gacha_weapon/${id}.vmdl`;
}

// Common is only 1.85% at max rate-up, so with many Common skins a full set would take
// forever by pure chance: a Common roll gives a Common skin not owned yet while there is one.
// Other rarities stay purely random (duplicates possible).
/** @type {string[]} */
const UNOWNED_FIRST = ["Common"];

const TOTAL_SKINS = Object.values(SKINS).reduce((sum, list) => sum + list.length, 0);

/**
 * A trailing _n in a texture name only means "no rarity effects" (see gen_gacha_ak.ps1),
 * so it is left out of the shown name.
 * @param {string} skin
 */
function displayName(skin) {
    const w = weaponOf(skin);
    if (w === "ak47") return `AK-47 | ${skin.replace(/_n$/, "").replace(/_/g, " ")}`;
    const style = styleOf(skin).replace(/_n$/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
    return `${WEAPON_INFO[w]?.name ?? w} | ${style}`;
}

/** @param {string} rarityId */
function skinPool(rarityId) {
    const all = SKINS[rarityId];
    return TEST_SKINS.length === 0 ? all : all.filter((s) => TEST_SKINS.includes(s));
}

/**
 * Model generated by gen_gacha_ak.ps1 for this skin.
 * @param {{ prefix: string }} rarity
 * @param {string} skin
 */
function skinModel(rarity, skin) {
    return modelPathOf(modelIdOf(rarity, skin));
}

let coins = 0;
let kills = 0;

// Knife draws: every KNIFE_EVERY rolls of Super Rare or better earns one knife ticket,
// spent on the knife button. Both counters are saved.
const KNIFE_EVERY = 10;
const KNIFE_DELIVERY_READY = true;

/** Knife skins won so far (no duplicates; saved) and the one carried this session (not saved:
 * every visit starts with the player's own knife; shoot one on the knife wall to carry it) */
/** @type {string[]} */
let knives = [];
let equippedKnife = "";
const KNIFE_RARITIES = ["Super Rare", "Ultra Rare", "Legendary"];
let knifeProgress = 0;  // qualifying rolls towards the next ticket (0 .. KNIFE_EVERY-1)
let knifeTickets = 0;

/** Knife skins that can be drawn ({knife}_{style}); kept in sync by gen_gacha_knife.py */
/** @type {string[]} */
const KNIFE_SKINS = ["bayonet_arcticwhite", "bayonet_axis", "bayonet_blue_gem_rb", "bayonet_fade_rb", "bayonet_sunset_pl", "butterfly_blue_gem_rb", "butterfly_crimsonweb_rl", "butterfly_fire_ice_pl", "butterfly_ivoryrosegold_ed", "butterfly_redblack", "butterfly_tide", "karambit_arc", "karambit_blackflame", "karambit_doppler", "karambit_emerald_pl", "karambit_fade_rb", "karambit_matteblack", "m9_blue_gem_rb", "m9_fire_ice_pl", "m9_nightgold_ed", "m9_sapphire", "m9_slaughter", "m9_tigertooth", "skeleton_blue_gem_rb", "skeleton_casehardened", "skeleton_fire_ice_pl", "skeleton_mist", "skeleton_obsidiangold_ed", "skeleton_olivesand", "skeleton_sapphire_pl"];

/** Skins pulled so far, duplicates included; saved to disk after every change */
/** @type {{ skin: string, rarity: string }[]} */
let inventory = [];

// SetSaveData writes to disk right away, which can hitch a frame. Kills happen often,
// so they only schedule a save: at most one write every SAVE_DELAY seconds
// (leaving within that time loses those last few kills).
const SAVE_DELAY = 10;
let savePending = false;

function saveProgressSoon() {
    if (savePending) return;
    savePending = true;
    Instance.Delay(SAVE_DELAY).then(saveProgress);
}

function saveProgress() {
    savePending = false;
    try {
        Instance.SetSaveData(JSON.stringify({ inventory, boostLevel, coins, kills, knifeProgress, knifeTickets, knives, welcomeGiven, latestSkin }));
    } catch (e) {
        Instance.Msg("[gacha] could not save progress: " + e);
    }
}

// The first time a player starts the map (no welcome flag in the save) they get one
// free knife ticket. The flag is saved, so it happens once; reset_all keeps it.
let welcomeGiven = false;

function giveWelcomeTicket() {
    if (welcomeGiven) return;
    welcomeGiven = true;
    knifeTickets++;
    saveProgress();
    resultMessage = "Welcome! A free knife ticket - press the knife button";
    resultColor = RARITIES[RARITIES.length - 1].color;
    Instance.Msg("[gacha] welcome: 1 free knife ticket");
}

function loadProgress() {
    try {
        const raw = Instance.GetSaveData();
        if (!raw) return;
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : data?.inventory; // very old saves were a bare array
        if (!Array.isArray(list)) return;
        inventory = list.filter((i) => i && typeof i.skin === "string" && typeof i.rarity === "string");
        if (typeof data?.boostLevel === "number") setBoostLevel(data.boostLevel);
        if (typeof data?.coins === "number") coins = Math.max(0, Math.floor(data.coins));
        if (typeof data?.kills === "number") kills = Math.max(0, Math.floor(data.kills));
        if (typeof data?.knifeProgress === "number") knifeProgress = Math.max(0, Math.floor(data.knifeProgress)) % KNIFE_EVERY;
        if (typeof data?.knifeTickets === "number") knifeTickets = Math.max(0, Math.floor(data.knifeTickets));
        welcomeGiven = data?.welcomeGiven === true;
        if (typeof data?.latestSkin === "string") latestSkin = data.latestSkin;
        // Matched by base name, so a skin keeps counting as owned when its file gets an effect suffix
        if (Array.isArray(data?.knives)) {
            knives = [];
            for (const k of data.knives) {
                if (typeof k !== "string") continue;
                const sid = KNIFE_SKINS.find((s) => knifeBaseName(s) === knifeBaseName(k));
                if (sid && !knives.includes(sid)) knives.push(sid);
            }
        }
        Instance.Msg(`[gacha] loaded ${inventory.length} saved pull(s), ${uniqueSkinCount()}/${TOTAL_SKINS} skins, rate-up Lv ${boostLevel}, ${coins} coins, ${kills} kills`);
    } catch (e) {
        Instance.Msg("[gacha] could not load saved progress: " + e);
    }
}

/**
 * @param {string} name
 * @param {string} text
 */
function setText(name, text) {
    Instance.EntFireAtName({ name, input: "SetMessage", value: text });
}

/**
 * @param {string} rarityId
 * @param {string} skin
 */
function hasSkin(rarityId, skin) {
    return inventory.some((i) => i.rarity === rarityId && i.skin === skin);
}

/**
 * Distinct skins collected (duplicates count once). Saved entries whose skin
 * no longer exists in that rarity (e.g. after a texture was renamed) are ignored.
 */
function uniqueSkinCount() {
    const valid = inventory.filter((i) => (SKINS[i.rarity] ?? []).includes(i.skin));
    return new Set(valid.map((i) => `${i.rarity}/${i.skin}`)).size;
}

function updateCoinsText() {
    setText("coins_text", `Coins: ${coins}   Kills: ${kills}   Skins: ${uniqueSkinCount()}/${TOTAL_SKINS}`);
    updateRarityCountTexts();
}

// One point_worldtext per rarity, named count_c / count_r / count_sr / count_ur / count_l,
// showing e.g. "Rare 3/8" in the rarity's color.
function updateRarityCountTexts() {
    updateLegendTexts();
    for (const r of RARITIES) {
        const owned = SKINS[r.id].filter((skin) => hasSkin(r.id, skin)).length;
        const name = `count_${r.prefix}`;
        setText(name, `${r.id} ${owned}/${SKINS[r.id].length}`);
        const { r: red, g, b } = r.color;
        Instance.EntFireAtName({ name, input: "SetTextColor", value: `${red} ${g} ${b}` });
    }
}

// Legend shop texts: a point_worldtext named after a Legendary skin plus "_text"
// (e.g. "golden_blaze_text", "dark_lycoris_text") shows
//     Legend / <skin name> / Owned          or          Legend / <skin name> / Buy: 1000
// Any other point_worldtext ending in "_text" is left alone if no Legendary skin matches.
const RESERVED_TEXTS = ["coins_text", "result_text", "rates_text", "boost_text", "knife_text"];

function updateLegendTexts() {
    for (const ent of Instance.FindEntitiesByClass("point_worldtext")) {
        const name = ent.GetEntityName();
        if (!/_text$/i.test(name) || RESERVED_TEXTS.includes(name.toLowerCase())) continue;
        const item = legendSkinNamed(name.replace(/_text$/i, ""));
        if (!item) continue;
        const owned = hasSkin(item.rarity.id, item.skin);
        const title = displayName(item.skin).split(" | ").pop();
        setText(name, `Legend\n${title}\n${owned ? "Owned" : `Buy: ${BUY_PRICE}`}`);
        const { r, g, b } = owned ? item.rarity.color : WHITE;
        Instance.EntFireAtName({ name, input: "SetTextColor", value: `${r} ${g} ${b}` });
    }
}

let resultMessage = "";
let resultColor = WHITE;

/**
 * @param {string} text
 * @param {Rgb} [color]
 */
function setResult(text, color = WHITE) {
    resultMessage = text;
    resultColor = color;
    applyResult();
}

function applyResult() {
    setText("result_text", resultMessage);
    const { r, g, b } = resultColor;
    Instance.EntFireAtName({ name: "result_text", input: "SetTextColor", value: `${r} ${g} ${b}` });
}

// Round restarts (mp_restartgame) respawn map entities and wipe their text,
// so both texts are rewritten whenever a round starts.
function updateKnifeText() {
    setText("knife_count", `Knife: ${knives.length}/${KNIFE_SKINS.length}`);
    setText("knife_text", `Knife tickets: ${knifeTickets}   next: ${knifeProgress}/${KNIFE_EVERY} SR+ rolls   Knives: ${knives.length}/${KNIFE_SKINS.length}`);
}

function refreshTexts() {
    updateKnifeText();
    updateCoinsText();
    updateRatesText();
    applyResult();
    refreshShowcase();
    Instance.Msg(`[gacha] texts refreshed (coins ${coins}, skins ${uniqueSkinCount()}/${TOTAL_SKINS})`);
}

/**
 * Model id ("c_ak_cyberpunk") of a gacha AK model path, or undefined for any other model.
 * @param {string} modelName
 */
function gachaModelId(modelName) {
    const m = /maps\/gacha_(?:ak|weapon)\/([a-z0-9_]+)\.vmdl/.exec(modelName.toLowerCase().replace(/\\/g, "/"));
    return m ? m[1] : undefined;
}

// Rarities whose AKs are always on the showcase wall, owned or not (as a goal to chase).
// Shooting one still only equips it once it is owned.
const ALWAYS_SHOWN = ["Legendary"];

/** Model ids of the skins that are on the wall even when not owned */
function alwaysShownModelIds() {
    const ids = new Set();
    for (const r of RARITIES) {
        if (!ALWAYS_SHOWN.includes(r.id)) continue;
        for (const skin of SKINS[r.id]) ids.add(modelIdOf(r, skin));
    }
    return ids;
}

/** Model ids of every skin collected so far */
function ownedModelIds() {
    const ids = new Set();
    for (const r of RARITIES) {
        for (const skin of SKINS[r.id]) {
            if (hasSkin(r.id, skin)) ids.add(modelIdOf(r, skin));
        }
    }
    return ids;
}

// Showcase wall.
//
// The prop_dynamic AKs placed in Hammer only mark the layout: the round cleanup when
// the game starts turns them into entities the script can no longer see or control.
// So when the map loads the script records each prop's position, angles and skin,
// removes the prop, and builds the wall from real AK weapons instead (the same kind
// of entity as the dropped AKs, which the script controls reliably): frozen in place,
// not pickable, one per collected skin. They are rebuilt after every round cleanup.
function refreshShowcase() {
    try {
        refreshShowcaseUnsafe();
    } catch (e) {
        Instance.Msg(`[gacha] ERROR in showcase: ${e}`);
    }
    refreshKnifeWall();
    showLatest();
}

// ---------------------------------------------------------------------------
// "Latest" display: the skin you got most recently, glowing in its rarity color.
// Shoot it like a wall item to equip it. Hammer: an info_target named latest_display marks where it floats
// (its angles set the starting direction); optional point_worldtext latest_text shows
// its name. latestSkin is "gun:<model id>" or "knife:<knife skin>", saved.
// ---------------------------------------------------------------------------
const LATEST_POINT = "latest_display";
const LATEST_TEXT = "latest_text";

let latestSkin = "";
/** @type {CSWeaponBase | undefined} */
let latestEntity = undefined;
let latestShown = "";
let latestBusy = false;

/** @param {Entity} ent */
function isLatestDisplay(ent) {
    return latestEntity !== undefined && ent === latestEntity;
}

/** @param {string} key "gun:..." or "knife:..." */
function setLatest(key) {
    latestSkin = key;
    saveProgress();
    showLatest();
}

async function showLatest() {
    if (latestBusy || !latestSkin) return;
    if (latestShown === latestSkin && latestEntity?.IsValid()) return;
    const point = Instance.FindEntityByName(LATEST_POINT);
    if (!point) return;
    latestBusy = true;
    try {
        const key = latestSkin;
        if (latestEntity?.IsValid()) latestEntity.Remove();
        latestEntity = undefined;
        const pos = point.GetAbsOrigin();
        const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
        let color = RARITIES[RARITIES.length - 1].color, name = "";
        /** @type {CSWeaponBase | undefined} */
        let w = undefined;
        if (kind === "knife") {
            w = await makeSkinKnife(id, pos);
            name = knifeDisplayName(id);
        } else {
            const info = skinOfModelId(id);
            if (info) { color = info.rarity.color; name = `[${info.rarity.id}] ${displayName(info.skin)}`; }
            w = await makeSkinnedWeapon(id, pos, undefined);
        }
        if (!w) { Instance.Msg(`[gacha] latest display: could not make ${key}`); return; }
        w.Teleport({ position: pos, angles: point.GetAbsAngles(), velocity: { x: 0, y: 0, z: 0 } });
        w.SetMoveType(CSMoveType.NONE);
        Instance.EntFireAtTarget({ target: w, input: "ToggleCanBePickedUp" });
        w.Glow(color);
        latestEntity = w;
        latestShown = key;
        setText(LATEST_TEXT, `NEW\n${name}`);
        Instance.EntFireAtName({ name: LATEST_TEXT, input: "SetTextColor", value: `${color.r} ${color.g} ${color.b}` });
        if (latestSkin !== key) latestShown = "";  // a newer skin came in meanwhile
    } catch (e) {
        Instance.Msg(`[gacha] ERROR in latest display: ${e}`);
    } finally {
        latestBusy = false;
    }
    if (latestShown !== latestSkin) showLatest();
}


/** @typedef {import("cs_script/point_script").QAngle} QAngle */

/** Wall slots by model id, recorded from the Hammer props */
/** @type {Map<string, { pos: Vector, angles: QAngle }>} */
const showcaseSlots = new Map();

/** Display AK per model id */
/** @type {Map<string, CSWeaponBase>} */
const displayAks = new Map();

/** @param {Entity} ent */
function isDisplayAk(ent) {
    for (const ak of displayAks.values()) if (ak === ent) return true;
    return false;
}

/** Records the layout from any Hammer showcase props that still exist, then removes them. */
function recordShowcaseSlots() {
    for (const prop of Instance.FindEntitiesByClass("prop_dynamic")) {
        if (!(prop instanceof BaseModelEntity)) continue;
        const knife = /maps\/gacha_knife\/([a-z0-9_]+)\.vmdl/.exec(prop.GetModelName().toLowerCase().replace(/\\/g, "/"));
        if (knife) {
            if (!knifeSlots.has(knife[1])) knifeSlots.set(knife[1], { pos: prop.GetAbsOrigin(), angles: prop.GetAbsAngles() });
            prop.Remove();
            continue;
        }
        const id = gachaModelId(prop.GetModelName());
        if (!id) continue;
        if (!showcaseSlots.has(id)) {
            showcaseSlots.set(id, { pos: prop.GetAbsOrigin(), angles: prop.GetAbsAngles() });
        }
        prop.Remove();
    }
}

let showcaseRetries = 0;
let weaponWallBusy = false;
/** Wall skins that could not be made; not retried this session */
/** @type {Set<string>} */
const wallFailed = new Set();
/** @type {Set<string> | undefined} */
let weaponWallAgain = undefined;

/**
 * The non-AK display weapons of the showcase (made with ent_create, one at a time).
 * @param {Set<string>} shown model ids that belong on the wall
 */
async function refreshWeaponWall(shown) {
    if (weaponWallBusy) { weaponWallAgain = shown; return; }
    weaponWallBusy = true;
    try {
        for (let next = /** @type {Set<string> | undefined} */ (shown); next; next = weaponWallAgain) {
            weaponWallAgain = undefined;
            const missing = [...showcaseSlots.keys()].filter((id) => !isAkId(id) && next.has(id) && !displayAks.has(id) && !wallFailed.has(id));
            for (const id of missing) {
                const slot = /** @type {{ pos: Vector, angles: QAngle }} */ (showcaseSlots.get(id));
                const w = await makeSkinnedWeapon(id, slot.pos, undefined) ?? await makeSkinnedWeapon(id, slot.pos, undefined);
                if (!w) {
                    wallFailed.add(id);  // don't try again every refresh (each try may leave a gun behind)
                    Instance.Msg(`[gacha] weapon wall: could not make ${id}, skipped until the map reloads`);
                    continue;
                }
                w.Teleport({ position: slot.pos, angles: slot.angles, velocity: { x: 0, y: 0, z: 0 } });
                w.SetMoveType(CSMoveType.NONE);
                Instance.EntFireAtTarget({ target: w, input: "ToggleCanBePickedUp" });
                displayAks.set(id, w);
            }
        }
    } catch (e) {
        Instance.Msg(`[gacha] ERROR in weapon wall: ${e}`);
    } finally {
        weaponWallBusy = false;
    }
}

function refreshShowcaseUnsafe() {
    recordShowcaseSlots();
    if (showcaseSlots.size === 0) {
        Instance.Msg("[gacha] showcase: no slots recorded (no prop_dynamic with a maps/gacha_ak or maps/gacha_weapon model when the map loaded)");
        return;
    }

    const owned = ownedModelIds();
    const shown = new Set([...owned, ...alwaysShownModelIds()]);
    // Drop handles of AKs removed by a cleanup, and AKs of skins no longer shown
    for (const [id, ak] of [...displayAks]) {
        if (!ak.IsValid()) displayAks.delete(id);
        else if (!shown.has(id)) { ak.Remove(); displayAks.delete(id); }
    }

    refreshWeaponWall(shown);
    const missing = [...showcaseSlots.keys()].filter((id) => isAkId(id) && shown.has(id) && !displayAks.has(id));
    const pawn = findPresser(undefined);
    if (missing.length > 0 && !pawn) {
        // Display AKs are created through a player; try again once someone has spawned
        if (showcaseRetries++ < 20) Instance.Delay(1).then(refreshShowcase);
        Instance.Msg(`[gacha] showcase: waiting for a player to build ${missing.length} display AK(s)`);
        return;
    }
    showcaseRetries = 0;

    let built = 0;
    for (const id of missing) {
        const slot = /** @type {{ pos: Vector, angles: QAngle }} */ (showcaseSlots.get(id));
        const ak = spawnAk(slot.pos, pawn);
        if (!ak) continue;
        ak.SetModel(`maps/gacha_ak/${id}.vmdl`);
        ak.Teleport({ position: slot.pos, angles: slot.angles, velocity: { x: 0, y: 0, z: 0 } });
        ak.SetMoveType(CSMoveType.NONE);
        Instance.EntFireAtTarget({ target: ak, input: "ToggleCanBePickedUp" });
        displayAks.set(id, ak);
        // A vanished AK leaves an invalid handle, which the next refresh replaces
        checkTemplateAk(ak, refreshShowcase);
        built++;
    }
    Instance.Msg(`[gacha] showcase: ${displayAks.size} on the wall (${built} built now), ${showcaseSlots.size} slots, ${owned.size} skins owned`);
}

function rollRarity() {
    const available = RARITIES.filter((r) => skinPool(r.id).length > 0);
    /** @param {{ id: string }} r */
    const weightOf = (r) => (TEST_EQUAL_WEIGHTS ? 1 : rateOf(r.id));
    const total = available.reduce((sum, r) => sum + weightOf(r), 0);
    let n = Math.random() * total;
    for (const r of available) {
        n -= weightOf(r);
        if (n < 0) return r;
    }
    return available[0];
}

/** @param {import("cs_script/point_script").Entity | undefined} ent */
function isHumanPawn(ent) {
    if (!(ent instanceof CSPlayerPawn)) return false;
    const ctrl = ent.GetPlayerController();
    return !!ctrl && !ctrl.IsBot();
}

/** @typedef {import("cs_script/point_script").Entity} Entity */
/** @typedef {import("cs_script/point_script").Vector} Vector */

/**
 * Where the AK lands: the drop point if the map has one, otherwise just above the button.
 * @param {Entity | undefined} button
 * @param {CSPlayerPawn | undefined} pawn
 * @returns {Vector | undefined}
 */
function dropPosition(button, pawn) {
    const point = Instance.FindEntityByName(DROP_POINT);
    if (point) return point.GetAbsOrigin();
    const from = button ?? pawn;
    if (!from) return undefined;
    const p = from.GetAbsOrigin();
    return { x: p.x, y: p.y, z: p.z + 16 };
}

/**
 * The player who pressed the button, or the first human player.
 * @param {Entity | undefined} activator
 */
function findPresser(activator) {
    if (activator instanceof CSPlayerPawn) return activator;
    for (const ctrl of Instance.GetAllPlayerControllers()) {
        if (ctrl.IsBot()) continue;
        const pawn = ctrl.GetPlayerPawn();
        if (pawn) return pawn;
    }
    return undefined;
}

/** A living bot pawn. Bots have no inventory, so an AK given to them is a plain AK. */
function findBotPawn() {
    for (const ctrl of Instance.GetAllPlayerControllers()) {
        if (!ctrl.IsBot()) continue;
        const pawn = ctrl.GetPlayerPawn();
        if (pawn && pawn.IsAlive()) return pawn;
    }
    return undefined;
}

// AKs from the point_template have no stickers, but the game may delete them right
// after they spawn. Each one is checked shortly after; if it vanished, the template
// is marked broken and the AK is made again through GiveNamedItem.
const TEMPLATE_CHECK_DELAY = 0.5;
let templateBroken = false;
/** AKs made from the template that haven't been checked yet */
/** @type {Set<Entity>} */
const templateAks = new Set();

/**
 * Calls `onVanished` if `ak` came from the template and is gone shortly after.
 * @param {CSWeaponBase} ak
 * @param {() => void} onVanished
 */
function checkTemplateAk(ak, onVanished) {
    if (!templateAks.has(ak)) return;
    Instance.Delay(TEMPLATE_CHECK_DELAY).then(() => {
        templateAks.delete(ak);
        if (ak.IsValid()) return;
        if (!templateBroken) Instance.Msg(`[gacha] AKs from ${AK_TEMPLATE} vanish right after spawning, using GiveNamedItem from now on`);
        templateBroken = true;
        onVanished();
    });
}

/**
 * Plan A: point_template in the map. Plan B: give a bot an AK and drop it right away.
 * Plan C: same through the player, as a last resort.
 *
 * An AK given to a human comes from their inventory and carries their stickers and
 * keychain, which float around wrongly once the model is swapped to a gacha skin.
 * A bot's AK has none, so a bot is used whenever one is alive.
 * @param {Vector} pos
 * @param {CSPlayerPawn | undefined} pawn
 * @returns {CSWeaponBase | undefined}
 */
function spawnAk(pos, pawn) {
    const useTemplate = akSource === "template" || (akSource === "auto" && !templateBroken);
    const template = useTemplate ? Instance.FindEntityByName(AK_TEMPLATE) : undefined;
    if (template instanceof PointTemplate) {
        const ak = (template.ForceSpawn(pos) ?? []).find((e) => e instanceof CSWeaponBase);
        if (ak instanceof CSWeaponBase) {
            if (akSource === "auto") templateAks.add(ak);
            lastAkSource = "template";
            return ak;
        }
        Instance.Msg(`[gacha] ${AK_TEMPLATE} spawned no weapon, falling back to GiveNamedItem`);
    }

    // The bots are CTs and the game may refuse them an AK, so the player is the fallback
    const bot = akSource === "player" ? undefined : findBotPawn();
    let ak = bot ? giveAkThrough(bot, true) : undefined;
    lastAkSource = "bot";
    if (!ak && pawn) {
        if (akSource !== "player") Instance.Msg(`[gacha] ${bot ? "the bot got no AK" : "no living bot"}, the AK comes from the player's inventory (stickers/keychain included)`);
        ak = giveAkThrough(pawn, false);
        lastAkSource = "player";
    }
    if (!ak) {
        Instance.Msg("[gacha] could not create an AK (no bot or player could be given one)");
        return undefined;
    }
    ak.Teleport({ position: pos, velocity: { x: 0, y: 0, z: 0 } });
    return ak;
}

// Debug: where AKs come from. auto = template, then bot, then player.
/** @type {"auto" | "template" | "bot" | "player"} */
let akSource = "auto";
let lastAkSource = "";

/**
 * Debug: logs whether a freshly made AK is still there a moment later, and where.
 * @param {CSWeaponBase} ak
 * @param {string} what
 */
function traceAk(ak, what) {
    const source = lastAkSource;
    for (const t of [0.5, 2]) {
        Instance.Delay(t).then(() => {
            if (!ak.IsValid()) { Instance.Msg(`[gacha] trace ${what} (${source}) after ${t}s: REMOVED`); return; }
            const p = ak.GetAbsOrigin();
            const owner = ak.GetOwner();
            Instance.Msg(`[gacha] trace ${what} (${source}) after ${t}s: at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}, model ${ak.GetModelName()}${owner ? ", held by " + owner.GetClassName() : ""}`);
        });
    }
}

/**
 * A weapon of class `cls` handed over by a bot (GiveNamedItem, then dropped), or undefined.
 * Bots have no inventory, so it carries no stickers. The bot gets a gun of the same
 * slot back so it doesn't pick the new one up again.
 * @param {string} cls
 * @param {CSGearSlot} gear
 */
function giveThroughBot(cls, gear) {
    const bot = findBotPawn();
    if (!bot) return undefined;
    const old = bot.FindWeaponBySlot(gear);
    if (old) bot.DestroyWeapon(old);
    bot.GiveNamedItem(cls, false);
    const w = bot.FindWeaponBySlot(gear);
    if (!(w instanceof CSWeaponBase)) {
        Instance.Msg(`[gacha] the bot got no ${cls}`);
        return undefined;
    }
    handedOverAks.add(w);
    bot.DropWeapon(w);
    bot.GiveNamedItem(gear === CSGearSlot.PISTOL ? "weapon_usp_silencer" : "weapon_m4a1", false);
    return w;
}

/**
 * Gives `donor` an AK and drops it right away. Returns the new AK, or undefined.
 * @param {CSPlayerPawn} donor
 * @param {boolean} isBot
 */
function giveAkThrough(donor, isBot) {
    // Free the bot's rifle slot so the new AK goes straight into its hands
    if (isBot) {
        const rifle = donor.FindWeaponBySlot(CSGearSlot.RIFLE);
        if (rifle) donor.DestroyWeapon(rifle);
    }
    const before = new Set(Instance.FindEntitiesByClass("weapon_ak47"));
    donor.GiveNamedItem("weapon_ak47", false);
    const ak = Instance.FindEntitiesByClass("weapon_ak47").find((e) => !before.has(e));
    if (!(ak instanceof CSWeaponBase)) {
        Instance.Msg(`[gacha] GiveNamedItem on the ${isBot ? "bot" : "player"} created no weapon_ak47`);
        return undefined;
    }
    if (ak.GetOwner()) {
        handedOverAks.add(ak);
        donor.DropWeapon(ak);
    }
    // A bot with an empty rifle slot grabs the AK right back off the ground
    // (it lies at its feet until the teleport lands), so give it a rifle again
    if (isBot) donor.GiveNamedItem("weapon_m4a1", false);
    return ak;
}

/**
 * Swaps the weapon to a textured AK model, and re-applies it if the game
 * resets the model when the AK is picked up.
 * @param {CSWeaponBase} ak
 * @param {string} model
 */
function applySkinModel(ak, model) {
    ak.SetModel(model);
    Instance.Msg(`[gacha] skin model set: ${ak.GetModelName()}`);

    Instance.ConnectOutput(ak, "OnPlayerPickup", () => {
        Instance.Msg(`[gacha] picked up, model is ${ak.GetModelName()}`);
        // Check again once the pickup has finished
        Instance.Delay(0.1).then(() => {
            if (!ak.IsValid()) return;
            const now = ak.GetModelName();
            if (now !== model) {
                Instance.Msg(`[gacha] model was reset to ${now}, re-applying`);
                ak.SetModel(model);
            }
        });
    });
}

/**
 * Drops a usable AK-47 near the button, glowing in the rarity color.
 * @param {{ r: number, g: number, b: number }} color
 * @param {string} model
 * @param {Entity | undefined} button
 * @param {Entity | undefined} activator
 */
function dropAk(color, model, button, activator) {
    const pawn = findPresser(activator);
    const pos = dropPosition(button, pawn);
    if (!pos) {
        Instance.Msg("[gacha] no drop position, no AK dropped");
        return;
    }
    const id = gachaModelId(model);
    if (id && !isAkId(id)) {
        // Another weapon: made with ent_create, which takes a moment
        makeSkinnedWeapon(id, pos, pawn).then((w) => {
            if (!w) return;
            w.Glow(color);
            Instance.Msg(`[gacha] ${w.GetClassName()} dropped at ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}`);
        });
        return;
    }
    const ak = spawnAk(pos, pawn);
    if (!ak) return;
    applySkinModel(ak, model);
    ak.Glow(color);
    checkTemplateAk(ak, () => dropAk(color, model, button, activator));
    Instance.Msg(`[gacha] AK dropped at ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}`);
}

// ---------------------------------------------------------------------------
// Shoot a display AK on the wall: the AK you fired with switches to that skin.
// Bullets pass through dropped weapons, so each shot's line (from the eyes along
// the view direction) is checked against points along every display AK's body.
// ---------------------------------------------------------------------------

const SHOT_RANGE = 1000;       // how far away a display AK can be shot (units)
const SHOT_HIT_RADIUS = 7;     // how close the shot line has to pass the gun body (units)
// The AK body runs from about -16 (stock) to +25 (muzzle) along its own forward axis
const AK_BODY_FROM = -16, AK_BODY_TO = 25, AK_BODY_STEP = 3;

/** @param {QAngle} a */
function forwardFromAngles(a) {
    const p = (a.pitch * Math.PI) / 180, y = (a.yaw * Math.PI) / 180;
    return { x: Math.cos(p) * Math.cos(y), y: Math.cos(p) * Math.sin(y), z: -Math.sin(p) };
}

/**
 * The display AK whose body passes closest to the shot line, and that distance.
 * @param {Vector} from
 * @param {Vector} dir unit vector
 */
function nearestDisplayAk(from, dir) {
    return nearestDisplay(displayAks, from, dir, AK_BODY_FROM, AK_BODY_TO, AK_BODY_STEP, SHOT_HIT_RADIUS);
}

// A knife runs from about -6 (pommel) to +12 (tip) along its own forward axis
const KNIFE_BODY_FROM = -6, KNIFE_BODY_TO = 12, KNIFE_BODY_STEP = 2;
const KNIFE_HIT_RADIUS = 5;

/**
 * The display weapon in `wall` the shot hits: of those whose body passes within `radius`
 * of the shot line, the one nearest to the shooter, as long as no wall stands in between.
 * Returns its id, how far the line passed from it (dist) and how far away it is (along).
 * @param {Map<string, CSWeaponBase>} wall
 * @param {Vector} from
 * @param {Vector} dir unit vector
 * @param {number} bodyFrom
 * @param {number} bodyTo
 * @param {number} step
 * @param {number} radius
 * @param {Entity} [shooter] ignored by the wall check
 */
function nearestDisplay(wall, from, dir, bodyFrom, bodyTo, step, radius, shooter) {
    /** @type {string | undefined} */
    let best = undefined;
    let bestDist = Infinity, bestAlong = Infinity;
    for (const [id, ak] of wall) {
        if (!ak.IsValid()) continue;
        const o = ak.GetAbsOrigin();
        const axis = forwardFromAngles(ak.GetAbsAngles());
        for (let s = bodyFrom; s <= bodyTo; s += step) {
            const d = { x: o.x + axis.x * s - from.x, y: o.y + axis.y * s - from.y, z: o.z + axis.z * s - from.z };
            const along = d.x * dir.x + d.y * dir.y + d.z * dir.z;
            if (along < 0 || along > SHOT_RANGE) continue;
            const off = Math.hypot(d.x - along * dir.x, d.y - along * dir.y, d.z - along * dir.z);
            if (off > radius) continue;
            if (along < bestAlong) { best = id; bestDist = off; bestAlong = along; }
        }
    }
    if (best === undefined) return { id: undefined, dist: Infinity, along: Infinity };
    // A wall (or anything solid) between the shooter and the item stops the shot
    const stop = Math.max(0, bestAlong - 6);
    const tr = Instance.TraceLine({
        start: from,
        end: { x: from.x + dir.x * stop, y: from.y + dir.y * stop, z: from.z + dir.z * stop },
        ignorePlayers: true,
        ...(shooter ? { ignoreEntity: shooter } : {}),
    });
    if (tr.didHit) return { id: undefined, dist: Infinity, along: Infinity };
    return { id: best, dist: bestDist, along: bestAlong };
}

/** @param {string} id model id like "c_ak_cyberpunk" */
function skinOfModelId(id) {
    for (const r of RARITIES) {
        for (const skin of SKINS[r.id]) {
            if (modelIdOf(r, skin) === id) return { rarity: r, skin };
        }
    }
    return undefined;
}

Instance.OnGunFire(({ weapon }) => {
    const latestOn = latestEntity !== undefined && latestEntity.IsValid();
    if (displayAks.size === 0 && displayKnives.size === 0 && !latestOn) return;
    const shooter = weapon.GetOwner();
    if (!shooter || !isHumanPawn(shooter)) return;

    const eye = shooter.GetEyePosition(), aim = forwardFromAngles(shooter.GetEyeAngles());
    // The "latest" display counts as one more item on the gun wall or the knife wall
    const latestKind = latestShown.slice(0, latestShown.indexOf(":"));
    const latestId = latestShown.slice(latestShown.indexOf(":") + 1);
    const knifeWall = new Map(displayKnives), gunWall = new Map(displayAks);
    // Its own key ("#" never appears in a skin id): the same skin is usually on the wall
    // too, and must stay shootable there
    const LATEST_KEY = "#latest";
    if (latestOn && latestEntity) (latestKind === "knife" ? knifeWall : gunWall).set(LATEST_KEY, latestEntity);
    const hitKnife = nearestDisplay(knifeWall, eye, aim, KNIFE_BODY_FROM, KNIFE_BODY_TO, KNIFE_BODY_STEP, KNIFE_HIT_RADIUS, shooter);
    if (hitKnife.id === LATEST_KEY) hitKnife.id = latestId;
    const nearestGun = nearestDisplay(gunWall, eye, aim, AK_BODY_FROM, AK_BODY_TO, AK_BODY_STEP, SHOT_HIT_RADIUS, shooter);
    const id = nearestGun.id === LATEST_KEY ? latestId : nearestGun.id, dist = nearestGun.dist;
    // Whichever is nearer to the shooter is the one the bullet reaches first
    if (hitKnife.id && (!id || hitKnife.along < nearestGun.along)) {
        const sid = hitKnife.id;
        if (sid === equippedKnife) {
            setResult(`${knifeDisplayName(sid)} is already in your hands`, RARITIES[RARITIES.length - 1].color);
            return;
        }
        // Don't swap weapons in the middle of the fire callback
        Instance.QueueAfterThinks(() => {
            giveKnife(shooter, sid).then((ok) => {
                if (!ok) return;
                equippedKnife = sid;
                setResult(`Equipped ${knifeDisplayName(sid)}`, RARITIES[RARITIES.length - 1].color);
            });
        });
        return;
    }
    if (!id || dist > SHOT_HIT_RADIUS) return;

    const info = skinOfModelId(id);
    if (!info) return;
    if (!hasSkin(info.rarity.id, info.skin)) {
        setResult(`[${info.rarity.id}] ${displayName(info.skin)}: not owned yet`, info.rarity.color);
        return;
    }
    // Any gun can shoot the wall: the skinned weapon goes into its slot (rifle or pistol)
    const gear = WEAPON_INFO[weaponOf(info.skin)]?.slot ?? CSGearSlot.RIFLE;
    const current = shooter.FindWeaponBySlot(gear);
    // Don't swap weapons in the middle of the fire callback
    if (current && gachaModelId(current.GetModelName()) === id) {
        // Shooting the skin you already carry takes it off and gives your own weapon back
        Instance.QueueAfterThinks(() => restoreOwnAk(shooter, current, gear));
        return;
    }
    Instance.Msg(`[gacha] wall hit: ${id} (shot passed ${dist.toFixed(1)} units away), slot ${gear}, current ${current ? current.GetClassName() : "none"}`);
    Instance.QueueAfterThinks(() => swapForSkinnedAk(shooter, current, id, info, dist, gear));
});

// ---------------------------------------------------------------------------
// The player's own AK (their inventory skin, stickers and keychain) is not destroyed
// when a gacha skin is equipped: it is hidden far below the map, frozen and not
// pickable, and handed back when they shoot the skin they are wearing again.
// Round cleanups remove it; then a newly bought AK is their own skin again anyway.
// ---------------------------------------------------------------------------

// Height the own AK is hidden at: in the empty space below the map, but still
// inside the world bounds (+-16384) so the engine doesn't delete it
const STASH_Z = -15000;

/** Own weapon per player slot and gear slot ("3:0" = player 3's rifle) */
/** @type {Map<string, { ak: CSWeaponBase, moveType: CSMoveType }>} */
const ownAks = new Map();

/** @param {CSPlayerPawn} pawn @param {CSGearSlot} gear */
function stashKey(pawn, gear) {
    const slot = pawn.GetPlayerController()?.GetPlayerSlot();
    return slot === undefined ? undefined : `${slot}:${gear}`;
}

/** @param {Entity} ent */
function isStashedAk(ent) {
    for (const s of ownAks.values()) if (s.ak === ent) return true;
    return false;
}

/**
 * @param {CSPlayerPawn} pawn
 * @param {CSWeaponBase} ak
 * @param {CSGearSlot} [gear]
 */
function stashOwnAk(pawn, ak, gear = CSGearSlot.RIFLE) {
    const slot = stashKey(pawn, gear);
    if (slot === undefined) { pawn.DestroyWeapon(ak); return; }
    const old = ownAks.get(slot);
    if (old && old.ak.IsValid()) old.ak.Remove();

    if (ak.GetOwner() === pawn) pawn.DropWeapon(ak);
    const moveType = ak.GetMoveType();
    const at = pawn.GetAbsOrigin();
    ak.Teleport({ position: { x: at.x, y: at.y, z: STASH_Z }, velocity: { x: 0, y: 0, z: 0 } });
    ak.SetMoveType(CSMoveType.NONE);
    Instance.EntFireAtTarget({ target: ak, input: "ToggleCanBePickedUp" });
    ownAks.set(slot, { ak, moveType });
    // Debug: where the own weapon ended up
    Instance.Delay(0.5).then(() => {
        if (!ak.IsValid()) { Instance.Msg(`[gacha] stash: own ${ak.GetClassName()} was removed`); return; }
        const p = ak.GetAbsOrigin();
        Instance.Msg(`[gacha] stash: own ${ak.GetClassName()} at z=${Math.round(p.z)}${ak.GetOwner() ? ", held" : ""}`);
    });
}

/**
 * Takes the gacha weapon off and gives back the player's own one, ammo carried over
 * when they are the same kind of gun.
 * @param {CSPlayerPawn} pawn
 * @param {CSWeaponBase} gachaAk
 * @param {CSGearSlot} [gear]
 */
function restoreOwnAk(pawn, gachaAk, gear = CSGearSlot.RIFLE) {
    if (!pawn.IsValid() || !gachaAk.IsValid()) return;
    const slot = stashKey(pawn, gear);
    const stash = slot === undefined ? undefined : ownAks.get(slot);
    if (!stash || !stash.ak.IsValid()) {
        if (slot !== undefined) ownAks.delete(slot);
        if (gachaAk.GetOwner() === pawn) pawn.DestroyWeapon(gachaAk);
        setResult(`Your own ${gear === CSGearSlot.PISTOL ? "pistol" : "rifle"} is gone (round restarted), buy a new one`);
        return;
    }
    ownAks.delete(/** @type {string} */ (slot));

    const own = stash.ak;
    if (own.GetClassName() === gachaAk.GetClassName()) {
        own.SetClipAmmo(gachaAk.GetClipAmmo());
        own.SetReserveAmmo(gachaAk.GetReserveAmmo());
    }
    if (gachaAk.GetOwner() === pawn) pawn.DestroyWeapon(gachaAk);
    else gachaAk.Remove();

    own.SetMoveType(stash.moveType);
    Instance.EntFireAtTarget({ target: own, input: "ToggleCanBePickedUp" });
    const at = pawn.GetAbsOrigin();
    own.Teleport({ position: { x: at.x, y: at.y, z: at.z + 8 }, velocity: { x: 0, y: 0, z: 0 } });

    Instance.Delay(0.2).then(() => {
        if (pawn.IsValid() && own.IsValid() && own.GetOwner() === pawn) pawn.SwitchToWeapon(own);
        else Instance.Msg("[gacha] your own AK is at your feet, walk over it or press E to pick it up");
    });
    setResult(`Back to your own ${gear === CSGearSlot.PISTOL ? "pistol" : "rifle"}`);
}

/**
 * Changing the model of a gun in the hand doesn't update the first-person view,
 * but picking a gun up does. So: make a new AK with the skin while it lies on
 * the ground, give it the old AK's ammo, clear the rifle slot (the player's own
 * rifle, whatever it is, is kept aside), and drop the new AK at the player's feet
 * so it is picked up automatically.
 * @param {CSPlayerPawn} pawn
 * @param {CSWeaponBase | undefined} oldAk whatever is in the weapon's slot, if anything
 * @param {string} id model id of the skin
 * @param {{ rarity: { id: string, color: Rgb }, skin: string }} info
 * @param {number} dist
 * @param {CSGearSlot} gear
 */
async function swapForSkinnedAk(pawn, oldAk, id, info, dist, gear) {
    if (!pawn.IsValid() || !pawn.IsAlive()) return;
    if (oldAk && !oldAk.IsValid()) oldAk = undefined;
    const model = modelPathOf(id);
    const cls = WEAPON_INFO[weaponOf(info.skin)]?.cls ?? "weapon_ak47";
    // Ammo carries over only from the same kind of gun; anything else leaves it full
    const same = oldAk?.GetClassName() === cls;
    const clip = same && oldAk ? oldAk.GetClipAmmo() : -1, reserve = same && oldAk ? oldAk.GetReserveAmmo() : -1;

    const feet = pawn.GetAbsOrigin();
    const newAk = await makeSkinnedWeapon(id, { x: feet.x, y: feet.y, z: feet.z + 8 }, pawn);
    if (!newAk || !pawn.IsValid() || !pawn.IsAlive()) {
        if (newAk) newAk.Remove();
        setResult("Could not swap the weapon, try again");
        return;
    }
    if (oldAk && !oldAk.IsValid()) oldAk = undefined;
    if (clip >= 0) newAk.SetClipAmmo(clip);
    if (reserve >= 0) newAk.SetReserveAmmo(reserve);
    // Rare: the wall is built (and the template tested) before anyone can swap
    checkTemplateAk(newAk, () => setResult("The skinned weapon vanished, shoot the skin again"));

    // Free the slot (keeping the player's own weapon aside), then put the new one
    // on the player so it is picked up
    if (oldAk && oldAk.IsValid()) {
        if (!gachaModelId(oldAk.GetModelName())) stashOwnAk(pawn, oldAk, gear);
        else if (oldAk.GetOwner() === pawn) pawn.DestroyWeapon(oldAk);
        else oldAk.Remove();
    }
    const at = pawn.GetAbsOrigin();
    newAk.Teleport({ position: { x: at.x, y: at.y, z: at.z + 8 }, velocity: { x: 0, y: 0, z: 0 } });

    // Make sure it ends up in the hands once it has been picked up
    Instance.Delay(0.2).then(() => {
        if (pawn.IsValid() && newAk.IsValid() && newAk.GetOwner() === pawn) pawn.SwitchToWeapon(newAk);
        else Instance.Msg("[gacha] the skinned weapon is at your feet, walk over it or press E to pick it up");
    });

    setResult(`Equipped [${info.rarity.id}] ${displayName(info.skin)}`, info.rarity.color);
    Instance.Msg(`[gacha] equipped ${model} (shot passed ${dist.toFixed(1)} units away)`);
}

const SCRIPT_VERSION = "shot-occlusion-1";

Instance.OnActivate(() => {
    Instance.Msg(`[gacha] aim_gacha.js loaded (${SCRIPT_VERSION})`);
    loadProgress();
    printRates();
    resultMessage = `Press the button to roll (${COST} coins)`;
    giveWelcomeTicket();
    refreshTexts();
});

Instance.OnRoundStart(() => {
    // Wait a moment so the respawned point_worldtext entities exist
    Instance.Delay(0.5).then(refreshTexts);
});

// Guns bots drop when they die pile up on the floor and slow the game down, so they
// are removed right away. (mp_death_drop_gun 0 would do it, but it also makes the
// game delete every AK this script creates.) The AK a bot hands over is kept.
// The drop event may arrive after DropWeapon returns, so handed-over AKs are remembered
/** @type {Set<Entity>} */
const handedOverAks = new Set();

Instance.OnWeaponDrop(({ weapon, dropper }) => {
    if (dropper && isHumanPawn(dropper)) Instance.Msg(`[gacha] you dropped ${weapon.GetClassName()} (${weapon.GetModelName().split("/").pop()})`);
    if (handedOverAks.has(weapon)) return;
    const ctrl = dropper?.GetPlayerController();
    if (!ctrl || !ctrl.IsBot()) return;
    Instance.Delay(0.1).then(() => {
        if (weapon.IsValid() && !weapon.GetOwner() && !isDisplayAk(weapon)) weapon.Remove();
    });
});

// Every bot killed by a human player = 1 coin
Instance.OnPlayerKill((event) => {
    const victim = event.player.GetPlayerController();
    if (!victim || !victim.IsBot()) return;
    if (!isHumanPawn(event.attacker)) return;

    coins++;
    kills++;
    saveProgressSoon();
    updateCoinsText();
});

// Button: output OnPressed -> point_script, input RunScriptInput, parameter "gacha"
Instance.OnScriptInput("gacha", ({ caller, activator }) => {
    if (coins < COST) {
        setResult(`Need ${COST} coins (you have ${coins})`);
        return;
    }
    coins -= COST;

    const rarity = rollRarity();
    const pool = skinPool(rarity.id);
    // Rarities in UNOWNED_FIRST hand out a skin not owned yet while there is one
    const unowned = UNOWNED_FIRST.includes(rarity.id) ? pool.filter((sk) => !hasSkin(rarity.id, sk)) : [];
    const from = unowned.length > 0 ? unowned : pool;
    const skin = from[Math.floor(Math.random() * from.length)];
    if (KNIFE_RARITIES.includes(rarity.id)) {
        knifeProgress++;
        if (knifeProgress >= KNIFE_EVERY) {
            knifeProgress -= KNIFE_EVERY;
            knifeTickets++;
            Instance.Msg(`[gacha] knife ticket earned (${knifeTickets} now)`);
        }
        updateKnifeText();
    }
    giveSkin(rarity, skin, caller, activator);  // saves, so the knife counters are saved too
    Instance.Msg(`[gacha] rolled ${rarity.id}: ${skin}`);
});

/**
 * Adds the skin to the collection (saved) and drops it as an AK.
 * @param {{ id: string, prefix: string, color: Rgb }} rarity
 * @param {string} skin
 * @param {Entity | undefined} button
 * @param {Entity | undefined} activator
 */
function giveSkin(rarity, skin, button, activator) {
    const isNew = !hasSkin(rarity.id, skin);
    inventory.push({ skin, rarity: rarity.id });
    latestSkin = `gun:${modelIdOf(rarity, skin)}`;
    saveProgress();
    showLatest();

    dropAk(rarity.color, skinModel(rarity, skin), button, activator);

    updateCoinsText();
    if (isNew) refreshShowcase();
    setResult(`[${rarity.id}] ${displayName(skin)}${isNew ? "  NEW!" : ""}`, rarity.color);
}

// Button: output OnPressed -> point_script, input RunScriptInput, parameter "boost"
Instance.OnScriptInput("boost", () => {
    if (boostLevel >= BOOST_STEPS.length) {
        setResult("Drop rates are already at max");
        return;
    }
    const step = BOOST_STEPS[boostLevel];
    if (coins < step.cost) {
        setResult(`Rate Up needs ${step.cost} coins (you have ${coins})`);
        return;
    }
    coins -= step.cost;
    // Adds this step's gains on top of the current rates (keeps rates set by console)
    for (const [id, g] of Object.entries(step.gains)) rates[id] += g;
    boostLevel++;
    saveProgress();

    updateCoinsText();
    updateRatesText();
    setResult(`Rate Up! Lv ${boostLevel}/${BOOST_STEPS.length}`, RARITIES[RARITIES.length - 1].color);
    Instance.Msg(`[gacha] rate up to Lv ${boostLevel}: ${ratesLine()}`);
});

/** Removes every weapon lying on the ground (weapons held by players are kept). */
function clearDroppedWeapons() {
    Instance.Msg("[gacha] clearing dropped weapons...");
    try {
        let removed = 0, held = 0, notWeapon = 0;
        // "weapon_*" relies on wildcard class search; the AK is listed too in case wildcards aren't supported
        const weapons = new Set([...Instance.FindEntitiesByClass("weapon_*"), ...Instance.FindEntitiesByClass("weapon_ak47")]);
        for (const ent of weapons) {
            if (!(ent instanceof CSWeaponBase)) { notWeapon++; continue; }
            if (ent.GetOwner()) { held++; continue; }
            if (isDisplayAk(ent) || isDisplayKnife(ent) || isLatestDisplay(ent)) continue; // the showcase walls stay
            if (isStashedAk(ent)) continue; // players' own AKs, hidden while a gacha skin is used
            ent.Remove();
            removed++;
        }
        Instance.Msg(`[gacha] removed ${removed} dropped weapon(s) (found ${weapons.size}, ${held} held, ${notWeapon} not weapons)`);
    } catch (e) {
        Instance.Msg(`[gacha] ERROR clearing weapons: ${e}`);
    }
}

// ---------------------------------------------------------------------------
// Admin console command, locked by a password.
//
// Every test command lives under one console command (ADMIN_COMMAND) and only works
// after logging in for this map session:
//     <ADMIN_COMMAND> login <password>
//     <ADMIN_COMMAND> coins 500
//     <ADMIN_COMMAND> logout
// Only a hash of the password is stored here, so reading the script doesn't reveal it.
// To change the password: run "<ADMIN_COMMAND> hash <new password>" (works without
// logging in) and put the number it prints into ADMIN_PASSWORD_HASH.
// ---------------------------------------------------------------------------
const ADMIN_COMMAND = "aimx";
const ADMIN_PASSWORD_HASH = 0; // real value from .env (AIMX_PASSWORD_HASH), see README

/** FNV-1a, 32 bit */
/** @param {string} text */
function hashText(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

let adminUnlocked = false;
/** @type {Map<string, (args: string) => void>} */
const adminCommands = new Map();

/**
 * @param {string} name
 * @param {(args: string) => void} handler
 */
function adminCommand(name, handler) {
    adminCommands.set(name, handler);
}

Instance.RegisterCheatCommand(ADMIN_COMMAND, (args) => {
    const words = argWords(ADMIN_COMMAND, args);
    const sub = (words.shift() ?? "").toLowerCase();
    const rest = words.join(" ");
    if (sub === "hash") {
        Instance.Msg(`[gacha] hash: ${hashText(rest)}`);
        return;
    }
    if (sub === "login") {
        adminUnlocked = hashText(rest) === ADMIN_PASSWORD_HASH;
        Instance.Msg(adminUnlocked ? "[gacha] unlocked" : "[gacha] wrong password");
        return;
    }
    if (sub === "logout") {
        adminUnlocked = false;
        Instance.Msg("[gacha] locked");
        return;
    }
    if (!adminUnlocked) {
        Instance.Msg("[gacha] locked");
        return;
    }
    const handler = adminCommands.get(sub);
    if (!handler) {
        Instance.Msg(`[gacha] commands: ${[...adminCommands.keys()].join(", ")}`);
        return;
    }
    handler(rest);
});

// Bot spawn area (aimbot_map.js): area a | area b | area off | area
adminCommand("area", (args) => {
    const [which] = argWords("area", args);
    const input = which === "a" || which === "b" || which === "off" ? `bot_area_${which}` : "bot_area";
    Instance.EntFireAtName({ name: "main_script", input: "RunScriptInput", value: input });
});

// Debug: list what the showcase sees
adminCommand("showcase", () => {
    // Also retries wall items that failed earlier this session
    wallFailed.clear();
    Instance.Msg(`[gacha]   ${showcaseSlots.size} gun slots, ${displayAks.size} shown; ${knifeSlots.size} knife slots, ${displayKnives.size} shown`);
    refreshShowcase();
});

// Button: output OnPressed -> point_script, input RunScriptInput, parameter "clear_weapons"
Instance.OnScriptInput("clear_weapons", clearDroppedWeapons);

// ---------------------------------------------------------------------------
// Test commands, run as "<ADMIN_COMMAND> <name> ..." after "<ADMIN_COMMAND> login <password>"
//   coins           show coins
//   coins 500       set coins to 500
//   addcoins 100    add 100 coins
//   clear           remove every weapon lying on the ground
//   reset_skins     forget every collected skin
//   rates           show drop rates and the rate-up level
//   rate sr 12.5    set one rarity's rate in percent (r / sr / ur / l; Common is the rest)
//   boost 10        jump to rate-up level 10 (0-30; rates are recalculated from the start)
//   rates_reset     back to the starting rates, rate-up level 0
//   skins           list every skin name
//   give guochao    drop that skin and add it to the collection (part of the name is enough)
// ---------------------------------------------------------------------------

/**
 * Words after the command name (some builds pass the command name in args, some don't).
 * @param {string} cmd
 * @param {string} args
 */
function argWords(cmd, args) {
    const words = (args ?? "").trim().split(/\s+/).filter((w) => w.length > 0);
    if (words[0]?.toLowerCase() === cmd) words.shift();
    return words;
}

/** @param {string} args */
function parseAmount(args) {
    const n = parseInt(args.trim().split(/\s+/).pop() ?? "", 10);
    return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Shop buttons: buy one specific Legendary skin for BUY_PRICE coins.
// Hammer: name the button after the skin plus "_button" (e.g. "cyberpunk_button",
// "ur_ak_y2k_button", "karambit_doppler_button"; "_bottun" works too), and give it
// output OnPressed -> point_script (gacha_script), input RunScriptInput, parameter "buy".
// Gun skins drop as an AK like a roll; knife skins go straight into the player's hands.
// ---------------------------------------------------------------------------
const BUY_PRICE = 500;
let knifePurchasePending = false;

/**
 * The Legendary skin called `name` (skin name, "weapon:Style" style name or model id;
 * case, spaces and underscores don't matter), or undefined.
 * @param {string} name
 */
function legendSkinNamed(name) {
    const q = normalizeName(name);
    if (!q) return undefined;
    const rarity = RARITIES[RARITIES.length - 1];
    for (const skin of SKINS[rarity.id]) {
        if (normalizeName(skin) === q || normalizeName(styleOf(skin)) === q || normalizeName(modelIdOf(rarity, skin)) === q) {
            return { kind: /** @type {"ak"} */ ("ak"), rarity, skin };
        }
    }
    return undefined;
}

/**
 * The skin a shop button sells, from its name. Shop buttons sell Legendary skins only.
 * @param {string} buttonName
 * @returns {{ kind: "ak", rarity: typeof RARITIES[number], skin: string } | { kind: "knife", sid: string } | undefined}
 */
function skinForButton(buttonName) {
    return legendSkinNamed(buttonName.replace(/_(button|bottun)$/i, ""));
}

Instance.OnScriptInput("buy", ({ caller, activator }) => {
    const name = caller?.GetEntityName() ?? "";
    const item = skinForButton(name);
    if (!item) {
        setResult(`This shop button sells nothing ("${name}")`);
        Instance.Msg(`[gacha] buy: no Legendary skin matches button "${name}" (name it <skin>_button)`);
        return;
    }
    const label = item.kind === "ak" ? `[${item.rarity.id}] ${displayName(item.skin)}` : knifeDisplayName(item.sid);
    const color = item.kind === "ak" ? item.rarity.color : RARITIES[RARITIES.length - 1].color;
    const owned = item.kind === "ak" ? hasSkin(item.rarity.id, item.skin) : knives.includes(item.sid);
    if (owned) {
        setResult(`You already own ${label}`, color);
        return;
    }
    if (coins < BUY_PRICE) {
        setResult(`${label} costs ${BUY_PRICE} coins (you have ${coins})`, color);
        return;
    }
    if (item.kind === "ak") {
        coins -= BUY_PRICE;
        giveSkin(item.rarity, item.skin, caller, activator);  // saves, refreshes the wall
        setResult(`Bought ${label}`, color);
        Instance.Msg(`[gacha] bought ${item.rarity.id}: ${item.skin}`);
        return;
    }
    const pawn = findPresser(activator);
    if (!pawn || !pawn.IsAlive()) {
        setResult("Be alive to buy a knife");
        return;
    }
    if (knifePurchasePending) return;  // the knife takes a moment to make
    knifePurchasePending = true;
    coins -= BUY_PRICE;  // refunded if the knife can't be made
    updateCoinsText();
    const sid = item.sid;
    giveKnife(pawn, sid).then((ok) => {
        knifePurchasePending = false;
        if (!ok) {
            coins += BUY_PRICE;
            updateCoinsText();
            return;
        }
        if (!knives.includes(sid)) knives.push(sid);
        setLatest(`knife:${sid}`);
        equippedKnife = sid;
        saveProgress();
        refreshKnifeWall();
        setResult(`Bought ${label}`, color);
        Instance.Msg(`[gacha] bought knife ${sid}`);
    });
});

// Button: output OnPressed -> point_script, input RunScriptInput, parameter "knife"
Instance.OnScriptInput("knife", ({ activator }) => {
    if (knifeTickets < 1) {
        setResult(`No knife ticket yet (${knifeProgress}/${KNIFE_EVERY} SR+ rolls)`);
        return;
    }
    if (!KNIFE_DELIVERY_READY || KNIFE_SKINS.length === 0) {
        // Keep the ticket until a knife can actually be handed out
        setResult(`Knife skins are coming soon (you have ${knifeTickets} ticket${knifeTickets > 1 ? "s" : ""})`);
        return;
    }
    const pawn = findPresser(activator);
    if (!pawn || !pawn.IsAlive()) {
        setResult("Be alive to draw a knife");
        return;
    }
    // Draw only from knife skins not owned yet
    const pool = KNIFE_SKINS.filter((k) => !knives.includes(k));
    if (pool.length === 0) {
        setResult("You already own every knife skin (ticket kept)", RARITIES[RARITIES.length - 1].color);
        return;
    }
    const sid = pool[Math.floor(Math.random() * pool.length)];
    Instance.Msg(`[gacha] knife drawn: ${sid} (${pool.length} not owned)`);
    giveKnife(pawn, sid).then((ok) => {
        if (!ok) return;  // nothing was spent
        knifeTickets--;
        const isNew = !knives.includes(sid);
        if (isNew) knives.push(sid);
        setLatest(`knife:${sid}`);
        equippedKnife = sid;
        saveProgress();
        updateKnifeText();
        if (isNew) refreshKnifeWall();
        setResult(`${knifeDisplayName(sid)}${isNew ? "  NEW!" : ""}`, RARITIES[RARITIES.length - 1].color);
    });
});

// ---------------------------------------------------------------------------
// Handing out a knife skin.
// Knife animations belong to the weapon class, so the skin's model must sit on a
// knife of the same class (a butterfly model on a butterfly knife). The player's
// knife is replaced by a new one of that class wearing the skin model, given the
// same way as the skinned AK: made while not held, then picked up so the
// first-person view shows the new model.
// ---------------------------------------------------------------------------

/** Item definition index per knife, for the ChangeSubclass input */
/** @type {Record<string, string>} */
const KNIFE_DEF_INDEX = {
    bayonet: "500",
    butterfly: "515",
    karambit: "507",
    m9: "508",
    skeleton: "525",
};

/** Weapon class per knife (the file names use the community names) */
/** @type {Record<string, string>} */
const KNIFE_CLASS = {
    bayonet: "weapon_bayonet",
    butterfly: "weapon_knife_butterfly",
    karambit: "weapon_knife_karambit",
    m9: "weapon_knife_m9_bayonet",
    skeleton: "weapon_knife_skeleton",
};

/** Effect tier suffixes of knife skin names (see gen_gacha_knife.py); not shown in game */
const KNIFE_FX = ["rb", "pl", "gl", "ed", "rl"];

/** "bayonet_fade_rb" -> "bayonet_fade" */
/** @param {string} sid */
function knifeBaseName(sid) {
    const parts = sid.split("_");
    return parts.length > 2 && KNIFE_FX.includes(parts[parts.length - 1]) ? parts.slice(0, -1).join("_") : sid;
}

/** Names shown in game, by skin id without the effect suffix (file names stay as they are) */
/** @type {Record<string, string>} */
const KNIFE_TITLES = {
    bayonet_arcticwhite: "Glacier Oath",
    bayonet_axis: "Axis Breaker",
    bayonet_blue_gem: "Abyssal Gem",
    bayonet_fade: "Prism Fade",
    bayonet_sunset: "Dusk Requiem",
    butterfly_blue_gem: "Tempest Gem",
    butterfly_crimsonweb: "Crimson Snare",
    butterfly_fire_ice: "Frostfire",
    butterfly_ivoryrosegold: "Rose Sovereign",
    butterfly_redblack: "Blood Pact",
    butterfly_tide: "Riptide",
    karambit_arc: "Voltaic Arc",
    karambit_blackflame: "Umbral Blaze",
    karambit_doppler: "Void Nebula",
    karambit_emerald: "Verdant Venom",
    karambit_fade: "Solar Flare",
    karambit_matteblack: "Shadow Fang",
    m9_blue_gem: "Cobalt Storm",
    m9_fire_ice: "Ember & Ice",
    m9_nightgold: "Midnight Regalia",
    m9_sapphire: "Azure Abyss",
    m9_slaughter: "Crimson Carnage",
    m9_tigertooth: "Tiger's Wrath",
    skeleton_blue_gem: "Leviathan",
    skeleton_casehardened: "Forged Relic",
    skeleton_fire_ice: "Cataclysm",
    skeleton_mist: "Phantom Mist",
    skeleton_obsidiangold: "Obsidian Crown",
    skeleton_olivesand: "Desert Wraith",
    skeleton_sapphire: "Starfall",
};

/** Knife type names shown in game */
/** @type {Record<string, string>} */
const KNIFE_TYPE_NAMES = { bayonet: "Bayonet", butterfly: "Butterfly Knife", karambit: "Karambit", m9: "M9 Bayonet", skeleton: "Skeleton Knife" };

/** @param {string} sid like "karambit_doppler" */
function knifeDisplayName(sid) {
    const base = knifeBaseName(sid);
    const title = KNIFE_TITLES[base];
    if (title) return `\u2605 ${KNIFE_TYPE_NAMES[base.split("_")[0]] ?? base.split("_")[0]} | ${title}`;
    const [knife, ...style] = base.split("_");
    const cap = (/** @type {string} */ w) => w.charAt(0).toUpperCase() + w.slice(1);
    return `★ ${cap(knife)} | ${style.map(cap).join(" ")}`;
}

// In CS2 every knife is the same entity class (weapon_knife); which knife it is comes
// from its item definition. A knife made by the script (ent_create weapon_knife) shows
// the model the script gives it, on the ground and in hand, while the player's own knife
// always shows its inventory look. So a skin is given as a fresh knife: ent_create, then
// the ChangeSubclass input turns it into the skin's knife type (e.g. "507" = karambit,
// with the karambit's animations), then the skin model goes on, then it replaces the
// player's knife. The display knives on the knife wall are made the same way.

/** ent_create makes one entity at a time to tell them apart, so they are made in turn */
let knifeQueue = Promise.resolve();

/**
 * A copy of the source weapon behind point_template `name` (Hammer: gacha_tpl_<weapon>,
 * e.g. gacha_tpl_m4a4 -> a weapon_m4a1 named gacha_src_m4a4), lying at `pos`, or undefined.
 * Templates need no cheats and give the exact weapon right away.
 * @param {string} name
 * @param {Vector} pos
 */
function fromTemplate(name, pos) {
    const tpl = Instance.FindEntityByName(name);
    if (!(tpl instanceof PointTemplate)) return undefined;
    const made = (tpl.ForceSpawn(pos) ?? []).find((e) => e instanceof CSWeaponBase);
    if (!(made instanceof CSWeaponBase)) {
        Instance.Msg(`[gacha] ${name} spawned no weapon, falling back to ent_create`);
        return undefined;
    }
    handedOverAks.add(made);  // the bot-drop cleanup must leave it alone
    return made;
}

/**
 * A new entity of class `cls` made with ent_create, or undefined.
 * @param {string} cls
 * @returns {Promise<CSWeaponBase | undefined>}
 */
function entCreate(cls) {
    // The entity's class name can differ from the item name (ent_create weapon_usp_silencer
    // may make a weapon_hkp2000), so the new weapon is found as "any weapon that wasn't
    // there before and has no owner" (ent_create calls run one at a time).
    const allWeapons = () => new Set([...Instance.FindEntitiesByClass("weapon_*"), ...Instance.FindEntitiesByClass(cls)]);
    /** @type {Promise<CSWeaponBase | undefined>} */
    const job = knifeQueue.then(async () => {
        const before = allWeapons();
        Instance.ServerCommand(`ent_create ${cls}`);
        for (let i = 0; i < 20; i++) {
            await Instance.Delay(0.1);
            const made = [...allWeapons()].find((e) => !before.has(e) && e instanceof CSWeaponBase && !e.GetOwner());
            if (made instanceof CSWeaponBase) {
                handedOverAks.add(made);  // the bot-drop cleanup must leave it alone
                if (made.GetClassName() !== cls) Instance.Msg(`[gacha] ent_create ${cls} made a ${made.GetClassName()}`);
                return made;
            }
        }
        Instance.Msg(`[gacha] ent_create ${cls} made nothing`);
        return undefined;
    });
    knifeQueue = job.then(() => undefined, () => undefined);
    return job;
}

/**
 * A weapon wearing gacha skin `id`, lying at `pos`. AKs come from spawnAk, the
 * other weapons from ent_create (weapons the script makes show the model it sets).
 * @param {string} id
 * @param {Vector} pos
 * @param {CSPlayerPawn | undefined} pawn
 * @param {boolean} [forHand] it must be picked up by walking over it
 * @returns {Promise<CSWeaponBase | undefined>}
 */
async function makeSkinnedWeapon(id, pos, pawn, forHand = false) {
    const info = skinOfModelId(id);
    const cls = info ? WEAPON_INFO[weaponOf(info.skin)]?.cls : undefined;
    if (!cls) return undefined;
    // Weapons from map templates aren't picked up by walking over them, so a weapon that
    // has to land in the player's hands is made through a bot (a normal dropped weapon)
    const fromBot = forHand ? giveThroughBot(cls, WEAPON_INFO[weaponOf(/** @type {{ skin: string }} */ (info).skin)].slot) : undefined;
    const w = fromBot ?? (cls === "weapon_ak47" ? spawnAk(pos, pawn)
        : fromTemplate(`gacha_tpl_${weaponOf(/** @type {{ skin: string }} */ (info).skin)}`, pos) ?? await entCreate(cls));
    if (!w || !w.IsValid()) return undefined;
    w.Teleport({ position: pos, velocity: { x: 0, y: 0, z: 0 } });
    applySkinModel(w, modelPathOf(id));
    return w;
}

/**
 * A new knife of the skin's type wearing the skin's model, lying at `pos`, or undefined.
 * @param {string} sid
 * @param {Vector} pos
 * @returns {Promise<CSWeaponBase | undefined>}
 */
function makeSkinKnife(sid, pos) {
    /** @type {Promise<CSWeaponBase | undefined>} */
    const job = knifeQueue.then(async () => {
        /** @type {CSWeaponBase | undefined} */
        let knife = undefined;
        const before = new Set(Instance.FindEntitiesByClass("weapon_knife"));
        Instance.ServerCommand("ent_create weapon_knife");
        for (let i = 0; i < 20 && !knife; i++) {
            await Instance.Delay(0.1);
            const k = Instance.FindEntitiesByClass("weapon_knife").find((e) => !before.has(e));
            if (k instanceof CSWeaponBase) knife = k;
        }
        if (!(knife instanceof CSWeaponBase)) {
            Instance.Msg("[gacha] could not make a weapon_knife");
            return undefined;
        }
        handedOverAks.add(knife);  // the bot-drop cleanup must leave it alone
        const defIndex = KNIFE_DEF_INDEX[sid.split("_")[0]];
        if (defIndex) Instance.EntFireAtTarget({ target: knife, input: "ChangeSubclass", value: defIndex });
        await Instance.Delay(0.2);
        if (!knife.IsValid()) return undefined;
        knife.Teleport({ position: pos, velocity: { x: 0, y: 0, z: 0 } });
        keepKnifeModel(knife, `maps/gacha_knife/${sid}.vmdl`, sid);
        return knife;
    });
    knifeQueue = job.then(() => undefined, () => undefined);
    return job;
}

/**
 * Replaces the player's knife with knife skin `sid` (e.g. "karambit_doppler").
 * Resolves true once the new knife exists; on failure nothing is changed.
 * @param {CSPlayerPawn} pawn
 * @param {string} sid
 * @returns {Promise<boolean>}
 */
async function giveKnife(pawn, sid) {
    const at = pawn.GetAbsOrigin();
    const knife = await makeSkinKnife(sid, { x: at.x, y: at.y, z: at.z + 8 });
    if (!knife || !pawn.IsValid() || !pawn.IsAlive()) {
        if (knife) knife.Remove();
        setResult("Could not create the knife, nothing was spent (see console)");
        return false;
    }
    // Only now free the knife slot, then put the new knife on the player so it is picked up
    const current = pawn.FindWeaponBySlot(CSGearSlot.KNIFE);
    if (current && current !== knife) pawn.DestroyWeapon(current);
    const now = pawn.GetAbsOrigin();
    knife.Teleport({ position: { x: now.x, y: now.y, z: now.z + 8 }, velocity: { x: 0, y: 0, z: 0 } });

    Instance.Delay(0.3).then(() => {
        if (!knife.IsValid()) { Instance.Msg(`[gacha] knife ${sid} vanished`); return; }
        const owner = knife.GetOwner();
        Instance.Msg(`[gacha] knife ${sid}: ${owner === pawn ? "in your hands" : owner ? "held by someone else" : "on the ground"}, model ${knife.GetModelName()}`);
        if (owner === pawn) pawn.SwitchToWeapon(knife);
        else setResult("Your new knife is at your feet: press E to pick it up", RARITIES[RARITIES.length - 1].color);
    });
    return true;
}

/**
 * The game may put the knife type's own model back a moment after a subclass change
 * or a pickup: for a few seconds, and after every pickup, put the skin model back on.
 * @param {CSWeaponBase} knife
 * @param {string} model
 * @param {string} sid
 */
function keepKnifeModel(knife, model, sid) {
    knife.SetModel(model);
    let resets = 0;
    const check = () => {
        if (!knife.IsValid()) return;
        const now = knife.GetModelName();
        if (now !== model) {
            if (resets++ < 3) Instance.Msg(`[gacha] knife ${sid}: model was reset to ${now}, re-applying`);
            knife.SetModel(model);
        }
    };
    for (let t = 0.1; t <= 3; t += 0.1) Instance.Delay(t).then(check);
    Instance.ConnectOutput(knife, "OnPlayerPickup", () => {
        for (const t of [0.05, 0.2, 0.5, 1]) Instance.Delay(t).then(check);
    });
}

// ---------------------------------------------------------------------------
// Knife wall: like the AK wall. The prop_dynamic knives placed in Hammer (models in
// maps/gacha_knife) only mark the layout; when the map loads their position and
// angles are recorded and the props removed. Each owned knife skin then gets a
// display knife there: made like a given knife, frozen, not pickable.
// ---------------------------------------------------------------------------

/** @type {Map<string, { pos: Vector, angles: QAngle }>} */
const knifeSlots = new Map();
/** @type {Map<string, CSWeaponBase>} */
const displayKnives = new Map();
let knifeWallBusy = false;
let knifeWallAgain = false;

/** @param {Entity} ent */
function isDisplayKnife(ent) {
    for (const k of displayKnives.values()) if (k === ent) return true;
    return false;
}

async function refreshKnifeWall() {
    updateKnifeText();
    if (knifeWallBusy) { knifeWallAgain = true; return; }
    knifeWallBusy = true;
    try {
        do {
            knifeWallAgain = false;
            for (const [sid, k] of [...displayKnives]) {
                if (!k.IsValid()) displayKnives.delete(sid);
                else if (!knives.includes(sid)) { k.Remove(); displayKnives.delete(sid); }
            }
            const missing = [...knifeSlots.keys()].filter((sid) => knives.includes(sid) && !displayKnives.has(sid) && !wallFailed.has(sid));
            for (const sid of missing) {
                const slot = /** @type {{ pos: Vector, angles: QAngle }} */ (knifeSlots.get(sid));
                const k = await makeSkinKnife(sid, slot.pos) ?? await makeSkinKnife(sid, slot.pos);
                if (!k) {  // not retried every refresh
                    wallFailed.add(sid);
                    Instance.Msg(`[gacha] knife wall: could not make ${sid}, skipped until the map reloads (aimx showcase retries)`);
                    continue;
                }
                k.Teleport({ position: slot.pos, angles: slot.angles, velocity: { x: 0, y: 0, z: 0 } });
                k.SetMoveType(CSMoveType.NONE);
                Instance.EntFireAtTarget({ target: k, input: "ToggleCanBePickedUp" });
                displayKnives.set(sid, k);
            }
            if (knifeSlots.size > 0) Instance.Msg(`[gacha] knife wall: ${displayKnives.size} shown, ${knifeSlots.size} slots, ${knives.length} owned`);
        } while (knifeWallAgain);
    } catch (e) {
        Instance.Msg(`[gacha] ERROR in knife wall: ${e}`);
    } finally {
        knifeWallBusy = false;
    }
}

// knife_test [skin]   lays knives with the skin on the ground in front of you and traces them:
//   A = your own knife (model only), B = your knife after ChangeSubclass, C = a new weapon_knife
//   from ent_create. Look at each one on the ground, then pick them up (E) one by one.
adminCommand("knife_test", async (args) => {
    const sid = findKnifeSkin(argWords("knife_test", args).join("") || "m9_tigertooth", KNIFE_SKINS);
    const pawn = findPresser(undefined);
    if (!sid || !pawn) return;
    const model = `maps/gacha_knife/${sid}.vmdl`;
    const eye = pawn.GetEyePosition(), dir = forwardFromAngles({ ...pawn.GetEyeAngles(), pitch: 0 });
    const side = { x: -dir.y, y: dir.x };
    /** @param {number} k */
    const spot = (k) => ({ x: eye.x + dir.x * 70 + side.x * 24 * k, y: eye.y + dir.y * 70 + side.y * 24 * k, z: eye.z - 30 });
    /** @param {CSWeaponBase} knife @param {string} label @param {number} k */
    const lay = (knife, label, k) => {
        handedOverAks.add(knife);
        if (knife.GetOwner()) pawn.DropWeapon(knife);
        knife.SetModel(model);
        knife.Teleport({ position: spot(k), velocity: { x: 0, y: 0, z: 0 } });
        keepKnifeModel(knife, model, `${sid} [${label}]`);
        for (const t of [0.5, 2]) Instance.Delay(t).then(() => Instance.Msg(`[gacha] knife_test ${label} after ${t}s: ${knife.IsValid() ? `model ${knife.GetModelName()}, ${knife.GetOwner() ? "held" : "on the ground"}` : "REMOVED"}`));
    };

    // A: your own knife, model only
    const own = pawn.FindWeaponBySlot(CSGearSlot.KNIFE);
    if (own) lay(own, "A own knife", -1);
    else Instance.Msg("[gacha] knife_test A: you have no knife");

    // C: a fresh weapon_knife from ent_create (made first so B can reuse its subclass test)
    const before = new Set(Instance.FindEntitiesByClass("weapon_knife"));
    Instance.ServerCommand("ent_create weapon_knife");
    let fresh = undefined;
    for (let i = 0; i < 10 && !fresh; i++) {
        await Instance.Delay(0.1);
        fresh = Instance.FindEntitiesByClass("weapon_knife").find((e) => !before.has(e) && e !== own);
    }
    if (fresh instanceof CSWeaponBase) {
        lay(fresh, "C ent_create weapon_knife", 1);
        // B: the same kind of fresh knife, switched to the skin's knife type
        const before2 = new Set(Instance.FindEntitiesByClass("weapon_knife"));
        Instance.ServerCommand("ent_create weapon_knife");
        let fresh2 = undefined;
        for (let i = 0; i < 10 && !fresh2; i++) {
            await Instance.Delay(0.1);
            fresh2 = Instance.FindEntitiesByClass("weapon_knife").find((e) => !before2.has(e));
        }
        if (fresh2 instanceof CSWeaponBase) {
            const defIndex = KNIFE_DEF_INDEX[sid.split("_")[0]];
            if (defIndex) Instance.EntFireAtTarget({ target: fresh2, input: "ChangeSubclass", value: defIndex });
            await Instance.Delay(0.2);
            if (fresh2.IsValid()) lay(fresh2, "B ent_create + ChangeSubclass", 0);
        }
    } else {
        Instance.Msg("[gacha] knife_test C: ent_create weapon_knife made nothing");
    }
    Instance.Msg("[gacha] knife_test: knives laid out left (A), middle (B), right (C)");
});



// The game gives the loadout knife back on every respawn: put the equipped skin back on
Instance.OnPlayerReset(({ player }) => {
    if (!equippedKnife || !isHumanPawn(player)) return;
    Instance.Delay(0.5).then(() => {
        if (player.IsValid() && player.IsAlive()) giveKnife(player, equippedKnife);
    });
});

// knife_give karambit_doppler   give (and own) a knife skin; part of the name is enough
adminCommand("knife_give", (args) => {
    const sid = findKnifeSkin(argWords("knife_give", args).join(""), KNIFE_SKINS);
    const pawn = findPresser(undefined);
    if (!sid || !pawn) return;
    giveKnife(pawn, sid).then((ok) => {
        if (!ok) return;
        if (!knives.includes(sid)) knives.push(sid);
        setLatest(`knife:${sid}`);
        equippedKnife = sid;
        saveProgress();
        refreshKnifeWall();
    });
});

// knife_off   stop re-equipping the gacha knife (your own knife comes back on respawn)
adminCommand("knife_off", () => {
    equippedKnife = "";
    saveProgress();
    Instance.Msg("[gacha] gacha knife unequipped (back to your own knife after respawning)");
});

/**
 * The one knife skin matching `query` (exact, else part of the name), or undefined with a message.
 * @param {string} query
 * @param {string[]} pool
 */
function findKnifeSkin(query, pool) {
    const q = normalizeName(query);
    const exact = pool.filter((k) => normalizeName(k) === q);
    const matches = exact.length > 0 ? exact : pool.filter((k) => normalizeName(k).includes(q));
    if (q && matches.length === 1) return matches[0];
    Instance.Msg(`[gacha] ${matches.length > 1 && q ? "matches " + matches.join(", ") : "choose from: " + pool.join(", ")}`);
    return undefined;
}

// knives   list every knife skin; * = owned, > = equipped
adminCommand("knives", () => {
    for (const knifeType of Object.keys(KNIFE_CLASS)) {
        const list = KNIFE_SKINS.filter((k) => k.startsWith(knifeType + "_"))
            .map((k) => `${k === equippedKnife ? ">" : ""}${knives.includes(k) ? "*" : ""}${k} (${KNIFE_TITLES[knifeBaseName(k)] ?? "-"})`);
        Instance.Msg(`[gacha] ${knifeType} (${KNIFE_CLASS[knifeType]}): ${list.join(", ")}`);
    }
    Instance.Msg(`[gacha] owned ${knives.length}/${KNIFE_SKINS.length}, tickets ${knifeTickets}, progress ${knifeProgress}/${KNIFE_EVERY}`);
});

// knife_equip m9_sapphire   switch to a knife skin you own
adminCommand("knife_equip", (args) => {
    if (knives.length === 0) { Instance.Msg("[gacha] no knife owned yet"); return; }
    const sid = findKnifeSkin(argWords("knife_equip", args).join(""), knives);
    const pawn = findPresser(undefined);
    if (!sid || !pawn) return;
    giveKnife(pawn, sid).then((ok) => {
        if (!ok) return;
        equippedKnife = sid;
        saveProgress();
    });
});

// knife_take karambit_doppler   remove a knife skin from the collection
adminCommand("knife_take", (args) => {
    const sid = findKnifeSkin(argWords("knife_take", args).join(""), knives);
    if (!sid) return;
    knives = knives.filter((k) => k !== sid);
    if (equippedKnife === sid) equippedKnife = "";
    saveProgress();
    refreshKnifeWall();
    Instance.Msg(`[gacha] ${sid} removed${equippedKnife ? "" : " (back to your own knife after respawning)"}`);
});

// knife_reset   forget every knife skin, tickets and progress
adminCommand("knife_reset", () => {
    knives = [];
    equippedKnife = "";
    knifeTickets = 0;
    knifeProgress = 0;
    saveProgress();
    updateKnifeText();
    refreshKnifeWall();
    Instance.Msg("[gacha] knives, tickets and progress cleared");
});

// knife_progress 9   set the SR+ roll count towards the next ticket
adminCommand("knife_progress", (args) => {
    const n = parseAmount(args);
    if (n !== undefined) {
        knifeProgress = Math.max(0, Math.min(KNIFE_EVERY - 1, n));
        saveProgress();
        updateKnifeText();
    }
    Instance.Msg(`[gacha] knife progress ${knifeProgress}/${KNIFE_EVERY}`);
});

// knife_tickets [n]  show or set knife tickets
adminCommand("knife_tickets", (args) => {
    const n = parseAmount(args);
    if (n !== undefined) {
        knifeTickets = Math.max(0, n);
        saveProgress();
        updateKnifeText();
    }
    Instance.Msg(`[gacha] knife tickets: ${knifeTickets}, progress ${knifeProgress}/${KNIFE_EVERY}`);
});

adminCommand("coins", (args) => {
    const n = parseAmount(args);
    if (n !== undefined) {
        coins = Math.max(0, n);
        saveProgress();
        updateCoinsText();
    }
    Instance.Msg(`[gacha] coins: ${coins}`);
});

adminCommand("addcoins", (args) => {
    coins = Math.max(0, coins + (parseAmount(args) ?? 0));
    saveProgress();
    updateCoinsText();
    Instance.Msg(`[gacha] coins: ${coins}`);
});

adminCommand("clear", () => clearDroppedWeapons());

// Debug: test_ak template|bot|player [plain] — makes one AK in front of you and
// traces it for 5 s. "plain" skips the skin model and glow, to see if those matter.
adminCommand("test_ak", (args) => {
    const [mode, plain] = argWords("test_ak", args);
    if (mode !== "template" && mode !== "bot" && mode !== "player") {
        Instance.Msg("[gacha] usage: test_ak template|bot|player [plain]");
        return;
    }
    const pawn = findPresser(undefined);
    if (!pawn) return;
    const eye = pawn.GetEyePosition(), dir = forwardFromAngles(pawn.GetEyeAngles());
    const pos = { x: eye.x + dir.x * 64, y: eye.y + dir.y * 64, z: eye.z };
    const saved = akSource;
    akSource = mode;
    const ak = spawnAk(pos, pawn);
    akSource = saved;
    if (!ak) { Instance.Msg("[gacha] test: no AK was made"); return; }
    if (plain !== "plain") {
        ak.SetModel("maps/gacha_ak/c_ak_cyberpunk.vmdl");
        ak.Glow(WHITE);
    }
    const label = `test ${mode}${plain === "plain" ? " plain" : ""}`;
    traceAk(ak, label);
    Instance.Delay(5).then(() => Instance.Msg(`[gacha] trace ${label} after 5s: ${ak.IsValid() ? "still there" : "REMOVED"}`));
});

// Debug: ak_source auto|template|bot|player — then rebuild the wall with it
adminCommand("ak_source", (args) => {
    const [mode] = argWords("ak_source", args);
    if (mode === "auto" || mode === "template" || mode === "bot" || mode === "player") {
        akSource = mode;
        templateBroken = false;
        for (const ak of displayAks.values()) if (ak.IsValid()) ak.Remove();
        displayAks.clear();
        refreshShowcase();
    }
    Instance.Msg(`[gacha] AK source: ${akSource}  (auto | template | bot | player)`);
});

// reset_all confirm   back to a fresh start: no skins, knives, coins, kills, tickets, rate-ups
// give_all          own every gun skin and every knife skin (nothing is dropped)
// give_all guns     only the gun skins      give_all knives   only the knife skins
adminCommand("give_all", (args) => {
    const [what] = argWords("give_all", args);
    let added = 0;
    if (what !== "knives") {
        for (const r of RARITIES) {
            for (const skin of SKINS[r.id]) {
                if (!hasSkin(r.id, skin)) { inventory.push({ skin, rarity: r.id }); added++; }
            }
        }
    }
    if (what !== "guns") {
        for (const k of KNIFE_SKINS) if (!knives.includes(k)) { knives.push(k); added++; }
    }
    saveProgress();
    updateCoinsText();
    updateKnifeText();
    refreshShowcase();  // fills the AK, weapon and knife walls
    Instance.Msg(`[gacha] ${added} skins added: ${uniqueSkinCount()}/${TOTAL_SKINS} gun skins, ${knives.length}/${KNIFE_SKINS.length} knives`);
});

adminCommand("reset_all", (args) => {
    const [word] = argWords("reset_all", args);
    if (word !== "confirm") {
        Instance.Msg("[gacha] this wipes ALL progress (skins, knives, coins, kills, knife tickets, rate-up level). Type: reset_all confirm");
        return;
    }
    inventory = [];
    knives = [];
    equippedKnife = "";
    coins = 0;
    kills = 0;
    knifeTickets = 0;
    knifeProgress = 0;
    setBoostLevel(0);
    saveProgress();
    updateCoinsText();
    updateRatesText();
    updateKnifeText();
    refreshShowcase();  // the AK wall and the knife wall
    setResult("Progress reset");
    Instance.Msg("[gacha] everything reset to a fresh start");
});

adminCommand("reset_skins", () => {
    inventory = [];
    saveProgress();
    updateCoinsText();
    refreshShowcase();
    Instance.Msg("[gacha] collected skins cleared");
});

function printRates() {
    Instance.Msg(`[gacha] rates: ${ratesLine()}`);
    Instance.Msg(`[gacha] ${boostLine()}`);
}

adminCommand("rates", () => printRates());

adminCommand("rate", (args) => {
    const [key, value] = argWords("rate", args);
    const rarity = RARITIES.find((r) => r.prefix === key?.toLowerCase());
    const v = parseFloat(value ?? "");
    if (!rarity || rarity.id === "Common" || !Number.isFinite(v) || v < 0) {
        Instance.Msg("[gacha] usage: rate <r|sr|ur|l> <percent>   (Common is whatever is left)");
        return;
    }
    const others = Object.entries(rates).filter(([id]) => id !== rarity.id).reduce((a, [, x]) => a + x, 0);
    if (others + v > 100) {
        Instance.Msg(`[gacha] too high: the other rarities already take ${pct(others)}, max for ${rarity.id} is ${pct(100 - others)}`);
        return;
    }
    rates[rarity.id] = v;
    updateRatesText();
    printRates();
});

adminCommand("boost", (args) => {
    const [value] = argWords("boost", args);
    const n = parseInt(value ?? "", 10);
    if (Number.isFinite(n)) {
        setBoostLevel(n);
        saveProgress();
        updateRatesText();
    }
    printRates();
});

adminCommand("rates_reset", () => {
    setBoostLevel(0);
    saveProgress();
    updateRatesText();
    printRates();
});

adminCommand("skins", () => {
    for (const r of RARITIES) Instance.Msg(`[gacha] ${r.prefix.toUpperCase()}: ${SKINS[r.id].join(", ")}`);
});

/** @param {string} s */
const normalizeName = (s) => s.toLowerCase().replace(/[\s_\-]/g, "");

adminCommand("give", (args) => {
    const query = normalizeName(argWords("give", args).join(""));
    if (!query) {
        Instance.Msg("[gacha] usage: give <skin name>   (skins lists them)");
        return;
    }
    /** @type {{ rarity: typeof RARITIES[number], skin: string }[]} */
    const all = RARITIES.flatMap((rarity) => SKINS[rarity.id].map((skin) => ({ rarity, skin })));
    const exact = all.filter((s) => normalizeName(s.skin) === query);
    const matches = exact.length > 0 ? exact : all.filter((s) => normalizeName(s.skin).includes(query));
    if (matches.length === 0) {
        Instance.Msg(`[gacha] no skin matches "${query}" (skins lists them)`);
        return;
    }
    if (matches.length > 1) {
        Instance.Msg(`[gacha] "${query}" matches ${matches.length} skins: ${matches.map((s) => s.skin).join(", ")}`);
        return;
    }
    const { rarity, skin } = matches[0];
    giveSkin(rarity, skin, undefined, undefined);
    Instance.Msg(`[gacha] gave ${rarity.id}: ${skin}`);
});
