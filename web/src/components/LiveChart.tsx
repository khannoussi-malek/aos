import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { api, utc, type Live, type ParamDef } from '../api'

const WINDOWS: [string, number][] = [['2 min', 120_000], ['10 min', 600_000], ['1 h', 3_600_000], ['6 h', 21_600_000], ['24 h', 86_400_000]]
const MIN_SPAN_MS = 10_000
const HISTORY_MS = 86_400_000            // = Redis TimeSeries retention
const HINT = 'Hover to read values · drag across the chart to zoom in'

/** end = null: follow live. end = a time: paused on a past window. */
type View = { spanMs: number; end: number | null }
type Data = [number[], number[], number[], number[]]   // time (s), avg, min, max

/** One parameter over a time window. The server downsamples to about one point per pixel,
 *  so the browser holds a few hundred points whatever the window (2 min or 24 h). */
export function LiveChart({ param, live }: { param: ParamDef; live: Live | null }) {
  const box = useRef<HTMLDivElement>(null)
  const readout = useRef<HTMLSpanElement>(null)
  const plot = useRef<uPlot | null>(null)
  const data = useRef<Data>([[], [], [], []])
  const bucketMs = useRef(0)
  const [view, setView] = useState<View>({ spanMs: WINDOWS[0][1], end: null })
  const [error, setError] = useState('')

  // create the chart once per parameter
  useEffect(() => {
    if (!box.current) return
    const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()   // colours live in index.css
    const font = `12px ${css('--font-mono')}`
    const axis = { stroke: css('--muted'), font, labelFont: font, grid: { stroke: css('--chart-grid') }, ticks: { stroke: css('--chart-grid') } }
    const hidden: uPlot.Series = { stroke: 'transparent', points: { show: false } }
    plot.current = new uPlot({
      width: box.current.clientWidth, height: 280,
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), 'Etc/UTC'),
      legend: { show: false },                                    // the readout line below replaces it
      cursor: { drag: { x: true, y: false, setScale: false } },  // we zoom by fetching finer data instead
      scales: { y: { range: (_u, lo, hi) => yRange(lo, hi, param) } },
      series: [{}, { label: param.label, stroke: css('--chart-line'), width: 2, points: { show: false } }, hidden, hidden],
      bands: [{ series: [3, 2], fill: css('--chart-band') }],    // min..max of each bucket
      axes: [{ ...axis, label: 'Time (UTC)', space: 90, values: (u, ticks) => ticks.map((t) => timeTick(u, t)) }, { ...axis, label: param.unit, size: 56 }],
      hooks: {
        draw: [(u) => drawLimits(u, param, { caution: css('--caution'), warning: css('--warning'), font: css('--font-mono') })],
        setCursor: [(u) => { if (readout.current) readout.current.textContent = describe(u, param) }],
        setSelect: [(u) => {
          if (u.select.width < 5) return
          const a = u.posToVal(u.select.left, 'x') * 1000, b = u.posToVal(u.select.left + u.select.width, 'x') * 1000
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
          setView({ end: Math.round(b), spanMs: Math.max(MIN_SPAN_MS, Math.round(b - a)) })
        }],
      },
    }, data.current, box.current)
    return () => { plot.current?.destroy(); plot.current = null }
  }, [param])

  // load the window from the server, at the resolution the chart can show
  useEffect(() => {
    let cancelled = false
    const points = Math.min(2000, Math.max(100, Math.round(box.current?.clientWidth ?? 600)))
    api.history(param.name, view.spanMs, view.end, points)
      .then((res) => {
        if (cancelled || !plot.current) return
        bucketMs.current = res.bucket_ms
        data.current = toColumns(res.points)
        plot.current.setData(data.current)
        setError('')
      })
      .catch((e: Error) => { if (!cancelled) setError(`Could not load history: ${e.message}`) })
    return () => { cancelled = true }
  }, [param, view])

  // live mode: append new values, at most one per bucket, and drop what scrolls out of the window
  useEffect(() => {
    const s = live?.state[param.name]
    if (view.end !== null || !s || !plot.current) return
    const xs = data.current[0]
    if (xs.length && s.t - xs[xs.length - 1] * 1000 < bucketMs.current) return   // memory stays flat for any window
    data.current[0].push(s.t / 1000); data.current[1].push(s.v); data.current[2].push(s.v); data.current[3].push(s.v)
    const cutoff = (s.t - view.spanMs) / 1000
    while (xs.length && xs[0] < cutoff) data.current.forEach((c) => c.shift())
    plot.current.setData(data.current)
  }, [live, param, view])

  const now = live?.now ?? Date.now()
  const pan = (dir: -1 | 1) => {
    const end = (view.end ?? now) + (dir * view.spanMs) / 2
    setView(end >= now ? { spanMs: view.spanMs, end: null }
                        : { spanMs: view.spanMs, end: Math.max(end, now - HISTORY_MS + view.spanMs) })
  }
  const windowLabel = WINDOWS.find(([, ms]) => ms === view.spanMs)?.[0]

  return (
    <div className="chart-wrap">
      <div className="chart-bar">
        <b className="chart-title">{param.label}</b>
        <div className="chart-nav" role="group" aria-label="Chart time window">
          <button onClick={() => pan(-1)}>‹ Earlier</button>
          {WINDOWS.map(([label, ms]) => (
            <button key={label} aria-pressed={view.end === null && view.spanMs === ms}
                    onClick={() => setView({ spanMs: ms, end: null })}>{label}</button>
          ))}
          <button onClick={() => pan(1)} disabled={view.end === null}>Later ›</button>
        </div>
      </div>
      <p className="chart-status" data-testid="chart-status">
        {view.end === null
          ? <><span className="badge badge-nominal">Live</span> last {windowLabel ?? `${Math.round(view.spanMs / 1000)} s`}</>
          : <><span className="badge badge-paused">Paused</span>
              {utc(view.end - view.spanMs)} – {utc(view.end)} UTC · not updating
              <button onClick={() => setView({ spanMs: WINDOWS[0][1], end: null })}>Back to live</button></>}
      </p>
      <div ref={box} className="chart" />
      <p className="readout">{error ? <span className="error">{error}</span> : <span ref={readout}>{HINT}</span>}</p>
    </div>
  )
}

/** 24 h UTC ticks: HH:MM:SS when zoomed in, HH:MM otherwise. */
function timeTick(u: uPlot, t: number): string {
  const spanS = (u.scales.x.max ?? 0) - (u.scales.x.min ?? 0)
  return spanS > 600 ? utc(t * 1000).slice(0, 5) : utc(t * 1000)
}

function toColumns(points: [number, number, number, number][]): Data {
  const cols: Data = [[], [], [], []]
  for (const [t, avg, lo, hi] of points) { cols[0].push(t / 1000); cols[1].push(avg); cols[2].push(lo); cols[3].push(hi) }
  return cols
}

/** Y axis always shows the red limits, plus whatever the data reaches beyond them. */
function yRange(lo: number | null, hi: number | null, p: ParamDef): uPlot.Range.MinMax {
  const a = Math.min(Number.isFinite(lo) ? lo! : p.red[0], p.red[0])
  const b = Math.max(Number.isFinite(hi) ? hi! : p.red[1], p.red[1])
  const pad = (b - a) * 0.08
  return [a - pad, b + pad]
}

/** Dashed limit lines with their name and value written on them. */
function drawLimits(u: uPlot, p: ParamDef, c: { caution: string; warning: string; font: string }) {
  const { ctx, bbox } = u
  const px = uPlot.pxRatio
  const lines: [number, string, string, boolean][] = [   // [value, name, colour, label above the line]
    [p.red[1], 'RED HIGH', c.warning, true], [p.red[0], 'RED LOW', c.warning, false],
    [p.yellow[1], 'YELLOW HIGH', c.caution, false], [p.yellow[0], 'YELLOW LOW', c.caution, true],
  ]
  ctx.save()
  ctx.font = `600 ${12 * px}px ${c.font}`
  ctx.textAlign = 'right'
  ctx.lineWidth = 1.5 * px
  ctx.setLineDash([6 * px, 4 * px])
  const labelYs: number[] = []
  for (const [v, name, color, above] of lines) {
    const y = Math.round(u.valToPos(v, 'y', true))
    ctx.strokeStyle = ctx.fillStyle = color
    ctx.beginPath(); ctx.moveTo(bbox.left, y); ctx.lineTo(bbox.left + bbox.width, y); ctx.stroke()
    const ty = above ? y - 5 * px : y + 15 * px                      // red outside, yellow inside
    if (labelYs.some((o) => Math.abs(o - ty) < 14 * px)) continue    // zoomed far out: skip a label rather than overlap
    ctx.fillText(`${name} ${v}`, bbox.left + bbox.width - 6 * px, ty)
    labelYs.push(ty)
  }
  ctx.restore()
}

/** Text for the readout line: time and value under the cursor. */
function describe(u: uPlot, p: ParamDef): string {
  const i = u.cursor.idx
  if (i == null) return HINT
  const [t, avg, lo, hi] = u.data as unknown as Data
  if (t[i] === undefined) return HINT
  const spread = lo[i] !== hi[i] ? `   min ${lo[i].toFixed(2)} · max ${hi[i].toFixed(2)}` : ''
  return `${utc(t[i] * 1000)} UTC   ${avg[i].toFixed(2)} ${p.unit}${spread}`
}
