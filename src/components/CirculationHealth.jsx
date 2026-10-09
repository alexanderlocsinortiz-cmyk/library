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
  const state = error ? 'Unavailable' : !checkedAt ? 'Checking' : stale ? 'Needs attention' : 'Healthy'
  const checkedLabel = checkedAt ? new Date(checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Pending'
  return <div className={`system-scheduler-health${error || (checkedAt && stale) ? ' attention' : ''}`} role={error || (checkedAt && stale) ? 'alert' : 'status'}>
    <div><span>Execution status</span><strong>{state}</strong><small>{error ? 'The scheduler health record could not be read.' : !checkedAt ? 'Checking scheduler health…' : stale ? 'No successful scheduled run was recorded in the last 15 minutes.' : 'Scheduled processing is reporting recent success.'}</small></div>
    <div><span>Last successful run</span><strong>{lastRun ? new Date(lastRun).toLocaleString() : 'Not recorded'}</strong><small>Health checked {checkedLabel}; refreshes every minute.</small></div>
  </div>
}
