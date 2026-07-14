"use client";

import { useEffect, useRef, useState, useTransition } from "react";

const RINGS = [
  { r: 0.9, color: "#39ff8e", speed: 0.014, width: 3.6, strands: 3, spread: 0.058, angle: Math.random() * Math.PI * 2 },
  { r: 0.8, color: "#2fd9ff", speed: -0.019, width: 4.0, strands: 3, spread: 0.04, angle: Math.random() * Math.PI * 2 },
  { r: 0.68, color: "#ff3ea5", speed: 0.024, width: 3.0, strands: 2, spread: 0.036, angle: Math.random() * Math.PI * 2 },
  { r: 0.58, color: "#ff8a3d", speed: -0.03, width: 2.4, strands: 2, spread: 0.024, angle: Math.random() * Math.PI * 2 },
];

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function drawStrand(ctx, cx, cy, radius, color, rotation, lineWidth, glow) {
  const [cr, cg, cb] = hexToRgb(color);
  // createConicGradient may be available in modern browsers
  const grad = ctx.createConicGradient ? ctx.createConicGradient(rotation, cx, cy) : null;
  const c0 = `rgba(${cr},${cg},${cb},0)`;
  const cMid = `rgba(${cr},${cg},${cb},${0.55 * glow})`;
  const cHot = `rgba(${Math.min(255, cr + 120)},${Math.min(255, cg + 120)},${Math.min(255, cb + 120)},${0.95 * glow})`;
  if (grad) {
    grad.addColorStop(0, c0);
    grad.addColorStop(0.08, cMid);
    grad.addColorStop(0.16, cHot);
    grad.addColorStop(0.3, cMid);
    grad.addColorStop(0.55, c0);
    grad.addColorStop(0.82, `rgba(${cr},${cg},${cb},${0.18 * glow})`);
    grad.addColorStop(1, c0);
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = grad || `rgba(${cr},${cg},${cb},${0.9 * glow})`;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = 16 * glow;
  ctx.stroke();
}

export default function Dashboard({ playRandomSong, pausePlayback, resumePlayback }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [trackCount, setTrackCount] = useState(0);
  const [track, setTrack] = useState(null);
  const [error, setError] = useState(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();

    function resize() {
      const rect = stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    function draw(now) {
      const dt = Math.min(now - last, 48);
      last = now;

      const rect = stage.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2, cy = h / 2;
      const baseR = Math.min(w, h) / 2;
      const speedMul = isPlaying ? 1 : 0.16;
      const glow = isPlaying ? 1 : 0.45;

      RINGS.forEach((ring) => {
        ring.angle += reducedMotion ? 0 : ring.speed * speedMul * (dt / 16);
        for (let i = 0; i < ring.strands; i++) {
          const offset = ring.strands === 1 ? 0 : (i / (ring.strands - 1) - 0.5) * ring.spread;
          const radius = baseR * (ring.r + offset);
          const lw = ring.width * (1 - Math.abs(offset) * 4);
          drawStrand(ctx, cx, cy, radius, ring.color, ring.angle + i * 0.6, Math.max(1, lw), glow);
        }
      });

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [isPlaying]);

  function firePulse() {
    setPulse(false);
    requestAnimationFrame(() => setPulse(true));
  }

  function handlePlayToggle() {
    setError(null);

    if (!track) {
      startTransition(async () => {
        const result = await playRandomSong();
        if (result.ok) {
          setTrack(result.track);
          setTrackCount((n) => n + 1);
          setIsPlaying(true);
          firePulse();
        } else {
          setError(result.error);
        }
      });
      return;
    }

    if (isPlaying) {
      startTransition(async () => {
        const result = await pausePlayback();
        if (result.ok) {
          setIsPlaying(false);
        } else {
          setError(result.error);
        }
      });
    } else {
      startTransition(async () => {
        const result = await resumePlayback();
        if (result.ok) {
          setIsPlaying(true);
        } else {
          setError(result.error);
        }
      });
    }
  }

  function handleNext() {
    setError(null);
    firePulse();
    setRevealed(false);

    startTransition(async () => {
      const result = await playRandomSong();
      if (result.ok) {
        setTrack(result.track);
        setTrackCount((n) => n + 1);
        setIsPlaying(true);
      } else {
        setError(result.error);
        setIsPlaying(false);
      }
    });
  }

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap');

        :root{
          --bg-void:#0a0e17;
          --bg-deep:#111a2c;
          --bg-panel:#141d31;
          --line:rgba(255,255,255,0.08);

          --green:#39ff8e;
          --blue:#2fd9ff;
          --pink:#ff3ea5;
          --orange:#ff8a3d;

          --ink:#f4f6fb;
          --ink-dim:#8b93ab;
          --ink-faint:#5b6480;

          --disp: 'Space Grotesk', sans-serif;
          --body: 'Inter', sans-serif;
          --mono: 'IBM Plex Mono', monospace;
        }

        *{ box-sizing:border-box; }

        html,body{
          margin:0; padding:0; height:100%;
          background:
            radial-gradient(ellipse 900px 600px at 50% 18%, rgba(47,217,255,0.10), transparent 60%),
            radial-gradient(ellipse 700px 500px at 82% 78%, rgba(255,62,165,0.08), transparent 60%),
            radial-gradient(ellipse 700px 500px at 12% 82%, rgba(255,138,61,0.07), transparent 60%),
            var(--bg-void);
          color:var(--ink);
          font-family:var(--body);
          overflow-x:hidden;
        }

        .app{
          min-height:100vh;
          display:flex;
          flex-direction:column;
          padding:1.75rem clamp(1rem, 4vw, 3rem) 2.5rem;
        }

        header{ display:flex; align-items:center; justify-content:center; }

        .show-btn{
          font-family:var(--disp); font-weight:700; font-size:2rem; letter-spacing:.03em;
          color:var(--bg-void);
          background:linear-gradient(120deg, var(--blue), var(--green));
          border:none; padding:.9rem 2.4rem; border-radius:999px; cursor:pointer;
          display:inline-flex; align-items:center; gap:.6rem;
          box-shadow:0 10px 30px -8px rgba(47,217,255,0.45);
          transition:transform .15s ease, box-shadow .2s ease;
          margin-top: 150px;
        }
        .show-btn:hover{ transform:translateY(-2px); box-shadow:0 14px 34px -6px rgba(47,217,255,0.55); }
        .show-btn:active{ transform:translateY(0); }
        .show-btn:focus-visible{ outline:2px solid var(--ink); outline-offset:3px; }

        main{
          flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
          gap:1.2rem; padding:1.5rem 0;
        }

        .stage-wrap{ position:relative; width:min(82vw, 600px); aspect-ratio:1/1; }
        .stage-wrap.pulse{ animation:pulse .5s ease; }
        @keyframes pulse{ 0%{ transform:scale(1); } 35%{ transform:scale(1.045); } 100%{ transform:scale(1); } }

        canvas{ position:absolute; inset:0; width:100%; height:100%; }

        .disc{
          position:absolute; inset:24%; border-radius:50%;
          background:
            repeating-radial-gradient(circle at 50% 50%, #1b2135 0px, #1b2135 2px, #14192a 3px, #14192a 4px);
          box-shadow:
            0 0 0 1px rgba(255,255,255,0.06),
            0 18px 40px rgba(0,0,0,0.55),
            inset 0 0 30px rgba(0,0,0,0.6);
          display:flex; align-items:center; justify-content:center; z-index:1;
        }

        .label{
          width:52%; height:52%; border-radius:50%;
          background:conic-gradient(from 180deg, var(--green), var(--blue), var(--pink), var(--orange), var(--green));
          display:flex; align-items:center; justify-content:center;
          box-shadow:0 0 0 4px var(--bg-void), 0 0 25px rgba(57,255,142,0.25);
        }

        .play-btn{
          width:68%; height:68%; border-radius:50%; background:var(--bg-void); border:none; cursor:pointer;
          display:flex; align-items:center; justify-content:center;
          transition:transform .15s ease, box-shadow .3s ease;
          box-shadow:0 0 0 0 rgba(47,217,255,0);
        }
        .play-btn:hover{ transform:scale(1.06); }
        .play-btn:active{ transform:scale(0.95); }
        .play-btn:focus-visible{ outline:2px solid var(--green); outline-offset:4px; }
        .play-btn svg{ width:34%; height:34%; }
        .play-btn.is-playing{ box-shadow:0 0 26px 4px rgba(47,217,255,0.35); }
        .play-btn:disabled{ opacity:.6; cursor:wait; }

        .card-reveal{
          position:absolute; inset:24%; border-radius:22px; z-index:5;
          display:flex; flex-direction:column; align-items:center; justify-content:space-between;
          text-align:center; padding:11% 8%;
          background:
            radial-gradient(120% 140% at 50% 0%, rgba(9, 208, 235, 0.75), transparent 55%),
            linear-gradient(155deg, #effd2c 0%, #37ff25 48%, #ff289b 100%);
          box-shadow:
            0 0 0 1px rgba(255,255,255,0.15),
            0 25px 60px -12px rgba(255,80,90,0.55),
            inset 0 0 50px rgba(0,0,0,0.12);
          opacity:0; transform:scale(0.82); pointer-events:none;
          transition:opacity .4s cubic-bezier(.4,0,.2,1), transform .4s cubic-bezier(.34,1.4,.64,1);
        }
        .card-reveal.open{ opacity:1; transform:scale(2); pointer-events:auto; }
        .card-artist{
          font-family:var(--body); font-weight:600; font-size:clamp(0.9rem, 3.4vw, 1.3rem);
          letter-spacing:.04em; color:rgba(20,10,10,0.85); text-transform:uppercase;
        }
        .card-year{
          font-family:var(--disp); font-weight:700; font-size:clamp(2.4rem, 11vw, 4.6rem);
          line-height:1; color:#1a0f0a; text-shadow:0 2px 0 rgba(255,255,255,0.25);
        }
        .card-title{ font-family:var(--body); font-weight:600; font-size:clamp(0.95rem, 3.6vw, 1.4rem); color:rgba(20,10,10,0.85); }

        .readout{
          font-family:var(--mono); font-size:.78rem; letter-spacing:.16em; color:var(--ink-faint);
          text-transform:uppercase; text-align:center;
        }
        .readout .num{ color:var(--green); }

        .error-banner{
          font-family:var(--body); font-size:.85rem; color:#ffb4b4;
          background:rgba(255,62,90,0.12); border:1px solid rgba(255,62,90,0.3);
          padding:.6rem 1rem; border-radius:10px; max-width:min(82vw, 500px); text-align:center;
        }

        footer{ display:flex; justify-content:center; }

        .next-btn{
          font-family:var(--disp); font-weight:700; font-size:2.05rem; letter-spacing:.03em;
          color:var(--bg-void);
          background:linear-gradient(120deg, var(--orange), var(--pink));
          border:none; padding:1rem 2.6rem; border-radius:999px; cursor:pointer;
          display:inline-flex; align-items:center; gap:.65rem;
          box-shadow:0 10px 30px -8px rgba(255,62,165,0.45);
          transition:transform .15s ease, box-shadow .2s ease;
        }
        .next-btn:hover{ transform:translateY(-2px); box-shadow:0 14px 34px -6px rgba(255,62,165,0.55); }
        .next-btn:active{ transform:translateY(0); }
        .next-btn:focus-visible{ outline:2px solid var(--ink); outline-offset:3px; }
        .next-btn:disabled{ opacity:.6; cursor:wait; }

        @media (prefers-reduced-motion: reduce){ .stage-wrap.pulse{ animation:none; } }
      `}</style>

      <header>
        <button
          className="show-btn"
          type="button"
          aria-expanded={revealed}
          onClick={() => setRevealed((r) => !r)}
          disabled={!track}
        >
          {revealed ? "Hide" : "Show"}
        </button>
      </header>

      <main>
        <div className={`stage-wrap${pulse ? " pulse" : ""}`} ref={stageRef} onAnimationEnd={() => setPulse(false)}>
          <canvas ref={canvasRef} />

          <div className="disc">
            <div className="label">
              <button
                className={`play-btn${isPlaying ? " is-playing" : ""}`}
                type="button"
                aria-label={isPlaying ? "Pause" : "Play"}
                onClick={handlePlayToggle}
                disabled={isPending}
              >
                {isPlaying ? (
                  <svg viewBox="0 0 24 24" fill="none">
                    <rect x="6" y="5" width="4.5" height="14" rx="1.2" fill="#F4F6FB" />
                    <rect x="13.5" y="5" width="4.5" height="14" rx="1.2" fill="#F4F6FB" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="M7 5.5v13a1 1 0 0 0 1.53.85l10.5-6.5a1 1 0 0 0 0-1.7l-10.5-6.5A1 1 0 0 0 7 5.5Z"
                      fill="#F4F6FB"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div className={`card-reveal${revealed ? " open" : ""}`}>
            <div className="card-artist">{track?.artist ?? "Redacted"}</div>
            <div className="card-year">{track?.year ?? "----"}</div>
            <div className="card-title">{track?.name ?? "Redacted"}</div>
          </div>
        </div>

        <div className="readout">
          Track <span className="num">{String(trackCount).padStart(2, "0")}</span> this session
        </div>

        {error && <div className="error-banner">{error}</div>}
      </main>

      <footer>
        <button className="next-btn" type="button" onClick={handleNext} disabled={isPending}>
          Next Song
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M6 5v14l10-7L6 5Z" fill="currentColor" />
            <rect x="17" y="5" width="2.2" height="14" fill="currentColor" />
          </svg>
        </button>
      </footer>
    </div>
  );
}
