import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import assert from 'node:assert/strict'

// Always creates a disposable cluster; never reads the application's credentials.
const root = mkdtempSync(join(tmpdir(), 'library-db-test-'))
const bin = process.env.PG_BIN || ''
const exe = (name) => bin ? join(bin, name + (process.platform === 'win32' ? '.exe' : '')) : name
const run = (name, args) => execFileSync(exe(name), args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const port = await new Promise((resolvePort) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolvePort(value)) })
})
const conn = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
const sql = (text) => run('psql', [...conn, '-c', text])
const file = (path) => run('psql', [...conn, '-f', path])
const concurrentSql = (text) => new Promise((resolveResult) => {
  const child = spawn(exe('psql'), [...conn, '-c', `begin; ${text} select pg_sleep(0.2); commit;`], { windowsHide: true })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  child.on('error', (error) => resolveResult({ code: -1, output: error.message }))
  child.on('close', (code) => resolveResult({ code, output }))
})
let started = false
try {
  run('initdb', ['-D', join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale'])
  execFileSync(exe('pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o', `-p ${port} -h 127.0.0.1`, '-w', 'start'], { windowsHide: true, stdio: 'ignore' })
  started = true
  sql('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;')
  const bootstrap = `    create schema auth;
    create schema storage;
    create table auth.users(id uuid primary key, email text unique, email_confirmed_at timestamptz, last_sign_in_at timestamptz, banned_until timestamptz, created_at timestamptz not null default now(), raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table storage.buckets(id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text not null references storage.buckets(id), name text not null, unique(bucket_id,name));
    create function storage.foldername(object_name text) returns text[] language sql immutable strict as $$select case when array_length(string_to_array(object_name,'/'),1)>1 then (string_to_array(object_name,'/'))[1:array_length(string_to_array(object_name,'/'),1)-1] else array[]::text[] end$$;
    create function storage.filename(object_name text) returns text language sql immutable strict as $$select regexp_replace(object_name,'^.*/','')$$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`
  sql(bootstrap)
  for (const migration of readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort()) {
    if (migration.startsWith('022_')) file(resolve('supabase/tests/registration_school_id_seed.sql'))
    run('psql', [...conn, '--single-transaction', '-f', resolve('supabase/migrations', migration)])
    console.log(`Installed ${migration}`)
  }
  file(resolve('supabase/tests/integrity.sql'))
  file(resolve('supabase/tests/book_cover_storage.sql'))
  file(resolve('supabase/tests/activity_logs.sql'))
  file(resolve('supabase/tests/registration_school_id.sql'))
  file(resolve('supabase/tests/registration_expiration.sql'))
  file(resolve('supabase/tests/admin_user_deletion.sql'))
  console.log('Database authorization and workflow assertions passed')
  const staff = `set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';`
  const promotions = await Promise.all([1,2].map(() => concurrentSql(`${staff} select public.promote_next_reservation('20000000-0000-0000-0000-000000000002');`)))
  assert.ok(promotions.every((r) => r.code === 0), JSON.stringify(promotions))
  sql(`do $$begin if (select count(*) from public.reservations where book_id='20000000-0000-0000-0000-000000000002' and status='ready_for_pickup') <> 2 then raise exception 'Promotion race failed'; end if; end$$;`)
  // One physical copy, two simultaneous checkout attempts: exactly one succeeds.
  const race = await Promise.all([4,5].map((member) => concurrentSql(`${staff} select public.checkout_copy('10000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-00000000000${member}');`)))
  assert.equal(race.filter((r) => r.code === 0).length, 1, JSON.stringify(race))
  assert.match(race.find((r) => r.code !== 0).output, /not available/)
  sql(`update public.system_settings set value='1' where key='max_active_loans';`)
  const limitRace = await Promise.all([11,12].map((copy) => concurrentSql(`${staff} select public.checkout_copy('10000000-0000-0000-0000-0000000000${copy}','00000000-0000-0000-0000-000000000006');`)))
  assert.equal(limitRace.filter((r) => r.code === 0).length, 1, JSON.stringify(limitRace))
  assert.match(limitRace.find((r) => r.code !== 0).output, /active loan limit/)
  const adminRace = await Promise.all([[1,2],[2,1]].map(([actor,target]) => concurrentSql(`set role authenticated; set request.jwt.claim.sub='00000000-0000-0000-0000-00000000000${actor}'; select public.change_member_role('00000000-0000-0000-0000-00000000000${target}','librarian');`)))
  assert.equal(adminRace.filter((r) => r.code === 0).length, 1, JSON.stringify(adminRace))
  console.log('Concurrency assertions passed: copy checkout, loan limit, queue promotion, admin continuity')
  sql('create database library_upgrade')
  conn[conn.indexOf('-d') + 1] = 'library_upgrade'
  sql(bootstrap)
  for (const migration of readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort()) {
    if (migration.startsWith('022_')) file(resolve('supabase/tests/registration_school_id_seed.sql'))
    run('psql', [...conn, '--single-transaction', '-f', resolve('supabase/migrations', migration)])
    if (migration.startsWith('004_')) {
      file(resolve('supabase/tests/upgrade_seed.sql'))
      file(resolve('supabase/tests/migration_impact_preview.sql'))
    }
    if (migration.startsWith('006_')) file(resolve('supabase/tests/member_migration_impact_preview.sql'))
  }
  file(resolve('supabase/tests/upgrade_assertions.sql'))
  console.log('Existing 004 database upgrade assertions passed')
  // SQL source remains available beside logs to aid reproductions.
  writeFileSync(join(root, 'tested-migrations.txt'), readdirSync('supabase/migrations').join('\n'))
  assert.ok(readFileSync(join(root, 'server.log')).length)
} catch (error) {
  console.error(error.stderr?.toString() || error)
  process.exitCode = 1
} finally {
  if (started) run('pg_ctl', ['-D', join(root, 'data'), '-m', 'fast', '-w', 'stop'])
  console.log(`Disposable database stopped. Logs: ${root}`)
}
