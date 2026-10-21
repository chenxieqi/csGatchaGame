# Generates one textured AK model + material per skin texture.
#   maps/skin_texture/{c|r|sr|ur|l}_AK_{Name}.png
#   A name ending in _n (e.g. ur_AK_Cappuccino_n.png) keeps its rarity but gets none of the
#   rarity's material effects (metal, gloss, sheen, glitter): plain paint like a Common.
#   -> maps/gacha_ak/{rarity}_ak_{name}.vmat
#   -> maps/gacha_ak/{rarity}_ak_{name}.vmdl   (copy of the AK with its material remapped)
# It also rewrites the SKINS list in maps/scripts/aim_gacha.js from every texture
# in maps/skin_texture, so the script always matches the folder.
#
# Usage:
#   gen_gacha_ak.ps1                      # every texture
#   gen_gacha_ak.ps1 -Only Cyberpunk,Steampunk
#   gen_gacha_ak.ps1 -Compile             # also run resourcecompiler on the results
#   gen_gacha_ak.ps1 -HdMesh Solarpunk    # these skins use the CS2 HD mesh instead of the legacy one
#   gen_gacha_ak.ps1 -FlipV Y2K           # these skins use their texture flipped upside down
param(
    [string[]]$Only = @(),
    [switch]$Compile,
    [string[]]$HdMesh = @(),
    [string[]]$FlipV = @()
)

$addon  = $PSScriptRoot
$cs2    = (Resolve-Path (Join-Path $addon "..\..\..")).Path
$texDir = Join-Path $addon "maps\skin_texture"
$outDir = Join-Path $addon "maps\gacha_ak"
$base   = Join-Path $outDir "_original_weapon_rif_ak47.vmdl.txt"
$utf8   = New-Object System.Text.UTF8Encoding($false)

# Base model text with addon-local mesh/animation paths and a material remap placeholder
$baseText = [IO.File]::ReadAllText($base).Replace('"weapons/models/ak47/weapon_rif_ak47_', '"maps/gacha_ak/weapon_rif_ak47_')
# The magazine is a separate game model, keep pointing at the original
$baseText = $baseText.Replace('"maps/gacha_ak/weapon_rif_ak47_mag.vmdl"', '"weapons/models/ak47/weapon_rif_ak47_mag.vmdl"')

$groups = @"
		children =
		[
			{
				_class = "MaterialGroupList"
				children =
				[
					{
						_class = "DefaultMaterialGroup"
						remaps =
						[
							{
								from = "weapons/models/ak47/materials/weapon_rif_ak47.vmat"
								to = "__MATERIAL__"
							},
							{
								from = "materials/models/weapons/v_models/rif_ak47/ak47.vmat"
								to = "__MATERIAL__"
							},
						]
						use_global_default = false
						global_default_material = ""
					},
				]
			},
"@
$baseText = [regex]::Replace($baseText, '(_class = "RootNode"\r?\n)\t\tchildren = \r?\n\t\t\[', { param($m) $m.Groups[1].Value + $groups }, 'None')
if (-not $baseText.Contains("__MATERIAL__")) { throw "could not insert material remap into base model" }

# The AK has two meshes with different UV layouts: body_legacy (CS:GO) and body_hd (CS2).
# Keep only one and show it for every body choice (the game may pick a choice by name).
function Use-OnlyMesh([string]$text, [string]$keep, [string]$drop) {
    $text = [regex]::Replace($text, "\t*\{\s*_class = `"RenderMeshFile`"\s*name = `"$drop`"\s*filename = `"[^`"]*`"\s*\},\r?\n", '')
    $text = [regex]::Replace($text, "(meshes = \s*\[\s*)`"$drop`"", "`$1`"$keep`"")
    if ($text -match "name = `"$drop`"\s*filename|meshes = \s*\[\s*`"$drop`"") { throw "could not switch the model to $keep" }
    return $text
}
# Default: the skin textures are painted for the legacy UV layout
$legacyText = Use-OnlyMesh $baseText "body_legacy" "body_hd"
$hdText     = Use-OnlyMesh $baseText "body_hd" "body_legacy"

# ---------------------------------------------------------------------------
# Material presets per rarity. The rarer, the fancier.
#   Metal/Rough: base value + Contrast * (brightness - 0.5) of the color texture,
#                written to grayscale maps (white = metal / white = rough).
#                Metal = -1 keeps the default (non-metal) look with no maps.
#   Pearl:       pearlescent strength (color shifts with view angle)
#   Iridescent:  rainbow sheen strength, only where the effect mask is white
#   Glitter:     sparkle intensity, only where the effect mask is white
#   MaskFrom:    brightness above which a pixel gets the effects (mask)
# ---------------------------------------------------------------------------
$presets = @{
    # Common / Rare: plain matte paint
    c  = @{ Metal = -1;   MetalContrast = 0;   Rough = 0;    RoughContrast = 0;   Pearl = 0;   Iridescent = 0;   Glitter = 0;   MaskFrom = 1 }
    r  = @{ Metal = -1;   MetalContrast = 0;   Rough = 0;    RoughContrast = 0;   Pearl = 0;   Iridescent = 0;   Glitter = 0;   MaskFrom = 1 }
    # Super Rare: glossy, brighter areas shinier
    sr = @{ Metal = 0.0;  MetalContrast = 0;   Rough = 0.55; RoughContrast = 0.4; Pearl = 0;   Iridescent = 0;   Glitter = 0;   MaskFrom = 1 }
    # Ultra Rare: high metal, near mirror
    ur = @{ Metal = 0.85; MetalContrast = 0.3; Rough = 0.15; RoughContrast = 0.2; Pearl = 0;   Iridescent = 0;   Glitter = 0;   MaskFrom = 1 }
    # Legendary: Ultra Rare's metal plus rainbow sheen and glitter
    l  = @{ Metal = 0.85; MetalContrast = 0.3; Rough = 0.15; RoughContrast = 0.2; Pearl = 0;   Iridescent = 0.35; Glitter = 0.6; MaskFrom = 0.45 }
}

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class GachaMaps {
    static float Clamp(float v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    // Writes metalness, roughness and effect-mask maps derived from the color texture's brightness.
    public static void Generate(string src, string metalPath, string roughPath, string maskPath, int size,
                                float metal, float metalContrast, float rough, float roughContrast, float maskFrom) {
        using (var img = Image.FromFile(src))
        using (var color = new Bitmap(img, size, size))
        using (var m = new Bitmap(size, size, PixelFormat.Format24bppRgb))
        using (var r = new Bitmap(size, size, PixelFormat.Format24bppRgb))
        using (var k = new Bitmap(size, size, PixelFormat.Format24bppRgb)) {
            var rect = new Rectangle(0, 0, size, size);
            var cd = color.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            var md = m.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
            var rd = r.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
            var kd = k.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
            int len = cd.Stride * size;
            byte[] c = new byte[len], mb = new byte[len], rb = new byte[len], kb = new byte[len];
            Marshal.Copy(cd.Scan0, c, 0, len);
            for (int y = 0; y < size; y++) {
                for (int x = 0; x < size; x++) {
                    int i = y * cd.Stride + x * 3;
                    float lum = (0.0722f * c[i] + 0.7152f * c[i + 1] + 0.2126f * c[i + 2]) / 255f;
                    byte mv = (byte)(Clamp(metal + metalContrast * (lum - 0.5f)) * 255);
                    byte rv = (byte)(Clamp(rough - roughContrast * (lum - 0.5f)) * 255);
                    byte kv = (byte)(lum >= maskFrom ? 255 : 0);
                    mb[i] = mb[i + 1] = mb[i + 2] = mv;
                    rb[i] = rb[i + 1] = rb[i + 2] = rv;
                    kb[i] = kb[i + 1] = kb[i + 2] = kv;
                }
            }
            Marshal.Copy(mb, 0, md.Scan0, len);
            Marshal.Copy(rb, 0, rd.Scan0, len);
            Marshal.Copy(kb, 0, kd.Scan0, len);
            color.UnlockBits(cd); m.UnlockBits(md); r.UnlockBits(rd); k.UnlockBits(kd);
            m.Save(metalPath, ImageFormat.Png);
            r.Save(roughPath, ImageFormat.Png);
            k.Save(maskPath, ImageFormat.Png);
        }
    }
}
"@

# Returns $true when the file was (re)written
function Write-IfChanged([string]$path, [string]$text) {
    if ((Test-Path $path) -and [IO.File]::ReadAllText($path) -ceq $text) { return $false }
    [IO.File]::WriteAllText($path, $text, $utf8)
    return $true
}

$mapDir = Join-Path $outDir "maps"
New-Item -ItemType Directory -Force $mapDir | Out-Null
$inv = [Globalization.CultureInfo]::InvariantCulture

$made = @()
Get-ChildItem $texDir -File -Filter *.png | ForEach-Object {
    if ($_.Name -notmatch '^(sr|ur|c|r|l)_?AK_(.+)\.png$') { Write-Warning "skipped $($_.Name)"; return }
    $rarity = $Matches[1]; $name = $Matches[2]
    if ($Only.Count -gt 0 -and $Only -notcontains $name) { return }

    $id  = "${rarity}_ak_$name".ToLower()
    $mat = "maps/gacha_ak/$id.vmat"
    # _n = no rarity effects: the rarity stays, the material is plain paint
    $plain = $name -match '_n$'
    $p   = if ($plain) { $presets['c'] } else { $presets[$rarity] }
    $f   = { param($v) ([double]$v).ToString("0.000", $inv) }

    # Color source: the texture as-is, or an upside-down copy (-FlipV)
    $colorFile = $_.FullName
    $colorTex  = "maps/skin_texture/$($_.Name)"
    if ($FlipV -contains $name) {
        $colorFile = Join-Path $mapDir "${id}_color_flipv.png"
        $img = [System.Drawing.Image]::FromFile($_.FullName)
        $img.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipY)
        $img.Save($colorFile, [System.Drawing.Imaging.ImageFormat]::Png)
        $img.Dispose()
        $colorTex = "maps/gacha_ak/maps/${id}_color_flipv.png"
    }
    $useHd = $HdMesh -contains $name

    $metalTex = "materials/default/default_metal.tga"
    $extra = ""
    $stale = $null
    if ($p.Metal -ge 0) {
        $mapFiles = "metal", "rough", "fxmask" | ForEach-Object { Join-Path $mapDir "${id}_$_.png" }
        # Regenerate only when missing, older than the texture, or older than this script (presets changed)
        $srcTime = @((Get-Item $colorFile).LastWriteTime, (Get-Item $PSCommandPath).LastWriteTime) | Sort-Object | Select-Object -Last 1
        $stale = $mapFiles | Where-Object { -not (Test-Path $_) -or (Get-Item $_).LastWriteTime -lt $srcTime }
        if ($stale) {
            [GachaMaps]::Generate($colorFile, $mapFiles[0], $mapFiles[1], $mapFiles[2],
                1024, $p.Metal, $p.MetalContrast, $p.Rough, $p.RoughContrast, $p.MaskFrom)
        }
        $metalTex = "maps/gacha_ak/maps/${id}_metal.png"
        $extra += "`t`"TextureRoughness1`"`t`t`"maps/gacha_ak/maps/${id}_rough.png`"`r`n"
        $extra += "`t`"g_vMetalnessRemapRange`"`t`t`"[0.000 1.000]`"`r`n"
    }
    if ($p.Pearl -gt 0) {
        $extra += "`t`"g_flPearlescentScale`"`t`t`"$(& $f $p.Pearl)`"`r`n"
    }
    if ($p.Iridescent -gt 0 -or $p.Glitter -gt 0) {
        $extra += "`t`"F_ENABLE_SFX_MASK`"`t`t`"1`"`r`n"
        $extra += "`t`"TextureSfxMask1`"`t`t`"maps/gacha_ak/maps/${id}_fxmask.png`"`r`n"
    }
    if ($p.Iridescent -gt 0) {
        $extra += "`t`"F_IRIDESCENCE`"`t`t`"1`"`r`n"
        $extra += "`t`"g_flIridescentStrength`"`t`t`"$(& $f $p.Iridescent)`"`r`n"
        $extra += "`t`"g_flIridescentScale`"`t`t`"2.000`"`r`n"
        $extra += "`t`"g_flIridescentHueShift`"`t`t`"0.500`"`r`n"
    }
    if ($p.Glitter -gt 0) {
        $extra += "`t`"F_GLITTER`"`t`t`"1`"`r`n"
        $extra += "`t`"TextureGlitterMask`"`t`t`"materials/default/stickers/squares_glitter_mask.tga`"`r`n"
        $extra += "`t`"TextureGlitterNormal`"`t`t`"materials/default/stickers/squares_glitter_normal.tga`"`r`n"
        $extra += "`t`"g_fGlitterIntensity`"`t`t`"$(& $f $p.Glitter)`"`r`n"
        $extra += "`t`"g_fGlitterScale`"`t`t`"40.000`"`r`n"
        $extra += "`t`"g_fGlitterRainbowBalance`"`t`t`"0.250`"`r`n"
        $extra += "`t`"g_fGlitterRainbowSpread`"`t`t`"0.500`"`r`n"
    }

    $vmat = @"
// Generated by gen_gacha_ak.ps1 from $($_.Name) (preset: $(if ($plain) { "c, _n plain" } else { $rarity }), mesh: $(if ($useHd) { "hd" } else { "legacy" })$(if ($FlipV -contains $name) { ", flipped V" }))
"Layer0"
{
	"shader"		"csgo_weapon.vfx"
	"TextureColor1"		"$colorTex"
	"TextureMetalness1"		"$metalTex"
$extra	"g_flModelTintAmount"		"1.000000"
	"g_vColorTint"		"[1.000000 1.000000 1.000000 0.000000]"
	"g_vTexCoordCenter"		"[0.500 0.500]"
	"g_vTexCoordOffset"		"[0.000 0.000]"
	"g_vTexCoordScale"		"[1.000 1.000]"
	"g_flTexCoordRotation"		"0.000000"
	"g_flUvScale1"		"1.000000"
}
"@
    $vmdlPath = Join-Path $outDir "$id.vmdl"
    $isNew = -not (Test-Path $vmdlPath)
    $modelText = if ($useHd) { $hdText } else { $legacyText }
    # Only touch files whose content changed, so Workshop Tools doesn't recompile them for nothing
    $changed = (Write-IfChanged (Join-Path $outDir "$id.vmat") $vmat) -bor (Write-IfChanged $vmdlPath $modelText.Replace("__MATERIAL__", $mat))
    if ($changed -or $stale) { $made += [pscustomobject]@{ Id = $id; New = $isNew } }
    $state = if ($isNew) { "new" } elseif ($changed -or $stale) { "updated" } else { "unchanged" }
    "$state maps/gacha_ak/$id.vmdl  (mesh: $(if ($useHd) { 'hd' } else { 'legacy' })$(if ($FlipV -contains $name) { ', flipped V' }))"
}

# Keep the SKINS list in aim_gacha.js in sync with every texture in the folder
$scriptPath = Join-Path $addon "maps\scripts\aim_gacha.js"
if (Test-Path $scriptPath) {
    $rarityNames = [ordered]@{ c = "Common"; r = "Rare"; sr = "Super Rare"; ur = "Ultra Rare"; l = "Legendary" }
    $all = Get-ChildItem $texDir -File -Filter *.png | ForEach-Object {
        if ($_.Name -match '^(sr|ur|c|r|l)_?AK_(.+)\.png$') { [pscustomobject]@{ R = $Matches[1]; N = $Matches[2] } }
    }
    $lines = foreach ($k in $rarityNames.Keys) {
        $names = $all | Where-Object R -eq $k | Sort-Object N | ForEach-Object { "`"$($_.N)`"" }
        "    `"$($rarityNames[$k])`": [" + ($names -join ", ") + "],"
    }
    $block = "const SKINS = {`n" + ($lines -join "`n") + "`n};"
    $js = [IO.File]::ReadAllText($scriptPath)
    $newJs = [regex]::Replace($js, 'const SKINS = \{[\s\S]*?\r?\n\};', { param($m) $block }, 'None')
    if ($newJs -ceq $js) {
        "skin list in aim_gacha.js already up to date ($($all.Count) skins)"
    } elseif ((Write-IfChanged $scriptPath $newJs)) {
        "updated skin list in aim_gacha.js ($($all.Count) skins)"
        if ($Compile -and -not (Get-Process cs2 -ErrorAction SilentlyContinue)) {
            & (Join-Path $cs2 "game\bin\win64\resourcecompiler.exe") -addon (Split-Path $addon -Leaf) -i $scriptPath 2>&1 |
                Select-String -Pattern "OK:|ERROR|Error|failed" | ForEach-Object { "  aim_gacha.js : $($_.Line.Trim())" }
        }
    }
}

# Workshop Tools recompiles changed sources by itself. Compiling here at the same
# time makes both write the same texture files and corrupts them (noisy textures).
# New models are safe to compile: the tools haven't loaded them yet.
$toolsOpen = [bool](Get-Process cs2 -ErrorAction SilentlyContinue)
$toCompile = @($made | Where-Object { -not $toolsOpen -or $_.New })
if ($Compile -and $toolsOpen) {
    $skipped = @($made | Where-Object { -not $_.New })
    if ($skipped.Count -gt 0) {
        Write-Warning "CS2 Workshop Tools is running: left $($skipped.Count) updated model(s) for the tools to recompile: $($skipped.Id -join ', ')"
        Write-Warning "If a texture looks like colored noise, close the tools and run this again with -Compile."
    }
}

if ($Compile -and $toCompile.Count -gt 0) {
    $rc = Join-Path $cs2 "game\bin\win64\resourcecompiler.exe"
    foreach ($item in $toCompile) {
        # Material first: a changed vmat alone doesn't make the model look stale.
        # -f (force) only with the tools closed, so shared textures are never rewritten under them.
        foreach ($file in "$($item.Id).vmat", "$($item.Id).vmdl") {
            $rcArgs = @("-addon", (Split-Path $addon -Leaf), "-i", (Join-Path $outDir $file))
            if (-not $toolsOpen) { $rcArgs += "-f" }
            & $rc @rcArgs 2>&1 | Select-String -Pattern "OK:|ERROR|Error|failed" | ForEach-Object { "  $file : $($_.Line.Trim())" }
        }
    }
}
