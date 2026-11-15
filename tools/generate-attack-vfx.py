#!/usr/bin/env python3
"""
Procedural 60fps VP9-alpha (.webm) combat VFX generator for Showstopper.
Generates self-contained Sequencer-compatible effects in assets/attacks/
with zero external JB2A dependency.

All directional assets point toward +X (right, 0 rad) to match Sequencer's
rotateTowards() / moveTowards() convention.
"""

from __future__ import annotations

import math
import os
import subprocess
import sys
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np


ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets" / "attacks"
FPS = 60


def encode_webm_alpha(frames_rgba: list[np.ndarray], out_path: Path, fps: int = FPS) -> None:
    """Encode list of uint8 RGBA (straight-alpha) frames into VP9 .webm with yuva420p alpha."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    h, w, c = frames_rgba[0].shape
    assert c == 4
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg,
        "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "rgba",
        "-s", f"{w}x{h}",
        "-r", str(fps),
        "-i", "-",
        "-an",
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0",
        "-b:v", "0",
        "-crf", "24",
        "-deadline", "good",
        "-cpu-used", "2",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    raw = b"".join(frame.tobytes() for frame in frames_rgba)
    _, err = proc.communicate(input=raw)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {out_path.name}:\n{err.decode('utf-8', errors='replace')}")


def hdr_to_straight_rgba(rgb_hdr: np.ndarray, alpha_extra: np.ndarray | None = None) -> np.ndarray:
    """
    Convert additive HDR linear-ish light buffer (H, W, 3) into crisp straight-alpha RGBA8.
    Preserves bright white-hot cores and vivid colored halos without dark premultiplied fringes.
    """
    # Soft tonemap for intense cores (>1.0 blooms toward white naturally across channels)
    lum = np.max(rgb_hdr, axis=-1)
    if alpha_extra is not None:
        lum_a = np.maximum(lum, alpha_extra)
    else:
        lum_a = lum

    # Smooth alpha curve with clean zero floor near edges
    alpha = np.clip((lum_a - 0.012) / 0.988, 0.0, 1.0)
    alpha = np.power(alpha, 0.82)

    # Unpremultiply HDR color by alpha, allowing >1 energy to spill across channels (white core)
    spill = np.maximum(0.0, lum - 1.0)
    rgb = rgb_hdr + spill[..., None] * 0.42
    safe_a = np.maximum(alpha[..., None], 1e-4)
    straight = np.clip(rgb / np.minimum(safe_a, 1.0), 0.0, 1.0)
    straight = np.where(alpha[..., None] > 0.002, straight, 0.0)

    out = np.zeros((*rgb_hdr.shape[:2], 4), dtype=np.uint8)
    out[..., :3] = np.round(straight * 255.0).astype(np.uint8)
    out[..., 3] = np.round(alpha * 255.0).astype(np.uint8)
    return out


def add_bloom(hdr: np.ndarray, sigma1: float = 5.0, sigma2: float = 16.0, w1: float = 0.45, w2: float = 0.28) -> np.ndarray:
    h, w = hdr.shape[:2]
    yy = np.abs(np.linspace(-1.0, 1.0, h, dtype=np.float32))[:, None]
    xx = np.abs(np.linspace(-1.0, 1.0, w, dtype=np.float32))[None, :]
    edge_d = np.maximum(xx, yy)
    pre_guard = np.clip((0.94 - edge_d) / 0.14, 0.0, 1.0) ** 1.4
    hdr = hdr * pre_guard[..., None]
    b1 = cv2.GaussianBlur(hdr, (0, 0), sigmaX=sigma1, sigmaY=sigma1)
    b2 = cv2.GaussianBlur(hdr, (0, 0), sigmaX=sigma2, sigmaY=sigma2)
    out = hdr + b1 * w1 + b2 * w2
    post_guard = np.clip((0.995 - edge_d) / 0.09, 0.0, 1.0) ** 1.5
    return out * post_guard[..., None]


def make_grid(w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    ys = np.linspace(-1.0, 1.0, h, dtype=np.float32)
    xs = np.linspace(-1.0, 1.0, w, dtype=np.float32)
    x, y = np.meshgrid(xs, ys)
    # Keep aspect ratio square in y if w != h
    if w > h:
        x = x * (w / h)
    elif h > w:
        y = y * (h / w)
    return x, y


def angular_noise(theta: np.ndarray, seed: int, freqs: tuple[int, ...] = (5, 9, 17, 29)) -> np.ndarray:
    rng = np.random.default_rng(seed)
    acc = np.zeros_like(theta, dtype=np.float32)
    amp = 0.55
    for f in freqs:
        phase = float(rng.uniform(0, math.tau))
        acc += amp * np.sin(theta * f + phase)
        amp *= 0.58
    return acc


def draw_sparks(
    hdr: np.ndarray,
    sparks: list[dict],
    t: float,
    w: int,
    h: int,
    aspect_x: float = 1.0,
) -> None:
    """Draw anti-aliased motion-stretched spark streaks onto HDR float32 canvas."""
    scale = np.zeros((h, w, 3), dtype=np.float32)
    for sp in sparks:
        t0 = sp["t0"]
        life = sp["life"]
        u = (t - t0) / life
        if u <= 0.0 or u >= 1.0:
            continue
        # Fast deceleration drag
        ease = 1.0 - pow(1.0 - u, 2.6)
        ease_prev = 1.0 - pow(1.0 - max(0.0, u - 0.14), 2.6)
        ang = sp["ang"] + sp.get("curve", 0.0) * u
        ca, sa = math.cos(ang), math.sin(ang)
        r0 = sp["r0"] + sp["dist"] * ease_prev
        r1 = sp["r0"] + sp["dist"] * ease
        x0, y0 = sp["ox"] + ca * r0, sp["oy"] + sa * r0
        x1, y1 = sp["ox"] + ca * r1, sp["oy"] + sa * r1

        px0 = int(round((x0 / aspect_x * 0.5 + 0.5) * (w - 1)))
        py0 = int(round((y0 * 0.5 + 0.5) * (h - 1)))
        px1 = int(round((x1 / aspect_x * 0.5 + 0.5) * (w - 1)))
        py1 = int(round((y1 * 0.5 + 0.5) * (h - 1)))

        fade = (1.0 - u) ** 1.35 * min(1.0, u * 9.0)
        col = tuple(float(c * fade * sp.get("intensity", 1.4)) for c in sp["color"])
        thick = max(1, int(round(sp.get("thick", 2.0) * (1.0 - 0.5 * u))))
        cv2.line(scale, (px0, py0), (px1, py1), col, thickness=thick, lineType=cv2.LINE_AA)

    hdr += scale


# ---------------------------------------------------------------------------
# 1. SLASH ARC (512x512, 24 frames) — points +X, supports mirrorY & tint
# ---------------------------------------------------------------------------
def gen_slash_arc() -> list[np.ndarray]:
    w = h = 512
    n_frames = 24
    x, y = make_grid(w, h)
    # Shift arc center slightly left so crescent sweeps right (+X) across contact
    cx, cy = -0.18, 0.0
    dx, dy = x - cx, y - cy
    r = np.hypot(dx, dy)
    theta = np.arctan2(dy, dx)  # 0 at +X
    wisp = angular_noise(theta, seed=101, freqs=(6, 13, 23, 37))

    rng = np.random.default_rng(101)
    sparks = []
    for _ in range(24):
        ang = float(rng.uniform(-1.15, 1.15))
        sparks.append({
            "ox": cx + math.cos(ang) * 0.56,
            "oy": cy + math.sin(ang) * 0.56,
            "r0": 0.0,
            "dist": float(rng.uniform(0.18, 0.46)),
            "ang": ang + float(rng.uniform(-0.35, 0.35)),
            "curve": float(rng.uniform(-0.3, 0.3)),
            "t0": float(rng.uniform(0.04, 0.22)),
            "life": float(rng.uniform(0.45, 0.78)),
            "color": (1.5, 1.28, 0.95),
            "thick": float(rng.uniform(1.6, 3.0)),
            "intensity": float(rng.uniform(1.1, 1.8)),
        })

    frames: list[np.ndarray] = []
    for i in range(n_frames):
        t = i / (n_frames - 1)
        hdr = np.zeros((h, w, 3), dtype=np.float32)

        if t < 0.94:
            # Sweep head goes from -1.35 rad (top-left-ish) to +1.25 rad (bottom-right) very fast
            sweep_u = min(1.0, t / 0.34)
            head_ease = 1.0 - pow(1.0 - sweep_u, 3.2)
            tail_u = max(0.0, (t - 0.07) / 0.72)
            tail_ease = tail_u ** 1.45

            a_start = -1.32 + 2.35 * tail_ease
            a_end = -1.32 + 2.62 * head_ease

            if a_end > a_start + 0.02:
                span = a_end - a_start
                u_arc = (theta - a_start) / max(span, 1e-4)
                in_arc = (u_arc >= 0.0) & (u_arc <= 1.0)

                # Tapered crescent profile: sharpest & brightest near leading edge (u_arc ~ 0.82)
                u_clamped = np.clip(u_arc, 0.0, 1.0)
                profile = np.where(in_arc, np.maximum(0.0, np.sin(u_clamped * math.pi)) ** 0.65, 0.0)
                lead_boost = np.where(in_arc, u_clamped ** 1.6, 0.0)

                base_r = 0.64 + 0.11 * t + 0.018 * wisp * t
                half_thick = (0.105 * (1.0 - 0.62 * t)) * (0.35 + 0.85 * profile)
                radial_dist = np.abs(r - base_r) / np.maximum(half_thick, 1e-4)

                blade_core = np.exp(-(radial_dist ** 2) * 2.8) * profile
                blade_aura = np.exp(-(radial_dist ** 2) * 0.75) * profile

                # Secondary inner wind-scar echo
                echo_r = base_r - 0.11 - 0.04 * t
                echo_dist = np.abs(r - echo_r) / np.maximum(half_thick * 0.55, 1e-4)
                echo = np.exp(-(echo_dist ** 2) * 3.2) * profile * max(0.0, 1.0 - t * 1.45)

                # Clean erosion near tail end
                dissolve = max(0.0, 1.0 - max(0.0, (t - 0.45) / 0.49) ** 1.5)
                erode_mask = np.clip(1.0 + 0.35 * wisp - max(0.0, t - 0.52) * 1.9, 0.0, 1.0)
                energy = dissolve * erode_mask

                # Color: cool silver-cyan steel aura + blazing white core (also tints cleanly!)
                col_aura = np.array([0.62, 0.84, 1.15], dtype=np.float32)
                col_core = np.array([1.55, 1.58, 1.65], dtype=np.float32)
                hdr += (blade_aura[..., None] * col_aura * 0.85 + blade_core[..., None] * col_core * (1.15 + 0.55 * lead_boost[..., None])) * energy[..., None]
                hdr += echo[..., None] * np.array([0.85, 0.95, 1.2], dtype=np.float32) * 0.65 * dissolve

        # Contact flash at (+0.45, 0) on frames 2..8
        if 0.05 <= t <= 0.38:
            ft = (t - 0.05) / 0.33
            f_amp = math.sin(ft * math.pi) * (1.0 - ft * 0.5)
            fx, fy = x - 0.44, y
            fr = np.hypot(fx, fy)
            fa = np.arctan2(fy, fx)
            star = np.exp(-fr * 9.5) + np.exp(-fr * 4.2) * (np.abs(np.cos(fa * 2.0 + 0.4)) ** 14)
            hdr += (star * f_amp * 1.45)[..., None] * np.array([1.3, 1.25, 1.15], dtype=np.float32)

        draw_sparks(hdr, sparks, t, w, h)
        hdr = add_bloom(hdr, sigma1=4.5, sigma2=15.0, w1=0.48, w2=0.26)
        frames.append(hdr_to_straight_rgba(hdr))

    # Guarantee final frame clean zero
    frames[-1][:] = 0
    return frames


# ---------------------------------------------------------------------------
# 2. PIERCE THRUST (640x320, 22 frames) — supersonic lance along +X
# ---------------------------------------------------------------------------
def gen_pierce_thrust() -> list[np.ndarray]:
    w, h = 640, 320
    n_frames = 22
    aspect_x = w / h  # 2.0 -> x in [-2, 2], y in [-1, 1]
    x, y = make_grid(w, h)

    rng = np.random.default_rng(202)
    sparks = []
    for _ in range(26):
        ang = float(rng.normal(0.0, 0.26))
        sparks.append({
            "ox": -0.15,
            "oy": 0.0,
            "r0": 0.05,
            "dist": float(rng.uniform(0.55, 1.65)),
            "ang": ang,
            "curve": float(rng.uniform(-0.12, 0.12)),
            "t0": float(rng.uniform(0.02, 0.18)),
            "life": float(rng.uniform(0.42, 0.76)),
            "color": (1.55, 1.38, 1.05),
            "thick": float(rng.uniform(1.5, 2.8)),
            "intensity": float(rng.uniform(1.2, 1.9)),
        })

    frames: list[np.ndarray] = []
    for i in range(n_frames):
        t = i / (n_frames - 1)
        hdr = np.zeros((h, w, 3), dtype=np.float32)

        if t < 0.92:
            shoot_u = min(1.0, t / 0.24)
            tip_x = -1.35 + 3.05 * (1.0 - pow(1.0 - shoot_u, 3.5))
            tail_x = -1.45 + 2.85 * (max(0.0, (t - 0.06) / 0.78) ** 1.35)

            if tip_x > tail_x + 0.05:
                u_len = (x - tail_x) / (tip_x - tail_x)
                in_len = (u_len >= 0.0) & (u_len <= 1.0)
                u_c = np.clip(u_len, 0.0, 1.0)
                taper = np.where(in_len, (u_c ** 0.75) * (np.maximum(0.0, np.sin(u_c * math.pi)) ** 0.45), 0.0)
                half_w = (0.075 * (1.0 - 0.58 * t)) * (0.25 + 0.95 * taper)
                yd = np.abs(y) / np.maximum(half_w, 1e-4)

                lance_core = np.exp(-(yd ** 2) * 3.2) * taper
                lance_aura = np.exp(-(yd ** 2) * 0.75) * taper
                fade = (1.0 - max(0.0, (t - 0.32) / 0.60)) ** 1.4

                hdr += (
                    lance_aura[..., None] * np.array([0.65, 0.88, 1.25], dtype=np.float32) * 0.9
                    + lance_core[..., None] * np.array([1.65, 1.62, 1.55], dtype=np.float32) * 1.45
                ) * fade

            # Supersonic Mach shock-rings around entry (-0.05, 0) and mid (+0.35, 0)
            for idx_ring, rx0 in enumerate((-0.12, 0.32)):
                rt = (t - 0.05 * idx_ring) / 0.68
                if 0.0 < rt < 1.0:
                    re = 1.0 - (1.0 - rt) ** 2.4
                    ex = (x - (rx0 + 0.18 * re)) / 0.32
                    ey = y / (0.18 + 0.58 * re)
                    er = np.hypot(ex, ey)
                    ring = np.exp(-((er - 1.0) / 0.16) ** 2 * 2.5) * ((1.0 - rt) ** 1.6) * (x > rx0 - 0.25)
                    hdr += ring[..., None] * np.array([0.95, 1.12, 1.35], dtype=np.float32) * 0.95

            # Entry starflash at (0, 0)
            if t < 0.36:
                st = t / 0.36
                sr = np.hypot(x * 0.65, y * 1.25)
                sa = np.arctan2(y, x)
                rays = np.abs(np.cos(sa * 2.0)) ** 18
                burst = (np.exp(-sr * 8.0) + np.exp(-sr * 2.8) * rays) * ((1.0 - st) ** 1.5)
                hdr += burst[..., None] * np.array([1.5, 1.45, 1.3], dtype=np.float32) * 1.3

        draw_sparks(hdr, sparks, t, w, h, aspect_x=aspect_x)
        hdr = add_bloom(hdr, sigma1=4.0, sigma2=13.0, w1=0.45, w2=0.25)
        frames.append(hdr_to_straight_rgba(hdr))

    frames[-1][:] = 0
    return frames


# ---------------------------------------------------------------------------
# 3. BLUDGEON IMPACT (512x512, 26 frames) — heavy radial shockwave + crown
# ---------------------------------------------------------------------------
def gen_bludgeon_impact() -> list[np.ndarray]:
    w = h = 512
    n_frames = 26
    x, y = make_grid(w, h)
    r = np.hypot(x, y)
    theta = np.arctan2(y, x)
    spike_noise = angular_noise(theta, seed=303, freqs=(7, 13, 21, 33))
    dust_noise = angular_noise(theta, seed=309, freqs=(4, 9, 16))

    rng = np.random.default_rng(303)
    sparks = []
    for _ in range(32):
        ang = float(rng.uniform(-math.pi, math.pi))
        sparks.append({
            "ox": 0.0,
            "oy": 0.0,
            "r0": float(rng.uniform(0.04, 0.14)),
            "dist": float(rng.uniform(0.35, 0.82)),
            "ang": ang,
            "curve": float(rng.uniform(-0.2, 0.2)),
            "t0": float(rng.uniform(0.0, 0.12)),
            "life": float(rng.uniform(0.45, 0.85)),
            "color": (1.45, 1.12, 0.72),
            "thick": float(rng.uniform(1.8, 3.4)),
            "intensity": float(rng.uniform(1.0, 1.6)),
        })

    frames: list[np.ndarray] = []
    for i in range(n_frames):
        t = i / (n_frames - 1)
        hdr = np.zeros((h, w, 3), dtype=np.float32)

        if t < 0.94:
            # 1) Core impact flash + jagged spike crown
            if t < 0.48:
                ct = t / 0.48
                ce = 1.0 - (1.0 - ct) ** 2.8
                crown_r = (0.18 + 0.56 * ce) * (0.72 + 0.38 * np.abs(spike_noise))
                crown = np.clip(1.0 - r / np.maximum(crown_r, 1e-4), 0.0, 1.0) ** 1.7
                rim = np.exp(-((r - crown_r * 0.88) / 0.055) ** 2 * 2.2) * (r <= crown_r * 1.08)
                cfade = (1.0 - ct) ** 1.45
                hdr += (
                    crown[..., None] * np.array([1.25, 0.95, 0.62], dtype=np.float32) * 0.9
                    + rim[..., None] * np.array([1.55, 1.38, 1.05], dtype=np.float32) * 1.35
                ) * cfade

            # 2) Primary & secondary shockwave rings
            for delay, max_r, width, strength in ((0.0, 0.72, 0.070, 1.35), (0.09, 0.54, 0.052, 0.9)):
                rt = (t - delay) / (0.86 - delay)
                if 0.0 < rt < 1.0:
                    re = 1.0 - (1.0 - rt) ** 2.6
                    ring_r = (0.10 + max_r * re) + 0.028 * dust_noise * re
                    rw = width * (1.0 - 0.45 * rt)
                    ring = np.exp(-((r - ring_r) / np.maximum(rw, 1e-4)) ** 2 * 2.4)
                    erode = np.clip(1.1 + 0.45 * dust_noise - rt * 1.25, 0.0, 1.0)
                    rfade = ((1.0 - rt) ** 1.3) * erode
                    hdr += ring[..., None] * np.array([1.35, 1.12, 0.82], dtype=np.float32) * (strength * rfade)[..., None]

        draw_sparks(hdr, sparks, t, w, h)
        hdr = add_bloom(hdr, sigma1=4.5, sigma2=14.0, w1=0.44, w2=0.26)
        frames.append(hdr_to_straight_rgba(hdr))

    frames[-1][:] = 0
    return frames


# ---------------------------------------------------------------------------
# 4. SHIELD BLOCK (512x512, 24 frames) — golden-steel barrier facing +X
# ---------------------------------------------------------------------------
def gen_shield_block() -> list[np.ndarray]:
    w = h = 512
    n_frames = 24
    x, y = make_grid(w, h)
    # Barrier centered around defender origin (-0.15, 0), curved shell at radius ~0.52 facing +X
    cx, cy = -0.22, 0.0
    dx, dy = x - cx, y - cy
    r = np.hypot(dx, dy)
    theta = np.arctan2(dy, dx)
    hex_ripple = np.abs(np.sin(theta * 14.0) * np.sin(r * 28.0))
    n_wisp = angular_noise(theta, seed=404, freqs=(8, 15, 27))

    rng = np.random.default_rng(404)
    sparks = []
    for _ in range(34):
        # Sparks ricochet outward/sideways into +X fan
        ang = float(rng.uniform(-1.38, 1.38))
        sparks.append({
            "ox": 0.28,
            "oy": float(rng.uniform(-0.08, 0.08)),
            "r0": 0.02,
            "dist": float(rng.uniform(0.28, 0.72)),
            "ang": ang,
            "curve": float(rng.uniform(-0.35, 0.35)),
            "t0": float(rng.uniform(0.0, 0.10)),
            "life": float(rng.uniform(0.45, 0.88)),
            "color": (1.65, 1.22, 0.55),
            "thick": float(rng.uniform(1.6, 3.2)),
            "intensity": float(rng.uniform(1.2, 2.0)),
        })

    frames: list[np.ndarray] = []
    for i in range(n_frames):
        t = i / (n_frames - 1)
        hdr = np.zeros((h, w, 3), dtype=np.float32)

        if t < 0.94:
            # Curved aegis barrier arc across [-1.05, +1.05] rad
            arc_span = 1.02 * (0.75 + 0.25 * min(1.0, t / 0.18))
            ang_mask = np.clip(1.0 - (np.abs(theta) / arc_span) ** 2.4, 0.0, 1.0)
            shell_r = 0.50 + 0.06 * (1.0 - (1.0 - t) ** 2.5)
            shell_w = 0.052 * (1.0 - 0.35 * t)
            shell = np.exp(-((r - shell_r) / shell_w) ** 2 * 2.5) * ang_mask

            # Shock ripple spreading along the shield arc from theta=0 outward
            wave_pos = min(1.2, t * 2.8)
            wave = np.exp(-((np.abs(theta) - wave_pos) / 0.24) ** 2 * 2.0) * shell
            fade = (1.0 - max(0.0, (t - 0.16) / 0.78)) ** 1.45
            erode = np.clip(1.15 + 0.3 * n_wisp - t * 1.15, 0.0, 1.0)

            col_gold = np.array([1.45, 1.15, 0.58], dtype=np.float32)
            col_steel = np.array([0.85, 1.12, 1.45], dtype=np.float32)
            hdr += (
                shell[..., None] * (col_gold * 0.85 + col_steel * 0.45 * hex_ripple[..., None])
                + wave[..., None] * np.array([1.65, 1.55, 1.25], dtype=np.float32) * 1.15
            ) * (fade * erode)[..., None]

            # Bright metallic clash star at impact point (+0.28, 0)
            if t < 0.42:
                ct = t / 0.42
                sx, sy = x - 0.28, y
                sr = np.hypot(sx, sy)
                sa = np.arctan2(sy, sx)
                cross = (np.abs(np.cos(sa * 2.0 + 0.35)) ** 20 + np.abs(np.cos(sa * 4.0)) ** 28 * 0.5)
                clash = (np.exp(-sr * 9.0) * 1.4 + np.exp(-sr * 3.0) * cross * 1.2) * ((1.0 - ct) ** 1.6)
                hdr += clash[..., None] * np.array([1.65, 1.48, 1.1], dtype=np.float32)

        draw_sparks(hdr, sparks, t, w, h)
        hdr = add_bloom(hdr, sigma1=4.2, sigma2=14.0, w1=0.46, w2=0.26)
        frames.append(hdr_to_straight_rgba(hdr))

    frames[-1][:] = 0
    return frames


# ---------------------------------------------------------------------------
# 5. CRIT BURST (640x640, 36 frames) — replaces jb2a.impact.004.orange!
# ---------------------------------------------------------------------------
def gen_crit_burst() -> list[np.ndarray]:
    w = h = 640
    n_frames = 36
    x, y = make_grid(w, h)
    r = np.hypot(x, y)
    theta = np.arctan2(y, x)
    flare_noise = angular_noise(theta, seed=505, freqs=(6, 11, 19, 31))
    speed_rays = np.abs(np.cos(theta * 12.0 + flare_noise * 0.5)) ** 22 + np.abs(np.cos(theta * 5.0 - 0.4)) ** 16 * 0.7

    rng = np.random.default_rng(505)
    sparks = []
    for _ in range(48):
        ang = float(rng.uniform(-math.pi, math.pi))
        hot = rng.random() < 0.55
        sparks.append({
            "ox": 0.0,
            "oy": 0.0,
            "r0": float(rng.uniform(0.03, 0.14)),
            "dist": float(rng.uniform(0.45, 0.96)),
            "ang": ang,
            "curve": float(rng.uniform(-0.32, 0.32)),
            "t0": float(rng.uniform(0.0, 0.16)),
            "life": float(rng.uniform(0.48, 0.88)),
            "color": (1.75, 1.32, 0.58) if hot else (1.65, 0.62, 0.32),
            "thick": float(rng.uniform(1.8, 3.6)),
            "intensity": float(rng.uniform(1.3, 2.2)),
        })

    frames: list[np.ndarray] = []
    for i in range(n_frames):
        t = i / (n_frames - 1)
        hdr = np.zeros((h, w, 3), dtype=np.float32)

        if t < 0.95:
            # Stage 1: Blinding impact star + diagonal X-cleave + radial speedlines
            if t < 0.34:
                st = t / 0.34
                s_fade = (1.0 - st) ** 1.5
                x_slash = (
                    np.exp(-((x * 0.707 - y * 0.707) / 0.042) ** 2 * 2.5) * np.exp(-(r / 0.85) ** 2 * 1.4)
                    + np.exp(-((x * 0.707 + y * 0.707) / 0.036) ** 2 * 2.5) * np.exp(-(r / 0.78) ** 2 * 1.5)
                )
                rays = speed_rays * np.exp(-((r - (0.18 + 0.55 * st)) / 0.36) ** 2 * 1.8) * (r > 0.06)
                core = np.exp(-r * 6.5) * 1.8
                hdr += (
                    (core + x_slash * 1.35)[..., None] * np.array([1.75, 1.55, 1.18], dtype=np.float32)
                    + rays[..., None] * np.array([1.65, 1.05, 0.45], dtype=np.float32) * 1.25
                ) * s_fade

            # Stage 2: Fiery golden-crimson plasma crown
            if t < 0.72:
                pt = t / 0.72
                pe = 1.0 - (1.0 - pt) ** 2.7
                crown_r = (0.13 + 0.56 * pe) * (0.76 + 0.32 * np.abs(flare_noise))
                fire_rim = np.exp(-((r - crown_r * 0.86) / (0.080 * (1.0 - 0.35 * pt))) ** 2 * 2.0) * (r <= crown_r * 1.15)
                inner_glow = np.clip(1.0 - r / np.maximum(crown_r, 1e-4), 0.0, 1.0) ** 2.1
                pfade = (1.0 - pt) ** 1.35
                hdr += (
                    fire_rim[..., None] * np.array([1.65, 0.92, 0.32], dtype=np.float32) * 1.35
                    + inner_glow[..., None] * np.array([1.45, 0.48, 0.22], dtype=np.float32) * 0.95
                ) * pfade

            # Stage 3: Twin supersonic shockwaves
            for delay, r_max, col in (
                (0.02, 0.76, np.array([1.65, 1.28, 0.68], dtype=np.float32)),
                (0.14, 0.62, np.array([1.55, 0.62, 0.32], dtype=np.float32)),
            ):
                wt = (t - delay) / (0.90 - delay)
                if 0.0 < wt < 1.0:
                    we = 1.0 - (1.0 - wt) ** 2.8
                    wr = 0.08 + r_max * we + 0.022 * flare_noise * we
                    ww = 0.062 * (1.0 - 0.52 * wt)
                    wave = np.exp(-((r - wr) / np.maximum(ww, 1e-4)) ** 2 * 2.5)
                    erode = np.clip(1.15 + 0.4 * flare_noise - wt * 1.22, 0.0, 1.0)
                    hdr += wave[..., None] * col * (((1.0 - wt) ** 1.35) * erode)[..., None] * 1.25

        draw_sparks(hdr, sparks, t, w, h)
        hdr = add_bloom(hdr, sigma1=5.0, sigma2=18.0, w1=0.50, w2=0.30)
        frames.append(hdr_to_straight_rgba(hdr))

    frames[-1][:] = 0
    return frames


# ---------------------------------------------------------------------------
# 6. PROJECTILE ARROW (512x192, 20 frames) — aerodynamic physical bolt (+X)
# ---------------------------------------------------------------------------
def gen_projectile_arrow() -> list[np.ndarray]:
    w, h = 512, 192
    n_frames = 20
    x, y = make_grid(w, h)  # x in [-2.66, 2.66], y in [-1, 1]

    frames: list[np.ndarray] = []
    for i in range(n_frames):
        phase = (i / n_frames) * math.tau
        hdr = np.zeros((h, w, 3), dtype=np.float32)

        # Arrow shaft + blazing arrowhead positioned forward (+X ~ +1.15)
        in_shaft = (x >= -1.95) & (x <= 1.25)
        u_s = np.clip((x + 1.95) / 3.20, 0.0, 1.0)
        shaft_w = 0.032 + 0.035 * (u_s ** 1.8)
        shaft = np.where(in_shaft, np.exp(-(y / shaft_w) ** 2 * 2.8) * (u_s ** 0.7), 0.0)

        # V-shaped broadhead / supersonic wind cone at tip (+1.28, 0)
        dx_tip = 1.32 - x
        in_cone = (dx_tip >= -0.08) & (dx_tip <= 1.65)
        cone_y = 0.035 + np.maximum(0.0, dx_tip) * 0.24
        cone = np.where(
            in_cone,
            np.exp(-((np.abs(y) - cone_y) / 0.042) ** 2 * 2.4) * np.exp(-np.maximum(0.0, dx_tip) * 1.45),
            0.0,
        )

        # Helical slipstream ribbons pulsing along wake
        hel1_y = np.sin(x * 3.6 - phase) * (0.06 + 0.16 * (1.0 - u_s))
        hel2_y = -hel1_y
        wake_u = np.clip((x + 2.35) / 3.5, 0.0, 1.0)
        wake_mask = np.where((x >= -2.35) & (x <= 1.15), np.maximum(0.0, np.sin(wake_u * math.pi)) ** 0.75, 0.0)
        ribbon = (
            np.exp(-((y - hel1_y) / 0.048) ** 2 * 2.2)
            + np.exp(-((y - hel2_y) / 0.048) ** 2 * 2.2)
        ) * wake_mask * 0.55

        tip_glow = np.exp(-np.hypot((x - 1.22) * 0.85, y * 1.8) * 5.2)

        hdr += shaft[..., None] * np.array([1.45, 1.42, 1.32], dtype=np.float32) * 1.35
        hdr += cone[..., None] * np.array([0.95, 1.18, 1.45], dtype=np.float32) * 1.05
        hdr += ribbon[..., None] * np.array([0.85, 1.05, 1.28], dtype=np.float32) * 0.85
        hdr += tip_glow[..., None] * np.array([1.65, 1.58, 1.38], dtype=np.float32) * 1.3

        hdr = add_bloom(hdr, sigma1=3.5, sigma2=11.0, w1=0.45, w2=0.24)
        frames.append(hdr_to_straight_rgba(hdr))

    return frames


# ---------------------------------------------------------------------------
# 7. PROJECTILE SPELL (512x256, 24 frames) — neutral white-silver arcane comet (+X)
#    Neutral white luminance so Sequencer .tint(hex) colors it to ANY element!
# ---------------------------------------------------------------------------
def gen_projectile_spell() -> list[np.ndarray]:
    w, h = 512, 256
    n_frames = 24
    x, y = make_grid(w, h)  # x in [-2, 2], y in [-1, 1]

    frames: list[np.ndarray] = []
    for i in range(n_frames):
        phase = (i / n_frames) * math.tau
        hdr = np.zeros((h, w, 3), dtype=np.float32)

        # Comet head at (+0.88, 0)
        hx, hy = x - 0.88, y
        hr = np.hypot(hx * 0.9, hy * 1.15)
        ha = np.arctan2(hy, hx)
        swirl = 0.5 + 0.5 * np.sin(ha * 4.0 - hr * 9.0 + phase * 2.0)
        head_core = np.exp(-hr * 5.4) * 1.75
        head_corona = np.exp(-hr * 2.7) * (0.65 + 0.55 * swirl) * 1.1

        # Spiraling comet tail trailing to -1.85
        in_tail = (x >= -1.88) & (x <= 0.95)
        u_t = np.clip((x + 1.88) / 2.83, 0.0, 1.0)
        env = np.where(in_tail, (u_t ** 1.15) * (1.0 - 0.15 * (1.0 - u_t)), 0.0)

        w1 = np.sin(x * 4.5 - phase * 2.0) * (0.24 * (1.0 - u_t * 0.75))
        w2 = np.sin(x * 6.2 - phase * 3.0 + 2.1) * (0.17 * (1.0 - u_t * 0.7))
        tail_core = np.exp(-(y / (0.09 + 0.08 * u_t)) ** 2 * 2.4) * env
        strand1 = np.exp(-((y - w1) / 0.065) ** 2 * 2.4) * env
        strand2 = np.exp(-((y - w2) / 0.055) ** 2 * 2.4) * env

        # Sparkling motes drifting backward in the wake
        mote = np.zeros((h, w), dtype=np.float32)
        for m in range(10):
            mu = ((m / 10.0) - (i / n_frames)) % 1.0
            mx = 0.85 - mu * 2.45
            my = math.sin(m * 2.3 + mu * 6.0) * (0.05 + 0.22 * mu)
            mr = np.hypot(x - mx, y - my)
            mote += np.exp(-mr * 18.0) * (1.0 - mu) * 1.25

        lum = head_core + head_corona + tail_core * 1.15 + (strand1 + strand2) * 0.78 + mote
        # Pure neutral white-silver so .tint() maps cleanly to fire, force, necrotic, cold, lightning, etc.
        hdr += lum[..., None] * np.array([1.0, 1.0, 1.0], dtype=np.float32)

        hdr = add_bloom(hdr, sigma1=4.0, sigma2=13.0, w1=0.46, w2=0.28)
        frames.append(hdr_to_straight_rgba(hdr))

    return frames


# ---------------------------------------------------------------------------
# 8. SPELL IMPACT (512x512, 26 frames) — neutral white-silver elemental burst
#    Designed for .tint(damageColor) across all magical damage types!
# ---------------------------------------------------------------------------
def gen_spell_impact() -> list[np.ndarray]:
    w = h = 512
    n_frames = 26
    x, y = make_grid(w, h)
    r = np.hypot(x, y)
    theta = np.arctan2(y, x)
    arc_noise = angular_noise(theta, seed=808, freqs=(5, 12, 21, 34))

    rng = np.random.default_rng(808)
    sparks = []
    for _ in range(36):
        ang = float(rng.uniform(-math.pi, math.pi))
        sparks.append({
            "ox": 0.0,
            "oy": 0.0,
            "r0": float(rng.uniform(0.03, 0.12)),
            "dist": float(rng.uniform(0.38, 0.88)),
            "ang": ang,
            "curve": float(rng.uniform(-0.55, 0.55)),
            "t0": float(rng.uniform(0.0, 0.14)),
            "life": float(rng.uniform(0.45, 0.86)),
            "color": (1.55, 1.55, 1.55),
            "thick": float(rng.uniform(1.6, 3.0)),
            "intensity": float(rng.uniform(1.1, 1.85)),
        })

    frames: list[np.ndarray] = []
    for i in range(n_frames):
        t = i / (n_frames - 1)
        hdr = np.zeros((h, w, 3), dtype=np.float32)

        if t < 0.94:
            # Arcane sigil / star burst in early frames
            if t < 0.44:
                st = t / 0.44
                se = 1.0 - (1.0 - st) ** 2.6
                sigil_r = 0.22 + 0.42 * se
                poly = np.abs(np.cos(theta * 6.0 + st * 1.4)) ** 10
                sigil = np.exp(-((r - sigil_r) / 0.045) ** 2 * 2.5) * (0.55 + 0.75 * poly)
                core = np.exp(-r * 6.0) * 1.65
                hdr += (core + sigil * 1.35)[..., None] * ((1.0 - st) ** 1.45)

            # Swirling arcane tendrils + shockwave
            wt = t / 0.90
            if wt < 1.0:
                we = 1.0 - (1.0 - wt) ** 2.5
                swirl_ang = theta + (1.0 - r) * 2.8 - t * 3.2
                tendrils = (0.5 + 0.5 * np.sin(swirl_ang * 7.0 + arc_noise * 1.4)) ** 2.2
                ring_r = 0.12 + 0.64 * we + 0.032 * arc_noise * we
                ring = np.exp(-((r - ring_r) / (0.08 * (1.0 - 0.4 * wt))) ** 2 * 2.2)
                nebula = np.exp(-((r - ring_r * 0.72) / 0.22) ** 2 * 1.6) * tendrils
                erode = np.clip(1.15 + 0.42 * arc_noise - wt * 1.2, 0.0, 1.0)
                fade = ((1.0 - wt) ** 1.35) * erode
                hdr += (ring * 1.35 + nebula * 0.85)[..., None] * fade[..., None]

        draw_sparks(hdr, sparks, t, w, h)
        hdr = add_bloom(hdr, sigma1=4.5, sigma2=15.0, w1=0.48, w2=0.28)
        frames.append(hdr_to_straight_rgba(hdr))

    frames[-1][:] = 0
    return frames


def save_preview_sheet(all_clips: dict[str, list[np.ndarray]], preview_path: Path) -> None:
    """Render a checkerboard contact sheet of peak frames for visual verification."""
    rows = []
    tile_h = 160
    tile_w = 240
    sample_fracs = (0.08, 0.22, 0.42, 0.68)

    for name, frames in all_clips.items():
        row_tiles = []
        for frac in sample_fracs:
            idx = min(len(frames) - 1, max(0, int(round(frac * (len(frames) - 1)))))
            fr = cv2.resize(frames[idx], (tile_w, tile_h), interpolation=cv2.INTER_AREA)
            # Dark checkerboard background so alpha & fringes are easy to inspect
            yy, xx = np.mgrid[0:tile_h, 0:tile_w]
            checker = np.where(((xx // 16) + (yy // 16)) % 2 == 0, 28, 42).astype(np.float32)
            bg = np.stack([checker, checker * 0.95, checker * 1.08], axis=-1)
            a = fr[..., 3:4].astype(np.float32) / 255.0
            comp = np.clip(fr[..., :3].astype(np.float32) * a + bg * (1.0 - a), 0, 255).astype(np.uint8)
            cv2.putText(comp, f"{name} f{idx}", (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 230), 1, cv2.LINE_AA)
            row_tiles.append(comp)
        rows.append(np.concatenate(row_tiles, axis=1))

    sheet = np.concatenate(rows, axis=0)
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(preview_path), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR))


def main() -> int:
    generators = {
        "slash-arc": gen_slash_arc,
        "pierce-thrust": gen_pierce_thrust,
        "bludgeon-impact": gen_bludgeon_impact,
        "shield-block": gen_shield_block,
        "crit-burst": gen_crit_burst,
        "projectile-arrow": gen_projectile_arrow,
        "projectile-spell": gen_projectile_spell,
        "spell-impact": gen_spell_impact,
    }

    rendered: dict[str, list[np.ndarray]] = {}
    for name, fn in generators.items():
        frames = fn()
        out_file = OUT_DIR / f"{name}.webm"
        encode_webm_alpha(frames, out_file, fps=FPS)
        size_kb = out_file.stat().st_size / 1024.0
        print(f"OK  {out_file.relative_to(ROOT)}  ({len(frames)} frames, {size_kb:.1f} KB)")
        rendered[name] = frames

    if len(sys.argv) > 1:
        preview = Path(sys.argv[1])
        save_preview_sheet(rendered, preview)
        print(f"Preview saved: {preview}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
