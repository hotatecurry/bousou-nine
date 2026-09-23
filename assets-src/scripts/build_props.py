"""持ち物の部品（バット・グラブ・キャッチャーミット・拳銃・バイク）を props.blend に作って書き出す。

Blender MCP から実行する：
    import sys; sys.path.insert(0, r"<repo>/assets-src/scripts")
    import build_props; build_props.build(r"<repo>")

**原点は「取り付く場所」**（`src/entities/props.ts` の約束）：バットは握る手、グラブと
ミットは手のひらの中心。three では手のノードの子になるので、手の向き＝前腕の向きに
付いてくる。Blender の -Z が three の -Y（前腕の先＝指先の方向）。

バットの長さは **1.1m（`dekkaiScene.ts` の BAT_LENGTH）から変えない**：判定の到達範囲は
「描かれたバットが覆う範囲」に合わせてある（フェーズRR-66）ので、長さを変えると
見た目と判定がずれる。握り（原点）から先端までちょうど 1.1m。
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import importlib  # noqa: E402

import blender_shapes as S  # noqa: E402

importlib.reload(S)

BAT_LENGTH = 1.1
# 作り直す部品（拳銃とバイクはブラッシュアップの2段目で箱の旧モデルから作り直した）
NEW_PARTS = ("Bat", "Glove", "Mitt", "Gun", "Bike")
# 拳銃の銃口（マズルフラッシュの取り付け口。旧モデルと同じ位置に置く＝閃光の出どころが変わらない）
GUN_MUZZLE = (0.0, -0.405, 0.02)


def remove_existing():
    for name in ("GunMuzzle",) + NEW_PARTS:
        obj = bpy.data.objects.get(name)
        if obj is not None:
            mesh = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            if mesh is not None and getattr(mesh, "users", 1) == 0:
                bpy.data.meshes.remove(mesh)


def build_bat():
    wood = S.material("BatWood", (0.86, 0.6, 0.32))
    grip = S.material("BatGrip", (0.12, 0.12, 0.14))
    L = BAT_LENGTH
    body = S.bm_to_object("bat_body", S.lathe([
        (0.05, 0.0, 0.0),
        (0.048, 0.018, 0.018),
        (0.042, 0.028, 0.028),
        (0.032, 0.029, 0.029),
        (0.024, 0.019, 0.019),
        (0.0, 0.0175, 0.0175),
        (-0.30, 0.0185, 0.0185),
        (-0.48, 0.024, 0.024),
        (-0.64, 0.033, 0.033),
        (-0.78, 0.039, 0.039),
        (-0.95, 0.042, 0.042),
        (-(L - 0.03), 0.041, 0.041),
        (-(L - 0.012), 0.035, 0.035),
        (-L, 0.0, 0.0),
    ], segments=16), wood)
    tape = S.bm_to_object("bat_grip", S.lathe([
        (0.022, 0.0195, 0.0195),
        (-0.24, 0.0205, 0.0205),
    ], segments=16), grip)
    return S.join([body, tape], "Bat")


def build_glove():
    leather = S.material("GloveLeather", (0.64, 0.37, 0.16))
    lace = S.material("GloveLace", (0.36, 0.2, 0.09))
    body = S.bm_to_object("glove_body", S.lathe(S.ellipsoid_rings((0.0, 0.0, -0.05), 0.048, 0.088, 0.105, steps=10), segments=18), leather)
    thumb = S.bm_to_object("glove_thumb", S.lathe(S.ellipsoid_rings((0.0, -0.078, 0.005), 0.04, 0.03, 0.055, steps=8), segments=14), leather)
    web = S.bm_to_object("glove_web", S.lathe(S.ellipsoid_rings((0.0, -0.07, -0.075), 0.03, 0.026, 0.04, steps=6), segments=12), lace)
    cuff = S.bm_to_object("glove_cuff", S.lathe([
        (0.06, 0.042, 0.06),
        (0.03, 0.05, 0.07),
        (0.022, 0.0, 0.0),
    ], segments=18), lace)
    return S.join([body, thumb, web, cuff], "Glove")


def build_mitt():
    leather = S.material("MittLeather", (0.42, 0.22, 0.1))
    pocket = S.material("MittPocket", (0.62, 0.38, 0.18))
    body = S.bm_to_object("mitt_body", S.lathe(S.ellipsoid_rings((0.0, 0.0, -0.035), 0.06, 0.105, 0.11, steps=10), segments=20), leather)
    rim = S.bm_to_object("mitt_rim", S.lathe(S.ellipsoid_rings((0.0, 0.0, -0.035), 0.05, 0.112, 0.117, steps=10), segments=20), leather)
    face = S.bm_to_object("mitt_face", S.lathe(S.ellipsoid_rings((-0.035, 0.0, -0.045), 0.032, 0.07, 0.075, steps=8), segments=16), pocket)
    return S.join([body, rim, face], "Mitt")


def build_gun():
    """回転式拳銃（★3 メカ `ジュウ`）。

    **原点＝握る手**・銃口は -Y（three の +Z）。寸法は旧モデルに揃える：握りは原点から
    下へ約0.2m、銃身の先（銃口）は原点から 0.405m 前、銃身の軸は原点より 2cm 上。
    手に持たせて腕ごと向けるので、握りの傾き（後ろへ流れる）もそのまま構えの形になる。
    """
    metal = S.material("PropMetal", (0.56, 0.59, 0.63), roughness=0.35)
    dark = S.material("PropDark", (0.055, 0.06, 0.075), roughness=0.5)
    wood = S.material("GunWood", (0.36, 0.17, 0.07), roughness=0.6)
    axis_z = GUN_MUZZLE[2]
    parts = []
    # 銃身（先端に一段太い銃口の輪）
    parts.append(S.bm_to_object("gun_barrel", S.lathe_forward(-0.12, [
        (0.0, 0.0, 0.0, 0.0, axis_z),
        (0.0, 0.021, 0.021, 0.0, axis_z),
        (0.265, 0.021, 0.021, 0.0, axis_z),
        (0.268, 0.024, 0.024, 0.0, axis_z),
        (0.283, 0.024, 0.024, 0.0, axis_z),
        (0.285, 0.0, 0.0, 0.0, axis_z),
    ], segments=20), metal))
    # 銃口の穴（黒い円を少しだけ前へ出す＝どちらを向いているかが先端で読める）
    parts.append(S.bm_to_object("gun_bore", S.lathe_forward(-0.395, [
        (0.0, 0.0, 0.0, 0.0, axis_z),
        (0.0, 0.0095, 0.0095, 0.0, axis_z),
        (0.0115, 0.0095, 0.0095, 0.0, axis_z),
        (0.0118, 0.0, 0.0, 0.0, axis_z),
    ], segments=14), dark))
    # 銃身の下の筒（エジェクターロッドの覆い）
    parts.append(S.bm_to_object("gun_ejector", S.rod((0.0, -0.13, axis_z - 0.026), (0.0, -0.33, axis_z - 0.026), 0.011, segments=12), metal))
    # 銃身の上の平たい背（リブ）と照星
    parts.append(S.bm_to_object("gun_rib", S.rounded_box((0.0, -0.262, axis_z + 0.024), (0.02, 0.27, 0.014), 0.006), dark))
    parts.append(S.bm_to_object("gun_sight", S.rounded_box((0.0, -0.385, axis_z + 0.038), (0.007, 0.02, 0.018), 0.003), dark))
    # 弾倉（シリンダー）：両端を面取りした円筒。枠より太いので左右から見える
    parts.append(S.bm_to_object("gun_cylinder", S.lathe_forward(-0.055, [
        (0.0, 0.0, 0.0, 0.0, 0.01),
        (0.0, 0.036, 0.036, 0.0, 0.01),
        (0.008, 0.047, 0.047, 0.0, 0.01),
        (0.082, 0.047, 0.047, 0.0, 0.01),
        (0.09, 0.036, 0.036, 0.0, 0.01),
        (0.09, 0.0, 0.0, 0.0, 0.01),
    ], segments=20), metal))
    # 枠（フレーム）
    parts.append(S.bm_to_object("gun_frame", S.rounded_box((0.0, -0.055, 0.012), (0.05, 0.23, 0.088), 0.014), dark))
    # 撃鉄（後ろへ倒れている）
    parts.append(S.bm_to_object("gun_hammer", S.rounded_box((0.0, 0.056, 0.055), (0.015, 0.034, 0.032), 0.006, rotation=(-0.5, 0.0, 0.0)), metal))
    # 用心金（輪の上半分は枠の中に隠れる）と引き金
    parts.append(S.bm_to_object("gun_guard", S.torus((0.0, -0.022, -0.028), "X", 0.027, 0.0055, seg_major=28, seg_minor=8), dark))
    parts.append(S.bm_to_object("gun_trigger", S.rounded_box((0.0, -0.014, -0.046), (0.007, 0.011, 0.03), 0.003, rotation=(0.35, 0.0, 0.0)), metal))
    # 握り（木）。下へ行くほど後ろへ流れる＝手首を返さずに腕の延長で構えられる
    parts.append(S.bm_to_object("gun_grip", S.lathe([
        (0.004, 0.0, 0.0, 0.0, 0.034),
        (0.0, 0.02, 0.034, 0.0, 0.034),
        (-0.05, 0.023, 0.04, 0.0, 0.045),
        (-0.12, 0.024, 0.043, 0.0, 0.062),
        (-0.175, 0.023, 0.041, 0.0, 0.077),
        (-0.198, 0.018, 0.033, 0.0, 0.083),
        (-0.205, 0.0, 0.0, 0.0, 0.085),
    ], segments=18), wood))
    gun = S.join(parts, "Gun")
    muzzle = bpy.data.objects.new("GunMuzzle", None)
    muzzle.empty_display_size = 0.03
    bpy.context.scene.collection.objects.link(muzzle)
    muzzle.parent = gun
    muzzle.location = GUN_MUZZLE
    return gun


def build_bike():
    """オートバイ（★3 メカ `バイク`）。

    **原点＝シートの真下の地面**・前輪は -Y（three の +Z）。乗る姿勢（`player.ts` の
    `BIKE_*`）は次の寸法から逆算してあるので、**ここを動かしたら姿勢も直す**：
    シート上面 0.72m ／ハンドルの握り＝原点の 0.66m 前・高さ1.00m・左右 ±0.27m ／
    ステップ＝原点の 0.20m 前・天面の高さ 0.25m。車輪（外径0.6m・軸距1.2m）も旧モデルと同じ。
    """
    tire = S.material("PropTire", (0.03, 0.03, 0.035), roughness=0.9)
    metal = S.material("PropMetal", (0.56, 0.59, 0.63), roughness=0.35)
    dark = S.material("PropDark", (0.055, 0.06, 0.075), roughness=0.5)
    accent = S.material("PropAccent", (1.0, 0.52, 0.04), roughness=0.4)
    lens = S.material("PropLens", (1.0, 0.93, 0.62), roughness=0.2)
    lamp = S.material("PropLamp", (0.8, 0.06, 0.05), roughness=0.3)
    parts = []

    def add(name, bm, mat):
        parts.append(S.bm_to_object(name, bm, mat))

    wheel_z = 0.30
    for tag, wy in (("rear", 0.32), ("front", -0.88)):
        # タイヤ（輪の太さ0.124m＝外径0.6m）・リム（銀の輪）・円盤（暗い）・ハブ
        add(f"tire_{tag}", S.torus((0.0, wy, wheel_z), "X", 0.238, 0.062, seg_major=36, seg_minor=12), tire)
        add(f"rim_{tag}", S.torus((0.0, wy, wheel_z), "X", 0.168, 0.016, seg_major=36, seg_minor=8), metal)
        add(f"disc_{tag}", S.rod((-0.022, wy, wheel_z), (0.022, wy, wheel_z), 0.158, segments=36, round_ends=False), dark)
        add(f"hub_{tag}", S.rod((-0.07, wy, wheel_z), (0.07, wy, wheel_z), 0.048, segments=20), metal)

    # 泥よけ：タイヤの外周に沿った帯（前はアクセント色で上から前へ、後ろは上から後ろへ）
    add("fender_front", S.arc_band((0.0, -0.88, wheel_z), 0.335, 55, 165, 0.078, 0.012, seg_arc=22), accent)
    add("fender_rear", S.arc_band((0.0, 0.32, wheel_z), 0.335, 15, 105, 0.075, 0.012, seg_arc=18), dark)

    # 前フォーク（前輪の軸からハンドルの下へ。上が後ろへ寝ている）
    for sx in (-0.075, 0.075):
        add(f"fork_{sx}", S.rod((sx, -0.88, wheel_z), (sx, -0.695, 0.93), 0.024, segments=12), metal)
    add("fork_clamp", S.rounded_box((0.0, -0.69, 0.935), (0.22, 0.08, 0.05), 0.02), dark)
    # ハンドル（支柱・バー・握り）。握りの位置が乗る姿勢の手の位置
    for sx in (-0.06, 0.06):
        add(f"riser_{sx}", S.rod((sx, -0.688, 0.95), (sx, -0.665, 1.0), 0.016, segments=10), metal)
    add("handlebar", S.rod((-0.22, -0.66, 1.0), (0.22, -0.66, 1.0), 0.016, segments=12), metal)
    for sx in (-1, 1):
        add(f"grip_{sx}", S.rod((sx * 0.21, -0.66, 1.0), (sx * 0.33, -0.66, 1.0), 0.025, segments=12), tire)

    # 前照灯（暗い殻＋明るいレンズ）
    add("headlight_shell", S.lathe_forward(-0.735, [
        (0.0, 0.0, 0.0, 0.0, 0.85),
        (0.0, 0.05, 0.05, 0.0, 0.85),
        (0.05, 0.08, 0.08, 0.0, 0.85),
        (0.095, 0.09, 0.09, 0.0, 0.85),
        (0.1, 0.09, 0.09, 0.0, 0.85),
        (0.1, 0.0, 0.0, 0.0, 0.85),
    ], segments=20), dark)
    add("headlight_lens", S.ellipsoid((0.0, -0.836, 0.85), 0.078, 0.016, 0.078, steps=6, segments=20), lens)

    # 骨組み（ハンドルの下からエンジンの前へ降りる管・タンクの下を通る背骨・後ろの腕）
    add("frame_down", S.rod((0.0, -0.70, 0.89), (0.0, -0.46, 0.38), 0.03, segments=12), dark)
    add("frame_spine", S.rod((0.0, -0.70, 0.9), (0.0, -0.1, 0.58), 0.03, segments=12), dark)
    for sx in (-0.085, 0.085):
        add(f"swingarm_{sx}", S.rod((sx, -0.1, 0.36), (sx, 0.32, wheel_z), 0.024, segments=10), dark)
        add(f"shock_{sx}", S.rod((sx, 0.2, 0.33), (sx, 0.04, 0.6), 0.02, segments=10), metal)

    # 燃料タンク（後ろほど細い＝またがった膝の間に収まる）
    add("tank", S.lathe_forward(-0.12, [
        (0.0, 0.0, 0.0, 0.0, 0.64),
        (0.015, 0.045, 0.045, 0.0, 0.64),
        (0.05, 0.08, 0.075, 0.0, 0.645),
        (0.11, 0.105, 0.095, 0.0, 0.645),
        (0.2, 0.122, 0.105, 0.0, 0.64),
        (0.32, 0.125, 0.102, 0.0, 0.635),
        (0.41, 0.11, 0.088, 0.0, 0.63),
        (0.465, 0.08, 0.062, 0.0, 0.625),
        (0.495, 0.035, 0.03, 0.0, 0.62),
        (0.5, 0.0, 0.0, 0.0, 0.62),
    ], segments=20), accent)
    # シート（上面0.72m＝乗る腰の高さ）
    add("seat", S.rounded_box((0.0, 0.08, 0.675), (0.25, 0.52, 0.09), 0.04), dark)
    # 座席の下のサイドカバー
    add("side_cover", S.rounded_box((0.0, 0.07, 0.535), (0.2, 0.38, 0.14), 0.05), accent)
    # テールカウルと尾灯
    add("tail_cowl", S.lathe_forward(0.53, [
        (0.0, 0.0, 0.0, 0.0, 0.70),
        (0.012, 0.045, 0.03, 0.0, 0.70),
        (0.06, 0.085, 0.048, 0.0, 0.70),
        (0.14, 0.11, 0.055, 0.0, 0.69),
        (0.21, 0.12, 0.05, 0.0, 0.68),
        (0.22, 0.0, 0.0, 0.0, 0.68),
    ], segments=18), accent)
    add("tail_lamp", S.ellipsoid((0.0, 0.528, 0.70), 0.042, 0.012, 0.022, steps=6, segments=14), lamp)

    # エンジン（箱＋冷却フィン3枚）
    add("engine", S.rounded_box((0.0, -0.29, 0.35), (0.24, 0.34, 0.22), 0.05), metal)
    add("engine_head", S.rounded_box((0.0, -0.40, 0.47), (0.19, 0.14, 0.1), 0.03), metal)
    for k, fz in enumerate((0.435, 0.47, 0.505)):
        add(f"fin_{k}", S.rounded_box((0.0, -0.40, fz), (0.25, 0.17, 0.012), 0.005), dark)
    # 排気管（エンジンの前から右下へ降り、後ろへ伸びてマフラーになる）
    # （右のステップ＝天面0.25m・下面0.21m の下をくぐる高さで通す）
    add("exhaust_header", S.rod((0.07, -0.47, 0.40), (0.15, -0.40, 0.17), 0.022, segments=12), metal)
    add("exhaust_pipe", S.rod((0.15, -0.40, 0.17), (0.155, 0.02, 0.18), 0.022, segments=12), metal)
    add("muffler", S.tube((0.155, -0.02, 0.18), (0.17, 0.47, 0.28), [
        (0.0, 0.0), (0.0, 0.03), (0.08, 0.045), (0.92, 0.045), (1.0, 0.038), (1.0, 0.0),
    ], segments=16), metal)
    add("muffler_end", S.rod((0.1695, 0.465, 0.279), (0.1705, 0.478, 0.282), 0.026, segments=14, round_ends=False), dark)

    # ステップ（天面0.25m＝乗る足の裏の高さ）
    for sx in (-1, 1):
        add(f"step_{sx}", S.rod((sx * 0.09, -0.2, 0.23), (sx * 0.25, -0.2, 0.23), 0.02, segments=10), dark)

    return S.join(parts, "Bike")


def build(repo):
    path = os.path.join(repo, "assets-src", "props.blend")
    bpy.ops.wm.open_mainfile(filepath=path)
    remove_existing()
    made = [build_bat(), build_glove(), build_mitt(), build_gun(), build_bike()]
    info = {}
    for obj in made:
        info[obj.name] = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        obj.data.name = obj.name + "Mesh"
    S.save_blend(path)
    glb = os.path.join(repo, "src", "assets", "props.glb")
    S.export_glb(glb)
    info["size"] = os.path.getsize(glb)
    return info
