import type { CSSProperties } from 'react'
import { STALE_MS, type Live, type ParamDef } from '../api'

type Props = { params: ParamDef[]; live: Live | null; selected: string; onSelect: (p: string) => void }

/** One row per parameter. Colour = limit state; grey STALE = no fresh data for more than 2 s. */
export function ParamTable({ params, live, selected, onSelect }: Props) {
  return (
    <table className="params">
      <thead>
        <tr><th>Parameter</th><th className="num">Value</th><th>Unit</th><th>Position in limits</th><th>State</th></tr>
      </thead>
      <tbody>
        {params.map((p) => {
          const s = live?.state[p.name]
          const stale = !s || !live || live.now - s.rx > STALE_MS
          const state = stale ? 'stale' : s.level
          return (
            <tr key={p.name} className={`row-${state} ${selected === p.name ? 'selected' : ''}`}
                onClick={() => onSelect(p.name)} data-testid={`param-${p.name}`}
                tabIndex={0} aria-selected={selected === p.name}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.name) } }}>
              <td><span className="pname">{p.label}</span><span className="pcode">{p.name}</span></td>
              <td className="num value">{s ? s.v.toFixed(2) : '—'}</td>
              <td className="unit">{p.unit}</td>
              <td><LimitBar p={p} v={s?.v} /></td>
              <td><span className={`badge badge-${state}`}>{state.toUpperCase()}</span></td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** Bullet-chart style bar: red | yellow | ok | yellow | red zones, and a marker at the current value.
 *  Shows a value drifting towards a limit before any alarm fires. */
function LimitBar({ p, v }: { p: ParamDef; v?: number }) {
  const pad = (p.red[1] - p.red[0]) * 0.15
  const lo = p.red[0] - pad, span = p.red[1] + pad - lo
  const pct = (x: number) => `${Math.min(100, Math.max(0, ((x - lo) / span) * 100))}%`
  const style = { '--r0': pct(p.red[0]), '--y0': pct(p.yellow[0]), '--y1': pct(p.yellow[1]), '--r1': pct(p.red[1]) } as CSSProperties
  return (
    <div className="limitbar" aria-label={`yellow ${p.yellow.join(' to ')}, red ${p.red.join(' to ')} ${p.unit}`}>
      <span>{p.yellow[0]}</span>
      <div className="track" style={style}>{v !== undefined && <i style={{ left: pct(v) }} />}</div>
      <span>{p.yellow[1]}</span>
    </div>
  )
}
