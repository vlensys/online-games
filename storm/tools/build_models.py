# Storm Royale model build: generates every in-game model in Blender and exports one GLB.
#
#   blender -b --factory-startup --python storm/tools/build_models.py
#
# Writes storm/assets/models.glb. The game loads it at boot (js/client/models.js) and falls back
# to its procedural shapes if the file is missing, so re-run this after editing any model.
#
# Conventions (must match js/client/views.js):
# - Coordinates are written in three.js space (y up, characters face -z). They are converted
#   to Blender space just before the mesh is created, and the glTF exporter converts back.
# - Colors are per-face vertex colors. Parts that the game tints per instance (car paint,
#   outfits, rarity accents...) are modelled white/grey so the tint multiplies through.
# - Each mesh keeps the pivot of the procedural model it replaces (limbs hang from the hip or
#   shoulder, weapons sit at the grip, the chest lid hinges at its back edge, ...).
import bmesh
import bpy
import math
import os
import random
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'assets', 'models.glb')
PI = math.pi


# ------------------------------------------------------------------ helpers
def lin(h, s=1.0):
    """'#rrggbb' (sRGB) -> linear RGB tuple, times a shade factor (same as THREE.Color.set)."""
    h = h.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        out.append(c * s)
    return tuple(out)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def xf(x=0.0, y=0.0, z=0.0, rx=0.0, ry=0.0, rz=0.0, sx=1.0, sy=1.0, sz=1.0):
    """Same order as models.js part(): scale, rotateX, rotateZ, rotateY, translate."""
    return (Matrix.Translation((x, y, z)) @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rz, 4, 'Z')
            @ Matrix.Rotation(rx, 4, 'X') @ Matrix.Diagonal((sx, sy, sz, 1)))


def bevel(bm, amount, seg=1, edges=None):
    if amount <= 0:
        return bm
    geom = list(edges) if edges is not None else bm.edges[:]
    if not geom:
        return bm
    bmesh.ops.bevel(bm, geom=geom, offset=amount, offset_type='OFFSET', segments=seg, profile=0.5,
                    affect='EDGES', clamp_overlap=True)
    return bm


def p_box(w, h, d, bev=0.0, seg=1):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * w, v.co.y * h, v.co.z * d))
    return bevel(bm, min(bev, min(w, h, d) * 0.45), seg)


def p_frustum(wb, db, wt, dt, h, bev=0.0, seg=1):
    """Box whose bottom is wb x db and top wt x dt (centered, height h along y)."""
    bm = p_box(1, 1, 1)
    for v in bm.verts:
        top = v.co.y > 0
        v.co = Vector((v.co.x * (wt if top else wb), v.co.y * h, v.co.z * (dt if top else db)))
    return bevel(bm, min(bev, min(wb, wt, db, dt, h) * 0.45), seg)


def p_cyl(rt, rb, h, seg, bev=0.0):
    """Cylinder along y like THREE.CylinderGeometry (rt top radius, rb bottom radius)."""
    bm = bmesh.new()
    cone = rt < 1e-3 or rb < 1e-3
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=max(rb, 1e-3),
                          radius2=max(rt, 1e-3), depth=h, matrix=Matrix.Rotation(-PI / 2, 4, 'X'))
    if cone:
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.004)
    elif bev > 0:
        rim = [e for e in bm.edges if abs(e.verts[0].co.y - e.verts[1].co.y) < 1e-5]
        bevel(bm, min(bev, h * 0.45, min(rt, rb) * 0.45), 1, rim)
    return bm


def p_ico(r, sub=1):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    return bm


def p_sphere(r, u=12, v=8):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    return bm


def p_prism(profile, width):
    """Extrude a convex 2D profile [(z, y), ...] (counter-clockwise seen from +x) along x."""
    bm = bmesh.new()
    a = [bm.verts.new((-width / 2, y, z)) for z, y in profile]
    b = [bm.verts.new((width / 2, y, z)) for z, y in profile]
    n = len(profile)
    bm.faces.new(list(reversed(a)))
    bm.faces.new(b)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm


def p_arch(width, depth, base, arch, seg=8):
    """Chest-lid shape: a box of height `base` topped by a half-ellipse of height `arch`."""
    pts = [(depth / 2, 0.0)]
    for i in range(seg + 1):
        a = PI * i / seg
        pts.append((math.cos(a) * depth / 2, base + math.sin(a) * arch))
    pts.append((-depth / 2, 0.0))
    # first arc point duplicates the (depth/2, base) corner only when base == 0
    clean = []
    for p in pts:
        if not clean or (abs(clean[-1][0] - p[0]) > 1e-6 or abs(clean[-1][1] - p[1]) > 1e-6):
            clean.append(p)
    return p_prism(clean, width)


def jitter(bm, amt, seed):
    rnd = random.Random(seed)
    for v in bm.verts:
        v.co += Vector(((rnd.random() - 0.5) * amt, (rnd.random() - 0.5) * amt, (rnd.random() - 0.5) * amt))
    return bm


def hashf(v, seed=0):
    """Deterministic 0..1 noise from a position (per-face color variation)."""
    k = math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed * 4.1) * 43758.5453
    return k - math.floor(k)


def vary(hexes, amount=0.08, under=0.62, seed=0):
    """Color function: pick from hexes per face, small brightness noise, darker undersides."""
    cols = [lin(h) for h in hexes]

    def f(c, n):
        r = hashf(c, seed)
        base = cols[int(r * len(cols)) % len(cols)]
        s = 1 - amount + 2 * amount * hashf(c, seed + 7)
        if n.y < -0.3:
            s *= under
        return tuple(x * s for x in base)
    return f


class Model:
    def __init__(self, name):
        self.name = name
        self.V = []
        self.F = []
        self.C = []

    def add(self, bm, col, m=None):
        if m is not None:
            bmesh.ops.transform(bm, matrix=m, verts=bm.verts[:])
        bm.normal_update()
        bm.verts.index_update()
        off = len(self.V)
        self.V.extend(tuple(v.co) for v in bm.verts)
        for f in bm.faces:
            self.F.append([off + v.index for v in f.verts])
            c = col(f.calc_center_median(), f.normal) if callable(col) else col
            self.C.append(lin(c) if isinstance(c, str) else c)
        bm.free()
        return self

    # shorthands mirroring models.js
    def box(self, w, h, d, col, bev=0.0, seg=1, **t):
        return self.add(p_box(w, h, d, bev, seg), col, xf(**t))

    def cyl(self, rt, rb, h, seg, col, bev=0.0, **t):
        return self.add(p_cyl(rt, rb, h, seg, bev), col, xf(**t))

    def beam(self, a, b, t, col, seg=0):
        """Square (seg=0) or round (seg>2) bar from point a to point b."""
        a, b = Vector(a), Vector(b)
        d = b - a
        bm = p_box(t, d.length, t) if seg == 0 else p_cyl(t / 2, t / 2, d.length, seg)
        rot = Vector((0, 1, 0)).rotation_difference(d.normalized()).to_matrix().to_4x4()
        return self.add(bm, col, Matrix.Translation((a + b) / 2) @ rot)


MODELS = []


def model(name):
    m = Model(name)
    MODELS.append(m)
    return m


# three.js space (x, y, z) -> Blender space (x, -z, y); the glTF exporter maps it back.
TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def finalize(m):
    me = bpy.data.meshes.new(m.name)
    verts = [tuple(TO_BLENDER @ Vector(v)) for v in m.V]
    me.from_pydata(verts, [], m.F)
    attr = me.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='CORNER')
    for poly, c in zip(me.polygons, m.C):
        poly.use_smooth = False
        for li in poly.loop_indices:
            attr.data[li].color = (c[0], c[1], c[2], 1.0)
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
    me.update()
    ob = bpy.data.objects.new(m.name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


# ------------------------------------------------------------------ palette
BARK = '#6e4a2c'
BARK_D = '#5c3d24'
WOOD = '#8a5a32'
DARK = '#34393f'
MID = '#565d66'
STEEL = '#8d949c'
GLASS = '#bfe4f5'
RUBBER = '#2a2a2e'


# ------------------------------------------------------------------ props
def pine():
    m = model('prop_pine_0')
    m.cyl(0.2, 0.42, 3.4, 7, vary([BARK, BARK_D], 0.06), y=1.7)
    for i, a in enumerate((0.0, 2.1, 4.2)):
        m.add(p_cyl(0.02, 0.2, 0.9, 5), BARK_D, xf(x=math.cos(a) * 0.32, y=0.18, z=math.sin(a) * 0.32, rz=-math.cos(a) * 1.1, rx=math.sin(a) * 1.1))
    tiers = [(3.6, 3.0, 2.45), (5.1, 2.7, 2.05), (6.5, 2.4, 1.6), (7.8, 2.0, 1.12), (8.9, 1.3, 0.55)]
    greens = ['#2f8a45', '#2a7d3e', '#33914a', '#2c8442', '#3a9a50']
    for i, (y, h, r) in enumerate(tiers):
        seg = 10
        bm = p_cyl(0.0, r, h, seg)
        bottom = [v for v in bm.verts if v.co.y < -h / 2 + 1e-4]
        bottom.sort(key=lambda v: math.atan2(v.co.z, v.co.x))
        for k, v in enumerate(bottom):
            if k % 2:
                v.co.x *= 0.74
                v.co.z *= 0.74
                v.co.y += 0.22
            else:
                v.co.y -= 0.14
        caps = [f for f in bm.faces if len(f.verts) > 4]
        res = bmesh.ops.poke(bm, faces=caps)
        for v in res['verts']:
            v.co.y += h * 0.3
        g = lin(greens[i])

        def col(c, n, g=g):
            if n.y < -0.2:
                return tuple(x * 0.5 for x in g)
            return tuple(x * (0.86 + 0.22 * hashf(c, 3)) for x in g)
        m.add(bm, col, xf(y=y, ry=i * 0.7))


def oak():
    m = model('prop_oak_0')
    m.cyl(0.26, 0.52, 4.3, 8, vary(['#7a5232', '#6c4729'], 0.06), y=2.15)
    m.beam((0.15, 2.9, 0), (1.3, 4.3, 0.3), 0.2, '#6c4729', seg=5)
    m.beam((-0.1, 3.2, 0.1), (-1.1, 4.5, -0.5), 0.18, '#6c4729', seg=5)
    m.beam((0, 3.5, -0.1), (0.3, 4.6, 1.2), 0.16, '#6c4729', seg=5)
    blobs = [(2.15, 0, 5.4, 0), (1.6, 1.35, 4.8, 0.5), (1.55, -1.25, 4.9, -0.4), (1.35, 0.2, 6.7, -0.4), (1.4, -0.3, 5.0, 1.35)]
    for i, (r, x, y, z) in enumerate(blobs):
        bm = jitter(p_ico(r, 1), r * 0.3, 10 + i)
        m.add(bm, vary(['#5cae3c', '#52a236', '#62b541', '#4f9c34'], 0.07, 0.62, i), xf(x=x, y=y, z=z, ry=i))


def frond(m, ang, base, length=3.5, seg=5):
    """One V-folded, drooping palm leaf, double sided."""
    secs = []
    for k in range(seg + 1):
        t = k / seg
        y = 0.75 * t - 1.9 * t * t
        w = 0.5 * math.sin(PI * min(1.0, t * 1.1)) + 0.04
        secs.append((t * length, y, w))
    rot = xf(ry=ang)
    for side in (1, -1):
        bm = bmesh.new()
        rows = []
        for z, y, w in secs:
            rows.append((bm.verts.new((-w, y - 0.1, z)), bm.verts.new((0, y + 0.06, z)), bm.verts.new((w, y - 0.1, z))))
        for k in range(seg):
            a, b = rows[k], rows[k + 1]
            quads = [(a[0], a[1], b[1], b[0]), (a[1], a[2], b[2], b[1])]
            for q in quads:
                bm.faces.new(q if side > 0 else tuple(reversed(q)))
        g = lin('#47a53a') if side > 0 else lin('#327a2a')

        def col(c, n, g=g):
            return tuple(x * (0.88 + 0.2 * hashf(c, 5)) for x in g)
        m.add(bm, col, Matrix.Translation(base) @ rot)


def palm():
    m = model('prop_palm_0')
    for i in range(6):
        x = i * i * 0.022
        m.cyl(0.25 - i * 0.018, 0.3 - i * 0.018, 1.45, 7, '#b8905a' if i % 2 else '#a88150', x=x, y=0.72 + i * 1.36, rz=-i * 0.025)
        m.cyl(0.31 - i * 0.018, 0.31 - i * 0.018, 0.12, 7, '#8e6c3e', x=x, y=0.06 + i * 1.36)
    crown = Vector((0.8, 8.2, 0))
    m.add(p_ico(0.42, 1), '#7a5a2c', xf(x=crown.x, y=crown.y - 0.05, z=0))
    for i in range(7):
        a = i / 7 * PI * 2 + 0.3
        frond(m, a, crown, 3.3 + (i % 3) * 0.25)
    for i in range(3):
        a = i / 3 * PI * 2
        m.add(p_ico(0.2, 1), '#6b4a22', xf(x=crown.x + math.cos(a) * 0.38, y=crown.y - 0.42, z=math.sin(a) * 0.38))


def rock():
    m = model('prop_rock_0')
    stone = lin('#9ea3a8')
    moss = lin('#7f9a5a')

    def col(c, n):
        s = 0.88 + 0.2 * hashf(c, 2)
        base = mix(stone, moss, 0.55) if n.y > 0.8 and hashf(c, 9) > 0.35 else stone
        if n.y < -0.2:
            s *= 0.7
        return tuple(x * s for x in base)
    bm = jitter(p_ico(1.5, 1), 0.42, 9)
    m.add(bm, col, xf(y=0.66, sx=1.05, sy=0.72, sz=0.98))
    m.add(jitter(p_ico(0.62, 1), 0.2, 12), col, xf(x=1.15, y=0.18, z=0.75, sy=0.7))
    m.add(jitter(p_ico(0.4, 0), 0.12, 13), col, xf(x=-1.2, y=0.1, z=-0.6, sy=0.6))


def bush():
    m = model('prop_bush_0')
    for i, (r, x, y, z) in enumerate([(0.9, 0, 0.62, 0), (0.72, 0.62, 0.5, 0.3), (0.66, -0.55, 0.5, -0.3), (0.6, 0.1, 0.48, -0.6), (0.55, -0.2, 0.45, 0.62)]):
        m.add(jitter(p_ico(r, 1), r * 0.3, 30 + i), vary(['#46a23f', '#3f9839', '#4eaa45'], 0.07, 0.6, i), xf(x=x, y=y, z=z))
    rnd = random.Random(4)
    for i in range(7):
        a = rnd.random() * PI * 2
        m.add(p_ico(0.075, 0), '#e0485a' if i % 2 else '#f4f0e8', xf(x=math.cos(a) * 0.8, y=0.6 + rnd.random() * 0.5, z=math.sin(a) * 0.75))


def car():
    paint = model('prop_car_0')  # tinted by the car color
    det = model('prop_car_1')
    paint.box(2.1, 0.64, 4.3, '#ffffff', bev=0.14, seg=2, y=0.7)
    paint.add(p_frustum(1.84, 2.25, 1.56, 1.6, 0.62, bev=0.07), '#ffffff', xf(y=1.32, z=0.3))
    paint.box(2.12, 0.08, 3.9, '#d8d8d8', y=0.78)
    paint.box(1.62, 0.1, 1.2, '#f4f4f4', bev=0.03, y=1.03, z=-1.45, rx=-0.06)  # hood bulge
    # glass band follows the cabin taper (frustum above spans y 1.01..1.63)
    def cab(y):
        t = (y - 1.01) / 0.62
        return 1.84 + (1.56 - 1.84) * t, 2.25 + (1.6 - 2.25) * t
    wb, db = cab(1.1)
    wt, dt = cab(1.54)
    det.add(p_frustum(wb + 0.03, db + 0.03, wt + 0.03, dt + 0.03, 0.44), GLASS, xf(y=1.32, z=0.3))
    paint.add(p_frustum(wb + 0.05, 0.12, wt + 0.05, 0.12, 0.44), '#ffffff', xf(y=1.32, z=0.36))
    for x in (0.97, -0.97):
        for z in (1.35, -1.35):
            det.cyl(0.37, 0.37, 0.28, 12, RUBBER, rz=PI / 2, x=x, y=0.37, z=z)
            det.cyl(0.2, 0.2, 0.3, 8, '#b8bcc2', rz=PI / 2, x=x, y=0.37, z=z)
    for x in (0.62, -0.62):
        det.box(0.42, 0.18, 0.06, '#fff3b0', bev=0.02, x=x, y=0.82, z=-2.16)
        det.box(0.42, 0.16, 0.06, '#d8423a', bev=0.02, x=x, y=0.84, z=2.16)
        det.box(0.16, 0.1, 0.12, '#2d2d33', x=x * 1.62, y=1.08, z=-0.62)
    for z in (2.13, -2.13):
        det.box(2.16, 0.2, 0.2, '#3a3a40', bev=0.05, y=0.44, z=z)
        det.box(0.5, 0.14, 0.03, '#f2f2f2', y=0.5, z=z + (0.11 if z > 0 else -0.11))
    det.box(0.9, 0.16, 0.04, '#2a2a30', y=0.62, z=-2.16)


def container():
    m = model('prop_container_0')
    m.box(2.6, 2.75, 6.2, '#ffffff', bev=0.03, y=1.375)
    for i in range(-5, 6):
        m.box(2.66, 2.44, 0.16, '#dadada', y=1.375, z=i * 0.55)
    for y in (0.08, 2.67):
        m.box(2.7, 0.16, 6.28, '#bdbdbd', y=y)
    for x in (1.3, -1.3):
        for z in (3.1, -3.1):
            m.box(0.18, 2.75, 0.18, '#bdbdbd', x=x, y=1.375, z=z)
    m.box(2.4, 2.45, 0.06, '#c8c8c8', y=1.375, z=-3.12)
    m.box(0.04, 2.45, 0.04, '#8a8a8a', y=1.375, z=-3.16)
    for x in (0.35, 0.95, -0.35, -0.95):
        m.cyl(0.035, 0.035, 2.4, 6, '#9a9a9a', x=x, y=1.375, z=-3.2)
        m.box(0.06, 0.24, 0.06, '#7a7a7a', x=x + 0.08, y=1.2, z=-3.22)


def crate():
    m = model('prop_crate_0')
    m.box(1.4, 1.4, 1.4, '#a67a46', y=0.75)
    planks = ['#c09058', '#b9894f', '#c79a60']
    for k, (ax, sgn) in enumerate([('x', 1), ('x', -1), ('z', 1), ('z', -1)]):
        for j in range(3):
            y = 0.33 + j * 0.42
            c = planks[(j + k) % 3]
            if ax == 'x':
                m.box(0.06, 0.39, 1.3, c, x=sgn * 0.71, y=y)
            else:
                m.box(1.3, 0.39, 0.06, c, z=sgn * 0.71, y=y)
        if ax == 'x':
            m.box(0.06, 1.72, 0.14, '#8c6238', x=sgn * 0.75, y=0.75, rx=PI / 4 * sgn)
        else:
            m.box(0.14, 1.72, 0.06, '#8c6238', z=sgn * 0.75, y=0.75, rz=PI / 4 * sgn)
    for j in range(3):
        m.box(0.39, 0.06, 1.3, planks[j], x=-0.42 + j * 0.42, y=1.46)
    e = 0.7
    for x in (e, -e):
        for z in (e, -e):
            m.box(0.15, 1.5, 0.15, '#8c6238', x=x, y=0.75, z=z)
    for y in (0.08, 1.42):
        for s in (e, -e):
            m.box(1.54, 0.15, 0.15, '#8c6238', y=y, z=s)
            m.box(0.15, 0.15, 1.54, '#8c6238', y=y, x=s)


def hay():
    m = model('prop_hay_0')
    m.cyl(0.95, 0.95, 1.5, 16, vary(['#e4c35c', '#dcb850', '#e9cb68'], 0.05), bev=0.12, y=0.75)
    for y in (0.42, 1.08):
        m.cyl(0.965, 0.965, 0.06, 16, '#a8823a', y=y)
    rnd = random.Random(7)
    for i in range(6):
        a = rnd.random() * PI * 2
        r = rnd.random() * 0.6
        m.add(p_cyl(0.0, 0.07, 0.22, 4), '#efd27a', xf(x=math.cos(a) * r, y=1.56, z=math.sin(a) * r, rz=rnd.random() - 0.5))


# ------------------------------------------------------------------ landmarks (static, one each)
def lighthouse():
    m = model('lm_lighthouse')
    for i in range(6):
        rb, rt = 3.3 - i * 0.18, 3.3 - (i + 1) * 0.18
        m.cyl(rt, rb, 4, 16, '#d8403a' if i % 2 else '#f7f4ee', y=1 + i * 4)
    m.cyl(3.45, 3.5, 1.2, 16, '#9a9a94', y=-0.3)
    m.box(1.3, 2.2, 0.4, '#5a3a24', bev=0.05, y=1.1, z=-3.2)
    m.box(1.6, 0.25, 0.5, '#2d2d33', y=2.3, z=-3.2)
    for i, (y, a) in enumerate([(7.5, 0.0), (11.5, 2.4), (15.5, 4.4), (19.5, 1.3)]):
        r = 3.3 - (y / 4) * 0.18 - 0.05
        m.box(0.7, 1.0, 0.2, '#2d3a4a', x=math.sin(a) * r, y=y, z=-math.cos(a) * r, ry=-a)
    m.cyl(2.9, 2.9, 0.3, 16, '#2d2d33', y=23.6)
    m.cyl(2.4, 2.4, 0.4, 16, '#2d2d33', y=23.2)
    for i in range(16):
        a = i / 16 * PI * 2
        m.cyl(0.04, 0.04, 0.9, 4, '#2d2d33', x=math.cos(a) * 2.8, y=24.2, z=math.sin(a) * 2.8)
    m.cyl(2.84, 2.84, 0.08, 16, '#2d2d33', y=24.65)
    m.cyl(1.7, 1.7, 3.6, 12, '#fff5c2', y=25.55)
    for i in range(6):
        a = i / 6 * PI * 2
        m.box(0.12, 3.6, 0.12, '#2d2d33', x=math.cos(a) * 1.72, y=25.55, z=math.sin(a) * 1.72)
    m.cyl(1.9, 1.9, 0.3, 12, '#2d2d33', y=27.4)
    m.cyl(0.25, 2.3, 1.8, 12, '#d8403a', y=28.4)
    m.add(p_sphere(0.3, 8, 6), '#2d2d33', xf(y=29.5))


def windmill():
    m = model('lm_windmill')
    m.cyl(2.3, 3.3, 15, 8, vary(['#f1e8d6', '#ece2ce'], 0.03), bev=0.08, y=7)
    m.cyl(3.32, 3.38, 2.0, 8, vary(['#b8ad98', '#a89d88'], 0.06), y=0.4)
    m.cyl(2.45, 2.45, 0.35, 8, '#7a5232', y=14.4)
    m.cyl(0.2, 3.0, 3.0, 8, vary(['#8a3b2f', '#7c3428'], 0.04), y=16)
    m.box(1.3, 2.2, 0.35, '#6e4a33', bev=0.04, y=1.1, z=-3.15)
    m.box(1.6, 0.2, 0.5, '#5a3a24', y=2.3, z=-3.2)
    for y, a in [(5.5, 0.0), (9.0, PI), (11.5, 0.0), (7.0, PI / 2), (7.0, -PI / 2)]:
        r = 3.3 - (y + 0.5) / 15 * 1.0 - 0.1
        m.box(0.9, 1.1, 0.2, '#ffffff', x=math.sin(a) * r, y=y, z=-math.cos(a) * r, ry=-a)
        m.box(0.7, 0.9, 0.22, '#3b3b44', x=math.sin(a) * r, y=y, z=-math.cos(a) * r, ry=-a)
    m.box(1.0, 1.0, 1.4, '#6e4a33', bev=0.05, y=15.5, z=-2.5)


def windmill_blades():
    m = model('lm_windmillBlades')
    m.cyl(0.45, 0.45, 0.8, 10, '#6e4a33', bev=0.05, rx=PI / 2)
    m.add(p_sphere(0.3, 8, 6), '#4a3222', xf(z=-0.45))
    for i in range(4):
        r = Matrix.Rotation(i * PI / 2, 4, 'Z')
        sail = Model('tmp')
        sail.box(0.2, 7.4, 0.2, '#7a5232', y=3.9)
        sail.box(1.35, 6.0, 0.06, vary(['#f7f4ee', '#efe9dc'], 0.03), x=0.85, y=4.4, z=0.06)
        for k in range(7):
            sail.box(1.7, 0.08, 0.1, '#6e4a33', x=0.75, y=1.6 + k * 0.95, z=-0.04)
        sail.box(0.08, 6.0, 0.1, '#6e4a33', x=1.55, y=4.4, z=-0.04)
        off = len(m.V)
        m.V.extend(tuple(r @ Vector(v)) for v in sail.V)
        m.F.extend([[i2 + off for i2 in f] for f in sail.F])
        m.C.extend(sail.C)


def watertower():
    m = model('lm_watertower')
    m.cyl(4.3, 4.3, 6.5, 16, lambda c, n: lin('#6fa0c8' if hashf(Vector((round(math.atan2(c.z, c.x) * 8 / PI), 0, 0)), 1) > 0.5 else '#679ac2', 0.7 if n.y < -0.5 else 1), y=14.25)
    for y in (11.9, 14.25, 16.6):
        m.cyl(4.36, 4.36, 0.16, 16, '#51789c', y=y)
    m.cyl(0.3, 4.6, 2.2, 16, '#51789c', y=18.6)
    m.add(p_sphere(0.35, 8, 6), '#3e5f80', xf(y=19.9))
    m.cyl(4.6, 4.6, 0.2, 16, '#6b6f75', y=10.95)
    for i in range(16):
        a = i / 16 * PI * 2
        m.cyl(0.035, 0.035, 0.9, 4, '#6b6f75', x=math.cos(a) * 4.55, y=11.5, z=math.sin(a) * 4.55)
    m.cyl(4.56, 4.56, 0.06, 16, '#6b6f75', y=11.95)
    legs = [(3, 3), (-3, 3), (-3, -3), (3, -3)]
    for x, z in legs:
        m.cyl(0.3, 0.35, 12, 8, '#6b6f75', x=x, y=5, z=z)
        m.box(0.9, 0.3, 0.9, '#8a8a84', x=x, y=-0.85, z=z)
    for k in range(4):
        (x1, z1), (x2, z2) = legs[k], legs[(k + 1) % 4]
        m.beam((x1, 5, z1), (x2, 5, z2), 0.22, '#6b6f75')
        m.beam((x1, 0.4, z1), (x2, 5, z2), 0.14, '#7a7e84')
        m.beam((x2, 0.4, z2), (x1, 5, z1), 0.14, '#7a7e84')
        m.beam((x1, 5.2, z1), (x2, 10.6, z2), 0.14, '#7a7e84')
        m.beam((x2, 5.2, z2), (x1, 10.6, z1), 0.14, '#7a7e84')
    for x in (0.3, -0.3):
        m.box(0.07, 11.4, 0.07, '#4a4e54', x=x, y=5.3, z=-4.45)
    for k in range(20):
        m.box(0.6, 0.05, 0.05, '#4a4e54', y=-0.2 + k * 0.56, z=-4.45)
    m.beam((0, 0.0, -4.45), (0, 0.0, -3.4), 0.08, '#4a4e54')


def radiotower():
    m = model('lm_radiotower')
    top = 34.0

    def leg(y):  # half width of the lattice at height y (tapers toward the top)
        return 1.45 - (y + 1) / (top + 1) * 0.65
    corners = [(1, 1), (-1, 1), (-1, -1), (1, -1)]
    for sx, sz in corners:
        m.beam((sx * leg(-1), -1, sz * leg(-1)), (sx * leg(top), top, sz * leg(top)), 0.24, '#d8403a')
    for i in range(12):
        y0 = 0.4 + i * 2.8
        y1 = y0 + 2.8
        hexc = '#f7f4ee' if i % 2 else '#d8403a'
        for k in range(4):
            (ax, az), (bx, bz) = corners[k], corners[(k + 1) % 4]
            m.beam((ax * leg(y0), y0, az * leg(y0)), (bx * leg(y0), y0, bz * leg(y0)), 0.16, hexc)
            m.beam((ax * leg(y0), y0, az * leg(y0)), (bx * leg(y1), y1, bz * leg(y1)), 0.09, hexc)
    m.box(1.8, 0.2, 1.8, '#d8403a', y=top)
    m.cyl(0.08, 0.12, 6, 6, '#d8403a', y=top + 3)
    m.box(0.6, 0.6, 0.6, '#ff5040', bev=0.08, y=39)
    for y, a in [(20.0, 0.4), (26.0, 2.6)]:
        r = leg(y) + 0.35
        m.add(p_cyl(0.75, 0.15, 0.35, 12), '#e8e8e8', xf(x=math.cos(a) * r, y=y, z=math.sin(a) * r, rz=PI / 2, ry=-a))
        m.box(0.6, 0.12, 0.12, '#7a7e84', x=math.cos(a) * (r - 0.3), y=y, z=math.sin(a) * (r - 0.3), ry=-a)
    m.box(2.2, 2.2, 2.2, '#9a9a94', bev=0.05, x=2.6, y=0.1, z=2.6)
    m.box(2.0, 0.3, 2.4, '#5a5e64', x=2.6, y=1.3, z=2.6)


# ------------------------------------------------------------------ characters (tinted by outfit)
def characters():
    t = model('char_torso')
    t.add(p_frustum(0.5, 0.3, 0.58, 0.32, 0.6, bev=0.05, seg=2), '#ffffff', xf(y=1.2))
    t.box(0.52, 0.08, 0.32, '#bdbdbd', bev=0.02, y=0.93)
    t.box(0.32, 0.07, 0.3, '#e6e6e6', bev=0.02, y=1.5)
    t.box(0.025, 0.42, 0.02, '#cfcfcf', y=1.2, z=-0.163)
    t.box(0.13, 0.11, 0.02, '#e2e2e2', x=0.14, y=1.32, z=-0.162)
    t.add(p_sphere(0.115, 8, 6), '#f0f0f0', xf(x=0.3, y=1.44))
    t.add(p_sphere(0.115, 8, 6), '#f0f0f0', xf(x=-0.3, y=1.44))

    p = model('char_pelvis')
    p.box(0.5, 0.22, 0.3, '#ffffff', bev=0.04, y=0.86)
    p.box(0.1, 0.07, 0.02, '#9a9a9a', y=0.9, z=-0.155)

    lg = model('char_leg')
    lg.add(p_frustum(0.2, 0.23, 0.23, 0.27, 0.4, bev=0.04), '#ffffff', xf(y=-0.2))
    lg.add(p_frustum(0.18, 0.21, 0.2, 0.23, 0.34, bev=0.04), '#f2f2f2', xf(y=-0.53))
    lg.box(0.21, 0.12, 0.05, '#dcdcdc', bev=0.015, y=-0.4, z=-0.125)
    lg.box(0.23, 0.14, 0.36, '#3a3a3a', bev=0.045, seg=2, y=-0.76, z=-0.05)
    lg.box(0.245, 0.04, 0.375, '#1e1e1e', bev=0.012, y=-0.835, z=-0.05)

    a = model('char_arm')
    a.add(p_frustum(0.15, 0.17, 0.18, 0.2, 0.6, bev=0.04), '#ffffff', xf(y=-0.3))
    a.box(0.175, 0.06, 0.195, '#dcdcdc', bev=0.02, y=-0.57)

    h = model('char_hand')
    h.box(0.14, 0.14, 0.15, '#ffffff', bev=0.035, seg=2, y=-0.67)
    h.box(0.05, 0.08, 0.06, '#f2f2f2', bev=0.015, y=-0.64, z=-0.085)

    hd = model('char_head')
    hd.box(0.42, 0.42, 0.4, '#ffffff', bev=0.07, seg=2, y=1.72)
    for x in (0.215, -0.215):
        hd.box(0.05, 0.11, 0.08, '#eeeeee', bev=0.015, x=x, y=1.71, z=0.01)
    hd.box(0.06, 0.08, 0.06, '#ececec', bev=0.015, y=1.69, z=-0.215)

    hr = model('char_hair')
    hr.box(0.46, 0.13, 0.44, '#ffffff', bev=0.045, seg=2, y=1.96)
    hr.box(0.46, 0.32, 0.11, '#ffffff', bev=0.035, y=1.8, z=0.19)
    for x in (0.215, -0.215):
        hr.box(0.05, 0.15, 0.14, '#f0f0f0', bev=0.015, x=x, y=1.83, z=0.08)
    for x, rz in ((-0.13, 0.25), (0.02, -0.1), (0.15, -0.3)):
        hr.box(0.17, 0.09, 0.07, '#f4f4f4', bev=0.02, x=x, y=1.905, z=-0.205, rz=rz)

    f = model('char_face')
    for x in (0.1, -0.1):
        f.box(0.095, 0.105, 0.012, '#ffffff', x=x, y=1.76, z=-0.204)
        f.box(0.05, 0.075, 0.012, '#1d1d24', x=x * 0.85, y=1.752, z=-0.212)
        f.box(0.02, 0.02, 0.006, '#ffffff', x=x * 0.85 + 0.012, y=1.772, z=-0.22)
        f.box(0.11, 0.024, 0.012, '#3a2a22', x=x, y=1.837, z=-0.205, rz=0.12 if x > 0 else -0.12)
    f.box(0.13, 0.026, 0.012, '#7a3b36', y=1.615, z=-0.205)

    pk = model('char_pack')
    pk.box(0.38, 0.44, 0.17, '#ffffff', bev=0.045, seg=2, y=1.22, z=0.25)
    pk.box(0.3, 0.15, 0.07, '#d6d6d6', bev=0.025, y=1.07, z=0.345)
    pk.box(0.39, 0.09, 0.18, '#e6e6e6', bev=0.02, y=1.42, z=0.25)
    pk.cyl(0.075, 0.075, 0.42, 10, '#c8c8c8', rz=PI / 2, y=1.5, z=0.27)
    for x in (0.15, -0.15):
        pk.box(0.06, 0.56, 0.025, '#d0d0d0', x=x, y=1.22, z=-0.17)

    g = model('char_glider')
    cells = 10
    span = 1.95
    for i in range(cells):
        x0 = -span + 2 * span * i / cells
        x1 = -span + 2 * span * (i + 1) / cells
        bm = bmesh.new()
        secs = []
        for x in (x0, x1):
            u = x / span
            y = 3.45 - 0.55 * u * u
            secs.append([bm.verts.new(v) for v in ((x, y - 0.08, -0.75), (x, y + 0.14, -0.6), (x, y + 0.1, 0.1), (x, y, 0.72), (x, y - 0.06, 0.1))])
        a, b = secs
        n = len(a)
        for k in range(n):
            j = (k + 1) % n
            bm.faces.new((a[k], b[k], b[j], a[j]))
        if i == 0:
            bm.faces.new(list(reversed(a)))
        if i == cells - 1:
            bm.faces.new(b)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        g.add(bm, '#ffffff' if i % 2 else '#cfcfcf')
    for sx in (1, -1):
        for wx, wz in ((1.7, -0.3), (1.0, -0.4), (1.3, 0.45)):
            u = wx / span
            g.beam((sx * 0.34, 2.1, 0.0), (sx * wx, 3.4 - 0.55 * u * u - 0.08, wz), 0.02, '#333333')


# ------------------------------------------------------------------ weapons (forward is -z, origin at the grip)
def weapons():
    def w(name):
        return model('wpn_' + name + '_body'), model('wpn_' + name + '_acc')

    b, a = w('pickaxe')
    b.cyl(0.035, 0.04, 0.95, 6, '#6b4a2e', rx=PI / 2, z=-0.3)
    b.cyl(0.045, 0.045, 0.26, 6, '#2a2a2a', rx=PI / 2, z=0.06)
    b.box(0.08, 0.08, 0.06, '#2a2a2a', bev=0.015, z=0.2)
    a.box(0.16, 0.15, 0.18, '#ffffff', bev=0.03, z=-0.74)
    for s in (1, -1):
        a.beam((s * 0.06, 0.0, -0.74), (s * 0.27, -0.06, -0.74), 0.09, '#ffffff')
        a.add(p_cyl(0.0, 0.05, 0.12, 4), '#e6e6e6', xf(x=s * 0.35, y=-0.1, z=-0.74, rz=s * (PI / 2 + 0.35)))

    b, a = w('pistol')
    b.box(0.08, 0.065, 0.32, DARK, bev=0.012, y=0.115, z=-0.12)
    b.box(0.075, 0.05, 0.28, MID, bev=0.01, y=0.06, z=-0.11)
    b.box(0.07, 0.17, 0.085, '#3a3f46', bev=0.015, y=-0.03, rx=-0.25)
    b.cyl(0.018, 0.018, 0.04, 8, '#1a1a1e', rx=PI / 2, y=0.11, z=-0.29)
    b.box(0.02, 0.05, 0.08, MID, y=0.0, z=-0.08)
    b.box(0.02, 0.025, 0.02, '#1a1a1e', y=0.155, z=-0.26)
    a.box(0.085, 0.03, 0.2, '#ffffff', y=0.145, z=-0.13)

    b, a = w('smg')
    b.box(0.1, 0.13, 0.5, DARK, bev=0.015, y=0.06, z=-0.16)
    b.box(0.06, 0.22, 0.08, MID, bev=0.01, y=-0.09, z=-0.2, rx=0.08)
    b.box(0.07, 0.14, 0.08, MID, bev=0.012, y=-0.04, z=0.03, rx=-0.2)
    b.cyl(0.025, 0.025, 0.16, 8, '#222226', rx=PI / 2, y=0.08, z=-0.48)
    b.box(0.05, 0.05, 0.22, MID, y=0.08, z=0.2)
    b.box(0.03, 0.08, 0.03, MID, y=0.1, z=0.32)
    b.box(0.03, 0.04, 0.03, '#1a1a1e', y=0.15, z=-0.36)
    a.box(0.105, 0.035, 0.3, '#ffffff', y=0.13, z=-0.18)

    b, a = w('ar')
    b.box(0.1, 0.14, 0.66, DARK, bev=0.015, y=0.06, z=-0.22)
    b.cyl(0.026, 0.026, 0.34, 8, MID, rx=PI / 2, y=0.08, z=-0.7)
    b.cyl(0.036, 0.036, 0.08, 8, '#1f1f24', rx=PI / 2, y=0.08, z=-0.86)
    b.box(0.07, 0.22, 0.1, MID, bev=0.012, y=-0.11, z=-0.26, rx=0.25)
    b.box(0.07, 0.15, 0.08, MID, bev=0.012, y=-0.04, z=0.02, rx=-0.2)
    b.box(0.08, 0.13, 0.28, DARK, bev=0.02, y=0.04, z=0.21)
    b.box(0.09, 0.15, 0.04, '#222222', y=0.04, z=0.355)
    b.box(0.05, 0.06, 0.1, '#222222', bev=0.01, y=0.17, z=-0.2)
    b.box(0.11, 0.1, 0.3, '#3f454c', bev=0.015, y=0.06, z=-0.47)
    a.box(0.105, 0.035, 0.42, '#ffffff', y=0.145, z=-0.26)

    b, a = w('shotgun')
    b.cyl(0.035, 0.035, 0.9, 8, DARK, rx=PI / 2, y=0.1, z=-0.36)
    b.cyl(0.03, 0.03, 0.74, 8, MID, rx=PI / 2, y=0.04, z=-0.32)
    b.box(0.1, 0.1, 0.26, WOOD, bev=0.02, y=0.03, z=-0.5)
    b.box(0.1, 0.12, 0.24, DARK, bev=0.015, y=0.08, z=-0.04)
    b.box(0.08, 0.16, 0.32, WOOD, bev=0.025, y=0.0, z=0.22, rx=0.15)
    b.box(0.07, 0.14, 0.08, DARK, bev=0.012, y=-0.04, z=0.0)
    b.box(0.02, 0.025, 0.02, '#c8a040', y=0.14, z=-0.78)
    a.box(0.095, 0.03, 0.3, '#ffffff', y=0.145, z=-0.1)

    b, a = w('sniper')
    b.box(0.09, 0.13, 0.9, DARK, bev=0.015, y=0.05, z=-0.28)
    b.cyl(0.022, 0.022, 0.52, 8, MID, rx=PI / 2, y=0.07, z=-0.96)
    b.cyl(0.032, 0.032, 0.09, 8, '#1f1f24', rx=PI / 2, y=0.07, z=-1.24)
    b.cyl(0.05, 0.05, 0.38, 10, '#1f1f24', rx=PI / 2, y=0.2, z=-0.25)
    b.cyl(0.065, 0.055, 0.08, 10, '#1f1f24', rx=PI / 2, y=0.2, z=-0.47)
    b.cyl(0.06, 0.055, 0.06, 10, '#1f1f24', rx=PI / 2, y=0.2, z=-0.05)
    b.box(0.03, 0.06, 0.04, MID, y=0.14, z=-0.32)
    b.box(0.03, 0.06, 0.04, MID, y=0.14, z=-0.16)
    b.box(0.08, 0.16, 0.32, WOOD, bev=0.025, y=0.0, z=0.28)
    b.box(0.07, 0.15, 0.08, DARK, bev=0.012, y=-0.05, z=0.02)
    for s in (1, -1):
        b.beam((s * 0.02, 0.0, -0.66), (s * 0.08, -0.22, -0.6), 0.025, '#222226')
    a.box(0.095, 0.03, 0.34, '#ffffff', y=0.12, z=-0.52)

    b, a = w('rocket')
    b.cyl(0.11, 0.11, 1.1, 10, '#4d5a3d', bev=0.02, rx=PI / 2, y=0.12, z=-0.2)
    b.cyl(0.13, 0.12, 0.16, 10, '#3a4430', rx=PI / 2, y=0.12, z=0.34)
    b.box(0.07, 0.15, 0.08, DARK, bev=0.012, y=-0.04, z=0)
    b.box(0.07, 0.14, 0.08, DARK, bev=0.012, y=-0.02, z=-0.34)
    b.box(0.05, 0.1, 0.16, '#222226', bev=0.01, y=0.26, z=-0.12)
    b.box(0.02, 0.05, 0.02, '#222226', y=0.25, z=-0.62)
    a.cyl(0.125, 0.125, 0.14, 10, '#ffffff', rx=PI / 2, y=0.12, z=-0.72)
    a.cyl(0.115, 0.115, 0.05, 10, '#e2e2e2', rx=PI / 2, y=0.12, z=0.1)


# ------------------------------------------------------------------ floor items
def items():
    m = model('cons_bandage')
    m.cyl(0.2, 0.2, 0.18, 12, '#f3efe6', bev=0.02, rz=PI / 2)
    m.cyl(0.08, 0.08, 0.2, 8, '#d9cdb2', rz=PI / 2)
    m.box(0.16, 0.012, 0.22, '#f3efe6', y=-0.19, z=-0.12)

    m = model('cons_medkit')
    m.box(0.52, 0.34, 0.36, '#f7f7f7', bev=0.04, seg=2)
    m.box(0.28, 0.08, 0.37, '#e0403a', bev=0.01)
    m.box(0.08, 0.28, 0.37, '#e0403a', bev=0.01)
    m.box(0.53, 0.03, 0.37, '#c8c8c8', y=-0.1)
    for x in (0.08, -0.08):
        m.box(0.03, 0.08, 0.04, '#888888', x=x, y=0.2)
    m.box(0.2, 0.03, 0.05, '#888888', y=0.245)

    m = model('cons_shieldS')
    m.add(p_sphere(0.17, 10, 8), '#4cc6ff')
    m.add(p_sphere(0.1, 8, 6), '#bdeeff', xf(x=-0.06, y=0.07, z=-0.08))
    m.cyl(0.05, 0.06, 0.12, 8, '#d6eef8', y=0.19)
    m.cyl(0.055, 0.05, 0.06, 8, '#a9784a', y=0.27)

    m = model('cons_shieldL')
    m.cyl(0.17, 0.2, 0.42, 10, '#2f8cff', bev=0.03)
    m.cyl(0.205, 0.205, 0.08, 10, '#9fd8ff')
    m.cyl(0.08, 0.17, 0.08, 10, '#2f8cff', y=0.25)
    m.cyl(0.07, 0.07, 0.1, 8, '#e8e8e8', y=0.32)
    m.box(0.14, 0.16, 0.012, '#ffffff', y=0.0, z=-0.19)

    m = model('ammo')
    m.box(0.46, 0.26, 0.3, '#ffffff', bev=0.025)
    m.box(0.48, 0.06, 0.32, '#3a3a3a', bev=0.01, y=0.1)
    for x in (-0.13, 0.0, 0.13):
        m.cyl(0.03, 0.03, 0.12, 6, '#e8d08a', x=x, y=0.19)
        m.cyl(0.0, 0.03, 0.05, 6, '#c08a4a', x=x, y=0.275)

    m = model('mat_0')
    for y, z, ry, c in ((-0.1, 0, 0, '#c98e55'), (0.0, 0.05, 0.3, '#b57a45'), (0.1, 0, -0.2, '#d49a60')):
        m.box(0.9, 0.1, 0.28, c, bev=0.015, y=y, z=z, ry=ry)
        m.box(0.02, 0.102, 0.22, '#8c6238', x=0.3, y=y, z=z, ry=ry)
    m = model('mat_1')
    for x, y, c in ((-0.2, 0, '#c2583f'), (0.22, 0, '#b24c35'), (0.0, 0.18, '#cf6a4c')):
        m.box(0.4, 0.18, 0.22, c, bev=0.02, x=x, y=y)
    m = model('mat_2')
    for y, ry, c in ((-0.05, 0, '#a3aeb9'), (0.03, 0.25, '#8d98a3'), (0.1, -0.15, '#b7c1cb')):
        m.box(0.8, 0.05, 0.5, c, bev=0.01, y=y, ry=ry)
        for x in (-0.3, 0.3):
            m.cyl(0.02, 0.02, 0.055, 6, '#5a6068', x=x * math.cos(ry), y=y, z=-x * math.sin(ry))


def chests():
    m = model('chest_body')
    m.box(1.0, 0.56, 0.62, '#e8b33a', bev=0.02, y=0.28)
    m.box(1.04, 0.1, 0.66, '#7a4b1e', bev=0.015, y=0.05)
    for x in (0.36, -0.36):
        m.box(0.1, 0.58, 0.66, '#7a4b1e', bev=0.015, x=x, y=0.29)
    for x in (0.5, -0.5):
        for z in (0.31, -0.31):
            m.box(0.08, 0.5, 0.08, '#5a3a18', x=x, y=0.3, z=z)
    for x in (0.52, -0.52):
        m.box(0.04, 0.06, 0.2, '#3a2a14', x=x, y=0.38)
    m.box(0.18, 0.16, 0.05, '#fff2b0', bev=0.01, y=0.47, z=-0.32)
    # lid: hinge at its back top edge (z = 0), extends toward -z
    m = model('chest_lid')
    m.add(p_arch(1.02, 0.64, 0.08, 0.2, 10), vary(['#f0c24a'], 0.03), xf(z=-0.32))
    for x in (0.36, -0.36):
        m.add(p_arch(0.1, 0.66, 0.085, 0.21, 10), '#7a4b1e', xf(x=x, z=-0.32))
    m.box(0.16, 0.18, 0.06, '#fff2b0', bev=0.015, y=0.02, z=-0.66)
    m.box(0.06, 0.06, 0.07, '#5a3a18', y=0.0, z=-0.68)

    m = model('chest_boxBody')
    m.box(0.9, 0.42, 0.5, '#6d7a45', bev=0.025, y=0.21)
    m.box(0.92, 0.06, 0.52, '#4d5732', y=0.34)
    m.box(0.92, 0.05, 0.52, '#4d5732', y=0.04)
    for x in (0.47, -0.47):
        m.box(0.04, 0.05, 0.22, '#2f3520', x=x, y=0.25)
    m.box(0.36, 0.1, 0.01, '#d8c86a', y=0.2, z=-0.255)
    m = model('chest_boxLid')
    m.box(0.92, 0.08, 0.52, '#5b673a', bev=0.015, y=0.04, z=-0.26)
    m.box(0.1, 0.1, 0.04, '#2f3520', y=0.0, z=-0.53)


def bus():
    m = model('bus')
    m.box(3.4, 2.7, 9.6, '#2f73d8', bev=0.22, seg=2, y=1.9)
    m.box(3.3, 0.6, 9.4, '#f4f4f4', bev=0.25, seg=2, y=3.45)
    m.box(3.46, 0.3, 9.66, '#1d4c96', bev=0.06, y=0.7)
    m.box(3.44, 0.14, 9.0, '#f2c94c', y=1.45)
    for side in (1, -1):
        for k in range(6):
            m.box(0.06, 0.8, 1.05, GLASS, bev=0.02, x=side * 1.71, y=2.5, z=-3.3 + k * 1.3 + 0.35)
    m.box(3.0, 1.1, 0.06, GLASS, bev=0.03, y=2.5, z=-4.82)
    m.box(3.0, 0.9, 0.06, GLASS, bev=0.03, y=2.55, z=4.82)
    m.box(0.06, 1.9, 0.95, '#bfd8f0', x=1.72, y=1.6, z=-3.6)
    m.box(1.6, 0.5, 0.1, '#e8e8e8', y=1.1, z=-4.83)
    for x in (1.25, -1.25):
        m.box(0.4, 0.25, 0.08, '#fff3b0', bev=0.02, x=x, y=1.2, z=-4.84)
        m.box(0.35, 0.25, 0.08, '#d8423a', bev=0.02, x=x, y=1.2, z=4.84)
    for z in (4.85, -4.85):
        m.box(3.5, 0.32, 0.22, '#2d2d33', bev=0.05, y=0.62, z=z)
    for x in (1.6, -1.6):
        for z in (3.2, -3.2):
            m.cyl(0.62, 0.62, 0.5, 14, '#222226', bev=0.06, rz=PI / 2, x=x, y=0.6, z=z)
            m.cyl(0.32, 0.32, 0.54, 10, '#c0c4ca', rz=PI / 2, x=x, y=0.6, z=z)
    # balloon with alternating gores, a skirt and ropes down to the roof
    red, white = lin('#e84a3c'), lin('#f7f4ee')

    def gore(c, n):
        a = math.atan2(c.z, c.x)
        return red if int((a + PI) / (2 * PI) * 16) % 2 else white
    m.add(p_sphere(4.6, 16, 12), gore, xf(y=12.2, sy=1.15))
    m.cyl(1.4, 2.4, 1.4, 16, gore, y=6.9)
    m.cyl(1.45, 1.45, 0.18, 16, '#7a5232', y=6.2)
    for x, z in [(1.4, 3.8), (-1.4, 3.8), (1.4, -3.8), (-1.4, -3.8)]:
        m.beam((x, 3.75, z), (x * 0.75, 6.2, z * 0.25), 0.07, '#4a4a4a')


def decor():
    """Ground cover scattered by the renderer (visual only, no collision). White-ish so the
    renderer can tint each instance with the terrain color underneath."""
    m = model('deco_grass')
    rnd = random.Random(21)
    for i in range(5):
        a = i / 5 * PI * 2 + rnd.random() * 0.5
        r = 0.08 + rnd.random() * 0.12
        h = 0.38 + rnd.random() * 0.3
        lean = 0.25 + rnd.random() * 0.3
        bm = bmesh.new()
        w = 0.06
        pts = ((-w, 0, 0), (w, 0, 0), (w * 0.35, h * 0.55, 0), (-w * 0.35, h * 0.55, 0), (0, h, 0))
        v = [bm.verts.new(p) for p in pts]
        bm.faces.new((v[0], v[1], v[2], v[3]))
        bm.faces.new((v[3], v[2], v[4]))
        u = [bm.verts.new(p) for p in pts]  # back side needs its own verts in bmesh
        bm.faces.new((u[3], u[2], u[1], u[0]))
        bm.faces.new((u[4], u[2], u[3]))

        def col(c, n, h=h):
            t = c.y / 0.6
            return tuple(x * (0.72 + 0.5 * t) for x in (1.0, 1.0, 1.0))
        m.add(bm, col, xf(x=math.cos(a) * r, z=math.sin(a) * r, rx=lean, ry=-a + PI / 2))

    for name, petals in (('deco_flowerA', ['#f4d03f', '#e8483c']), ('deco_flowerB', ['#f7f4ee', '#a774e0'])):
        m = model(name)
        for k, (x, z) in enumerate(((0, 0), (0.18, 0.1), (-0.12, 0.16))):
            h = 0.32 + k * 0.07
            m.cyl(0.012, 0.016, h, 4, '#4f9a3a', x=x, y=h / 2, z=z)
            pc = petals[k % 2]
            m.cyl(0.085, 0.06, 0.02, 5, pc, x=x, y=h, z=z, ry=k)
            m.cyl(0.03, 0.03, 0.03, 5, '#f2b233' if pc != '#f4d03f' else '#a8502a', x=x, y=h + 0.015, z=z)
        m.box(0.1, 0.012, 0.04, '#4f9a3a', x=0.05, y=0.1, z=0.0, rz=0.4)

    m = model('deco_pebbles')
    for i, (r, x, z) in enumerate(((0.22, 0, 0), (0.14, 0.3, 0.12), (0.1, -0.22, 0.2), (0.12, 0.08, -0.26))):
        m.add(jitter(p_ico(r, 0), r * 0.35, 40 + i), vary(['#a3a6a8', '#8f9396', '#b0b2b0'], 0.06, 0.7, i), xf(x=x, y=r * 0.35, z=z, sy=0.6))


# ------------------------------------------------------------------ build + export
def main():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for fn in (pine, oak, palm, rock, bush, car, container, crate, hay, lighthouse, windmill, windmill_blades,
               watertower, radiotower, characters, weapons, items, chests, bus, decor):
        fn()
    tris = 0
    for m in MODELS:
        finalize(m)
        t = sum(len(f) - 2 for f in m.F)
        tris += t
        print(f'  {m.name:24s} {t:6d} tris')
    print(f'{len(MODELS)} models, {tris} tris')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT), export_format='GLB', use_selection=False,
                              export_vertex_color='ACTIVE', export_materials='NONE', export_texcoords=False,
                              export_normals=False, export_yup=True, export_apply=True, export_animations=False)
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT), 'bytes')


main()
