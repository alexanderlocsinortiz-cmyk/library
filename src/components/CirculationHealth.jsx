import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function CirculationHealth() {
  const [lastRun, setLastRun] = useState(null)
  const [checkedAt, setCheckedAt] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const { data, error: loadError } = await supabase.from('circulation_job_health').select('last_scheduled_success_at').maybeSingle()
        if (loadError) throw loadError
        if (active) { setLastRun(data?.last_scheduled_success_at || null); setCheckedAt(Date.now()); setError('') }
      } catch (loadError) { if (active) setError(loadError.message) }
    }
    void check()
    const timer = setInterval(check, 60000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const stale = !lastRun || checkedAt - new Date(lastRun).getTime() > 15 * 60000
  if (!checkedAt && !error) return <p>Checking scheduled circulation…</p>
  return <div className={stale || error ? 'inline-error' : 'inline-success'} role={stale || error ? 'alert' : 'status'}>
    {error ? `Scheduler health unavailable: ${error}` : stale ? 'Scheduled circulation has not succeeded in the last 15 minutes. Check the background job.' : `Scheduled circulation last succeeded: ${new Date(lastRun).toLocaleString()}`}
  </div>
}
