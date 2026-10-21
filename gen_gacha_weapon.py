"""Gacha skins for weapons other than the AK (the AK has gen_gacha_ak.ps1).

    python gen_gacha_weapon.py              # every texture in maps/weapon_texture
    python gen_gacha_weapon.py --compile    # also compile the results (only with CS2 closed)

Inputs
  maps/weapon_texture/{c|r|sr|ur|l}_{weapon}_{Style}[_n].png   painted on the weapon's legacy UV
      weapon: desert_eagle / deagle, usp-s / usp_s, m4a1 / m4a1_s (M4A1-S), m4a4, awp
      _n: keep the rarity, but none of its material effects (plain paint)
  maps/gacha_weapon/base/   the decompiled official weapon (vmdl + dmx), per weapon
Outputs
  maps/gacha_weapon/{id}.vmat / .vmdl, maps/gacha_weapon/maps/{id}_*.png
  id = {rarity}_{weapon key}_{style}, e.g. sr_m4a4_azurefang
It also rewrites the WEAPON_SKINS list in maps/scripts/aim_gacha.js ("m4a4:AzureFang").

Material presets follow the AK's (gen_gacha_ak.ps1): the rarer, the fancier.
SPECIAL below gives single skins their own treatment (relief along a color, masks).
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ADDON = Path(__file__).resolve().parent
CS2 = ADDON.parents[2]
TEX_DIR = ADDON / "maps" / "weapon_texture"
OUT_DIR = ADDON / "maps" / "gacha_weapon"
BASE_DIR = OUT_DIR / "base"
MAP_DIR = OUT_DIR / "maps"
SCRIPT = ADDON / "maps" / "scripts" / "aim_gacha.js"
DMXCONVERT = CS2 / "game" / "bin" / "win64" / "dmxconvert.exe"
MAP_SIZE = 1024

# weapon key -> base model name; aliases used in texture file names
WEAPONS = {
    "deagle": {"model": "weapon_pist_deagle", "aliases": ["desert_eagle", "deagle"]},
    "usp_s": {"model": "weapon_pist_usp_silencer", "aliases": ["usp-s", "usp_s", "usp"]},
    "m4a1_s": {"model": "weapon_rif_m4a1_silencer", "aliases": ["m4a1_s", "m4a1-s", "m4a1"]},
    "m4a4": {"model": "weapon_rif_m4a4", "aliases": ["m4a4"]},
    "awp": {"model": "weapon_snip_awp", "aliases": ["awp"]},
}

# Same presets as the AK. Metal < 0: default (non-metal) look with no maps.
PRESETS = {
    "c":  dict(metal=-1,   metal_c=0,   rough=0,    rough_c=0,   irid=0,    glitter=0,   mask_from=1),
    "r":  dict(metal=-1,   metal_c=0,   rough=0,    rough_c=0,   irid=0,    glitter=0,   mask_from=1),
    "sr": dict(metal=0.0,  metal_c=0,   rough=0.55, rough_c=0.4, irid=0,    glitter=0,   mask_from=1),
    "ur": dict(metal=0.85, metal_c=0.3, rough=0.15, rough_c=0.2, irid=0,    glitter=0,   mask_from=1),
    "l":  dict(metal=0.85, metal_c=0.3, rough=0.15, rough_c=0.2, irid=0.35, glitter=0.6, mask_from=0.45),
}

# id -> special treatment
#   preset: use another rarity's preset (e.g. "c" = no effects)
#   relief: which color becomes raised ("red", "gold")
#   fxmask: where the effects of the preset go ("colored" = saturated, non-gold colors)
#   pearl:  a soft pearl sheen on one color only ("red"), like the knives' _pl tier
#   irid:   rainbow sheen strength instead of the preset's (0 = none)
SPECIAL = {
    "l_m4a4_darklycoris": {"preset": "c", "pearl": "red"},
    "l_m4a1_s_cathedral_outlined": {"relief": "gold", "fxmask": "colored", "irid": 0},
    "l_awp_silverundertow": {"irid": 0.175},
    "l_awp_tidalpatina": {"irid": 0.175},
}


def parse(stem):
    """(rarity, weapon key, style) from a texture name, or None."""
    m = re.match(r"^(c|r|sr|ur|l)_(.+)$", stem, re.I)
    if not m:
        return None
    rarity, rest = m.group(1).lower(), m.group(2)
    for key, w in WEAPONS.items():
        for alias in sorted(w["aliases"], key=len, reverse=True):
            if rest.lower().startswith(alias + "_"):
                return rarity, key, rest[len(alias) + 1:]
    return None


# ---------------------------------------------------------------------------- model
def base_model(key):
    """The decompiled vmdl: mesh/animation paths moved into the addon, only the legacy
    mesh kept (the textures are painted for its UV), the material remapped."""
    model = WEAPONS[key]["model"]
    text = (BASE_DIR / f"{model}.vmdl").read_text(encoding="utf-8")
    text = re.sub(r'"weapons/models/[a-z0-9_]+/(%s_[a-z0-9_]+\.dmx)"' % model, r'"maps/gacha_weapon/base/\1"', text)
    # only the legacy mesh, shown for every body choice
    text = re.sub(r'\t*\{\s*_class = "RenderMeshFile"\s*name = "body_hd"\s*filename = "[^"]*"\s*\},\r?\n', "", text)
    text = re.sub(r'(meshes = \s*\[\s*)"body_hd"', r'\1"body_legacy"', text)
    if 'name = "body_hd"\n\t\t\t\t\t\tfilename' in text or '"body_hd",' in text:
        raise SystemExit(f"could not switch {model} to its legacy mesh")
    return text


def materials_of(key):
    dmx = (BASE_DIR / f"{WEAPONS[key]['model']}_body_legacy.dmx").read_bytes()
    found = set(m.decode() for m in re.findall(rb"[A-Za-z0-9_/]+\.vmat", dmx))
    # shared materials (e.g. the AWP's scope glass) keep their own look
    return sorted(m for m in found if "/shared/" not in m)


def with_material(text, key, material):
    remaps = "".join(f"""
							{{
								from = "{src}"
								to = "{material}"
							}},""" for src in materials_of(key))
    block = f"""
			{{
				_class = "MaterialGroupList"
				children =
				[
					{{
						_class = "DefaultMaterialGroup"
						remaps =
						[{remaps}
						]
						use_global_default = false
						global_default_material = ""
					}},
				]
			}},"""
    new, n = re.subn(r'(_class = "RootNode"\r?\n\t\tchildren = ?\r?\n\t\t\[)', lambda m: m.group(1) + block, text, count=1)
    if n != 1:
        raise SystemExit(f"could not find the RootNode children of {WEAPONS[key]['model']}.vmdl")
    return new


# ---------------------------------------------------------------------------- maps
def load_rgb(src, size=None):
    img = Image.open(src).convert("RGB")
    if size:
        img = img.resize((size, size), Image.LANCZOS)
    return np.asarray(img, dtype=np.float32) / 255


def save_gray(a, path):
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).save(path, optimize=True)


def hsv(rgb):
    mx, mn = rgb.max(2), rgb.min(2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    d = np.maximum(mx - mn, 1e-6)
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return h, sat, mx


def color_mask(rgb, which):
    """0..1 mask of a named color in the texture."""
    h, s, v = hsv(rgb)
    if which == "red":
        hue_ok = (h < 20) | (h > 340)
        return np.clip((s - 0.45) / 0.2, 0, 1) * np.clip((v - 0.25) / 0.15, 0, 1) * hue_ok
    if which == "gold":
        hue_ok = (h > 25) & (h < 60)
        return np.clip((s - 0.35) / 0.2, 0, 1) * np.clip((v - 0.3) / 0.15, 0, 1) * hue_ok
    if which == "colored":  # saturated colors that aren't gold (e.g. stained glass)
        gold = (h > 25) & (h < 60)
        return np.clip((s - 0.4) / 0.2, 0, 1) * np.clip((v - 0.15) / 0.15, 0, 1) * ~gold
    raise ValueError(which)


def preset_maps(src, p, metal_path, rough_path, mask_path, fx_where=None):
    rgb = load_rgb(src, MAP_SIZE)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    save_gray(p["metal"] + p["metal_c"] * (lum - 0.5), metal_path)
    save_gray(p["rough"] - p["rough_c"] * (lum - 0.5), rough_path)
    if fx_where:
        mask = ndimage.gaussian_filter(ndimage.grey_dilation(color_mask(rgb, fx_where), size=3), 1.0)
    else:
        mask = (lum >= p["mask_from"]).astype(np.float32)
    save_gray(mask, mask_path)


def relief_maps(src, which, color_path, normal_path, strength=1.0):
    """The chosen color becomes raised: normal map + light/shadow baked into a color copy."""
    rgb = load_rgb(src)
    # A clean, continuous shape: stray specks of the color (e.g. in a marble pattern)
    # would each become a little bump, so they are dropped and gaps in lines are closed
    raw = color_mask(rgb, which) > 0.5
    raw = ndimage.binary_closing(raw, structure=np.ones((5, 5)), iterations=2)
    raw = ndimage.binary_opening(raw, structure=np.ones((2, 2)))
    labels, n = ndimage.label(raw)
    if n:
        sizes = ndimage.sum(raw, labels, range(1, n + 1))
        raw = np.isin(labels, 1 + np.flatnonzero(sizes >= 40))
    lines = ndimage.gaussian_filter(raw.astype(np.float32), 1.0)
    height = ndimage.gaussian_filter(lines, 2.0)
    k = 6.0 * strength
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5 * k
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5 * k
    n = np.dstack([-dx, dy, np.ones_like(height)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).resize((MAP_SIZE, MAP_SIZE), Image.LANCZOS).save(normal_path, optimize=True)
    light = np.array([-0.55, 0.55, 0.63], np.float32); light /= np.linalg.norm(light)
    shade = n @ light - light[2]
    cast = np.roll(np.roll(ndimage.gaussian_filter(lines, 2.5), 3, 0), 3, 1)
    shadow = np.clip(cast - lines, 0, 1)
    factor = 1 + 1.5 * strength * shade - 0.5 * strength * shadow
    Image.fromarray((np.clip(rgb * factor[..., None], 0, 1) * 255).astype(np.uint8)).save(color_path, optimize=True)


# ---------------------------------------------------------------------------- material
def vmat_text(tex, sid, p, special):
    color = f"maps/gacha_weapon/maps/{sid}_color.png" if special.get("relief") else f"maps/weapon_texture/{tex.name}"
    lines = [f'\t"TextureColor1"\t\t"{color}"']
    if special.get("relief"):
        lines.append(f'\t"TextureNormal"\t\t"maps/gacha_weapon/maps/{sid}_normal.png"')
    if p["metal"] >= 0:
        lines += [f'\t"TextureMetalness1"\t\t"maps/gacha_weapon/maps/{sid}_metal.png"',
                  f'\t"TextureRoughness1"\t\t"maps/gacha_weapon/maps/{sid}_rough.png"',
                  '\t"g_vMetalnessRemapRange"\t\t"[0.000 1.000]"']
    else:
        lines.append('\t"TextureMetalness1"\t\t"materials/default/default_metal.tga"')
    if special.get("pearl"):
        lines += ['\t"F_ENABLE_SFX_MASK"\t\t"1"', f'\t"TextureSfxMask1"\t\t"maps/gacha_weapon/maps/{sid}_fxmask.png"',
                  '\t"F_IRIDESCENCE"\t\t"1"', '\t"g_flIridescentStrength"\t\t"0.150"', '\t"g_flIridescentScale"\t\t"0.600"',
                  '\t"g_flIridescentHueShift"\t\t"0.120"', '\t"g_flPearlescentScale"\t\t"0.300"']
    if p["irid"] > 0 or p["glitter"] > 0:
        lines += ['\t"F_ENABLE_SFX_MASK"\t\t"1"', f'\t"TextureSfxMask1"\t\t"maps/gacha_weapon/maps/{sid}_fxmask.png"']
    if p["irid"] > 0:
        lines += ['\t"F_IRIDESCENCE"\t\t"1"', f'\t"g_flIridescentStrength"\t\t"{p["irid"]:.3f}"',
                  '\t"g_flIridescentScale"\t\t"2.000"', '\t"g_flIridescentHueShift"\t\t"0.500"']
    if p["glitter"] > 0:
        lines += ['\t"F_GLITTER"\t\t"1"',
                  '\t"TextureGlitterMask"\t\t"materials/default/stickers/squares_glitter_mask.tga"',
                  '\t"TextureGlitterNormal"\t\t"materials/default/stickers/squares_glitter_normal.tga"',
                  f'\t"g_fGlitterIntensity"\t\t"{p["glitter"]:.3f}"', '\t"g_fGlitterScale"\t\t"40.000"',
                  '\t"g_fGlitterRainbowBalance"\t\t"0.250"', '\t"g_fGlitterRainbowSpread"\t\t"0.500"']
    body = "\n".join(lines)
    return f"""// Generated by gen_gacha_weapon.py from {tex.name}
"Layer0"
{{
	"shader"		"csgo_weapon.vfx"
{body}
	"g_flModelTintAmount"		"1.000000"
	"g_vColorTint"		"[1.000000 1.000000 1.000000 0.000000]"
	"g_vTexCoordCenter"		"[0.500 0.500]"
	"g_vTexCoordOffset"		"[0.000 0.000]"
	"g_vTexCoordScale"		"[1.000 1.000]"
	"g_flTexCoordRotation"		"0.000000"
	"g_flUvScale1"		"1.000000"
}}
"""


def write_if_changed(path, text):
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def main():
    compile_ = "--compile" in sys.argv
    MAP_DIR.mkdir(parents=True, exist_ok=True)
    made = []
    lists = {k: [] for k in ("Common", "Rare", "Super Rare", "Ultra Rare", "Legendary")}
    rarity_name = {"c": "Common", "r": "Rare", "sr": "Super Rare", "ur": "Ultra Rare", "l": "Legendary"}
    for tex in sorted(TEX_DIR.glob("*.png")):
        parsed = parse(tex.stem)
        if not parsed:
            print(f"skipped {tex.name} (name it {{c|r|sr|ur|l}}_{{weapon}}_{{Style}}.png)")
            continue
        rarity, key, style = parsed
        if not (BASE_DIR / f"{WEAPONS[key]['model']}.vmdl").exists():
            print(f"skipped {tex.name}: no base model {WEAPONS[key]['model']}.vmdl in maps/gacha_weapon/base")
            continue
        sid = f"{rarity}_{key}_{style}".lower()
        special = SPECIAL.get(sid, {})
        plain = style.lower().endswith("_n")
        p = dict(PRESETS["c" if plain else special.get("preset", rarity)])
        if "irid" in special:
            p["irid"] = special["irid"]
        lists[rarity_name[rarity]].append(f"{key}:{style}")

        outs = [MAP_DIR / f"{sid}_{n}.png" for n in ("metal", "rough", "fxmask")]
        if special.get("relief"):
            outs += [MAP_DIR / f"{sid}_color.png", MAP_DIR / f"{sid}_normal.png"]
        newest = max(tex.stat().st_mtime, Path(__file__).stat().st_mtime)
        stale = any(not o.exists() or o.stat().st_mtime < newest for o in outs
                    if p["metal"] >= 0 or (special.get("pearl") and o.name.endswith("_fxmask.png"))
                    or "_color" in o.name or "_normal" in o.name)
        if stale:
            if p["metal"] >= 0:
                preset_maps(tex, p, outs[0], outs[1], outs[2], special.get("fxmask"))
            if special.get("relief"):
                relief_maps(tex, special["relief"], MAP_DIR / f"{sid}_color.png", MAP_DIR / f"{sid}_normal.png")
            if special.get("pearl"):
                rgb = load_rgb(tex, MAP_SIZE)
                mask = ndimage.gaussian_filter(ndimage.grey_dilation(color_mask(rgb, special["pearl"]), size=3), 1.0)
                save_gray(mask, outs[2])  # the fxmask
        mat =f"maps/gacha_weapon/{sid}.vmat"
        changed = write_if_changed(OUT_DIR / f"{sid}.vmat", vmat_text(tex, sid, p, special))
        changed |= write_if_changed(OUT_DIR / f"{sid}.vmdl", with_material(base_model(key), key, mat))
        if changed or stale:
            made.append(sid)
        print(f"{'updated' if changed or stale else 'unchanged'} maps/gacha_weapon/{sid}.vmdl{'  (special)' if special else ''}")

    js = SCRIPT.read_text(encoding="utf-8")
    block = "const WEAPON_SKINS = {\n" + "\n".join(
        f'    "{r}": [' + ", ".join(f'"{s}"' for s in lists[r]) + "]," for r in lists) + "\n};"
    new_js = re.sub(r"const WEAPON_SKINS = \{[\s\S]*?\n\};", lambda m: block, js, count=1)
    if new_js != js:
        SCRIPT.write_text(new_js, encoding="utf-8")
        print(f"updated WEAPON_SKINS in aim_gacha.js ({sum(len(v) for v in lists.values())} skins)")

    if compile_ and made:
        running = "cs2.exe" in subprocess.run(["tasklist"], capture_output=True, text=True).stdout.lower()
        if running:
            print("CS2 is running: not compiling (two compilers writing the same textures corrupts them)")
            return
        rc = CS2 / "game" / "bin" / "win64" / "resourcecompiler.exe"
        for sid in made:
            for ext in ("vmat", "vmdl"):
                out = subprocess.run([str(rc), "-addon", ADDON.name, "-f", "-i", str(OUT_DIR / f"{sid}.{ext}")],
                                     capture_output=True, text=True).stdout
                result = [l.strip() for l in out.splitlines() if "OK:" in l or "ERROR" in l]
                print(f"  {sid}.{ext}: {result[-1] if result else out[-300:]}")


if __name__ == "__main__":
    main()
