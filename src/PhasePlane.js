import React from "react";
import "katex/dist/katex.min.css";
import ConsolePanel from "./components/ConsolePanel";

const lerp = (a, b, t) => a + (b - a) * t;
const defaultDomain = { xMin: -3, xMax: 3, yMin: -3, yMax: 3 };

function useLogs() {
  const [logs, setLogs] = React.useState([]);
  const push = React.useCallback((type, text) => {
    setLogs((entries) => {
      const last = entries[entries.length - 1];
      if (last && last.type === type && last.text === text) return entries;
      return [...entries.slice(-400), { type, text, ts: Date.now() }];
    });
  }, []);
  const line = React.useCallback((t) => push("text", t), [push]);
  const latex = React.useCallback((t) => push("latex", t), [push]);
  const error = React.useCallback((t) => push("text", `Error: ${t}`), [push]);
  const clear = React.useCallback(() => setLogs([]), []);
  return { logs, line, latex, error, clear };
}

export default function PhasePlane() {
  const [exprX, setExprX] = React.useState("mu*x - x^2 - y");
  const [exprY, setExprY] = React.useState("x + mu*y - y^3");
  const [domain, setDomain] = React.useState(defaultDomain);
  const [domainInputs, setDomainInputs] = React.useState(() => ({
    xMin: String(defaultDomain.xMin),
    xMax: String(defaultDomain.xMax),
    yMin: String(defaultDomain.yMin),
    yMax: String(defaultDomain.yMax),
  }));
  const [gridN, setGridN] = React.useState(40);
  const [gridInput, setGridInput] = React.useState("40");
  const [params, setParams] = React.useState({});
  const [paramDefs, setParamDefs] = React.useState({});
  const [requiredParams, setRequiredParams] = React.useState([]);
  const [anim, setAnim] = React.useState({ enabled: false, key: null, speed: 0.4, min: -3, max: 3 });
  const [seeds, setSeeds] = React.useState([]);
  const [workerData, setWorkerData] = React.useState(null);

  const canvasRef = React.useRef(null);
  const workerRef = React.useRef(null);
  const requestIdRef = React.useRef(0);
  const lastReportSigRef = React.useRef("");
  const lastStatusRef = React.useRef("");

  const { logs, line, latex, error, clear: clearLogs } = useLogs();

  React.useEffect(() => {
    const worker = new Worker(new URL("./workers/phaseWorker.js", import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const { type, payload, requestId } = event.data || {};
      if (type !== "result") return;
      if (requestId && requestId !== requestIdRef.current) return;
      const {
        status,
        requiredParams: req = [],
        logs: newLogs = [],
        reportSignature,
        vectorField,
        nullclines,
        equilibria,
        trajectories,
        domain: domainResult,
        gridN: gridResult,
        message,
        missingParams = [],
      } = payload || {};

      setRequiredParams(req);

      if (status === "ok") {
        setWorkerData({
          vectorField: vectorField ?? [],
          nullclines: nullclines ?? { f: [], g: [] },
          equilibria: equilibria ?? [],
          trajectories: trajectories ?? [],
          domain: domainResult ?? domain,
          gridN: gridResult ?? gridN,
        });
      } else {
        setWorkerData(null);
      }

      if (newLogs.length) {
        const signature = reportSignature || newLogs.map((entry) => `${entry.type}:${entry.text}`).join("|");
        if (signature !== lastReportSigRef.current) {
          lastReportSigRef.current = signature;
          newLogs.forEach((entry) => {
            if (entry.type === "latex") latex(entry.text);
            else line(entry.text);
          });
        }
      }

      const statusSig = `${status}|${message || ""}|${missingParams.join(",")}`;
      if (status === "ok") {
        lastStatusRef.current = "ok";
      } else if (status && statusSig !== lastStatusRef.current) {
        if (status === "invalidDomain" && message) {
          error(message);
        } else if (status === "missingParams" && missingParams.length) {
          line(`Set parameter values for: ${missingParams.join(", ")}`);
        } else if (status === "error" && message) {
          error(message);
        }
        lastStatusRef.current = statusSig;
      }
    };
    worker.onerror = (evt) => {
      error(evt?.message || "Worker error");
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [error, latex, line]);

  React.useEffect(() => {
    setParams((prev) => {
      let changed = false;
      const next = { ...prev };
      requiredParams.forEach((key) => {
        if (!(key in next) || !Number.isFinite(next[key])) {
          next[key] = 1;
          changed = true;
        }
      });
      Object.keys(next).forEach((key) => {
        if (!requiredParams.includes(key)) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [requiredParams]);

  React.useEffect(() => {
    setParamDefs((prev) => {
      let changed = false;
      const next = { ...prev };
      requiredParams.forEach((key) => {
        if (!(key in next)) {
          next[key] = { min: -3, max: 3, step: 0.1 };
          changed = true;
        }
      });
      Object.keys(next).forEach((key) => {
        if (!requiredParams.includes(key)) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [requiredParams]);

  React.useEffect(() => {
    if (!anim.enabled || !anim.key) return;
    let raf = 0;
    let last = performance.now();
    const { min, max, speed } = anim;
    const span = max - min || 1;
    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setParams((prev) => {
        const cur = (prev[anim.key] ?? 0) + speed * dt * span;
        const wrapped = min + (((cur - min) % span) + span) % span;
        return { ...prev, [anim.key]: wrapped };
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anim]);

  React.useEffect(() => {
    setDomainInputs({
      xMin: String(domain.xMin),
      xMax: String(domain.xMax),
      yMin: String(domain.yMin),
      yMax: String(domain.yMax),
    });
  }, [domain]);

  React.useEffect(() => {
    setGridInput(String(gridN));
  }, [gridN]);

  React.useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setWorkerData(null);
    worker.postMessage({
      type: "compute",
      requestId,
      payload: {
        exprX,
        exprY,
        params,
        domain,
        gridN,
        seeds,
      },
    });
  }, [exprX, exprY, params, domain, gridN, seeds]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!workerData) return;

    const { vectorField = [], nullclines = { f: [], g: [] }, equilibria = [], trajectories = [], domain: drawDomain, gridN: drawGrid } = workerData;
    const { xMin, xMax, yMin, yMax } = drawDomain ?? domain;

    const x2px = (x) => ((x - xMin) / (xMax - xMin)) * w;
    const y2px = (y) => (1 - (y - yMin) / (yMax - yMin)) * h;

    ctx.save();
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 1;
    const y0 = y2px(0);
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();
    const x0 = x2px(0);
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, h);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.35;
    const scale = 0.6 * Math.min(w, h) / (Math.max(1, drawGrid) * 4);
    vectorField.forEach(({ x, y, u, v }) => {
      const magnitude = Math.hypot(u, v) || 1e-6;
      const dx = (u / magnitude) * scale;
      const dy = (v / magnitude) * scale;
      const px = x2px(x);
      const py = y2px(y);
      ctx.beginPath();
      ctx.moveTo(px - dx, py - dy);
      ctx.lineTo(px + dx, py + dy);
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      const angle = Math.atan2(dy, dx);
      const head = 3;
      ctx.beginPath();
      ctx.moveTo(px + dx, py + dy);
      ctx.lineTo(px + dx - head * Math.cos(angle - Math.PI / 6), py + dy - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(px + dx - head * Math.cos(angle + Math.PI / 6), py + dy - head * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = "#94a3b8";
      ctx.fill();
    });
    ctx.restore();

    const drawPolylines = (polylines, color) => {
      ctx.save();
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = color;
      polylines.forEach((polyline) => {
        if (!polyline || polyline.length < 2) return;
        ctx.beginPath();
        polyline.forEach(([x, y], idx) => {
          const px = x2px(x);
          const py = y2px(y);
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });
      ctx.restore();
    };

    drawPolylines(nullclines.f, "#22d3ee");
    drawPolylines(nullclines.g, "#f472b6");

    ctx.save();
    ctx.fillStyle = "#fef08a";
    ctx.strokeStyle = "#f59e0b";
    equilibria.forEach(({ x, y }) => {
      const px = x2px(x);
      const py = y2px(y);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#eab308";
    trajectories.forEach(({ path }) => {
      if (!path || path.length < 2) return;
      ctx.beginPath();
      path.forEach(([x, y], idx) => {
        const px = x2px(x);
        const py = y2px(y);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      for (let i = 15; i < path.length; i += 25) {
        const [x1, y1] = path[i - 1];
        const [x2, y2] = path[i];
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const px = x2px(x2);
        const py = y2px(y2);
        const head = 4;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - head * Math.cos(angle - Math.PI / 6), py - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(px - head * Math.cos(angle + Math.PI / 6), py - head * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = "#eab308";
        ctx.fill();
      }
    });
    ctx.restore();
  }, [workerData, domain]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleClick = (evt) => {
      const rect = canvas.getBoundingClientRect();
      const px = evt.clientX - rect.left;
      const py = evt.clientY - rect.top;
      const x = (px / canvas.width) * (domain.xMax - domain.xMin) + domain.xMin;
      const y = (1 - py / canvas.height) * (domain.yMax - domain.yMin) + domain.yMin;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      setSeeds((prev) => [...prev, [x, y]]);
    };
    canvas.addEventListener("click", handleClick);
    return () => canvas.removeEventListener("click", handleClick);
  }, [domain]);

  const handleDomainInputChange = (key) => (event) => {
    const value = event.target.value;
    setDomainInputs((prev) => ({ ...prev, [key]: value }));
  };

  const commitDomainValue = (key) => () => {
    setDomainInputs((prev) => {
      const raw = prev[key];
      if (typeof raw !== "string" || raw.trim() === "") {
        return { ...prev, [key]: String(domain[key]) };
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return { ...prev, [key]: String(domain[key]) };
      }
      const next = { ...domain, [key]: parsed };
      if (next.xMin >= next.xMax || next.yMin >= next.yMax) {
        error("Bounds must satisfy xMin < xMax and yMin < yMax");
        return { ...prev, [key]: String(domain[key]) };
      }
      setDomain(next);
      return prev;
    });
  };

  const handleDomainKeyDown = (key) => (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitDomainValue(key)();
      event.currentTarget.blur();
    }
  };

  const handleGridChange = (event) => {
    setGridInput(event.target.value);
  };

  const commitGrid = () => {
    const raw = gridInput.trim();
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 8 || parsed > 200) {
      error("Grid must be an integer between 8 and 200");
      setGridInput(String(gridN));
      return;
    }
    setGridN(parsed);
  };

  const handleGridKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitGrid();
      event.currentTarget.blur();
    }
  };

  const onCommand = (input) => {
    const [cmd, ...rest] = input.trim().split(/\s+/);
    if (cmd === "help") {
      line("commands: set <param> <value> | grid <N> | bounds xMin xMax yMin yMax | clear");
      return;
    }
    if (cmd === "clear") {
      clearLogs();
      return;
    }
    if (cmd === "set" && rest.length === 2) {
      const [name, val] = rest;
      if (!(name in params)) {
        line(`unknown param "${name}"`);
        return;
      }
      const num = Number(val);
      if (!Number.isFinite(num)) {
        line("value must be a number");
        return;
      }
      setParams((prev) => ({ ...prev, [name]: num }));
      return;
    }
    if (cmd === "grid" && rest.length === 1) {
      const n = Number(rest[0]);
      if (!Number.isInteger(n) || n < 8 || n > 200) {
        line("grid must be 8..200");
        return;
      }
      setGridN(n);
      return;
    }
    if (cmd === "bounds" && rest.length === 4) {
      const [a, b, c, d] = rest.map(Number);
      if (![a, b, c, d].every(Number.isFinite) || a >= b || c >= d) {
        line("bad bounds");
        return;
      }
      setDomain({ xMin: a, xMax: b, yMin: c, yMax: d });
      return;
    }
    line("unknown command (help)");
  };

  return (
    <div className="bg-slate-900 text-slate-100 pt-4 px-4 pb-0">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 bg-slate-800/60 rounded-2xl p-3">
          <div className="flex items-center justify-between mb-3 gap-2">
            <div className="text-slate-200 font-semibold">Phase Plane</div>
            <div className="text-xs text-slate-400">click canvas to add a trajectory seed</div>
          </div>
          <div className="relative">
            <canvas ref={canvasRef} width={900} height={700} className="w-full rounded-xl bg-slate-950 border border-slate-700" />
            <div className="absolute top-3 left-3 bg-slate-900/70 backdrop-blur-md rounded-lg px-3 py-2 text-xs border border-slate-700 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span>ẋ=</span>
                <input
                  className="w-56 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  value={exprX}
                  onChange={(event) => setExprX(event.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <span>ẏ=</span>
                <input
                  className="w-56 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  value={exprY}
                  onChange={(event) => setExprY(event.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="opacity-70">bounds</span>
                <input
                  title="xMin"
                  className="w-16 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  type="number"
                  value={domainInputs.xMin}
                  onChange={handleDomainInputChange("xMin")}
                  onBlur={commitDomainValue("xMin")}
                  onKeyDown={handleDomainKeyDown("xMin")}
                />
                <input
                  title="xMax"
                  className="w-16 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  type="number"
                  value={domainInputs.xMax}
                  onChange={handleDomainInputChange("xMax")}
                  onBlur={commitDomainValue("xMax")}
                  onKeyDown={handleDomainKeyDown("xMax")}
                />
                <input
                  title="yMin"
                  className="w-16 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  type="number"
                  value={domainInputs.yMin}
                  onChange={handleDomainInputChange("yMin")}
                  onBlur={commitDomainValue("yMin")}
                  onKeyDown={handleDomainKeyDown("yMin")}
                />
                <input
                  title="yMax"
                  className="w-16 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  type="number"
                  value={domainInputs.yMax}
                  onChange={handleDomainInputChange("yMax")}
                  onBlur={commitDomainValue("yMax")}
                  onKeyDown={handleDomainKeyDown("yMax")}
                />
                <label className="text-xs text-slate-300">
                  grid
                  <input
                    className="ml-2 w-20 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                    type="number"
                    value={gridInput}
                    min={8}
                    max={200}
                    onChange={handleGridChange}
                    onBlur={commitGrid}
                    onKeyDown={handleGridKeyDown}
                  />
                </label>
                <button
                  className="ml-2 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600"
                  title="Add a random seed"
                  onClick={() => {
                    const x = lerp(domain.xMin, domain.xMax, Math.random());
                    const y = lerp(domain.yMin, domain.yMax, Math.random());
                    setSeeds((prev) => [...prev, [x, y]]);
                  }}
                >
                  Seed
                </button>
                <button
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600"
                  title="Clear seeds"
                  onClick={() => setSeeds([])}
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="md:col-span-1 space-y-4">
          <div className="bg-slate-800/60 rounded-2xl p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300 font-medium">Parameters</span>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={anim.enabled}
                    onChange={(event) => setAnim((prev) => ({ ...prev, enabled: event.target.checked }))}
                  />
                  Animate
                </label>
                <select
                  className="text-xs bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  value={anim.key ?? ""}
                  onChange={(event) => setAnim((prev) => ({ ...prev, key: event.target.value || null }))}
                >
                  <option value="">(param)</option>
                  {Object.keys(params).map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
                <label className="text-xs text-slate-300">
                  speed
                  <input
                    className="ml-2 w-24 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                    type="number"
                    step="0.1"
                    value={anim.speed}
                    onChange={(event) => setAnim((prev) => ({ ...prev, speed: Number(event.target.value) || 0 }))}
                    disabled={!anim.key}
                  />
                </label>
              </div>
            </div>

            <div className="mt-2 space-y-3">
              {Object.keys(params).length === 0 && (
                <div className="text-xs text-slate-400">
                  No free parameters detected. Use symbols like <code>mu</code> or Greek <code>μ</code> in f,g.
                </div>
              )}
              {Object.keys(params).map((key) => {
                const def = paramDefs[key] ?? { min: -3, max: 3, step: 0.1 };
                return (
                  <div key={key} className="flex items-center gap-3">
                    <div className="w-10 text-xs text-slate-300">{key}</div>
                    <input
                      className="flex-1"
                      type="range"
                      min={def.min}
                      max={def.max}
                      step={def.step}
                      value={params[key]}
                      onChange={(event) => setParams((prev) => ({ ...prev, [key]: Number(event.target.value) }))}
                    />
                    <input
                      className="w-24 bg-slate-900/60 rounded px-2 py-1 border border-slate-700 text-sm"
                      type="number"
                      step={def.step}
                      value={params[key]}
                      onChange={(event) => setParams((prev) => ({ ...prev, [key]: Number(event.target.value) }))}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <ConsolePanel logs={logs} onCommand={onCommand} />
        </div>
      </div>
    </div>
  );
}
