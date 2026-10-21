# aim_trainer_gatcha

[English](#english) | [日本語](#日本語)

---

## English

A Counter-Strike 2 Workshop aim-training map with a gacha (capsule toy) twist.
Kill bots to earn coins, spend coins to roll for weapon skins, raise the drop rates,
collect skins on showcase walls, and shoot a skin on the wall to equip it.
Knife skins are earned along the way.

Everything runs on CS2's `cs_script` (`point_script`) JavaScript API.

### Features

- **Aim training** – strafing bots on the CT side (`aimbot_map.js`), spawning at random inside an
  area. You play on T.
- **Coins** – every bot you kill gives 1 coin. A roll costs `COST` coins (1).
- **Gacha** – the gacha button rolls a gun skin (AK-47, M4A4, M4A1-S, AWP, Desert Eagle, USP-S).
  The skinned gun drops at the drop point and glows in the rarity color.
  Common rolls hand out a Common skin you don't own yet while there is one.
- **Rarities and rate-up** – the rate-up button raises the rarer rates in 30 steps
  (40 → 220 coins per step, 4030 in all):

  | Rarity | Start | Max level | Color | Material |
  |---|---|---|---|---|
  | Common | 83.5% | 9.35% (never below 8%) | white | matte paint |
  | Rare | 10% | 23.16% | green | matte paint |
  | Super Rare | 5% | 24.41% | blue | glossy |
  | Ultra Rare | 1% | 23.08% | yellow | metallic, near mirror |
  | Legendary | 0.5% | 20% | red | metallic + rainbow sheen + glitter |

  Texture names ending in `_n` keep their rarity but get no material effects.
- **Knives** – every 20 rolls of Super Rare or better earn a knife ticket; the knife button draws a
  knife skin you don't own yet (5 knife types, 30 skins). The knife is switched to the right type
  with the `ChangeSubclass` input, so it has that knife's animations.
- **Showcase walls** – each owned skin is shown on the gun wall / knife wall (Legendary guns are
  always shown). Shoot one with any gun to equip it: the gun goes into its slot (rifle or pistol);
  your own gun is kept aside and comes back when you shoot the same skin again.
- **Shop** – a button named after a Legendary skin buys it for `BUY_PRICE` coins (500).
- **Saved progress** – skins, knives, coins, kills, knife tickets and the rate-up level are saved
  (the equipped knife only for the session).

### Repository layout

| Path | What it is |
|---|---|
| `maps/scripts/aim_gacha.js` | Gacha, coins, rate-up, walls, shoot-to-equip, knives, shop, admin commands |
| `maps/scripts/aimbot_map.js` | Bot setup, strafing, random spawn area |
| `maps/scripts/tsconfig.json` | Editor settings for type checking |
| `gen_gacha_ak.ps1` | AK skins: one model + material per texture in `maps/skin_texture/` |
| `gen_gacha_weapon.py` | Other guns: textures in `maps/weapon_texture/` (`SPECIAL` = per-skin effects) |
| `gen_gacha_knife.py` | Knives: textures in `maps/knife_texture/` (`_rb` `_pl` `_gl` `_ed` `_rl` effect tiers) |
| `make_relief.py` | Embossed silver + pearl sheen for one AK skin |
| `cfg/maps/aim_trainer_gatcha.cfg` | Convars run before the map loads (copy to the `game` side) |

Not included: the Hammer map, skin textures, decompiled Valve meshes and all compiled files.

### Setup

1. Create an addon named `aim_trainer_gatcha` in CS2 Workshop Tools and put this repository in
   `Counter-Strike Global Offensive/content/csgo_addons/aim_trainer_gatcha/`.
2. Copy `cfg/maps/aim_trainer_gatcha.cfg` to
   `Counter-Strike Global Offensive/game/csgo_addons/aim_trainer_gatcha/cfg/maps/`.
3. For editor type checking, copy `point_script.d.ts` from
   `content/csgo_addons/cs_script_demo/maps/scripts/` into `maps/scripts/` (Valve's file, not in this repository).
4. Decompile the official models with Source 2 Viewer (`game/csgo/pak01_dir.vpk`, **Decompile & export**):
   - AK: `weapons/models/ak47/weapon_rif_ak47.vmdl_c` → `.dmx` files into `maps/gacha_ak/`, the `.vmdl` as
     `maps/gacha_ak/_original_weapon_rif_ak47.vmdl.txt`
   - other guns (`weapon_rif_m4a4`, `weapon_rif_m4a1_silencer`, `weapon_snip_awp`, `weapon_pist_deagle`,
     `weapon_pist_usp_silencer`) → `.vmdl` + `.dmx` into `maps/gacha_weapon/base/`
   - knives (`weapon_knife_<type>`) → `.vmdl` + `.dmx` into `maps/gacha_knife/base/`
5. Put the textures in place (painted on the **legacy (CS:GO) UV layout**) and run the generators
   with **CS2 closed** (two compilers writing the same texture corrupt it):
   ```bash
   powershell -ExecutionPolicy Bypass -File gen_gacha_ak.ps1 -Compile
   python gen_gacha_weapon.py --compile
   python gen_gacha_knife.py --compile
   ```
   The generators keep the skin lists in `aim_gacha.js` up to date.
6. Build the map in Hammer with the entities below.

### Hammer entities

| Entity | Name | Notes |
|---|---|---|
| `point_script` | `gacha_script` | `maps/scripts/aim_gacha.js` |
| `point_script` | `main_script` | `maps/scripts/aimbot_map.js` |
| `point_template` + `weapon_ak47` | `gacha_ak_template` / `gacha_ak_src` | source of the skinned AKs |
| `point_template` + weapon | `gacha_tpl_<m4a4\|m4a1_s\|awp\|deagle\|usp_s>` / `gacha_src_…` | source of the other guns |
| `info_target` | `gacha_drop_point` | where rolled guns drop |
| `info_target` × 2 | `bot_area_a`, `bot_area_b` | opposite corners of the bot spawn area |
| `func_button` | any | `OnPressed` → `gacha_script` → `RunScriptInput` → `gacha` / `boost` / `knife` / `clear_weapons` |
| `func_button` | `<skin>_button` | `RunScriptInput` → `buy` (Legendary skins only) |
| `point_worldtext` | `coins_text`, `result_text`, `rates_text`, `boost_text`, `knife_text`, `knife_count`, `count_c` … `count_l` | status texts |
| `point_worldtext` | `<skin>_text` | Legend / skin name / Owned or Buy |
| `prop_dynamic` × skins | any | model `maps/gacha_ak/…`, `maps/gacha_weapon/…` or `maps/gacha_knife/…`; marks that skin's place on a wall |

### Admin console command

All test commands live under one password-locked console command defined in `aim_gacha.js`
(`ADMIN_COMMAND`); only a hash of the password is used. Log in with `<command> login <password>`,
then e.g. `coins 500`, `give <skin>`, `give_all`, `knife_give <skin>`, `boost 10`, `rate sr 12`,
`reset_all confirm`, `showcase`, `area a|b|off`. Change the password by running `<command> hash <new>`
and putting the number into `.env` as `AIMX_PASSWORD_HASH=<number>`.

The hash is kept out of the repository: `.env` is not committed, and a git filter
(`secret_filter.py`, set up by `.gitattributes`) stores `ADMIN_PASSWORD_HASH = 0` on commit and puts the
`.env` value back on checkout. Once per clone:

```bash
git config filter.adminhash.clean "python secret_filter.py clean"
git config filter.adminhash.smudge "python secret_filter.py smudge"
```

Custom skins only exist inside this map; they are not real CS2 inventory items.

---

## 日本語

ガチャ要素付きの Counter-Strike 2 ワークショップ用エイム練習マップです。
bot を倒してコインを集め、コインで武器スキンのガチャを回し、排出率を上げ、
手に入れたスキンをショーケースの壁に並べ、壁のスキンを撃つとそのスキンを装備できます。
ナイフスキンも集められます。

すべて CS2 の `cs_script`（`point_script`）JavaScript API で動いています。

### 機能

- **エイム練習** – CT 側で左右に動く bot（`aimbot_map.js`）。指定範囲内のランダムな位置に出現。プレイヤーは T 側。
- **コイン** – bot を 1 体倒すごとに 1 コイン。ガチャ 1 回は `COST` コイン（1）。
- **ガチャ** – ガチャボタンで銃スキン（AK-47、M4A4、M4A1-S、AWP、Desert Eagle、USP-S）を抽選。
  スキン付きの銃がドロップ地点に落ち、レアリティの色で光ります。
  Common が出たときは、未所持の Common スキンがある限りそこから選ばれます。
- **レアリティと確率アップ** – 確率アップボタンで高レアの確率を 30 段階で上げられます
  （1 段 40〜220 コイン、合計 4030）：

  | レアリティ | 初期 | 最大レベル | 色 | 質感 |
  |---|---|---|---|---|
  | Common | 83.5% | 9.35%（8% 未満にはならない） | 白 | マット塗装 |
  | Rare | 10% | 23.16% | 緑 | マット塗装 |
  | Super Rare | 5% | 24.41% | 青 | ツヤあり |
  | Ultra Rare | 1% | 23.08% | 黄 | 高メタリック・ほぼ鏡面 |
  | Legendary | 0.5% | 20% | 赤 | メタリック＋虹色の光沢＋ラメ |

  テクスチャ名が `_n` で終わるものはレアリティはそのままで、質感の特殊効果なし。
- **ナイフ** – Super Rare 以上を 20 回引くごとにナイフチケット 1 枚。ナイフボタンで未所持のナイフスキンを
  抽選（5 種類、30 スキン）。`ChangeSubclass` 入力でナイフの種類を切り替えるので、そのナイフのモーションになります。
- **ショーケースの壁** – 所持スキンが銃の壁／ナイフの壁に並びます（Legendary の銃は常に表示）。
  どの銃で撃っても装備でき、ライフル枠かピストル枠に入ります。元の銃は保管され、同じスキンをもう一度撃つと戻ります。
- **ショップ** – Legendary スキン名のボタンで、そのスキンを `BUY_PRICE` コイン（500）で購入。
- **セーブ** – スキン、ナイフ、コイン、キル数、ナイフチケット、確率アップのレベルを保存
  （装備中のナイフはそのセッションのみ）。

### リポジトリ構成

| パス | 内容 |
|---|---|
| `maps/scripts/aim_gacha.js` | ガチャ、コイン、確率アップ、壁、撃って装備、ナイフ、ショップ、管理コマンド |
| `maps/scripts/aimbot_map.js` | bot の設定、左右移動、出現範囲 |
| `maps/scripts/tsconfig.json` | エディタの型チェック設定 |
| `gen_gacha_ak.ps1` | AK スキン：`maps/skin_texture/` のテクスチャごとにモデルとマテリアルを生成 |
| `gen_gacha_weapon.py` | その他の銃：`maps/weapon_texture/` のテクスチャ（`SPECIAL` でスキン個別の効果） |
| `gen_gacha_knife.py` | ナイフ：`maps/knife_texture/` のテクスチャ（効果は `_rb` `_pl` `_gl` `_ed` `_rl`） |
| `make_relief.py` | AK スキン 1 つに銀色部分の浮き彫り＋パール光沢を付ける |
| `cfg/maps/aim_trainer_gatcha.cfg` | マップ読み込み前に実行される設定（`game` 側へコピー） |

含まれていないもの：Hammer のマップ、スキンテクスチャ、デコンパイルした Valve のメッシュ、コンパイル済みファイル。

### セットアップ

1. CS2 Workshop Tools で `aim_trainer_gatcha` という addon を作り、このリポジトリを
   `Counter-Strike Global Offensive/content/csgo_addons/aim_trainer_gatcha/` に置く。
2. `cfg/maps/aim_trainer_gatcha.cfg` を
   `Counter-Strike Global Offensive/game/csgo_addons/aim_trainer_gatcha/cfg/maps/` にコピー。
3. エディタで型チェックする場合は、`content/csgo_addons/cs_script_demo/maps/scripts/` の
   `point_script.d.ts` を `maps/scripts/` にコピー（Valve のファイルなのでリポジトリには含めていません）。
4. Source 2 Viewer で公式モデルをデコンパイル（`game/csgo/pak01_dir.vpk`、**Decompile & export**）：
   - AK：`weapons/models/ak47/weapon_rif_ak47.vmdl_c` → `.dmx` を `maps/gacha_ak/` に、`.vmdl` を
     `maps/gacha_ak/_original_weapon_rif_ak47.vmdl.txt` として置く
   - その他の銃（`weapon_rif_m4a4`、`weapon_rif_m4a1_silencer`、`weapon_snip_awp`、`weapon_pist_deagle`、
     `weapon_pist_usp_silencer`）→ `.vmdl` と `.dmx` を `maps/gacha_weapon/base/` に
   - ナイフ（`weapon_knife_<種類>`）→ `.vmdl` と `.dmx` を `maps/gacha_knife/base/` に
5. テクスチャ（**旧（CS:GO）の UV レイアウト**で描いたもの）を置き、**CS2 を閉じた状態で**ジェネレーターを実行
   （2 つのコンパイラーが同じテクスチャを書くと壊れるため）：
   ```bash
   powershell -ExecutionPolicy Bypass -File gen_gacha_ak.ps1 -Compile
   python gen_gacha_weapon.py --compile
   python gen_gacha_knife.py --compile
   ```
   ジェネレーターが `aim_gacha.js` のスキン一覧も更新します。
6. 下記のエンティティを配置して Hammer でマップをビルド。

### Hammer のエンティティ

| エンティティ | 名前 | 備考 |
|---|---|---|
| `point_script` | `gacha_script` | `maps/scripts/aim_gacha.js` |
| `point_script` | `main_script` | `maps/scripts/aimbot_map.js` |
| `point_template` + `weapon_ak47` | `gacha_ak_template` / `gacha_ak_src` | スキン付き AK の元 |
| `point_template` + 武器 | `gacha_tpl_<m4a4\|m4a1_s\|awp\|deagle\|usp_s>` / `gacha_src_…` | その他の銃の元 |
| `info_target` | `gacha_drop_point` | ガチャの銃が落ちる位置 |
| `info_target` × 2 | `bot_area_a`、`bot_area_b` | bot の出現範囲の対角 |
| `func_button` | 任意 | `OnPressed` → `gacha_script` → `RunScriptInput` → `gacha` / `boost` / `knife` / `clear_weapons` |
| `func_button` | `<スキン>_button` | `RunScriptInput` → `buy`（Legendary のみ） |
| `point_worldtext` | `coins_text`、`result_text`、`rates_text`、`boost_text`、`knife_text`、`knife_count`、`count_c` … `count_l` | 状態表示 |
| `point_worldtext` | `<スキン>_text` | Legend／スキン名／Owned または Buy |
| `prop_dynamic` × スキン数 | 任意 | モデル `maps/gacha_ak/…`、`maps/gacha_weapon/…`、`maps/gacha_knife/…`。壁のそのスキンの位置を示す |

### 管理コマンド

テスト用コマンドはすべて、`aim_gacha.js` で定義したパスワード付きのコンソールコマンド（`ADMIN_COMMAND`）
にまとめています。保存しているのはパスワードのハッシュだけです。`<コマンド> login <パスワード>` でログインし、
`coins 500`、`give <スキン>`、`give_all`、`knife_give <スキン>`、`boost 10`、`rate sr 12`、`reset_all confirm`、
`showcase`、`area a|b|off` などを使います。パスワードを変えるには `<コマンド> hash <新しいパスワード>` を実行し、
表示された数字を `.env` に `AIMX_PASSWORD_HASH=<数字>` として書きます。

ハッシュはリポジトリに含めません。`.env` はコミットされず、git のフィルター（`secret_filter.py`、
`.gitattributes` で指定）がコミット時に `ADMIN_PASSWORD_HASH = 0` にし、チェックアウト時に `.env` の値を戻します。
クローンごとに 1 回：

```bash
git config filter.adminhash.clean "python secret_filter.py clean"
git config filter.adminhash.smudge "python secret_filter.py smudge"
```

自作スキンはこのマップ内だけのもので、CS2 の本物のインベントリアイテムではありません。
