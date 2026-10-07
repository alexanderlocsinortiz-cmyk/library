import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function SchoolInvitations() {
  const [schoolId, setSchoolId] = useState('')
  const [fullName, setFullName] = useState('')
  const [verified, setVerified] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const issue = async (event) => {
    event.preventDefault()
    if (!verified || !supabase) return
    setBusy(true); setToken(''); setError('')
    try {
      const { data, error: issueError } = await supabase.rpc('issue_school_id_invitation', { p_school_id: schoolId, p_full_name: fullName, p_purpose: 'recovery' })
      if (issueError) throw issueError
      setToken(data)
      setVerified(false)
    } catch (issueError) { setError(issueError.message) } finally { setBusy(false) }
  }
  return <form className="tool-form" onSubmit={issue}>
    <h3>Recover an existing School ID account</h3>
    <p>Library members do not need online accounts. Use this only for someone who already has an account, after verifying their school-issued identification.</p>
    <div className="form-row">
      <label>School ID<input value={schoolId} onChange={(event) => { setSchoolId(event.target.value); setVerified(false); setToken('') }} required /></label>
      <label>Verified full name<input value={fullName} onChange={(event) => { setFullName(event.target.value); setVerified(false) }} required maxLength={200} /></label>
    </div>
    <label className="checkbox-field"><input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} required /> I verified this person's identity and enrollment.</label>
    <button type="submit" disabled={busy || !verified}>{busy ? 'Issuing…' : 'Issue one-time code'}</button>
    {error && <p role="alert">{error}</p>}
    {token && <div role="status"><p>Give this code only to the verified person. It expires in 24 hours.</p><label>Invitation code<input readOnly value={token} onFocus={(event) => event.target.select()} /></label></div>}
  </form>
}
