# aim_trainer_gatcha

[English](#english) | [日本語](#日本語)

---

## English

A Counter-Strike 2 Workshop aim-training map with a gacha (capsule toy) twist.
Kill bots to earn coins, spend coins to roll for AK-47 skins, collect them on a
showcase wall, and shoot a skin on the wall to equip it.

Everything runs on CS2's `cs_script` (`point_script`) JavaScript API.

### Features

- **Aim training** – strafing bots on the CT side (`aimbot_map.js`). You play on T.
- **Coins** – every bot you kill gives 1 coin.
- **Gacha** – press the gacha button to spend coins and roll a skin. A usable AK-47
  with that skin drops next to the button and glows in the rarity color.
- **Rarities** – the result text and glow use the rarity color:

  | Rarity | Chance | Color | Material |
  |---|---|---|---|
  | Common | 52.5% | white | matte paint |
  | Rare | 20% (1/5) | green | matte paint |
  | Super Rare | 12.5% (1/8) | blue | glossy |
  | Ultra Rare | 10% (1/10) | yellow | metallic, near mirror |
  | Legendary | 5% (1/20) | red | metallic + rainbow sheen + glitter |

- **Collection** – the wall text shows `Skins: collected/total`; duplicates count once
  and new pulls are marked `NEW!`. Nothing is saved: coins and skins reset when the map closes.
- **Showcase wall** – each collected skin appears on the wall as a frozen AK.
- **Shoot to equip** – shoot a skin on the wall with your AK and you get a new AK with that skin
  (ammo is kept).
- **Clear button** – removes every weapon lying on the ground (the wall stays).

### Repository layout

| Path | What it is |
|---|---|
| `maps/scripts/aim_gacha.js` | Gacha, coins, showcase wall, shoot-to-equip, test commands |
| `maps/scripts/aimbot_map.js` | Bot setup and strafing movement |
| `maps/scripts/tsconfig.json` | Editor settings for type checking |
| `gen_gacha_ak.ps1` | Generates one skinned AK model + material per skin texture |
| `cfg/maps/aim_trainer_gatcha.cfg` | Convars run before the map loads (copy to the `game` side, see below) |

Not included: the Hammer map, skin textures, the decompiled AK mesh and all compiled files.

### Setup

1. Create an addon named `aim_trainer_gatcha` in CS2 Workshop Tools and put this repository in
   `Counter-Strike Global Offensive/content/csgo_addons/aim_trainer_gatcha/`.
2. Copy `cfg/maps/aim_trainer_gatcha.cfg` to
   `Counter-Strike Global Offensive/game/csgo_addons/aim_trainer_gatcha/cfg/maps/`.
3. For editor type checking, copy `point_script.d.ts` from
   `content/csgo_addons/cs_script_demo/maps/scripts/` into `maps/scripts/` (it is Valve's file, so it is not in this repository).
4. Add the AK mesh: with Source 2 Viewer, open `game/csgo/pak01_dir.vpk`, **Decompile & export**
   `weapons/models/ak47/weapon_rif_ak47.vmdl_c`, then put the `.dmx` files in `maps/gacha_ak/` and the
   exported `.vmdl` there as `_original_weapon_rif_ak47.vmdl.txt`.
5. Put skin textures in `maps/skin_texture/` (see below) and run the generator.
6. Build the map in Hammer with the entities listed below.

### Skin textures

- File name: `{rarity}_AK_{Name}.png`, rarity is `c`, `r`, `sr`, `ur` or `l`
  (for example `sr_AK_Twilight_Sky.png`).
- Paint them on the **legacy (CS:GO) AK UV layout**. The models use the legacy mesh because the
  CS2 HD mesh has a different UV layout.

### Generator

```bash
powershell -ExecutionPolicy Bypass -File gen_gacha_ak.ps1 -Compile
```

| Option | Meaning |
|---|---|
| `-Only Name1,Name2` | only these skins |
| `-Compile` | also compile (skipped for changed models while Workshop Tools is open, to avoid corrupted textures) |
| `-HdMesh Name` | use the CS2 HD mesh for these skins |
| `-FlipV Name` | flip the texture upside down |

Material presets per rarity are at the top of the script (`$presets`).
After adding or renaming textures, update the `SKINS` list in `aim_gacha.js`.

### Hammer entities

| Entity | Name | Notes |
|---|---|---|
| `point_script` | `gacha_script` | script `maps/scripts/aim_gacha.js` |
| `point_script` | any | script `maps/scripts/aimbot_map.js` |
| `point_worldtext` | `coins_text` | coins / kills / skins |
| `point_worldtext` | `result_text` | roll result (color = rarity) |
| `func_button` | any | `OnPressed` → `gacha_script` → `RunScriptInput` → `gacha` |
| `func_button` | any | `OnPressed` → `gacha_script` → `RunScriptInput` → `clear_weapons` |
| `info_target` | `gacha_drop_point` | where rolled AKs drop |
| `prop_dynamic` × skins | any | model `maps/gacha_ak/<skin>.vmdl`; marks that skin's slot on the wall |

The showcase `prop_dynamic`s only mark positions: the script records them when the map loads and
replaces them with real AK weapons (the round cleanup makes map props unreachable for scripts).

### Console commands (need `sv_cheats 1`, which `aimbot_map.js` turns on)

| Command | Effect |
|---|---|
| `gacha_coins [n]` | show or set coins |
| `gacha_addcoins n` | add coins |
| `gacha_clear` | remove weapons on the ground |
| `gacha_reset_skins` | forget collected skins |
| `gacha_showcase` | rebuild the showcase wall and print its state |

### Before publishing

- Set `COST` in `aim_gacha.js` back to `50` (it is `1` for testing).
- Custom skins only exist inside this map; they are not real CS2 inventory items.

---

## 日本語

ガチャ要素付きの Counter-Strike 2 ワークショップ用エイム練習マップです。
bot を倒してコインを集め、コインで AK-47 のスキンガチャを回し、手に入れたスキンを
ショーケースの壁に並べ、壁のスキンを撃つとそのスキンを装備できます。

すべて CS2 の `cs_script`（`point_script`）JavaScript API で動いています。

### 機能

- **エイム練習** – CT 側で左右に動く bot（`aimbot_map.js`）。プレイヤーは T 側。
- **コイン** – bot を 1 体倒すごとに 1 コイン。
- **ガチャ** – ガチャボタンを押すとコインを使ってスキンを抽選。そのスキンの使える AK-47 が
  ボタンの横に落ち、レアリティの色で光ります。
- **レアリティ** – 結果テキストと発光はレアリティの色になります：

  | レアリティ | 確率 | 色 | 質感 |
  |---|---|---|---|
  | Common | 52.5% | 白 | マット塗装 |
  | Rare | 20%（1/5） | 緑 | マット塗装 |
  | Super Rare | 12.5%（1/8） | 青 | ツヤあり |
  | Ultra Rare | 10%（1/10） | 黄 | 高メタリック・ほぼ鏡面 |
  | Legendary | 5%（1/20） | 赤 | メタリック＋虹色の光沢＋ラメ |

- **コレクション** – 壁のテキストに `Skins: 所持数/総数` を表示。重複は 1 つとして数え、
  初入手は `NEW!` と表示。データは保存しません：マップを閉じるとコインもスキンもリセットされます。
- **ショーケースの壁** – 手に入れたスキンが壁に固定された AK として並びます。
- **撃って装備** – 壁のスキンを AK で撃つと、そのスキンの新しい AK に持ち替えます（弾数は引き継ぎ）。
- **クリアボタン** – 地面に落ちている武器をすべて消します（壁の AK は残ります）。

### リポジトリ構成

| パス | 内容 |
|---|---|
| `maps/scripts/aim_gacha.js` | ガチャ、コイン、ショーケース、撃って装備、テスト用コマンド |
| `maps/scripts/aimbot_map.js` | bot の設定と左右移動 |
| `maps/scripts/tsconfig.json` | エディタの型チェック設定 |
| `gen_gacha_ak.ps1` | スキンテクスチャごとに AK モデルとマテリアルを生成 |
| `cfg/maps/aim_trainer_gatcha.cfg` | マップ読み込み前に実行される設定（下記の通り `game` 側へコピー） |

含まれていないもの：Hammer のマップ、スキンテクスチャ、デコンパイルした AK メッシュ、コンパイル済みファイル。

### セットアップ

1. CS2 Workshop Tools で `aim_trainer_gatcha` という addon を作り、このリポジトリを
   `Counter-Strike Global Offensive/content/csgo_addons/aim_trainer_gatcha/` に置く。
2. `cfg/maps/aim_trainer_gatcha.cfg` を
   `Counter-Strike Global Offensive/game/csgo_addons/aim_trainer_gatcha/cfg/maps/` にコピー。
3. エディタで型チェックする場合は、`content/csgo_addons/cs_script_demo/maps/scripts/` の
   `point_script.d.ts` を `maps/scripts/` にコピー（Valve のファイルなのでリポジトリには含めていません）。
4. AK メッシュの用意：Source 2 Viewer で `game/csgo/pak01_dir.vpk` を開き、
   `weapons/models/ak47/weapon_rif_ak47.vmdl_c` を **Decompile & export**。`.dmx` を `maps/gacha_ak/` に、
   書き出された `.vmdl` を同じ場所に `_original_weapon_rif_ak47.vmdl.txt` という名前で置く。
5. スキンテクスチャを `maps/skin_texture/` に置き（下記参照）、ジェネレーターを実行。
6. 下記のエンティティを配置して Hammer でマップをビルド。

### スキンテクスチャ

- ファイル名：`{レアリティ}_AK_{名前}.png`。レアリティは `c`、`r`、`sr`、`ur`、`l`
  （例：`sr_AK_Twilight_Sky.png`）。
- **旧（CS:GO）AK の UV レイアウト**に合わせて描いてください。CS2 の HD メッシュは UV レイアウトが
  違うため、モデルは旧メッシュを使っています。

### ジェネレーター

```bash
powershell -ExecutionPolicy Bypass -File gen_gacha_ak.ps1 -Compile
```

| オプション | 意味 |
|---|---|
| `-Only Name1,Name2` | 指定したスキンだけ生成 |
| `-Compile` | コンパイルも行う（Workshop Tools 起動中は、テクスチャ破損を防ぐため変更されたモデルはスキップ） |
| `-HdMesh Name` | 指定スキンに CS2 の HD メッシュを使う |
| `-FlipV Name` | テクスチャを上下反転 |

レアリティごとの質感プリセットはスクリプト冒頭の `$presets` にあります。
テクスチャを追加・改名したら、`aim_gacha.js` の `SKINS` リストも更新してください。

### Hammer のエンティティ

| エンティティ | 名前 | 備考 |
|---|---|---|
| `point_script` | `gacha_script` | スクリプト `maps/scripts/aim_gacha.js` |
| `point_script` | 任意 | スクリプト `maps/scripts/aimbot_map.js` |
| `point_worldtext` | `coins_text` | コイン／キル数／スキン数 |
| `point_worldtext` | `result_text` | ガチャ結果（色＝レアリティ） |
| `func_button` | 任意 | `OnPressed` → `gacha_script` → `RunScriptInput` → `gacha` |
| `func_button` | 任意 | `OnPressed` → `gacha_script` → `RunScriptInput` → `clear_weapons` |
| `info_target` | `gacha_drop_point` | ガチャの AK が落ちる位置 |
| `prop_dynamic` × スキン数 | 任意 | モデル `maps/gacha_ak/<スキン>.vmdl`。壁のそのスキンの位置を示す |

ショーケースの `prop_dynamic` は位置の目印です。スクリプトがマップ読み込み時に位置を記録し、
本物の AK 武器に置き換えます（ラウンドのクリーンアップ後、マップの prop はスクリプトから操作できなくなるため）。

### コンソールコマンド（`sv_cheats 1` が必要。`aimbot_map.js` が有効にします）

| コマンド | 効果 |
|---|---|
| `gacha_coins [n]` | コインを表示／設定 |
| `gacha_addcoins n` | コインを追加 |
| `gacha_clear` | 地面の武器を消す |
| `gacha_reset_skins` | 集めたスキンをリセット |
| `gacha_showcase` | ショーケースを作り直して状態を表示 |

### 公開前に

- `aim_gacha.js` の `COST` を `50` に戻す（テスト用に `1` になっています）。
- 自作スキンはこのマップ内だけのもので、CS2 の本物のインベントリアイテムではありません。
