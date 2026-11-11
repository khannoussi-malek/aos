import type { Live, ParamDef, ParamState } from '../api'

type Props = { params: ParamDef[]; live: Live | null; los: boolean; onSelect: (p: string) => void }
type Bad = { p: ParamDef; s: ParamState }

/** One sentence at the top that says what is happening, so the operator does not have to scan the table. */
export function SituationBanner({ params, live, los, onSelect }: Props) {
  if (!live) return <Banner tone="wait" title="Connecting" detail="Waiting for telemetry…" />
  if (los) {
    const age = Math.round((live.now - (live.state.mode?.rx ?? live.now)) / 1000)
    return <Banner tone="red" title="Loss of signal" detail={`No telemetry for ${age} s. Values on screen are frozen.`} />
  }
  const bad: Bad[] = params
    .flatMap((p) => { const s = live.state[p.name]; return s && s.level !== 'nominal' ? [{ p, s }] : [] })
    .sort((a, b) => (a.s.level === 'red' ? 0 : 1) - (b.s.level === 'red' ? 0 : 1))
  if (bad.length === 0) {
    const todo = live.unacked ? ` · ${live.unacked} old alarm${live.unacked > 1 ? 's' : ''} to acknowledge` : ''
    return <Banner tone="ok" title="All nominal" detail={`${params.length} parameters within limits${todo}`} />
  }

  const tone = bad[0].s.level === 'red' ? 'red' : 'yellow'
  return (
    <Banner tone={tone} title={tone === 'red' ? 'Warning' : 'Caution'}>
      {bad.map(({ p, s }) => (
        <button key={p.name} className={`sit-item sit-item-${s.level}`} onClick={() => onSelect(p.name)}>
          <b>{p.label}</b> {s.v.toFixed(2)} {p.unit} <span className="sit-why">{why(p, s)}</span>
        </button>
      ))}
    </Banner>
  )
}

function why(p: ParamDef, s: ParamState) {
  const [lo, hi] = s.level === 'red' ? p.red : p.yellow
  if (s.v < lo) return `below ${s.level} limit ${lo}`
  if (s.v > hi) return `above ${s.level} limit ${hi}`
  return 'back inside limits, clearing'                     // hysteresis: level clears a little later
}

function Banner({ tone, title, detail, children }: { tone: string; title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <section className={`situation sit-${tone}`} role="status" aria-live="polite" data-testid="situation">
      <span className="sit-title">{title}</span>
      <div className="sit-detail">{detail ?? children}</div>
    </section>
  )
}
