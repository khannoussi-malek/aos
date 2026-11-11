import { api, usePoll, utc } from '../api'

/** Alarm log, newest first. Unacknowledged yellow/red alarms stay highlighted until a controller acks them. */
export function AlarmPanel() {
  const { data: events, refresh } = usePoll(api.events, 1000)
  const ack = (id: string) => api.ack(id).then(refresh)
  return (
    <section className="panel">
      <h2>Alarms</h2>
      <ul className="alarms">
        {(events ?? []).map((e) => (
          <li key={e.id} className={`alarm alarm-${e.level} ${e.acked ? 'acked' : ''}`} data-testid="alarm">
            <time>{utc(e.t)}</time>
            <span className={`badge badge-${e.level}`}>{e.kind === 'gap' ? 'GAP' : e.level.toUpperCase()}</span>
            <span className="msg">{e.message}</span>
            {!e.acked && <button onClick={() => ack(e.id)}>Ack</button>}
          </li>
        ))}
        {events?.length === 0 && <li className="empty">No alarms</li>}
      </ul>
    </section>
  )
}
