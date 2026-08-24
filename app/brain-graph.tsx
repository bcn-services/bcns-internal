"use client";

/**
 * brain-graph.tsx — the 3D knowledge graph over $OS_DIR, the home page's hero.
 *
 * Ported from project-dashboard's graph.astro client island. What changed and
 * why, so the next edit does not "restore" something that was cut on purpose:
 *
 *   * A node click opens a POPUP, it does not navigate. The Astro page sent you
 *     to /files, which this app no longer has. Business employees will not have
 *     os cloned, so the graph is their only way into knowledge/audience/ and
 *     knowledge/library/bcns/ — sending them to a second page to read one file
 *     was the worst part of the old flow.
 *   * The speaking-glow (bloom driven by voice level) is NOT ported. It has no
 *     input until voice lands; bloom sits at its resting strength.
 *   * The `graph:ready` event and `container.__fg` publish are gone. They
 *     existed so a late-mounting Astro island could find the instance; React
 *     owns the lifecycle here.
 *
 * The libraries load inside the effect, never at module scope: `3d-force-graph`
 * writes a <style> into document.head at import time and `three-forcegraph`
 * throws `window is not defined` off the server.
 */
import { useEffect, useRef, useState } from "react";

export type BrainNode = {
  id: string;
  kind: string;
  label: string;
  display: string;
  relPath: string | null;
};
export type BrainEdge = { source: string; target: string; kind: string };

// ── Palette ────────────────────────────────────────────────────────────────
// Checked once against the near-black ground, because a node is an unlit
// additive sprite: it renders at its own colour regardless of light direction,
// so there is no shaded column to check a second time. Measured on #06050c:
// note 15.6:1, folder 8.6:1, stub 6.9:1 — every node clears WCAG 1.4.11's 3:1
// non-text floor on its own, before any additive accumulation.
const BACKGROUND = "#06050c";
const NODE_COLOR: Record<string, string> = { note: "#ece5f8", folder: "#c3a6f2", stub: "#a99cc0" };

// Edges are LINE materials, so unlike the nodes they are composited, not
// additive — their contrast is the blend against the background and nothing
// brightens them later. Measured on the composited pixel at linkOpacity 0.63:
// link 4.11:1, contains 3.21:1. Both are load-bearing: LINK_OPACITY is set
// explicitly because the library ships 0.2, at which every relationship this
// page exists to draw measures under 1.25:1 and is invisible.
const LINK_COLOR = "#b3a9d6";
const CONTAINS_COLOR = "#968fb0";
const LINK_OPACITY = 0.63;
const NODE_OPACITY = 0.75;

// Width picks the GEOMETRY in three-forcegraph: >0 builds a lit cylinder mesh,
// 0 builds a flat unlit Line. Both are 0. A lit cylinder is a shaded solid —
// the exact thing removed from the nodes — so tube edges would be the only
// Lambert-shaded surface left, lit by lights nothing else uses.
const LINK_WIDTH = 0;
const CONTAINS_WIDTH = 0;

// The star texture's shape. `core` is the fraction of the radius that stays
// solid before the halo falls off; `falloff` is the halo exponent (higher =
// tighter star); `flare` is the four-point diffraction spike.
const STAR_CORE = 0.15;
const STAR_FALLOFF = 2.6;
const STAR_FLARE = 0.25;
// Star diameter in world units: cbrt(nodeVal) * NODE_REL_SIZE * this. World
// units and not a fraction of the layout, because sprites are built BEFORE the
// layout runs — there is no radius to measure yet, and sizing them later leaves
// a window where every node is ~9x too small, which also shrinks the raycast
// target and makes clicks miss.
const STAR_SIZE_FACTOR = 3.2;

const BLOOM_STRENGTH = 0.224;
const BLOOM_RADIUS = 0.28;
const BLOOM_THRESHOLD = 0.25;

// Volumes, not radii — the sprite scale is the cube root — so folders stay
// hubs, notes the content mass, stubs dust. These also feed the force layout.
const NODE_REL_SIZE = 5;
const NODE_VAL: Record<string, number> = { note: 2, folder: 10, stub: 0.25 };

/** An unknown kind is drawn as a note rather than dropped — a fourth `kind` in
 *  the graph builder should show up on screen, not vanish silently. */
const valOf = (kind: string): number => NODE_VAL[kind] ?? NODE_VAL.note ?? 2;
const colorOf = (kind: string): string => NODE_COLOR[kind] ?? NODE_COLOR.note ?? "#ffffff";

// A press that drifts a few pixels is still a click. The library's own
// onNodeClick has zero tolerance — it flags any pointermove-while-pressed as a
// drag — so a 1px trackpad drift would silently eat every open.
const CLICK_VS_DRAG_PX = 5;

const ROTATION_PERIOD_MS = 90_000;
const ROTATION_ANGULAR_SPEED = (2 * Math.PI) / ROTATION_PERIOD_MS;
const IDLE_RESUME_MS = 3_000;

export default function BrainGraph({
  nodes: nodeData,
  edges: edgeData,
}: {
  nodes: BrainNode[];
  edges: BrainEdge[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [showContains, setShowContains] = useState(true);
  const [open, setOpen] = useState<BrainNode | null>(null);

  // The toggle is React state but the renderer reads it inside a linkVisibility
  // callback that the library keeps hold of. A ref is what lets the callback see
  // the current value without rebuilding the whole scene on every toggle.
  const showContainsRef = useRef(showContains);
  showContainsRef.current = showContains;

  useEffect(() => {
    if (nodeData.length === 0) return;
    const container = containerRef.current;
    if (!container) return;

    // Probe for WebGL before importing ~700KB of renderer. No context means the
    // SSR list below stays the whole page.
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    if (!gl) return;
    gl.getExtension("WEBGL_lose_context")?.loseContext();

    let disposed = false;
    let teardown: (() => void) | null = null;

    (async () => {
      const [{ default: ForceGraph3D }, THREE, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import("3d-force-graph"),
        import("three"),
        import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
        import("three/examples/jsm/postprocessing/OutputPass.js"),
      ]);
      // The component can unmount while those four are in flight.
      if (disposed) return;

      // Fresh objects: the library mutates what it is given (source/target
      // become node references), and the props must survive a re-render.
      const nodes = nodeData.map((n) => ({ ...n }));
      const ids = new Set(nodes.map((n) => n.id));
      const links = edgeData
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

      const starTexture = (() => {
        const S = 256;
        const c = document.createElement("canvas");
        c.width = c.height = S;
        const ctx = c.getContext("2d")!;
        const mid = S / 2;

        const g = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(Math.min(STAR_CORE, 0.9), "rgba(255,255,255,1)");
        for (let i = 1; i <= 8; i++) {
          const t = STAR_CORE + (1 - STAR_CORE) * (i / 8);
          g.addColorStop(Math.min(t, 1), `rgba(255,255,255,${Math.pow(1 - i / 8, STAR_FALLOFF).toFixed(4)})`);
        }
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, S, S);

        if (STAR_FLARE > 0) {
          ctx.globalCompositeOperation = "lighter";
          const len = mid * 0.98;
          const thick = Math.max(1, S * 0.012);
          for (const horizontal of [true, false]) {
            const lg = horizontal
              ? ctx.createLinearGradient(mid - len, mid, mid + len, mid)
              : ctx.createLinearGradient(mid, mid - len, mid, mid + len);
            lg.addColorStop(0, "rgba(255,255,255,0)");
            lg.addColorStop(0.5, `rgba(255,255,255,${STAR_FLARE})`);
            lg.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = lg;
            if (horizontal) ctx.fillRect(mid - len, mid - thick / 2, len * 2, thick);
            else ctx.fillRect(mid - thick / 2, mid - len, thick, len * 2);
          }
          ctx.globalCompositeOperation = "source-over";
        }

        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })();

      // One material per kind, shared by every sprite of that kind — a material
      // per node is what makes a few thousand stars stutter.
      const starMaterials: Record<string, InstanceType<typeof THREE.SpriteMaterial>> = {};
      for (const kind of Object.keys(NODE_VAL)) {
        starMaterials[kind] = new THREE.SpriteMaterial({
          map: starTexture,
          color: new THREE.Color(colorOf(kind)),
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
        });
      }

      // The library types its accessors against its own NodeObject/LinkObject,
      // which know nothing about `kind` or `relPath` — those fields ride along
      // on the objects we handed to graphData(). One cast each, here, rather
      // than an `any` at every call site.
      const asNode = (n: unknown) => n as BrainNode;
      const asLink = (l: unknown) => l as { kind: string };

      let hoverNode: BrainNode | null = null;

      const fg = new ForceGraph3D(container, { controlType: "orbit" });
      container.style.background = BACKGROUND;

      fg.backgroundColor("rgba(0,0,0,0)")
        .width(container.clientWidth)
        .height(container.clientHeight)
        .showNavInfo(false)
        .nodeRelSize(NODE_REL_SIZE)
        .nodeVal((n) => valOf(asNode(n).kind))
        .nodeOpacity(NODE_OPACITY)
        // Enough warmup that the layout has settled by first paint. Left to the
        // per-frame default it settles at a different scale on a slow machine
        // than a fast one, because the tick count becomes frame-rate dependent.
        .warmupTicks(600)
        .cooldownTicks(200)
        .nodeThreeObject((n) => {
          const { kind: raw } = asNode(n);
          const kind = raw in starMaterials ? raw : "note";
          const s = new THREE.Sprite(starMaterials[kind]);
          const d = Math.cbrt(valOf(kind)) * NODE_REL_SIZE * STAR_SIZE_FACTOR;
          s.scale.set(d, d, 1);
          return s;
        })
        .nodeLabel((n) => {
          // An element, not a string: the library injects a label as HTML, and a
          // filename is not something to trust to that.
          const el = document.createElement("div");
          el.textContent = asNode(n).display;
          return el;
        })
        .linkColor((l) => (asLink(l).kind === "contains" ? CONTAINS_COLOR : LINK_COLOR))
        .linkWidth((l) => (asLink(l).kind === "contains" ? CONTAINS_WIDTH : LINK_WIDTH))
        .linkOpacity(LINK_OPACITY)
        .linkVisibility((l) => asLink(l).kind !== "contains" || showContainsRef.current)
        .enableNodeDrag(false)
        .showPointerCursor((n) => asNode(n).kind === "note" && !!asNode(n).relPath)
        .onNodeHover((n) => {
          hoverNode = n ? asNode(n) : null;
        })
        // The cast is the same seam as asNode/asLink: our nodes carry `kind`
        // and `relPath`, which the library's GraphData does not describe.
        .graphData({ nodes, links } as unknown as Parameters<typeof fg.graphData>[0]);

      const bloom = new UnrealBloomPass(
        new THREE.Vector2(container.clientWidth, container.clientHeight),
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD,
      );
      const composer = fg.postProcessingComposer();
      composer.addPass(bloom);
      composer.addPass(new OutputPass());

      // ── Ambient rotation ────────────────────────────────────────────────
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
      let userInteracting = false;
      let onScreen = true;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let frame: number | null = null;
      let lastTickAt = 0; // 0 = no prior frame this run

      const visible = () => onScreen && !document.hidden;
      const rotationAllowed = () => visible() && !userInteracting && !reduceMotion.matches;

      const controls = fg.controls() as {
        target?: { x: number; y: number; z: number };
        addEventListener: (t: string, f: () => void) => void;
        removeEventListener: (t: string, f: () => void) => void;
      };

      function tick(now: number) {
        frame = null;
        if (!rotationAllowed()) return;
        const dt = lastTickAt ? now - lastTickAt : 0;
        lastTickAt = now;
        const cam = fg.camera();
        const target = controls.target ?? { x: 0, y: 0, z: 0 };
        const radius = Math.hypot(cam.position.x - target.x, cam.position.z - target.z);
        const angle = Math.atan2(cam.position.x - target.x, cam.position.z - target.z)
          + ROTATION_ANGULAR_SPEED * dt;
        fg.cameraPosition(
          { x: target.x + radius * Math.sin(angle), y: cam.position.y, z: target.z + radius * Math.cos(angle) },
          target,
          0,
        );
        frame = requestAnimationFrame(tick);
      }
      const start = () => {
        if (frame !== null || !rotationAllowed()) return;
        lastTickAt = 0;
        frame = requestAnimationFrame(tick);
      };
      const stop = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      };

      const onControlsStart = () => {
        userInteracting = true;
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = null;
        stop();
      };
      const onControlsEnd = () => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimer = null;
          userInteracting = false;
          start();
        }, IDLE_RESUME_MS);
      };
      controls.addEventListener("start", onControlsStart);
      controls.addEventListener("end", onControlsEnd);

      const onReduceMotion = () => (reduceMotion.matches ? stop() : start());
      reduceMotion.addEventListener("change", onReduceMotion);

      const onVisibility = () => (document.hidden ? stop() : start());
      document.addEventListener("visibilitychange", onVisibility);

      start();

      // ── Click, distinguished from a drag ────────────────────────────────
      const canvas = fg.renderer().domElement;
      let press: { x: number; y: number; node: BrainNode | null } | null = null;

      const onPointerDown = (ev: PointerEvent) => {
        press = ev.button === 0 ? { x: ev.clientX, y: ev.clientY, node: hoverNode } : null;
      };
      const clearPress = () => {
        press = null;
      };
      const onPointerUp = (ev: PointerEvent) => {
        const p = press;
        press = null;
        if (!p || Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > CLICK_VS_DRAG_PX) return;
        // hoverNode first: the raycast is more current than what was under the
        // pointer when the press started.
        const node = hoverNode ?? p.node;
        if (node?.kind === "note" && node.relPath) setOpen(node);
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointerleave", clearPress);
      canvas.addEventListener("pointercancel", clearPress);
      canvas.addEventListener("pointerup", onPointerUp);

      // A lost context is unrecoverable here: drop back to the SSR list.
      const onContextLost = () => {
        stop();
        fg.pauseAnimation();
        setMounted(false);
      };
      canvas.addEventListener("webglcontextlost", onContextLost);

      // Off-screen the scene should not burn a GPU: pause the render loop too,
      // not just the rotation.
      const io = new IntersectionObserver(([entry]) => {
        onScreen = !!entry?.isIntersecting;
        if (onScreen) {
          fg.resumeAnimation();
          start();
        } else {
          fg.pauseAnimation();
          stop();
        }
      });
      io.observe(container);

      const onResize = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w !== fg.width() || h !== fg.height()) fg.width(w).height(h);
      };
      window.addEventListener("resize", onResize);

      setMounted(true);

      teardown = () => {
        io.disconnect();
        window.removeEventListener("resize", onResize);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerleave", clearPress);
        canvas.removeEventListener("pointercancel", clearPress);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("webglcontextlost", onContextLost);
        controls.removeEventListener("start", onControlsStart);
        controls.removeEventListener("end", onControlsEnd);
        reduceMotion.removeEventListener("change", onReduceMotion);
        document.removeEventListener("visibilitychange", onVisibility);
        if (idleTimer !== null) clearTimeout(idleTimer);
        stop();
        bloom.dispose?.();
        starTexture.dispose();
        for (const m of Object.values(starMaterials)) m.dispose();
        // forceContextLoss before _destructor: without it the browser keeps the
        // GPU context alive and a handful of remounts exhausts the pool.
        fg.renderer()?.forceContextLoss();
        (fg as unknown as { _destructor(): void })._destructor();
      };
    })().catch((err) => {
      console.warn("[brain] renderer init failed:", err);
      setMounted(false);
    });

    return () => {
      disposed = true;
      teardown?.();
    };
    // The graph is rebuilt only when the data itself changes. `showContains`
    // is deliberately absent — it is read through a ref so a toggle refreshes
    // the existing scene instead of tearing down and re-laying-out the graph.
  }, [nodeData, edgeData]);

  return (
    <>
      <div
        ref={containerRef}
        className="brain-stage"
        role="img"
        aria-label={`Knowledge graph of the os: ${nodeData.length} nodes.`}
      />
      {mounted && (
        <label className="brain-toggle">
          <input
            type="checkbox"
            checked={showContains}
            onChange={(e) => setShowContains(e.target.checked)}
          />
          Folder edges
        </label>
      )}
      {open && <NotePopup node={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * The read-only file popup. It is what a node click opens, and it replaces the
 * /files route entirely for anyone who does not have os cloned.
 */
function NotePopup({ node, onClose }: { node: BrainNode; onClose: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Escape closes, and the listener is torn down with the popup so it cannot
    // outlive it and close the next one.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    // A click can land while a previous fetch is still open; the flag makes the
    // stale response a no-op rather than the content of the wrong file.
    let live = true;
    setHtml(null);
    setError(null);
    fetch(`/api/os/note?file=${encodeURIComponent(node.relPath ?? "")}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        if (j.ok) setHtml(j.html);
        else setError(j.error ?? "Could not read that file.");
      })
      .catch(() => live && setError("Could not read that file."));
    return () => {
      live = false;
    };
  }, [node.relPath]);

  return (
    <div className="popup-backdrop" onClick={onClose} role="presentation">
      <div
        className="popup"
        role="dialog"
        aria-modal="true"
        aria-label={node.display}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{node.display}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {error && <p role="alert">{error}</p>}
        {!error && html === null && <p>Reading…</p>}
        {/* readNote() already stripped raw HTML and rewrote links; this is its
            sanitized output, not user input. */}
        {html !== null && <div dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  );
}
