import { useEffect, useState } from 'react'

export type Level = 'nominal' | 'yellow' | 'red'
export type ParamDef = { name: string; label: string; unit: string; yellow: [number, number]; red: [number, number] }
export type ParamState = { v: number; level: Level; t: number; rx: number }
export type Live = {
  now: number
  state: Record<string, ParamState> & { mode?: { v: string; t: number; rx: number } }
  unacked: number
}
export type AlarmEvent = {
  id: string; t: string; kind: string; level: Level; message: string; param?: string; acked: boolean
}
export type Command = { id: string; name: string; arg: string; sent: string; status: string }

export const STALE_MS = 2000

/** Mission control works in UTC: HH:MM:SS. */
export const utc = (ms: number | string) => new Date(Number(ms)).toISOString().slice(11, 19)

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

export const api = {
  parameters: () => call<{ params: ParamDef[]; faults: string[] }>('/parameters'),
  /** end = null means "until now". Points are [t, avg, min, max], at most `points` of them. */
  history: (param: string, spanMs: number, end: number | null, points: number) =>
    call<{ bucket_ms: number; points: [number, number, number, number][] }>(
      `/history?param=${param}&span_ms=${spanMs}&points=${points}${end === null ? '' : `&end=${end}`}`),
  events: () => call<AlarmEvent[]>('/events?count=50'),
  ack: (id: string) => call(`/events/${id}/ack`, { method: 'POST' }),
  commands: () => call<Command[]>('/commands'),
  send: (name: string, arg = '') =>
    call<Command>('/commands', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arg }),
    }),
}

/** Live snapshot over Server-Sent Events. `connected` is false while the stream is down. */
export function useLive() {
  const [live, setLive] = useState<Live | null>(null)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const es = new EventSource('/api/live')
    es.onmessage = (e) => { setLive(JSON.parse(e.data)); setConnected(true) }
    es.onerror = () => setConnected(false)       // EventSource reconnects by itself
    return () => es.close()
  }, [])
  return { live, connected }
}

/** Re-runs `load` every `ms` and returns the latest result. */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const run = () => load().then((d) => alive && setData(d)).catch(() => {})
    run()
    const id = setInterval(run, ms)
    return () => { alive = false; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, tick, ...deps])
  return { data, refresh: () => setTick((t) => t + 1) }
}
