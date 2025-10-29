import React, { useEffect, useMemo, useRef, useState } from "react";

// External CDNs (loaded dynamically) for math parsing and LaTeX rendering
// math.js: robust expression parsing (https://mathjs.org)
// KaTeX: fast LaTeX rendering (https://katex.org)

const loadScript = (src) =>
  new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

const ensureDeps = async () => {
  // Load math.js and KaTeX once
  await loadScript("https://cdn.jsdelivr.net/npm/mathjs@11/lib/browser/math.js");
  await loadScript("https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js");
  await loadScript("https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js");
  // Load KaTeX CSS
  if (!document.getElementById("katex-css")) {
    const link = document.createElement("link");
    link.id = "katex-css";
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
    document.head.appendChild(link);
  }
};

// ---------- Utilities ----------
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const nearlyEqual = (a, b, eps = 1e-8) => Math.abs(a - b) < eps;

function rk4Step(f, y, h) {
  // y is [x, y], f returns [dxdt, dydt]
  const k1 = f(y);
  const k2 = f([y[0] + 0.5 * h * k1[0], y[1] + 0.5 * h * k1[1]]);
  const k3 = f([y[0] + 0.5 * h * k2[0], y[1] + 0.5 * h * k2[1]]);
  const k4 = f([y[0] + h * k3[0], y[1] + h * k3[1]]);
  return [
    y[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
    y[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
  ];
}

function numericJacobian(F, p, h = 1e-4) {
  const [x, y] = p;
  const f0 = F([x, y]);
  const fx = F([x + h, y]);
  const fy = F([x, y + h]);
  return [
    [(fx[0] - f0[0]) / h, (fy[0] - f0[0]) / h],
    [(fx[1] - f0[1]) / h, (fy[1] - f0[1]) / h]
  ];
}

function eigenDecomp2x2(A) {
  const a = A[0][0], b = A[0][1], c = A[1][0], d = A[1][1];
  const tr = a + d;
  const det = a * d - b * c;
  const disc = tr * tr - 4 * det;
  if (disc < 0) {
    // complex eigenvalues -> spiral/center; return null vectors
    const real = tr / 2;
    const imag = Math.sqrt(-disc) / 2;
    return { type: "complex", eigenvalues: [real, imag], eigenvectors: [] };
  } else {
    const rdisc = Math.sqrt(disc);
    const l1 = (tr + rdisc) / 2;
    const l2 = (tr - rdisc) / 2;
    const v1 = Math.abs(b) > 1e-12 ? [l1 - d, b] : [c, l1 - a];
    const v2 = Math.abs(b) > 1e-12 ? [l2 - d, b] : [c, l2 - a];
    const norm = (v) => {
      const m = Math.hypot(v[0], v[1]) || 1;
      return [v[0] / m, v[1] / m];
    };
    return { type: "real", eigenvalues: [l1, l2], eigenvectors: [norm(v1), norm(v2)] };
  }
}

function uniquePoints(points, tol = 0.05) {
  const out = [];
  points.forEach((p) => {
    if (!out.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol)) out.push(p);
  });
  return out;
}

// ---------- Main Component ----------
export default function PhasePlane() {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const consoleRef = useRef(null);
  const [depsReady, setDepsReady] = useState(false);

  const [exprX, setExprX] = useState("y");
  const [exprY, setExprY] = useState("x - x^3");

  const [domain, setDomain] = useState({ xMin: -2.5, xMax: 2.5, yMin: -2.0, yMax: 2.0 });
  const [vfOpacity, setVfOpacity] = useState(0.25);
  const [grid, setGrid] = useState(22);

  const [trajectories, setTrajectories] = useState([]); // array of {pts: [[x,y],...], color}
  const [separatrices, setSeparatrices] = useState([]); // computed from saddles
  const [fixedPoints, setFixedPoints] = useState([]); // {p:[x,y], eig}
  const [nullclinePts, setNullclinePts] = useState({ f: [], g: [] });

  const [busy, setBusy] = useState(false);

  // Load external libs once
  useEffect(() => {
    (async () => {
      try {
        await ensureDeps();
        setDepsReady(true);
        renderConsoleLatex();
      } catch (e) {
        console.error("Dependency load error", e);
      }
    })();
  }, []);

  // Build evaluators using math.js
  const evalFns = useMemo(() => {
    if (!depsReady || !window.math) return null;
    try {
      const parserX = window.math.parse(exprX);
      const parserY = window.math.parse(exprY);
      const f = ({ x, y }) => {
        const scope = { x, y, t: 0, e: Math.E, pi: Math.PI };
        return parserX.evaluate(scope);
      };
      const g = ({ x, y }) => {
        const scope = { x, y, t: 0, e: Math.E, pi: Math.PI };
        return parserY.evaluate(scope);
      };
      return { f, g };
    } catch (e) {
      return null;
    }
  }, [depsReady, exprX, exprY]);

  const F = useMemo(() => {
    if (!evalFns) return null;
    return ([x, y]) => [evalFns.f({ x, y }), evalFns.g({ x, y })];
  }, [evalFns]);

  // Coordinate transforms
  const toCanvas = (x, y, canvas) => {
    const { xMin, xMax, yMin, yMax } = domain;
    const w = canvas.width, h = canvas.height;
    const cx = ((x - xMin) / (xMax - xMin)) * w;
    const cy = h - ((y - yMin) / (yMax - yMin)) * h;
    return [cx, cy];
  };

  const toWorld = (cx, cy, canvas) => {
    const { xMin, xMax, yMin, yMax } = domain;
    const w = canvas.width, h = canvas.height;
    const x = xMin + (cx / w) * (xMax - xMin);
    const y = yMin + ((h - cy) / h) * (yMax - yMin);
    return [x, y];
  };

  // Draw axes, background, labels
  const drawScaffold = (ctx) => {
    const { xMin, xMax, yMin, yMax } = domain;
    const w = ctx.canvas.width, h = ctx.canvas.height;

    // gradient background
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#0f172a");
    grad.addColorStop(1, "#1e293b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // axes
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1.5;

    const [cx0, cy0] = toCanvas(0, 0, ctx.canvas);
    // x-axis
    if (yMin < 0 && yMax > 0) {
      ctx.beginPath();
      ctx.moveTo(0, cy0);
      ctx.lineTo(w, cy0);
      ctx.stroke();
    }
    // y-axis
    if (xMin < 0 && xMax > 0) {
      ctx.beginPath();
      ctx.moveTo(cx0, 0);
      ctx.lineTo(cx0, h);
      ctx.stroke();
    }

    // ticks
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    const xtick = niceStep(xMin, xMax);
    for (let x = Math.ceil(xMin / xtick) * xtick; x <= xMax; x += xtick) {
      const [cx] = toCanvas(x, 0, ctx.canvas);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.stroke();
    }
    const ytick = niceStep(yMin, yMax);
    for (let y = Math.ceil(yMin / ytick) * ytick; y <= yMax; y += ytick) {
      const [, cy] = toCanvas(0, y, ctx.canvas);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(w, cy);
      ctx.stroke();
    }
    ctx.restore();
  };

  const niceStep = (min, max) => {
    const span = Math.abs(max - min);
    const raw = span / 8;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const steps = [1, 2, 5, 10].map((k) => k * pow);
    return steps.reduce((a, b) => (Math.abs(raw - a) < Math.abs(raw - b) ? a : b));
  };

  const drawVectorField = (ctx) => {
    if (!F) return;
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.save();
    ctx.globalAlpha = vfOpacity;
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;

    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        const x = lerp(domain.xMin, domain.xMax, (i + 0.5) / grid);
        const y = lerp(domain.yMin, domain.yMax, (j + 0.5) / grid);
        const v = F([x, y]);
        const m = Math.hypot(v[0], v[1]);
        if (m === 0) continue;
        const scale = 0.18 * Math.min((domain.xMax - domain.xMin) / grid, (domain.yMax - domain.yMin) / grid);
        const dx = (v[0] / m) * scale;
        const dy = (v[1] / m) * scale;
        const [cx1, cy1] = toCanvas(x - dx, y - dy, ctx.canvas);
        const [cx2, cy2] = toCanvas(x + dx, y + dy, ctx.canvas);
        ctx.beginPath();
        ctx.moveTo(cx1, cy1);
        ctx.lineTo(cx2, cy2);
        ctx.stroke();

        // arrowhead
        const angle = Math.atan2(cy2 - cy1, cx2 - cx1);
        const ah = 5;
        ctx.beginPath();
        ctx.moveTo(cx2, cy2);
        ctx.lineTo(cx2 - ah * Math.cos(angle - Math.PI / 6), cy2 - ah * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(cx2 - ah * Math.cos(angle + Math.PI / 6), cy2 - ah * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = "#e2e8f0";
        ctx.fill();
      }
    }

    ctx.restore();
  };

  // Compute nullclines and fixed points
  const recomputeStructure = async () => {
    if (!F || !evalFns) return;
    setBusy(true);
    appendLatex("\\textbf{Recomputing structure...}");

    // sample grid
    const NX = 100, NY = 100;
    const fPts = [];
    const gPts = [];
    const fpCandidates = [];
    for (let i = 0; i <= NX; i++) {
      const x = lerp(domain.xMin, domain.xMax, i / NX);
      for (let j = 0; j <= NY; j++) {
        const y = lerp(domain.yMin, domain.yMax, j / NY);
        const [fx, gy] = [evalFns.f({ x, y }), evalFns.g({ x, y })];
        if (Math.abs(fx) < 0.02) fPts.push([x, y]);
        if (Math.abs(gy) < 0.02) gPts.push([x, y]);
      }
    }
    setNullclinePts({ f: fPts, g: gPts });
    appendLatex("\\text{Nullclines: plotted points where }|f|,|g|<0.02.");

    // Find fixed points by sign changes of both on coarse grid cells
    const FP = [];
    const nx = 24, ny = 24;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const x0 = lerp(domain.xMin, domain.xMax, i / nx);
        const x1 = lerp(domain.xMin, domain.xMax, (i + 1) / nx);
        const y0 = lerp(domain.yMin, domain.yMax, j / ny);
        const y1 = lerp(domain.yMin, domain.yMax, (j + 1) / ny);
        const corners = [
          [x0, y0],
          [x1, y0],
          [x0, y1],
          [x1, y1]
        ];
        const vals = corners.map(([x, y]) => [evalFns.f({ x, y }), evalFns.g({ x, y })]);
        const fsigns = vals.map((v) => Math.sign(v[0]));
        const gsigns = vals.map((v) => Math.sign(v[1]));
        const fvar = new Set(fsigns).size > 1;
        const gvar = new Set(gsigns).size > 1;
        if (fvar && gvar) {
          fpCandidates.push([(x0 + x1) / 2, (y0 + y1) / 2]);
        }
      }
    }

    // Refine candidates via small Newton steps
    const newton = (p0) => {
      let p = p0.slice();
      for (let k = 0; k < 25; k++) {
        const J = numericJacobian(F, p);
        const Fp = F(p);
        const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
        if (Math.abs(det) < 1e-10) break;
        // Solve J * dp = -F
        const inv = [
          [J[1][1] / det, -J[0][1] / det],
          [-J[1][0] / det, J[0][0] / det]
        ];
        const dp = [
          -(inv[0][0] * Fp[0] + inv[0][1] * Fp[1]),
          -(inv[1][0] * Fp[0] + inv[1][1] * Fp[1])
        ];
        p = [p[0] + dp[0], p[1] + dp[1]];
        if (Math.hypot(dp[0], dp[1]) < 1e-8) break;
      }
      return p;
    };

    let fps = uniquePoints(fpCandidates.map(newton), 0.05);

    const detailed = fps.map((p) => {
      const J = numericJacobian(F, p);
      const E = eigenDecomp2x2(J);
      return { p, J, E };
    });

    setFixedPoints(detailed);
    appendLatex(
      `\\text{Found }${detailed.length}\\ \text{ fixed points. Linearization eigenvalues }` +
        detailed
          .map(({ p, E }, i) =>
            E.type === "real"
              ? `\\lambda=(${fmt(E.eigenvalues[0])},${fmt(E.eigenvalues[1])}) \\text{ at } (x,y)=(${fmt(
                  p[0]
                )},${fmt(p[1])})`
              : `\\lambda= ${fmt(E.eigenvalues[0])} \pm i${fmt(E.eigenvalues[1])} \\text{ at } (x,y)=(${fmt(
                  p[0]
                )},${fmt(p[1])})`
          )
          .join("; ")
    );

    // Separatrices: for saddles (real eigenvalues with opposite signs)
    const seps = [];
    detailed.forEach(({ p, E }) => {
      if (E.type === "real") {
        const s1 = Math.sign(E.eigenvalues[0]);
        const s2 = Math.sign(E.eigenvalues[1]);
        if (s1 * s2 < 0) {
          // saddle
          const dirs = E.eigenvectors;
          const mags = [
            0.006 * (domain.xMax - domain.xMin),
            0.006 * (domain.yMax - domain.yMin)
          ];
          [1, -1].forEach((sgn) => {
            dirs.forEach((v) => {
              const p0 = [p[0] + sgn * v[0] * mags[0], p[1] + sgn * v[1] * mags[1]];
              const fwd = integratePath(p0, 400, 0.004, +1);
              const bwd = integratePath(p0, 400, 0.004, -1);
              seps.push({ pts: [...bwd.reverse(), ...fwd], color: "#fbbf24" });
            });
          });
        }
      }
    });
    setSeparatrices(seps);
    appendLatex("\\text{Separatrices integrated from eigen-directions at saddle points.}");

    setBusy(false);
    renderScene();
    renderConsoleLatex();
  };

  const fmt = (x) => (Math.abs(x) < 1e-4 ? "0" : x.toFixed(3));

  const integratePath = (p0, steps, h, dir = +1) => {
    const pts = [p0];
    let p = p0.slice();
    for (let i = 0; i < steps; i++) {
      p = rk4Step(F, p, dir * h);
      // stop if out of bounds or NaN
      if (
        !isFinite(p[0]) ||
        !isFinite(p[1]) ||
        p[0] < domain.xMin - 1 ||
        p[0] > domain.xMax + 1 ||
        p[1] < domain.yMin - 1 ||
        p[1] > domain.yMax + 1
      )
        break;
      pts.push(p);
    }
    return pts;
  };

  const drawDots = (ctx, pts, color, size = 2) => {
    ctx.save();
    ctx.fillStyle = color;
    pts.forEach(([x, y]) => {
      const [cx, cy] = toCanvas(x, y, ctx.canvas);
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  };

  const drawPath = (ctx, pts, color, width = 2, arrowEvery = 30) => {
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let [cx, cy] = toCanvas(pts[0][0], pts[0][1], ctx.canvas);
    ctx.moveTo(cx, cy);
    for (let i = 1; i < pts.length; i++) {
      [cx, cy] = toCanvas(pts[i][0], pts[i][1], ctx.canvas);
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();

    // direction arrows
    for (let i = arrowEvery; i < pts.length; i += arrowEvery) {
      const p1 = pts[i - 1];
      const p2 = pts[i];
      const [c1x, c1y] = toCanvas(p1[0], p1[1], ctx.canvas);
      const [c2x, c2y] = toCanvas(p2[0], p2[1], ctx.canvas);
      const ang = Math.atan2(c2y - c1y, c2x - c1x);
      const ah = 7;
      ctx.beginPath();
      ctx.moveTo(c2x, c2y);
      ctx.lineTo(c2x - ah * Math.cos(ang - Math.PI / 6), c2y - ah * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(c2x - ah * Math.cos(ang + Math.PI / 6), c2y - ah * Math.sin(ang + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);

    const ctx = canvas.getContext("2d");
    drawScaffold(ctx);
    drawVectorField(ctx);

    // nullclines
    drawDots(ctx, nullclinePts.f, "#60a5fa", 1.8); // f=0 blue
    drawDots(ctx, nullclinePts.g, "#34d399", 1.8); // g=0 green

    // separatrices
    separatrices.forEach((s) => drawPath(ctx, s.pts, s.color, 2.5, 28));

    // trajectories
    trajectories.forEach((t) => drawPath(ctx, t.pts, t.color, 2.5, 22));

    // fixed points
    fixedPoints.forEach(({ p, E }) => {
      const color = E.type === "real" ? (Math.sign(E.eigenvalues[0]) * Math.sign(E.eigenvalues[1]) < 0 ? "#f87171" : "#a78bfa") : "#38bdf8";
      drawDots(ctx, [p], color, 4);
    });

    // overlay axes labels
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.innerHTML = `x ∈ [${domain.xMin}, ${domain.xMax}], y ∈ [${domain.yMin}, ${domain.yMax}]`;
  };

  const renderScene = () => {
    requestAnimationFrame(draw);
  };

  // Re-render when data changes
  useEffect(() => {
    renderScene();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vfOpacity, grid, domain, nullclinePts, separatrices, trajectories, fixedPoints, F]);

  // Recompute structure when bounds change (after user commits)
  useEffect(() => {
    if (F) {
      recomputeStructure();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain.xMin, domain.xMax, domain.yMin, domain.yMax, F]);

  const addTrajectoryFrom = (p0) => {
    if (!F) return;
    appendLatex(`\\text{Integrating trajectory from }(${fmt(p0[0])},${fmt(p0[1])})`);
    const fwd = integratePath(p0, 1500, 0.01, +1);
    const bwd = integratePath(p0, 1500, 0.01, -1);
    const path = [...bwd.reverse(), ...fwd];
    const hue = Math.floor(200 + 80 * Math.random());
    const color = `hsl(${hue} 90% 70%)`;
    setTrajectories((T) => [...T, { pts: path, color }]);
  };

  // Handle clicks to seed trajectories
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const [x, y] = toWorld(cx * (canvas.width / canvas.clientWidth), cy * (canvas.height / canvas.clientHeight), canvas);
      addTrajectoryFrom([x, y]);
    };
    canvas.addEventListener("click", onClick);
    return () => canvas.removeEventListener("click", onClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [F, domain]);

  const reset = () => {
    setTrajectories([]);
    setSeparatrices([]);
    setFixedPoints([]);
    setNullclinePts({ f: [], g: [] });
  };

  // ---------- LaTeX Console ----------
  const [consoleLines, setConsoleLines] = useState([]);
  const appendLatex = (line) => setConsoleLines((L) => [...L, line]);
  const clearConsole = () => setConsoleLines([]);
  const renderConsoleLatex = () => {
    const el = consoleRef.current;
    if (!el || !window.renderMathInElement) return;
    // escape HTML then insert spans with data-latex
    el.innerHTML = consoleLines
      .map((s) => `<div class=\"py-0.5\">$${s}$</div>`)
      .join("");
    window.renderMathInElement(el, { delimiters: [{ left: "$", right: "$", display: false }] });
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    renderConsoleLatex();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consoleLines, depsReady]);

  const handleRun = async () => {
    if (!depsReady) return;
    clearConsole();
    appendLatex("\\textbf{Parsing } f(x,y)=" + window.katex.renderToString(exprX) + ",\\quad g(x,y)=" + window.katex.renderToString(exprY));
    await new Promise((r) => setTimeout(r, 50));
    appendLatex("\\text{Building vector field and nullclines...}");
    reset();
    await new Promise((r) => setTimeout(r, 10));
    await recomputeStructure();
  };

  const randomSeeds = () => {
    for (let k = 0; k < 6; k++) {
      const x = lerp(domain.xMin, domain.xMax, Math.random());
      const y = lerp(domain.yMin, domain.yMax, Math.random());
      addTrajectoryFrom([x, y]);
    }
  };

  return (
    <div className="w-full h-full min-h-[720px] bg-slate-900 text-slate-100">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Interactive Phase Plane</h1>
            <p className="text-slate-300 text-sm">Click in the plane to seed trajectories. f = ẋ, g = ẏ. Nullclines: f=0 (blue), g=0 (green). Fixed points: saddle (red), node/focus (violet/cyan). Separatrices in amber.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={handleRun} className="px-4 py-2 rounded-2xl bg-sky-600 hover:bg-sky-500 shadow">Run</button>
            <button onClick={() => { reset(); renderScene(); }} className="px-4 py-2 rounded-2xl bg-slate-700 hover:bg-slate-600">Clear</button>
            <button onClick={randomSeeds} className="px-4 py-2 rounded-2xl bg-emerald-600 hover:bg-emerald-500">Seed</button>
          </div>
        </header>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 min-w-0">
              <div className="bg-slate-800/60 rounded-2xl p-3 min-w-0">
                <label className="text-sm text-slate-300">ẋ = f(x,y)</label>
                <input value={exprX} onChange={(e) => setExprX(e.target.value)} className="w-full mt-1 rounded-xl bg-slate-900/60 border border-slate-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="e.g. y" />
              </div>
              <div className="bg-slate-800/60 rounded-2xl p-3 min-w-0">
                <label className="text-sm text-slate-300">ẏ = g(x,y)</label>
                <input value={exprY} onChange={(e) => setExprY(e.target.value)} className="w-full mt-1 rounded-xl bg-slate-900/60 border border-slate-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="e.g. x - x^3" />
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
              <NumBox label="xMin" v={domain.xMin} set={(x)=>setDomain(d=>({...d,xMin:parseFloat(x)}))} />
              <NumBox label="xMax" v={domain.xMax} set={(x)=>setDomain(d=>({...d,xMax:parseFloat(x)}))} />
              <NumBox label="yMin" v={domain.yMin} set={(x)=>setDomain(d=>({...d,yMin:parseFloat(x)}))} />
              <NumBox label="yMax" v={domain.yMax} set={(x)=>setDomain(d=>({...d,yMax:parseFloat(x)}))} />
              <NumBox label="Grid" v={grid} set={(x)=>setGrid(parseInt(x||"20"))} />
              <NumBox label="VF α" v={vfOpacity} step={0.05} set={(x)=>setVfOpacity(parseFloat(x))} />
            </div>

            <div className="relative w-full h-[520px] rounded-3xl shadow-inner overflow-hidden border border-slate-800">
              <canvas ref={canvasRef} className="w-full h-full" />
              <div ref={overlayRef} className="absolute bottom-2 right-3 text-xs text-slate-300 bg-slate-800/60 rounded-lg px-2 py-1" />
            </div>
          </div>

          <div className="lg:col-span-1 flex flex-col gap-2">
            <div className="bg-slate-800/60 rounded-2xl p-3 h-[220px] overflow-auto">
              <h3 className="font-medium mb-2">Console (LaTeX)</h3>
              <div ref={consoleRef} className="text-sm leading-relaxed break-words" />
            </div>
            <div className="bg-slate-800/60 rounded-2xl p-3 space-y-2">
              <h3 className="font-medium">Quick Tips</h3>
              <ul className="text-sm text-slate-300 list-disc pl-5 space-y-1">
                <li>Click anywhere to add a trajectory (RK4 both directions).</li>
                <li>Press <span className="text-sky-400">Run</span> after editing f, g or bounds.</li>
                <li>Colors: f=0 <span className="text-sky-400">(blue)</span>, g=0 <span className="text-emerald-400">(green)</span>, saddles <span className="text-rose-400">(red)</span>, separatrices <span className="text-amber-400">(amber)</span>.</li>
                <li>Use ^ for powers, e.g., <code>x^3 - y</code>. Functions: sin, cos, tanh, exp, etc.</li>
              </ul>
            </div>
            <div className="bg-slate-800/60 rounded-2xl p-3">
              <h3 className="font-medium mb-1">Examples</h3>
              <div className="flex flex-wrap gap-2">
                <ExampleButton setX={setExprX} setY={setExprY} fx="y" gy="x - x^3" label="Duffing-like" />
                <ExampleButton setX={setExprX} setY={setExprY} fx="y - x" gy="x*(1 - x^2) - y" label="Van der Pol-ish" />
                <ExampleButton setX={setExprX} setY={setExprY} fx="x - y" gy="x + y - x*(x^2 + y^2)" label="Spiral sink" />
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function NumBox({ label, v, set, step }) {
  const [txt, setTxt] = React.useState(String(v));
  // keep local text in sync if parent changes
  React.useEffect(() => setTxt(String(v)), [v]);

  const commit = () => {
    const num = Number(txt);
    if (!Number.isFinite(num)) {
      // revert to last valid
      setTxt(String(v));
      return;
    }
    set(num);
  };

  return (
    <label className="text-xs text-slate-300 bg-slate-800/60 rounded-xl px-3 py-2 flex items-center gap-2 min-w-0">
      <span className="w-10 opacity-80">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        step={step ?? 0.1}
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className="flex-1 min-w-0 rounded-lg bg-slate-900/60 border border-slate-700 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-sky-500"
      />
    </label>
  );
}

function ExampleButton({ label, fx, gy, setX, setY }) {
  return (
    <button
      onClick={() => {
        setX(fx);
        setY(gy);
      }}
      className="text-xs px-2 py-1 rounded-lg bg-slate-700 hover:bg-slate-600"
    >
      {label}
    </button>
  );
}
