"""Blender 用の形状ヘルパー（選手モデル・持ち物の作り直しで使う）。

MCP から `import blender_shapes` して使う。すべて**ワールド座標で形を作ってから、
オブジェクトの原点を関節（ピボット）へ移す**という順で組む＝寸法を書くときに
親子の相対座標を考えなくてよい。

形はほぼ「断面が楕円の回転体（lathe）」だけで作る：腕・脚・胴・頭・帽子の山は
どれも上から下へ楕円の輪を並べて閉じれば書ける。なめらかさは輪の数と
スムーズシェードで出す（サブディビジョンは使わない＝頂点数を読める範囲に保つ）。
"""
import math

import bmesh
import bpy
from mathutils import Vector


# ---- 材質 ----

def material(name, rgb, roughness=0.8):
    """名前で材質を1つ作る（同名があれば使い回す）。three 側は名前で見分ける。"""
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return mat


# ---- 回転体 ----

def ring_points(z, rx, ry, cx=0.0, cy=0.0, segments=16, phase=0.0):
    pts = []
    for i in range(segments):
        t = 2.0 * math.pi * i / segments + phase
        pts.append((cx + rx * math.cos(t), cy + ry * math.sin(t), z))
    return pts


def lathe(rings, segments=16, close_top=True, close_bottom=True):
    """楕円の輪を上から下へ並べた閉じた面（bmesh を返す）。

    rings: [(z, rx, ry), (z, rx, ry, cx, cy), ...] を上から下の順に。
    半径が 1e-4 未満の輪は極（1点）として扱う。
    """
    bm = bmesh.new()
    loops = []
    for ring in rings:
        z, rx, ry = ring[0], ring[1], ring[2]
        cx = ring[3] if len(ring) > 3 else 0.0
        cy = ring[4] if len(ring) > 4 else 0.0
        if max(rx, ry) < 1e-4:
            loops.append([bm.verts.new((cx, cy, z))])
        else:
            loops.append([bm.verts.new(p) for p in ring_points(z, rx, ry, cx, cy, segments)])
    for a, b in zip(loops, loops[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        if len(a) == 1:
            for i in range(segments):
                bm.faces.new((a[0], b[(i + 1) % segments], b[i]))
        elif len(b) == 1:
            for i in range(segments):
                bm.faces.new((a[i], a[(i + 1) % segments], b[0]))
        else:
            for i in range(segments):
                j = (i + 1) % segments
                bm.faces.new((a[i], a[j], b[j], b[i]))
    if close_top and len(loops[0]) > 1:
        bm.faces.new(list(reversed(loops[0])))
    if close_bottom and len(loops[-1]) > 1:
        bm.faces.new(loops[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def dome_rings(z_equator, rx, ry, rz, cx=0.0, cy=0.0, steps=6, top=True):
    """半楕円体の輪（赤道から極まで）。top=True なら上向きのドーム、False なら下向き。"""
    rings = []
    for k in range(steps + 1):
        a = (math.pi / 2) * k / steps
        z = z_equator + (rz * math.sin(a) if top else -rz * math.sin(a))
        f = math.cos(a)
        rings.append((z, rx * f, ry * f, cx, cy))
    if top:
        rings.reverse()
    return rings


def ellipsoid_rings(center, rx, ry, rz, steps=10):
    """楕円体の輪（上の極から下の極まで）。"""
    cx, cy, cz = center
    rings = []
    for k in range(steps + 1):
        a = math.pi / 2 - math.pi * k / steps
        z = cz + rz * math.sin(a)
        f = math.cos(a)
        rings.append((z, rx * f, ry * f, cx, cy))
    return rings


def capsule_rings(x, y, z_top, z_bottom, r_top, r_bottom, mid=None, cap_steps=4, ry_scale=1.0):
    """上下が半球の筒（腕・脚の1節）。mid=[(z, r), ...] で途中の太さを足せる。"""
    rings = []
    for k in range(cap_steps, -1, -1):
        a = (math.pi / 2) * k / cap_steps
        rings.append((z_top + r_top * math.sin(a), r_top * math.cos(a), r_top * math.cos(a) * ry_scale, x, y))
    for (z, r) in (mid or []):
        rings.append((z, r, r * ry_scale, x, y))
    for k in range(0, cap_steps + 1):
        a = (math.pi / 2) * k / cap_steps
        rings.append((z_bottom - r_bottom * math.sin(a), r_bottom * math.cos(a), r_bottom * math.cos(a) * ry_scale, x, y))
    return rings


# ---- オブジェクト ----

def bm_to_object(name, bm, mat, collection=None):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def join(objects, name, collection=None):
    """複数のオブジェクトを1つにまとめる（材質はそれぞれ残る）。

    `bpy.ops.object.join` は MCP の実行文脈では poll に落ちるので、bmesh で直接束ねる
    （部品はどれも原点に置いたまま形をワールド座標で持っているので、変換は要らない）。
    """
    mats = []
    bm = bmesh.new()
    for o in objects:
        me = o.data
        remap = []
        for m in me.materials:
            if m not in mats:
                mats.append(m)
            remap.append(mats.index(m))
        for poly in me.polygons:
            poly.material_index = remap[poly.material_index] if remap else 0
        me.transform(o.matrix_world)
        bm.from_mesh(me)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for m in mats:
        mesh.materials.append(m)
    for poly in mesh.polygons:
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(obj)
    for o in objects:
        old = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if old.users == 0:
            bpy.data.meshes.remove(old)
    return obj


def set_pivot(obj, pivot):
    """メッシュの形はワールドに置いたまま、原点だけを pivot（ワールド座標）へ移す。"""
    p = Vector(pivot)
    obj.data.transform(__import__("mathutils").Matrix.Translation(-p))
    obj.location = p


def parent_keep(child, parent):
    """親子付け（回転の無い階層なので、位置の差をそのままローカル位置にする）。"""
    world = child.location.copy()
    child.parent = parent
    child.matrix_parent_inverse.identity()
    child.location = world - parent_world_location(parent)


def parent_world_location(obj):
    loc = obj.location.copy()
    p = obj.parent
    while p is not None:
        loc += p.location
        p = p.parent
    return loc


def mirror_x(bm):
    """bmesh を X について鏡像にする（左右の手足を片方から作る）。面の向きは直す。"""
    for v in bm.verts:
        v.co.x = -v.co.x
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    return bm


def export_glb(path, **settings):
    """glTF（.glb）へ書き出す。exporter は画面の文脈（active_object）を読むので、
    MCP から呼ぶときはウィンドウの文脈を与えてから呼ぶ。"""
    wm = bpy.context.window_manager
    win = wm.windows[0] if wm.windows else None
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=False,
        export_yup=True,
        export_texcoords=False,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )
    kwargs.update(settings)
    if win is None:
        return bpy.ops.export_scene.gltf(**kwargs)
    area = next((a for a in win.screen.areas if a.type == "VIEW_3D"), win.screen.areas[0])
    with bpy.context.temp_override(window=win, screen=win.screen, area=area):
        return bpy.ops.export_scene.gltf(**kwargs)


def save_blend(path):
    wm = bpy.context.window_manager
    win = wm.windows[0] if wm.windows else None
    if win is None:
        return bpy.ops.wm.save_as_mainfile(filepath=path)
    with bpy.context.temp_override(window=win, screen=win.screen):
        return bpy.ops.wm.save_as_mainfile(filepath=path)


def clear_scene():
    bpy.ops.wm.read_homefile(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for item in list(block):
            if item.users == 0:
                block.remove(item)
