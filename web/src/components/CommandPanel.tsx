import { useState } from 'react'
import { api, usePoll, utc } from '../api'

const MODES = ['IDLE', 'TEST', 'REENTRY']

/** Telecommands with a confirm step, and their status: sent -> received -> verified (or failed after 5 s). */
export function CommandPanel({ faults }: { faults: string[] }) {
  const { data: history, refresh } = usePoll(api.commands, 1000)
  const [error, setError] = useState('')

  const send = (name: string, arg = '') => {
    if (!window.confirm(`Send ${name} ${arg}?`)) return
    api.send(name, arg).then(() => { setError(''); refresh() }).catch((e: Error) => setError(e.message))
  }

  return (
    <section className="panel">
      <h2>Commands</h2>
      <div className="cmd-row">
        <span className="label">Mode</span>
        {MODES.map((m) => <button key={m} onClick={() => send('SET_MODE', m)}>{m}</button>)}
      </div>
      <div className="cmd-row">
        <span className="label">Inject fault</span>
        {faults.map((f) => <button key={f} className="danger" onClick={() => send('INJECT_FAULT', f)}>{f}</button>)}
        <button onClick={() => send('CLEAR_FAULTS')}>clear all</button>
      </div>
      {error && <p className="error">{error}</p>}
      <table className="cmds">
        <tbody>
          {(history ?? []).map((c) => (
            <tr key={c.id}>
              <td>{utc(c.sent)}</td>
              <td>{c.name} {c.arg}</td>
              <td><span className={`badge badge-cmd-${c.status}`}>{c.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
