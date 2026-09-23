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


# ---- 置き方（持ち物で使う：回転体を寝かせる・角を丸めた箱・輪） ----

def transform_bm(bm, matrix):
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    return bm


def lathe_forward(y0, rings, segments=16):
    """前（-Y）へ伸びる回転体。rings: [(t, rx, rz, cx, cz), ...]。

    t は y0 から前へ進んだ距離（Y = y0 - t）、rx は左右の半幅、rz は上下の半高、
    (cx, cz) は断面の中心。Z軸の回転体を X軸まわりに +90° 倒して作る
    （+Z → -Y、断面の Y 半径 → 上下）。
    """
    import mathutils
    bm = lathe([(r[0], r[1], r[2], r[3] if len(r) > 3 else 0.0, r[4] if len(r) > 4 else 0.0) for r in rings], segments=segments)
    rot = mathutils.Matrix.Rotation(math.pi / 2, 4, "X")
    return transform_bm(bm, mathutils.Matrix.Translation((0.0, y0, 0.0)) @ rot)


def tube(p0, p1, profile, segments=12):
    """p0 → p1 の軸に沿った回転体。profile: [(s, r), ...]（s=0..1 は軸上の位置、r は半径）。
    半径が 0 の輪は極（閉じた先端）になる。"""
    import mathutils
    a = Vector(p0)
    b = Vector(p1)
    d = b - a
    length = d.length
    rings = [(s * length, r, r) for (s, r) in profile]
    bm = lathe(rings, segments=segments)
    q = Vector((0.0, 0.0, 1.0)).rotation_difference(d.normalized())
    return transform_bm(bm, mathutils.Matrix.Translation(a) @ q.to_matrix().to_4x4())


def rod(p0, p1, r, segments=12, round_ends=True):
    """太さ一定の棒（端は丸めるか平らにする）。"""
    import mathutils
    d = (Vector(p1) - Vector(p0))
    length = d.length
    if not round_ends:
        return tube(p0, p1, [(0.0, 0.0), (0.0, r), (1.0, r), (1.0, 0.0)], segments)
    cap = min(r, length / 2) / length
    prof = [(0.0, 0.0)]
    for k in range(1, 4):
        a = (math.pi / 2) * k / 3
        prof.append((cap * (1 - math.cos(a)), r * math.sin(a)))
    for k in range(3, 0, -1):
        a = (math.pi / 2) * k / 3
        prof.append((1 - cap * (1 - math.cos(a)), r * math.sin(a)))
    prof.append((1.0, 0.0))
    return tube(p0, p1, prof, segments)


def rounded_box(center, size, radius, segments=3, rotation=(0.0, 0.0, 0.0)):
    """角を丸めた箱（トゥーンの縁が角でぎざぎざにならない）。rotation は XYZ オイラー角。"""
    import mathutils
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    transform_bm(bm, mathutils.Matrix.Diagonal((size[0], size[1], size[2], 1.0)))
    r = min(radius, min(size) * 0.49)
    bmesh.ops.bevel(
        bm,
        geom=list(bm.verts) + list(bm.edges),
        offset=r,
        offset_type="OFFSET",
        segments=segments,
        profile=0.5,
        affect="EDGES",
        clamp_overlap=True,
    )
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    m = mathutils.Matrix.Translation(center) @ mathutils.Euler(rotation, "XYZ").to_matrix().to_4x4()
    return transform_bm(bm, m)


def torus(center, axis, major, minor, seg_major=32, seg_minor=12):
    """輪（タイヤ・用心金）。axis は輪の軸（'X'/'Y'/'Z'）。"""
    import mathutils
    bm = bmesh.new()
    loops = []
    for i in range(seg_major):
        u = 2 * math.pi * i / seg_major
        ring = []
        for j in range(seg_minor):
            v = 2 * math.pi * j / seg_minor
            rr = major + minor * math.cos(v)
            ring.append(bm.verts.new((rr * math.cos(u), rr * math.sin(u), minor * math.sin(v))))
        loops.append(ring)
    for i in range(seg_major):
        a = loops[i]
        b = loops[(i + 1) % seg_major]
        for j in range(seg_minor):
            k = (j + 1) % seg_minor
            bm.faces.new((a[j], b[j], b[k], a[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    to_axis = {
        "Z": mathutils.Matrix.Identity(4),
        "X": mathutils.Matrix.Rotation(math.pi / 2, 4, "Y"),
        "Y": mathutils.Matrix.Rotation(math.pi / 2, 4, "X"),
    }[axis]
    return transform_bm(bm, mathutils.Matrix.Translation(center) @ to_axis)


def ellipsoid(center, rx, ry, rz, steps=10, segments=16):
    return lathe(ellipsoid_rings(center, rx, ry, rz, steps=steps), segments=segments)


def arc_band(center, radius, a0, a1, half_width, half_thick, seg_arc=20, seg_cross=12):
    """X軸まわりの円弧に沿った帯（泥よけ）。断面は楕円（左右 half_width・厚み half_thick）。

    角度は YZ 平面で測る（0 = +Y、90° = 真上）。両端は閉じる。
    """
    bm = bmesh.new()
    cx, cy, cz = center
    loops = []
    for i in range(seg_arc + 1):
        a = math.radians(a0 + (a1 - a0) * i / seg_arc)
        ny, nz = math.cos(a), math.sin(a)  # 外向き（半径方向）
        ring = []
        for j in range(seg_cross):
            v = 2 * math.pi * j / seg_cross
            x = half_width * math.cos(v)
            rr = radius + half_thick * math.sin(v)
            ring.append(bm.verts.new((cx + x, cy + rr * ny, cz + rr * nz)))
        loops.append(ring)
    for a, b in zip(loops, loops[1:]):
        for j in range(seg_cross):
            k = (j + 1) % seg_cross
            bm.faces.new((a[j], a[k], b[k], b[j]))
    bm.faces.new(loops[0])
    bm.faces.new(list(reversed(loops[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


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
