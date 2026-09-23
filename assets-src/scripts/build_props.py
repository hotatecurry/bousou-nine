"""持ち物の部品（バット・グラブ・キャッチャーミット）を props.blend に足して書き出す。

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
NEW_PARTS = ("Bat", "Glove", "Mitt")


def remove_existing():
    for name in NEW_PARTS:
        obj = bpy.data.objects.get(name)
        if obj is not None:
            mesh = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            if mesh is not None and mesh.users == 0:
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


def build(repo):
    path = os.path.join(repo, "assets-src", "props.blend")
    bpy.ops.wm.open_mainfile(filepath=path)
    remove_existing()
    made = [build_bat(), build_glove(), build_mitt()]
    info = {}
    for obj in made:
        info[obj.name] = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        obj.data.name = obj.name + "Mesh"
    S.save_blend(path)
    glb = os.path.join(repo, "src", "assets", "props.glb")
    S.export_glb(glb)
    info["size"] = os.path.getsize(glb)
    return info
