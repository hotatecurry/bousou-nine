"""選手モデルを組み立てて書き出す（ブラッシュアップ：グラフィック）。

Blender MCP から実行する：
    import sys; sys.path.insert(0, r"<repo>/assets-src/scripts")
    import build_player; build_player.build(r"<repo>")

**関節の名前・位置・親子関係は旧モデルと同一**（`src/entities/player.ts` の手続きアニメが
この階層に直接載っている）。寸法の約束（player.ts の定数と一致させる）：
  股関節→膝 0.45 / 膝→足首 0.385 / 足首→足の裏 0.085 / 肩→肘 0.28 / 肘→手 0.345
  肩の高さ 1.42（胴の原点から 0.5）・首の付け根 1.47（胴の原点から 0.55）・腰 0.92

Blender の座標（Z上・正面 -Y）は glTF で three の（Y上・正面 +Z）になる。
材質の名前は three 側の約束：`Uniform` だけがチーム色に塗り替えられる（靴下・帽子・袖も
この材質なのでチーム色になる）。`Eye` と `Brow` は輪郭線を付けない（小さすぎて潰れる）。
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

SEG = 16
# 頭と帽子を首の付け根を中心に何倍で描くか（実寸の頭では鳥瞰で顔が潰れる）
HEAD_SCALE = 1.14

PIVOTS = {
    "Pelvis": (0.0, 0.0, 0.92),
    "Torso": (0.0, 0.0, 0.92),
    "Head": (0.0, 0.0, 1.47),
    "Cap": (0.0, 0.0, 1.47),
    "ArmUpperL": (-0.2, 0.0, 1.42),
    "ArmLowerL": (-0.2, 0.0, 1.14),
    "ArmUpperR": (0.2, 0.0, 1.42),
    "ArmLowerR": (0.2, 0.0, 1.14),
    "LegUpperL": (-0.085, 0.0, 0.92),
    "LegLowerL": (-0.085, 0.0, 0.47),
    "FootL": (-0.085, 0.0, 0.085),
    "LegUpperR": (0.085, 0.0, 0.92),
    "LegLowerR": (0.085, 0.0, 0.47),
    "FootR": (0.085, 0.0, 0.085),
}

PARENTS = {
    "Torso": "Pelvis",
    "Head": "Torso",
    "Cap": "Head",
    "ArmUpperL": "Torso",
    "ArmLowerL": "ArmUpperL",
    "ArmUpperR": "Torso",
    "ArmLowerR": "ArmUpperR",
    "LegUpperL": "Pelvis",
    "LegLowerL": "LegUpperL",
    "FootL": "LegLowerL",
    "LegUpperR": "Pelvis",
    "LegLowerR": "LegUpperR",
    "FootR": "LegLowerR",
}


def materials():
    return {
        "Uniform": S.material("Uniform", (0.72, 0.12, 0.12)),
        "Pants": S.material("Pants", (0.94, 0.94, 0.91)),
        "Skin": S.material("Skin", (0.96, 0.74, 0.58)),
        "Shoes": S.material("Shoes", (0.07, 0.07, 0.09)),
        "Sole": S.material("Sole", (0.92, 0.92, 0.9)),
        "Belt": S.material("Belt", (0.1, 0.1, 0.16)),
        "Eye": S.material("Eye", (0.04, 0.035, 0.05)),
        "Brow": S.material("Brow", (0.14, 0.09, 0.06)),
        "Trim": S.material("Trim", (0.98, 0.98, 0.98)),
    }


def part(name, rings, mat, segments=SEG, **kw):
    return S.bm_to_object(name, S.lathe(rings, segments=segments, **kw), mat)


# ---- 部位ごとの形（ワールド座標。左＝-X 側で作り、右は鏡像） ----

def build_pelvis(M):
    hips = part("hips", [
        (0.985, 0.0, 0.0),
        (0.982, 0.08, 0.055),
        (0.97, 0.132, 0.092),
        (0.93, 0.150, 0.104),
        (0.87, 0.158, 0.110),
        (0.82, 0.150, 0.106),
        (0.785, 0.128, 0.094),
        (0.765, 0.09, 0.07),
        (0.755, 0.0, 0.0),
    ], M["Pants"])
    belt = part("belt", [
        (0.976, 0.142, 0.099),
        (0.972, 0.157, 0.110),
        (0.936, 0.159, 0.112),
        (0.931, 0.145, 0.101),
    ], M["Belt"], segments=24)
    buckle = part("buckle", S.ellipsoid_rings((0.0, -0.112, 0.954), 0.022, 0.008, 0.016, steps=6), M["Trim"], segments=12)
    return [hips, belt, buckle]


def build_torso(M):
    body = part("body", [
        (1.515, 0.0, 0.0),
        (1.512, 0.06, 0.05),
        (1.50, 0.12, 0.078),
        (1.48, 0.172, 0.097),
        (1.45, 0.203, 0.109),
        (1.40, 0.212, 0.116, 0.0, -0.004),
        (1.34, 0.205, 0.122, 0.0, -0.008),
        (1.26, 0.192, 0.124, 0.0, -0.010),
        (1.16, 0.172, 0.116, 0.0, -0.006),
        (1.06, 0.155, 0.106),
        (0.98, 0.148, 0.102),
        (0.93, 0.144, 0.099),
        (0.90, 0.12, 0.085),
        (0.885, 0.0, 0.0),
    ], M["Uniform"], segments=20)
    collar = part("collar", [
        (1.53, 0.055, 0.049),
        (1.527, 0.063, 0.056, 0.0, 0.002),
        (1.512, 0.066, 0.059, 0.0, 0.002),
        (1.506, 0.058, 0.052),
    ], M["Trim"], segments=20)
    return [body, collar]


def build_head(M):
    neck = part("neck", S.capsule_rings(0.0, 0.006, 1.56, 1.45, 0.05, 0.052, cap_steps=2), M["Skin"])
    head = part("head", S.ellipsoid_rings((0.0, -0.004, 1.648), 0.106, 0.114, 0.128, steps=12), M["Skin"], segments=20)
    objs = [neck, head]
    for sx in (-1, 1):
        objs.append(part("ear", S.ellipsoid_rings((sx * 0.104, 0.012, 1.642), 0.02, 0.028, 0.036, steps=6), M["Skin"], segments=10))
        objs.append(part("eye", S.ellipsoid_rings((sx * 0.037, -0.1045, 1.656), 0.0135, 0.008, 0.021, steps=6), M["Eye"], segments=10))
        objs.append(part("brow", S.ellipsoid_rings((sx * 0.038, -0.1, 1.692), 0.022, 0.006, 0.0065, steps=4), M["Brow"], segments=10))
    objs.append(part("nose", S.ellipsoid_rings((0.0, -0.117, 1.628), 0.012, 0.012, 0.016, steps=5), M["Skin"], segments=10))
    return objs


def brim_mesh(M):
    """帽子のつば（前だけの半楕円。両端が少し垂れる）。上面・下面・縁で閉じた板。"""
    import math

    import bmesh

    bm = bmesh.new()
    n = 16
    thick = 0.011
    top_in, top_out, bot_in, bot_out = [], [], [], []
    for i in range(n + 1):
        t = math.pi + math.pi * i / n  # π..2π（-Y 側の半周）
        c, s = math.cos(t), math.sin(t)
        droop = 0.006 * c * c + 0.008 * (-s)
        z = 1.711 - droop
        xi, yi = 0.110 * c, 0.004 + 0.116 * s
        xo, yo = 0.118 * c, 0.004 + 0.232 * s
        top_in.append(bm.verts.new((xi, yi, z + thick / 2)))
        top_out.append(bm.verts.new((xo, yo, z + thick / 2 - 0.004)))
        bot_in.append(bm.verts.new((xi, yi, z - thick / 2)))
        bot_out.append(bm.verts.new((xo, yo, z - thick / 2 - 0.004)))
    for i in range(n):
        bm.faces.new((top_in[i], top_in[i + 1], top_out[i + 1], top_out[i]))
        bm.faces.new((bot_in[i], bot_out[i], bot_out[i + 1], bot_in[i + 1]))
        bm.faces.new((top_out[i], top_out[i + 1], bot_out[i + 1], bot_out[i]))
        bm.faces.new((top_in[i], bot_in[i], bot_in[i + 1], top_in[i + 1]))
    bm.faces.new((top_in[0], top_out[0], bot_out[0], bot_in[0]))
    bm.faces.new((top_in[n], bot_in[n], bot_out[n], top_out[n]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return S.bm_to_object("brim", bm, M["Uniform"])


def build_cap(M):
    crown_rings = S.dome_rings(1.705, 0.117, 0.124, 0.102, cy=0.004, steps=7, top=True)
    crown_rings += [(1.699, 0.112, 0.119, 0.0, 0.004), (1.696, 0.0, 0.0, 0.0, 0.004)]
    crown = part("crown", crown_rings, M["Uniform"], segments=24)
    button = part("button", S.ellipsoid_rings((0.0, 0.004, 1.806), 0.014, 0.014, 0.01, steps=4), M["Uniform"], segments=10)
    logo = part("logo", S.ellipsoid_rings((0.0, -0.109, 1.752), 0.019, 0.006, 0.017, steps=5), M["Trim"], segments=12)
    return [crown, button, brim_mesh(M), logo]


def build_arm_upper(M, sx):
    x = sx * 0.2
    sleeve = part("sleeve", [
        (1.472, 0.0, 0.0, x, 0.0),
        (1.469, 0.03, 0.03, x, 0.0),
        (1.458, 0.05, 0.05, x, 0.0),
        (1.44, 0.062, 0.062, x, 0.0),
        (1.40, 0.068, 0.068, x, 0.0),
        (1.34, 0.068, 0.068, x, 0.0),
        (1.29, 0.067, 0.067, x, 0.0),
        (1.272, 0.066, 0.066, x, 0.0),
        (1.268, 0.05, 0.05, x, 0.0),
        (1.266, 0.0, 0.0, x, 0.0),
    ], M["Uniform"])
    cuff = part("cuff", [
        (1.286, 0.0695, 0.0695, x, 0.0),
        (1.268, 0.0695, 0.0695, x, 0.0),
    ], M["Trim"], segments=20)
    arm = part("upperarm", S.capsule_rings(x, 0.0, 1.33, 1.14, 0.053, 0.048, mid=[(1.25, 0.054), (1.18, 0.051)], cap_steps=3), M["Skin"])
    return [sleeve, cuff, arm]


def build_arm_lower(M, sx):
    x = sx * 0.2
    fore = part("forearm", S.capsule_rings(x, 0.0, 1.14, 0.85, 0.049, 0.037, mid=[(1.08, 0.05), (0.97, 0.045), (0.89, 0.04)], cap_steps=3), M["Skin"])
    hand = part("hand", S.ellipsoid_rings((x, -0.004, 0.80), 0.035, 0.047, 0.057, steps=8), M["Skin"], segments=14)
    return [fore, hand]


def build_leg_upper(M, sx):
    x = sx * 0.085
    thigh = part("thigh", S.capsule_rings(x, 0.0, 0.90, 0.47, 0.086, 0.07,
                                          mid=[(0.85, 0.088), (0.72, 0.083), (0.58, 0.076)], cap_steps=4), M["Pants"])
    return [thigh]


def build_leg_lower(M, sx):
    x = sx * 0.085
    knee = part("kneepants", [
        (0.52, 0.0, 0.0, x, 0.0),
        (0.515, 0.04, 0.04, x, 0.0),
        (0.50, 0.062, 0.062, x, 0.0),
        (0.47, 0.069, 0.069, x, 0.0),
        (0.43, 0.068, 0.068, x, 0.0),
        (0.38, 0.066, 0.066, x, 0.0),
        (0.345, 0.064, 0.064, x, 0.0),
        (0.336, 0.057, 0.057, x, 0.0),
        (0.332, 0.0, 0.0, x, 0.0),
    ], M["Pants"])
    sock = part("sock", S.capsule_rings(x, 0.0, 0.35, 0.10, 0.053, 0.037,
                                        mid=[(0.30, 0.051), (0.21, 0.045), (0.15, 0.04)], cap_steps=2), M["Uniform"])
    return [knee, sock]


def build_foot(M, sx):
    x = sx * 0.085
    shoe = part("shoe", [
        (0.108, 0.0, 0.0, x, -0.02),
        (0.104, 0.03, 0.055, x, -0.035),
        (0.09, 0.046, 0.098, x, -0.052),
        (0.064, 0.053, 0.118, x, -0.064),
        (0.036, 0.055, 0.124, x, -0.068),
        (0.016, 0.055, 0.124, x, -0.068),
        (0.014, 0.0, 0.0, x, -0.068),
    ], M["Shoes"], segments=18)
    sole = part("sole", [
        (0.017, 0.057, 0.127, x, -0.068),
        (0.0, 0.056, 0.126, x, -0.068),
    ], M["Sole"], segments=18)
    return [shoe, sole]


# ---- 組み立て ----

def assemble(objs_by_joint):
    joints = {}
    for name, objs in objs_by_joint.items():
        obj = S.join(objs, name)
        obj.data.name = name + "Mesh"  # 頂点データの名前を関節名と分ける（three の名前衝突を避ける）
        S.set_pivot(obj, PIVOTS[name])
        joints[name] = obj
    # 親子（親から順に。位置は親からの差）
    order = ["Pelvis", "Torso", "Head", "Cap", "ArmUpperL", "ArmLowerL", "ArmUpperR", "ArmLowerR",
             "LegUpperL", "LegLowerL", "FootL", "LegUpperR", "LegLowerR", "FootR"]
    world = {n: joints[n].location.copy() for n in order}
    for n in order:
        p = PARENTS.get(n)
        if p is None:
            continue
        child = joints[n]
        child.parent = joints[p]
        child.matrix_parent_inverse.identity()
        child.location = world[n] - world[p]
    return joints


def build(repo):
    S.clear_scene()
    M = materials()
    parts = {
        "Pelvis": build_pelvis(M),
        "Torso": build_torso(M),
        "Head": build_head(M),
        "Cap": build_cap(M),
        "ArmUpperL": build_arm_upper(M, -1),
        "ArmLowerL": build_arm_lower(M, -1),
        "ArmUpperR": build_arm_upper(M, 1),
        "ArmLowerR": build_arm_lower(M, 1),
        "LegUpperL": build_leg_upper(M, -1),
        "LegLowerL": build_leg_lower(M, -1),
        "FootL": build_foot(M, -1),
        "LegUpperR": build_leg_upper(M, 1),
        "LegLowerR": build_leg_lower(M, 1),
        "FootR": build_foot(M, 1),
    }
    joints = assemble(parts)
    from mathutils import Matrix
    for name in ("Head", "Cap"):
        joints[name].data.transform(Matrix.Scale(HEAD_SCALE, 4))
    bpy.context.view_layer.update()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in joints.values())
    blend_path = os.path.join(repo, "assets-src", "player.blend")
    glb_path = os.path.join(repo, "src", "assets", "player.glb")
    S.save_blend(blend_path)
    S.export_glb(glb_path)
    return {"tris": tris, "blend": blend_path, "glb": glb_path, "size": os.path.getsize(glb_path)}
