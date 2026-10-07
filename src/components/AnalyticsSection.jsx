import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const RANGE_OPTIONS = [
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last3months', label: 'Last 3 months' },
  { value: 'last6months', label: 'Last 6 months' },
  { value: 'thisYear', label: 'This year' },
]

const CATEGORY_COLORS = ['#00263d', '#a40000', '#c68a00', '#4a6b7c', '#8b5e83', '#5c805f', '#9b6b46', '#79828a']

function startOfDay(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function getRange(value) {
  const today = startOfDay(new Date())
  const endExclusive = new Date(today)
  endExclusive.setDate(endExclusive.getDate() + 1)
  const start = new Date(today)

  if (value === 'last7') start.setDate(start.getDate() - 6)
  if (value === 'last30') start.setDate(start.getDate() - 29)
  if (value === 'last3months') start.setMonth(start.getMonth() - 3)
  if (value === 'last6months') start.setMonth(start.getMonth() - 6)
  if (value === 'thisYear') start.setMonth(0, 1)

  return { start: startOfDay(start), end: endExclusive }
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateLabel(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function dateRangeLabel(start, end) {
  if (start === end) return dateLabel(start)
  return `${dateLabel(start)} – ${dateLabel(end)}`
}

function createDailyBuckets(start, end) {
  const buckets = []
  const cursor = new Date(start)
  while (cursor < end) {
    const key = dateKey(cursor)
    buckets.push({ key, start: key, end: key, loans: 0, returns: 0, members: new Set() })
    cursor.setDate(cursor.getDate() + 1)
  }
  return buckets
}

function compressSeries(series, step) {
  if (step <= 1 || series.length <= step) return series
  const compressed = []
  for (let index = 0; index < series.length; index += step) {
    const group = series.slice(index, index + step)
    compressed.push({
      key: group[0].key,
      start: group[0].start,
      end: group[group.length - 1].end,
      loans: group.reduce((sum, item) => sum + item.loans, 0),
      returns: group.reduce((sum, item) => sum + item.returns, 0),
      members: new Set(group.flatMap((item) => [...item.members])),
    })
  }
  return compressed
}

function chartStep(rangeKey, seriesLength) {
  if (rangeKey === 'last3months') return seriesLength > 31 ? 7 : 1
  if (rangeKey === 'last6months') return seriesLength > 31 ? 14 : 1
  if (rangeKey === 'thisYear') return seriesLength > 31 ? 30 : 1
  return 1
}

function buildSeries(rangeKey, start, end, rows) {
  const daily = createDailyBuckets(start, end)
  const byDate = new Map(rows.map((item) => [item.day, item]))
  for (const bucket of daily) {
    const row = byDate.get(bucket.key)
    if (row) { bucket.loans = Number(row.loans); bucket.returns = Number(row.returns); bucket.members = new Set(row.members) }
  }
  return compressSeries(daily, chartStep(rangeKey, daily.length))
}

function hasCirculation(series) {
  return series.some((item) => item.loans > 0 || item.returns > 0)
}

function hasMemberActivity(series) {
  return series.some((item) => item.members?.size > 0)
}

function AnalyticsPanel({ eyebrow, title, children, error, headerAction }) {
  return <section className="analytics-panel">
    <div className="analytics-panel-heading"><div><span className="eyebrow">{eyebrow}</span><h3>{title}</h3></div>{headerAction}</div>
    {error ? <div className="analytics-error">Unable to load analytics.</div> : children}
  </section>
}

function EmptyCollectionChart() {
  return <div className="empty-collection-layout">
    <svg className="empty-collection-donut" viewBox="0 0 200 200" role="img" aria-label="No catalog titles are available">
      <circle className="donut-track" cx="100" cy="100" r="68" />
      <text className="donut-total" x="100" y="96" textAnchor="middle">0</text>
      <text className="donut-total-label" x="100" y="116" textAnchor="middle">Books</text>
    </svg>
    <p>No catalog titles are available yet.</p>
  </div>
}

function EmptyAnalyticsState({ title, description }) {
  return <div className="analytics-empty chart-empty-state">
    <span className="analytics-empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19h16M6.5 16v-4m5 4V7m5 9v-6" />
      </svg>
    </span>
    <strong>{title}</strong>
    <span>{description}</span>
  </div>
}

function ChartSkeleton() {
  return <div className="chart-skeleton" aria-label="Loading analytics"><span /><span /><span /><span /><span /></div>
}

function ChartLegend({ items }) {
  return <div className="chart-legend">{items.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}</div>
}

function LineChart({ data }) {
  const [hoverIndex, setHoverIndex] = useState(null)
  const width = 640
  const height = 250
  const padding = { top: 18, right: 18, bottom: 36, left: 38 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const maxValue = Math.max(1, ...data.map((item) => Math.max(item.loans, item.returns)))
  const points = data.map((item, index) => ({
    ...item,
    x: padding.left + (data.length === 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth),
    loansY: padding.top + plotHeight - (item.loans / maxValue) * plotHeight,
    returnsY: padding.top + plotHeight - (item.returns / maxValue) * plotHeight,
  }))
  const toPath = (key) => points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point[key].toFixed(2)}`).join(' ')
  const hoverPoint = hoverIndex === null ? null : points[hoverIndex]
  const labelEvery = Math.max(1, Math.ceil(data.length / 5))

  return <div className="chart-wrap line-chart-wrap" onMouseLeave={() => setHoverIndex(null)}>
    <svg className="analytics-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Loans and returns line chart">
      {[0, .25, .5, .75, 1].map((ratio) => {
        const y = padding.top + plotHeight * ratio
        const value = Math.round(maxValue * (1 - ratio))
        return <g key={ratio}><line className="chart-grid-line" x1={padding.left} x2={width - padding.right} y1={y} y2={y} /><text className="chart-axis-label" x={padding.left - 8} y={y + 4} textAnchor="end">{value}</text></g>
      })}
      <path className="chart-line loans-line" d={toPath('loansY')} />
      <path className="chart-line returns-line" d={toPath('returnsY')} />
      {points.map((point, index) => <g key={point.key} onMouseEnter={() => setHoverIndex(index)}>
        <rect className="chart-hover-target" x={Math.max(padding.left, point.x - plotWidth / Math.max(data.length, 1) / 2)} y={padding.top} width={plotWidth / Math.max(data.length, 1)} height={plotHeight} />
        <circle className="chart-point loans-point" cx={point.x} cy={point.loansY} r={hoverIndex === index ? 4 : 2.5} />
        <circle className="chart-point returns-point" cx={point.x} cy={point.returnsY} r={hoverIndex === index ? 4 : 2.5} />
        {(index === 0 || index === data.length - 1 || index % labelEvery === 0) && <text className="chart-x-label" x={point.x} y={height - 10} textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}>{dateLabel(point.start)}</text>}
      </g>)}
    </svg>
    {hoverPoint && <div className="chart-tooltip" style={{ left: `${(hoverPoint.x / width) * 100}%`, top: `${(Math.min(hoverPoint.loansY, hoverPoint.returnsY) / height) * 100}%` }}><strong>{dateRangeLabel(hoverPoint.start, hoverPoint.end)}</strong><span><i className="tooltip-dot navy-dot" />Loans: {hoverPoint.loans}</span><span><i className="tooltip-dot green-dot" />Returns: {hoverPoint.returns}</span></div>}
    <ChartLegend items={[{ label: 'Loans', color: '#00263d' }, { label: 'Returns', color: '#4e8b65' }]} />
  </div>
}

function BarChart({ data }) {
  const [hoverIndex, setHoverIndex] = useState(null)
  const width = 640
  const height = 250
  const padding = { top: 18, right: 18, bottom: 36, left: 38 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const maxValue = Math.max(1, ...data.map((item) => item.members.size))
  const slotWidth = plotWidth / Math.max(data.length, 1)
  const barWidth = Math.max(3, slotWidth * .58)
  const labelEvery = Math.max(1, Math.ceil(data.length / 5))
  const hoverPoint = hoverIndex === null ? null : data[hoverIndex]

  return <div className="chart-wrap bar-chart-wrap" onMouseLeave={() => setHoverIndex(null)}>
    <svg className="analytics-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Member activity bar chart">
      {[0, .5, 1].map((ratio) => {
        const y = padding.top + plotHeight * ratio
        const value = Math.round(maxValue * (1 - ratio))
        return <g key={ratio}><line className="chart-grid-line" x1={padding.left} x2={width - padding.right} y1={y} y2={y} /><text className="chart-axis-label" x={padding.left - 8} y={y + 4} textAnchor="end">{value}</text></g>
      })}
      {data.map((item, index) => {
        const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2
        const barHeight = (item.members.size / maxValue) * plotHeight
        const y = padding.top + plotHeight - barHeight
        return <g key={item.key} onMouseEnter={() => setHoverIndex(index)}><rect className="chart-bar" x={x} y={y} width={barWidth} height={Math.max(barHeight, 1)} rx="2" /><rect className="chart-hover-target" x={padding.left + index * slotWidth} y={padding.top} width={slotWidth} height={plotHeight} />{(index === 0 || index === data.length - 1 || index % labelEvery === 0) && <text className="chart-x-label" x={x + barWidth / 2} y={height - 10} textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}>{dateLabel(item.start)}</text>}</g>
      })}
    </svg>
    {hoverPoint && <div className="chart-tooltip" style={{ left: `${((padding.left + hoverIndex * slotWidth + slotWidth / 2) / width) * 100}%`, top: '10%' }}><strong>{dateRangeLabel(hoverPoint.start, hoverPoint.end)}</strong><span>Active members: {hoverPoint.members.size}</span></div>}
    <p className="chart-caption">Unique members with borrowing or return activity</p>
  </div>
}

function DonutChart({ data, total }) {
  const [hoverIndex, setHoverIndex] = useState(null)
  const radius = 68
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const hoverItem = hoverIndex === null ? null : data[hoverIndex]

  return <div className="donut-layout">
    <div className="donut-chart-wrap">
      <svg className="donut-chart" viewBox="0 0 200 200" role="img" aria-label="Collection by category donut chart" onMouseLeave={() => setHoverIndex(null)}>
        <circle className="donut-track" cx="100" cy="100" r={radius} />
        {data.map((item, index) => {
          const dash = (item.count / total) * circumference
          const segment = <circle key={item.label} className="donut-segment" cx="100" cy="100" r={radius} stroke={CATEGORY_COLORS[index % CATEGORY_COLORS.length]} strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset} onMouseEnter={() => setHoverIndex(index)} />
          offset += dash
          return segment
        })}
        <text className="donut-total" x="100" y="96" textAnchor="middle">{total}</text>
        <text className="donut-total-label" x="100" y="116" textAnchor="middle">Books</text>
      </svg>
      {hoverItem && <div className="donut-tooltip"><strong>{hoverItem.label}</strong><span>{hoverItem.count} books · {hoverItem.percent}%</span></div>}
    </div>
    <div className="donut-legend">{data.map((item, index) => <div className="donut-legend-item" key={item.label}><span><i style={{ background: CATEGORY_COLORS[index % CATEGORY_COLORS.length] }} /><span className="donut-legend-name" title={item.label}>{item.label}</span></span><strong>{item.count} <small>({item.percent}%)</small></strong></div>)}</div>
  </div>
}

export function AnalyticsSection({ userId }) {
  const [rangeKey, setRangeKey] = useState('last30')
  const [loading, setLoading] = useState(true)
  const [series, setSeries] = useState([])
  const [categories, setCategories] = useState([])
  const [errors, setErrors] = useState({ circulation: false, collection: false, members: false })

  const range = useMemo(() => getRange(rangeKey), [rangeKey])

  useEffect(() => {
    let active = true
    const loadAnalytics = async () => {
      if (!supabase || !userId) {
        if (active) setLoading(false)
        return
      }

      setLoading(true)
      setErrors({ circulation: false, collection: false, members: false })
      const startISO = range.start.toISOString()
      const endISO = range.end.toISOString()

      try {
        const { data, error: analyticsError } = await supabase.rpc('library_analytics', {
          p_start: startISO, p_end: endISO, p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
        if (!active) return
        if (analyticsError) throw analyticsError
        setSeries(buildSeries(rangeKey, range.start, range.end, data.daily))
        const total = data.categories.reduce((sum, item) => sum + Number(item.count), 0)
        setCategories(data.categories.map((item) => ({ ...item, percent: total ? Math.round(Number(item.count) / total * 100) : 0 })))

      } catch (loadError) {
        if (import.meta.env.DEV) console.error('[analytics] load failed', loadError)
        if (active) {
          setErrors({ circulation: true, collection: true, members: true })
          setSeries([])
          setCategories([])
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    loadAnalytics()
    return () => { active = false }
  }, [range, rangeKey, userId])

  const totalBooks = categories.reduce((sum, item) => sum + item.count, 0)
  const selectedRangeLabel = RANGE_OPTIONS.find((option) => option.value === rangeKey)?.label || 'Last 30 days'

  const rangeSelect = <label className="analytics-range analytics-range-inline"><span className="sr-only">Analytics date range</span><select value={rangeKey} onChange={(event) => setRangeKey(event.target.value)} aria-label="Analytics date range">{RANGE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><span className="sr-only">Selected range: {selectedRangeLabel}</span></label>

  return <section className="analytics-section dashboard-analytics-section" aria-label="Library analytics">
    <div className="analytics-grid">
      <AnalyticsPanel eyebrow="Circulation" title="Loans and Returns" error={errors.circulation} headerAction={rangeSelect}>
        {loading ? <ChartSkeleton /> : !hasCirculation(series) ? <EmptyAnalyticsState title="No circulation recorded" description="Checkouts and returns will appear here once staff record them." /> : <LineChart data={series} />}
      </AnalyticsPanel>
      <AnalyticsPanel eyebrow="Collection" title="Collection by Category" error={errors.collection}>
        {loading ? <ChartSkeleton /> : totalBooks === 0 ? <EmptyCollectionChart /> : <DonutChart data={categories} total={totalBooks} />}
      </AnalyticsPanel>
      <AnalyticsPanel eyebrow="Members" title="Member Activity" error={errors.members}>
        {loading ? <ChartSkeleton /> : !hasMemberActivity(series) ? <EmptyAnalyticsState title="No member activity yet" description="Member activity will appear here as circulation is recorded." /> : <BarChart data={series} />}
      </AnalyticsPanel>
    </div>
  </section>
}
