import { useEffect, useState } from 'react'
import { api, STALE_MS, useLive, utc, type ParamDef } from './api'
import { AlarmPanel } from './components/AlarmPanel'
import { CommandPanel } from './components/CommandPanel'
import { LiveChart } from './components/LiveChart'
import { ParamTable } from './components/ParamTable'
import { SituationBanner } from './components/SituationBanner'

export default function App() {
  const { live, connected } = useLive()
  const [params, setParams] = useState<ParamDef[]>([])
  const [faults, setFaults] = useState<string[]>([])
  const [selected, setSelected] = useState('cabin_kpa')
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    api.parameters().then((d) => { setParams(d.params); setFaults(d.faults) })
      .catch((e: Error) => setLoadError(`Cannot reach the API: ${e.message}`))
  }, [])

  const mode = live?.state.mode
  const los = !!live && (!mode || live.now - mode.rx > STALE_MS)   // loss of signal: no frame for > 2 s
  const param = params.find((p) => p.name === selected)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>aos</h1>
          <span className="brand-sub">Ground segment console · learning prototype</span>
        </div>
        <div className="status" role="status" aria-live="polite">
          <div className="stat"><span className="label">Link</span>
            <span className={`badge ${connected ? 'badge-nominal' : 'badge-red'}`}>{connected ? 'API LINK' : 'API DOWN'}</span></div>
          <div className="stat"><span className="label">Downlink</span>
            <span className={`badge ${los ? 'badge-red blink' : 'badge-nominal'}`} data-testid="signal">{los ? 'LOSS OF SIGNAL' : 'SIGNAL'}</span></div>
          <div className="stat"><span className="label">Mode</span><span className="mode-value">{mode?.v ?? '—'}</span></div>
          <div className="stat"><span className="label">Alarms</span>
            <span className={`badge ${live?.unacked ? 'badge-yellow' : 'badge-nominal'}`} data-testid="unacked">{live?.unacked ?? 0} unacked</span></div>
          <div className="stat"><span className="label">UTC</span><span className="clock">{live ? utc(live.now) : '--:--:--'}</span></div>
        </div>
      </header>
      {loadError && <p className="error">{loadError}</p>}
      <SituationBanner params={params} live={live} los={los} onSelect={setSelected} />
      <main>
        <section className="panel wide">
          <h2>Telemetry <small>click a row to chart it</small></h2>
          <ParamTable params={params} live={live} selected={selected} onSelect={setSelected} />
          {param && <LiveChart key={param.name} param={param} live={live} />}
        </section>
        <div className="side">
          <AlarmPanel />
          <CommandPanel faults={faults} />
        </div>
      </main>
    </div>
  )
}
