import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import {
  Chart as ChartJS,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend
} from 'chart.js'
import { Scatter } from 'react-chartjs-2'

ChartJS.register(
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend
)

const STORAGE_KEY = 'hydro-pwa-stations-v2'
const CHART_CONFIG_KEY = 'hydro-pwa-chart-config-v1'
const CHART_LEGEND_POS_KEY = 'hydro-pwa-chart-legend-pos-v1'

const YEAR_COLORS = [
  '#1d4ed8',
  '#16a34a',
  '#31587c',
  '#5e0cec',
  '#976448',
  '#0891b2',
  '#dc2626',
  '#5851d8'
]

const CURVE_COLORS = [
  '#ff0000',
  '#ff00ff',
  '#0000ff',
  '#000000',
  '#00aa00',
  '#ff7f00'
]

const DEVICE_STYLES = {
  ADCP: { symbol: '◆', pointStyle: 'rectRot' },
  유속계: { symbol: '●', pointStyle: 'circle' },
  전자파: { symbol: '■', pointStyle: 'rect' },
  부자: { symbol: '▲', pointStyle: 'triangle' },
  배수: { symbol: '★', pointStyle: 'star' },
  조위: { symbol: '✕', pointStyle: 'cross' },
  식생: { symbol: '●', pointStyle: 'circle' },
  공사: { symbol: '✚', pointStyle: 'crossRot' },
  부분개방: { symbol: '■', pointStyle: 'rect' },
  기타: { symbol: '●', pointStyle: 'circle' }
}

const makeId = () => Math.random().toString(36).slice(2, 10)

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const fmt = (v, digits = 3) => {
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(digits) : ''
}

const formatTick = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return `${value}`
  return new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: 3
  }).format(n)
}

const safeScaleNumber = (value, scaleType) => {
  if (value === '' || value === null || value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  if (scaleType === 'logarithmic' && n <= 0) return undefined
  return n
}

function calcQ(h, section) {
  const H = num(h)
  const A = num(section.a)
  const B = num(section.b)
  const C = num(section.c)
  if (H === null || A === null || B === null || C === null) return null
  const x = H - B
  if (x < 0) return null
  const q = A * Math.pow(x, C)
  return Number.isFinite(q) ? q : null
}

function findSectionByH(h, sections, measurementDatetime = null) {
  const H = num(h)
  if (H === null) return null

  const applicableSections = sections.filter((section) => {
    const hMin = num(section.hMin)
    const hMax = num(section.hMax)
    if (hMin === null || hMax === null) return false
    if (H < hMin || H > hMax) return false
    if (!measurementDatetime) return true
    return isMeasurementApplicableToSection(measurementDatetime, section)
  })

  const exact = applicableSections.find((s) => {
    const hMin = num(s.hMin)
    const hMax = num(s.hMax)
    return hMin !== null && hMax !== null && H >= hMin && H <= hMax
  })
  if (exact) return exact

  let best = null
  let bestDist = Infinity
  for (const s of applicableSections) {
    const hMin = num(s.hMin)
    const hMax = num(s.hMax)
    if (hMin === null || hMax === null) continue
    const center = (hMin + hMax) / 2
    const dist = Math.abs(H - center)
    if (dist < bestDist) {
      bestDist = dist
      best = s
    }
  }
  return best
}

function genCurveRows(section) {
  const hMin = num(section.hMin)
  const hMax = num(section.hMax)
  if (hMin === null || hMax === null || hMax < hMin) return []

  const rows = []
  for (let h = hMin; h <= hMax + 0.000001; h += 0.01) {
    const q = calcQ(h, section)
    if (q !== null) {
      rows.push({
        h: Number(h.toFixed(2)),
        q
      })
    }
  }
  return rows
}

function normalizeDeviceLabel(raw) {
  const s = String(raw || '').trim()
  if (!s) return '기타'
  if (s.includes('ADCP')) return 'ADCP'
  if (s.includes('유속')) return '유속계'
  if (s.includes('전자')) return '전자파'
  if (s.includes('부자')) return '부자'
  if (s.includes('배수')) return '배수'
  if (s.includes('조위')) return '조위'
  if (s.includes('식생')) return '식생'
  if (s.includes('공사')) return '공사'
  if (s.includes('부분개방')) return '부분개방'
  return s
}

function getYearLabel(datetime) {
  const d = new Date(datetime)
  if (Number.isNaN(d.getTime())) return '미정'
  return String(d.getFullYear())
}

function compareYearLabel(a, b) {
  if (a === '미정' && b === '미정') return 0
  if (a === '미정') return 1
  if (b === '미정') return -1
  return Number(a) - Number(b)
}

function parseThreshold(note) {
  const s = String(note || '').trim()
  if (!s) return null
  const match = s.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

function parseDateTime(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function isMeasurementApplicableToSection(measurementDatetime, section) {
  const start = parseDateTime(section.periodStart)
  const end = parseDateTime(section.periodEnd)
  const measurementDate = parseDateTime(measurementDatetime)
  if (!start || !end || !measurementDate) return true

  const startYear = start.getFullYear()
  const measurementYear = measurementDate.getFullYear()

  if (measurementYear < startYear) return true
  return measurementDate >= start && measurementDate <= end
}

function normalizeStation(station) {
  return {
    ...station,
    classification: station.classification || '일반 지점',
    sections: Array.isArray(station.sections) ? station.sections : [],
    measurements: Array.isArray(station.measurements) ? station.measurements : [],
    processPlan: Array.isArray(station.processPlan)
      ? station.processPlan.slice(0, 12)
      : Array.from({ length: 12 }, () => '')
  }
}

function normalizeGroups(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    ...group,
    stations: Array.isArray(group.stations) ? group.stations.map(normalizeStation) : []
  }))
}

function buildCurveSegments(section) {
  const rows = genCurveRows(section)
  if (rows.length === 0) {
    return {
      datasets: [],
      dashed: false
    }
  }

  const lowThreshold = parseThreshold(section.lowNote)
  const highThreshold = parseThreshold(section.highNote)

  if (lowThreshold === null && highThreshold === null) {
    return {
      datasets: [{ rows, dashed: false }],
      dashed: false
    }
  }

  const datasets = []

  if (lowThreshold !== null && highThreshold !== null && lowThreshold < highThreshold) {
    const lowRows = rows.filter((row) => row.h <= lowThreshold)
    const midRows = rows.filter((row) => row.h > lowThreshold && row.h < highThreshold)
    const highRows = rows.filter((row) => row.h >= highThreshold)

    if (lowRows.length) datasets.push({ rows: lowRows, dashed: true })
    if (midRows.length) datasets.push({ rows: midRows, dashed: false })
    if (highRows.length) datasets.push({ rows: highRows, dashed: true })
  } else if (lowThreshold !== null) {
    const lowRows = rows.filter((row) => row.h <= lowThreshold)
    const normalRows = rows.filter((row) => row.h > lowThreshold)

    if (lowRows.length) datasets.push({ rows: lowRows, dashed: true })
    if (normalRows.length) datasets.push({ rows: normalRows, dashed: false })
  } else if (highThreshold !== null) {
    const normalRows = rows.filter((row) => row.h < highThreshold)
    const highRows = rows.filter((row) => row.h >= highThreshold)

    if (normalRows.length) datasets.push({ rows: normalRows, dashed: false })
    if (highRows.length) datasets.push({ rows: highRows, dashed: true })
  }

  return {
    datasets: datasets.length ? datasets : [{ rows, dashed: false }],
    dashed: true
  }
}

function buildInitialStations() {
  return [
    {
      id: makeId(),
      name: '진천군 (가산교)',
      code: '3011520',
      classification: '일반 지점',
      sections: [
        {
          id: makeId(),
          name: '저수위1',
          hMin: '0.06',
          hMax: '0.55',
          a: '18.556',
          b: '0.060',
          c: '1.507',
          lowNote: '0.29m 이하 외삽',
          highNote: '',
          periodStart: '2026-01-01T00:10',
          periodEnd: '2026-06-01T00:00'
        },
        {
          id: makeId(),
          name: '저수위2',
          hMin: '0.55',
          hMax: '1.74',
          a: '22.112',
          b: '0.110',
          c: '1.523',
          lowNote: '',
          highNote: '',
          periodStart: '2026-01-01T00:10',
          periodEnd: '2026-06-01T00:00'
        },
        {
          id: makeId(),
          name: '중수위',
          hMin: '1.74',
          hMax: '2.53',
          a: '20.007',
          b: '0.200',
          c: '1.955',
          lowNote: '',
          highNote: '',
          periodStart: '2026-01-01T00:10',
          periodEnd: '2026-06-01T00:00'
        },
        {
          id: makeId(),
          name: '고수위',
          hMin: '2.53',
          hMax: '7.11',
          a: '8.626',
          b: '0.100',
          c: '2.810',
          lowNote: '',
          highNote: '3.63m 이상 외삽',
          periodStart: '2026-01-01T00:10',
          periodEnd: '2026-06-01T00:00'
        }
      ],
      measurements: [
        {
          id: makeId(),
          datetime: '2020-08-06T12:00',
          h: '2.84',
          q: '146.516',
          device: 'ADCP',
          exclude: '',
          tide: '',
          vegetation: '',
          construction: '',
          partialOpen: ''
        },
        {
          id: makeId(),
          datetime: '2025-07-17T13:51',
          h: '3.63',
          q: '274.570',
          device: 'ADCP',
          exclude: '',
          tide: '',
          vegetation: '',
          construction: '',
          partialOpen: ''
        }
      ]
    }
  ]
}

function createEmptySection() {
  return {
    id: makeId(),
    name: '',
    hMin: '',
    hMax: '',
    a: '',
    b: '',
    c: '',
    lowNote: '',
    highNote: '',
    periodStart: '',
    periodEnd: ''
  }
}

function createEmptyMeasurement() {
  return {
    id: makeId(),
    datetime: '',
    h: '',
    q: '',
    device: '',
    exclude: '',
    tide: '',
    vegetation: '',
    construction: '',
    partialOpen: ''
  }
}

function createEmptyStation(name = '새 지점') {
  return {
    id: makeId(),
    name,
    code: '',
    classification: '일반 지점',
    sections: [],
    measurements: [],
    processPlan: Array.from({ length: 12 }, () => '')
  }
}

function createDefaultGroup(name = '그룹 1', stationName = '새 지점') {
  return {
    id: makeId(),
    name,
    stations: [createEmptyStation(stationName)]
  }
}

function buildInitialGroups() {
  return [
    {
      id: makeId(),
      name: '그룹 1',
      stations: buildInitialStations()
    }
  ]
}

function flattenGroupsToStations(groups) {
  return groups.flatMap((group) => group.stations)
}

function moveArrayItem(items, fromIndex, toIndex) {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items.slice()
  }

  const next = items.slice()
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

const DEFAULT_GROUPS = normalizeGroups(buildInitialGroups())
const SHARED_TABLE_STYLE = {
  tableLayout: 'auto',
  width: 'max-content',
  minWidth: '100%'
}


const HRFCO_API_KEY_STORAGE_KEY = 'hrfco-api-key-v1'
let cachedHrfcoStationInfoApiKey = ''
let cachedHrfcoStationInfoItems = []
let cachedHrfcoStationInfoPromise = null

const roundTo = (value, digits = 2) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

const formatHrfcoDateTime = (date) => {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}${mm}${dd}${hh}${mi}`
}

const alignToPreviousTenMinuteMark = (date) => {
  const aligned = new Date(date.getTime())
  aligned.setSeconds(0, 0)
  const minutes = aligned.getMinutes()
  const remainder = minutes % 10
  if (remainder !== 0) {
    aligned.setMinutes(minutes - remainder)
  }
  return aligned
}

const normalizeHrfcoStationName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s\-_.·•,()\[\]{}<>/\\|:;~`'"!?@#$%^&*=+]/g, '')

const loadHrfcoStationInfo = async (apiKey) => {
  const trimmedApiKey = String(apiKey || '').trim()
  if (!trimmedApiKey) {
    throw new Error('API 키가 비어 있습니다.')
  }

  if (
    cachedHrfcoStationInfoApiKey === trimmedApiKey &&
    cachedHrfcoStationInfoItems.length > 0
  ) {
    return cachedHrfcoStationInfoItems
  }

  if (cachedHrfcoStationInfoPromise && cachedHrfcoStationInfoApiKey === trimmedApiKey) {
    return cachedHrfcoStationInfoPromise
  }

  cachedHrfcoStationInfoApiKey = trimmedApiKey
  cachedHrfcoStationInfoPromise = (async () => {
    const url = `https://api.hrfco.go.kr/${encodeURIComponent(trimmedApiKey)}/waterlevel/info.xml`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`지점 정보 API 요청 실패 (${response.status})`)
    }

    const xmlText = await response.text()
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
    const nodes = doc.evaluate('//*[obsnm and wlobscd]', doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)

    const items = []
    for (let i = 0; i < nodes.snapshotLength; i += 1) {
      const node = nodes.snapshotItem(i)
      if (!node) continue

      const name = String(node.querySelector('obsnm')?.textContent || '').trim()
      const code = String(node.querySelector('wlobscd')?.textContent || '').trim()
      if (!name || !code) continue

      items.push({
        name,
        normName: normalizeHrfcoStationName(name),
        code
      })
    }

    cachedHrfcoStationInfoItems = items
    return items
  })()

  try {
    return await cachedHrfcoStationInfoPromise
  } finally {
    cachedHrfcoStationInfoPromise = null
  }
}

const findHrfcoStationCodeByName = async (apiKey, stationName) => {
  const targetName = String(stationName || '').trim()
  const targetNorm = normalizeHrfcoStationName(targetName)
  if (!targetNorm) {
    throw new Error('지점명이 비어 있습니다.')
  }

  const items = await loadHrfcoStationInfo(apiKey)
  if (items.length === 0) {
    throw new Error('지점 목록을 찾을 수 없습니다.')
  }

  const exact = items.find((item) => item.normName === targetNorm)
  if (exact) return exact.code

  const partial = items.find(
    (item) => item.normName.includes(targetNorm) || targetNorm.includes(item.normName)
  )
  if (partial) return partial.code

  let best = null
  let bestScore = Infinity
  for (const item of items) {
    const diff = Math.abs(item.normName.length - targetNorm.length)
    const overlap = item.normName.startsWith(targetNorm) || targetNorm.startsWith(item.normName)
    const score = diff + (overlap ? 0 : 20)
    if (score < bestScore) {
      bestScore = score
      best = item
    }
  }

  if (best) return best.code

  throw new Error(`지점명 "${targetName}"에 해당하는 코드를 찾지 못했습니다.`)
}

const extractHrfcoWaterLevelRowsFromXml = (xmlText, stationCode, stationName) => {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const xpathResult = doc.evaluate('//*[ymdhm and wl]', doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)

  const rows = []
  for (let i = 0; i < xpathResult.snapshotLength; i += 1) {
    const node = xpathResult.snapshotItem(i)
    if (!node) continue

    const ymdhm = String(node.querySelector('ymdhm')?.textContent || '').trim()
    let wl = String(node.querySelector('wl')?.textContent || '').trim()
    if (!ymdhm) continue
    if (wl === '-' || wl === '') continue

    wl = wl.replace(/,/g, '')
    const value = Number(wl)
    if (!Number.isFinite(value)) continue

    rows.push({
      ymdhm,
      value: roundTo(value, 2),
      stationCode,
      stationName
    })
  }

  rows.sort((a, b) => b.ymdhm.localeCompare(a.ymdhm))
  return rows
}

const fetchLatestHrfcoWaterLevel = async (apiKey, stationName, referenceTime = new Date()) => {
  const trimmedApiKey = String(apiKey || '').trim()
  const trimmedStationName = String(stationName || '').trim()
  const now = referenceTime instanceof Date && !Number.isNaN(referenceTime.getTime())
    ? new Date(referenceTime.getTime())
    : new Date()

  if (!trimmedApiKey) {
    throw new Error('API 키가 비어 있습니다.')
  }
  if (!trimmedStationName) {
    throw new Error('지점명이 비어 있습니다.')
  }

  const stationCode = await findHrfcoStationCodeByName(trimmedApiKey, trimmedStationName)
  // 10분 단위 API 특성상, 현재 시각이 1~9분이어도
  // 가장 최근의 완료된 10분 수위를 가져오도록 직전 10분 경계로 맞춘다.
  const endTime = alignToPreviousTenMinuteMark(now)

  // 버튼을 누른 시각과 무관하게, 최신 수위가 포함될 수 있도록 넓은 구간을 조회한다.
  const fallbackWindows = [720, 168, 72, 24, 6] // hours
  const rowMap = new Map()

  for (const hours of fallbackWindows) {
    const start = new Date(endTime.getTime() - hours * 60 * 60 * 1000)
    const url = `https://api.hrfco.go.kr/${encodeURIComponent(trimmedApiKey)}/waterlevel/list/10M/${encodeURIComponent(stationCode)}/${formatHrfcoDateTime(start)}/${formatHrfcoDateTime(endTime)}.xml`

    try {
      const response = await fetch(url)
      if (!response.ok) continue

      const xmlText = await response.text()
      const rows = extractHrfcoWaterLevelRowsFromXml(xmlText, stationCode, trimmedStationName)
      for (const row of rows) {
        if (!rowMap.has(row.ymdhm)) {
          rowMap.set(row.ymdhm, row)
        }
      }
    } catch {
      // 다음 범위로 계속 시도
    }
  }

  const sorted = Array.from(rowMap.values()).sort((a, b) => b.ymdhm.localeCompare(a.ymdhm))
  return {
    current: sorted[0] || null,
    previous: sorted[1] || null,
    stationCode,
    stationName: trimmedStationName
  }
}

const buildCurrentWaterEntries = (station, currentValue, previousValue) => {
  const historicalValues = (station.measurements || [])
    .map((measurement) => roundTo(measurement.h, 2))
    .filter((value) => value !== null)
    .sort((a, b) => a - b)

  const entries = historicalValues.map((value) => ({
    value,
    display: fmt(value, 2),
    isCurrent: false,
    exactMatch: false,
    trend: ''
  }))

  if (currentValue !== null && currentValue !== undefined) {
    const currentRounded = roundTo(currentValue, 2)
    if (currentRounded !== null) {
      const exactMatch = historicalValues.some((value) => value === currentRounded)
      let symbol = '-'
      if (previousValue !== null && previousValue !== undefined) {
        const prevRounded = roundTo(previousValue, 2)
        if (prevRounded !== null) {
          if (currentRounded > prevRounded) symbol = '▲'
          else if (currentRounded < prevRounded) symbol = '▼'
        }
      }

      entries.push({
        value: currentRounded,
        display: `${fmt(currentRounded, 2)} ${symbol}`,
        isCurrent: true,
        exactMatch,
        trend: symbol === '▲' ? 'up' : symbol === '▼' ? 'down' : 'same'
      })
    }
  }

  entries.sort((a, b) => {
    if (a.value !== b.value) return a.value - b.value
    if (a.isCurrent === b.isCurrent) return 0
    return a.isCurrent ? 1 : -1
  })

  return entries
}

function CopyableMatrixTable({
  headers,
  rows,
  tableClassName = 'spreadsheet',
  style,
  wrapperClassName = ''
}) {
  const [selection, setSelection] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const tableRef = useRef(null)

  const normalizeRange = (range) => {
    if (!range) return null
    return {
      startRow: Math.min(range.startRow, range.endRow),
      endRow: Math.max(range.startRow, range.endRow),
      startCol: Math.min(range.startCol, range.endCol),
      endCol: Math.max(range.startCol, range.endCol)
    }
  }

  const isSelected = (rowIndex, colIndex) => {
    const r = normalizeRange(selection)
    if (!r) return false
    return (
      rowIndex >= r.startRow &&
      rowIndex <= r.endRow &&
      colIndex >= r.startCol &&
      colIndex <= r.endCol
    )
  }

  const selectCell = (rowIndex, colIndex) => {
    setSelection({
      startRow: rowIndex,
      endRow: rowIndex,
      startCol: colIndex,
      endCol: colIndex
    })
  }

  const extendSelection = (rowIndex, colIndex) => {
    setSelection((prev) => {
      if (!prev) {
        return {
          startRow: rowIndex,
          endRow: rowIndex,
          startCol: colIndex,
          endCol: colIndex
        }
      }
      return {
        startRow: prev.startRow,
        endRow: rowIndex,
        startCol: prev.startCol,
        endCol: colIndex
      }
    })
  }

  const selectAll = () => {
    if (rows.length === 0 || headers.length === 0) return
    setSelection({
      startRow: 0,
      endRow: rows.length - 1,
      startCol: 0,
      endCol: headers.length - 1
    })
  }

  const clearSelection = () => {
    setSelection(null)
  }

  const copySelection = async () => {
    const r = normalizeRange(selection)
    if (!r) return

    const lines = []
    for (let rowIndex = r.startRow; rowIndex <= r.endRow; rowIndex += 1) {
      const row = rows[rowIndex] || []
      const cells = []
      for (let colIndex = r.startCol; colIndex <= r.endCol; colIndex += 1) {
        cells.push(String(row[colIndex] ?? ''))
      }
      lines.push(cells.join('\t'))
    }

    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const temp = document.createElement('textarea')
      temp.value = text
      document.body.appendChild(temp)
      temp.select()
      document.execCommand('copy')
      document.body.removeChild(temp)
    }
  }

  useEffect(() => {
    const stopDrag = () => setIsDragging(false)
    window.addEventListener('mouseup', stopDrag)
    return () => window.removeEventListener('mouseup', stopDrag)
  }, [])

  const handleKeyDown = async (e, rowIndex, colIndex) => {
    const isMod = e.ctrlKey || e.metaKey

    if (isMod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selectAll()
      return
    }

    if (isMod && e.key.toLowerCase() === 'c') {
      if (selection) {
        e.preventDefault()
        await copySelection()
      }
      return
    }

    if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      selection &&
      (selection.startRow !== selection.endRow || selection.startCol !== selection.endCol)
    ) {
      e.preventDefault()
      clearSelection()
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      const nextRow = Math.min(rowIndex + 1, rows.length - 1)
      const nextCell = tableRef.current?.querySelector(
        `[data-copy-cell="${nextRow}-${colIndex}"]`
      )
      if (nextCell) nextCell.focus()
    }
  }

  return (
    <div className={wrapperClassName}>
      <div className="grid-actions" style={{ justifyContent: 'flex-end', marginBottom: '8px' }}>
        <button className="btn secondary" onClick={selectAll}>
          전체 선택
        </button>
        <button className="btn secondary" onClick={copySelection}>
          선택 복사
        </button>
        <button className="btn secondary" onClick={clearSelection}>
          선택 해제
        </button>
      </div>

      <div
        className="table-wrap"
        ref={tableRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (selection) {
            const isMod = e.ctrlKey || e.metaKey
            if (isMod && e.key.toLowerCase() === 'c') {
              e.preventDefault()
              copySelection()
            }
            if (isMod && e.key.toLowerCase() === 'a') {
              e.preventDefault()
              selectAll()
            }
          }
        }}
      >
        <table className={tableClassName} style={style}>
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, colIndex) => (
                  <td
                    key={`${rowIndex}-${colIndex}`}
                    data-copy-cell={`${rowIndex}-${colIndex}`}
                    className={isSelected(rowIndex, colIndex) ? 'selected-cell' : ''}
                    onMouseDown={() => {
                      setIsDragging(true)
                      selectCell(rowIndex, colIndex)
                    }}
                    onMouseEnter={() => {
                      if (!isDragging) return
                      extendSelection(rowIndex, colIndex)
                    }}
                    onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                    tabIndex={0}
                  >
                    {cell ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SpreadsheetGrid({
  title,
  columns,
  rows,
  onRowsChange,
  createEmptyRow,
  onDeleteRow,
  addButtonLabel
}) {
  const [selection, setSelection] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const tableRef = useRef(null)
  const isCompactTable =
    title.includes('2. 곡선식 입력') || title.includes('3. 측정성과 입력')
  const tableClassName = [
    'spreadsheet',
    title.includes('2. 곡선식 입력')
      ? 'compact-table curve-table'
      : title.includes('3. 측정성과 입력')
        ? 'compact-table measurement-table'
        : title.includes('4. 수위별 환산유량표')
          ? 'flow-table'
          : ''
  ]
    .filter(Boolean)
    .join(' ')
  const tableStyle = {
    tableLayout: 'auto',
    width: 'max-content',
    minWidth: '100%'
  }

  const normalizeRange = (range) => {
    if (!range) return null
    return {
      startRow: Math.min(range.startRow, range.endRow),
      endRow: Math.max(range.startRow, range.endRow),
      startCol: Math.min(range.startCol, range.endCol),
      endCol: Math.max(range.startCol, range.endCol)
    }
  }

  const isSelected = (rowIndex, colIndex) => {
    const r = normalizeRange(selection)
    if (!r) return false
    return (
      rowIndex >= r.startRow &&
      rowIndex <= r.endRow &&
      colIndex >= r.startCol &&
      colIndex <= r.endCol
    )
  }

  const selectCell = (rowIndex, colIndex) => {
    setSelection({
      startRow: rowIndex,
      endRow: rowIndex,
      startCol: colIndex,
      endCol: colIndex
    })
  }

  const extendSelection = (rowIndex, colIndex) => {
    setSelection((prev) => {
      if (!prev) {
        return {
          startRow: rowIndex,
          endRow: rowIndex,
          startCol: colIndex,
          endCol: colIndex
        }
      }
      return {
        startRow: prev.startRow,
        endRow: rowIndex,
        startCol: prev.startCol,
        endCol: colIndex
      }
    })
  }

  const selectAll = () => {
    if (rows.length === 0 || columns.length === 0) return
    setSelection({
      startRow: 0,
      endRow: rows.length - 1,
      startCol: 0,
      endCol: columns.length - 1
    })
  }

  const clearSelection = () => {
    const r = normalizeRange(selection)
    if (!r) return

    const next = rows.map((row) => ({ ...row }))
    for (let rowIndex = r.startRow; rowIndex <= r.endRow; rowIndex += 1) {
      if (!next[rowIndex]) continue
      for (let colIndex = r.startCol; colIndex <= r.endCol; colIndex += 1) {
        const col = columns[colIndex]
        if (!col) continue
        next[rowIndex] = {
          ...next[rowIndex],
          [col.key]: ''
        }
      }
    }
    onRowsChange(next)
  }

const copySelection = async () => {
  const r = normalizeRange(selection)
  if (!r) return

  const lines = []
  for (let rowIndex = r.startRow; rowIndex <= r.endRow; rowIndex += 1) {
    const row = rows[rowIndex] || {}
    const cells = []
    for (let colIndex = r.startCol; colIndex <= r.endCol; colIndex += 1) {
      const col = columns[colIndex]
      if (!col) continue
      cells.push(String(row[col.key] ?? ''))
    }
    lines.push(cells.join('\t'))
  }

  const text = lines.join('\n')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const temp = document.createElement('textarea')
    temp.value = text
    document.body.appendChild(temp)
    temp.select()
    document.execCommand('copy')
    document.body.removeChild(temp)
  }
}

const pasteText = (text, rowIndex, colIndex) => {
  const lines = text.replace(/\r/g, '').split('\n')
  const matrix = lines
    .map((line) => line.split('\t'))
    .filter((line) => line.some((cell) => cell !== ''))

  if (matrix.length === 0) return

  const next = rows.map((r) => ({ ...r }))
  while (next.length < rowIndex + matrix.length) {
    next.push(createEmptyRow())
  }

  matrix.forEach((line, rOffset) => {
    const targetRow = rowIndex + rOffset
    if (!next[targetRow]) return

    line.forEach((cell, cOffset) => {
      const targetCol = colIndex + cOffset
      if (!columns[targetCol]) return
      const key = columns[targetCol].key
      next[targetRow] = {
        ...next[targetRow],
        [key]: cell
      }
    })
  })

  onRowsChange(next)
}

  const setCell = (rowIndex, key, value) => {
    const next = rows.map((r, idx) => (idx === rowIndex ? { ...r, [key]: value } : r))
    onRowsChange(next)
  }

  useEffect(() => {
    const stopDrag = () => setIsDragging(false)
    window.addEventListener('mouseup', stopDrag)
    return () => window.removeEventListener('mouseup', stopDrag)
  }, [])

  const handleKeyDown = async (e, rowIndex, colIndex) => {
    const isMod = e.ctrlKey || e.metaKey

    if (isMod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selectAll()
      return
    }

    if (isMod && e.key.toLowerCase() === 'c') {
      if (selection) {
        e.preventDefault()
        await copySelection()
      }
      return
    }

    if (
  (e.key === 'Delete' || e.key === 'Backspace') &&
  selection &&
  (
    selection.startRow !== selection.endRow ||
    selection.startCol !== selection.endCol
  )
) {
  e.preventDefault()
  clearSelection()
  return
}

    if (e.key === 'Enter') {
      e.preventDefault()
      const nextRow = Math.min(rowIndex + 1, rows.length - 1)
      const nextInput = tableRef.current?.querySelector(
        `[data-cell="${nextRow}-${colIndex}"]`
      )
      if (nextInput) nextInput.focus()
    }
  }

  const handleMouseDown = (rowIndex, colIndex) => {
    setIsDragging(true)
    selectCell(rowIndex, colIndex)
  }

  const handleMouseEnter = (rowIndex, colIndex) => {
    if (!isDragging) return
    extendSelection(rowIndex, colIndex)
  }

  const handlePaste = (event, rowIndex, colIndex) => {
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    pasteText(text, rowIndex, colIndex)
  }

  return (
    <>
      <div className="section-header">
        <h2>{title}</h2>
        <div className="grid-actions">
          <button className="btn secondary" onClick={selectAll}>
            전체 선택
          </button>
          <button className="btn secondary" onClick={copySelection}>
            선택 복사
          </button>
          <button className="btn secondary" onClick={clearSelection}>
            선택 삭제
          </button>
          <button className="btn" onClick={addButtonLabel.onClick}>
            {addButtonLabel.label}
          </button>
        </div>
      </div>

      <div className="table-wrap" ref={tableRef}>
        <table className={tableClassName} style={tableStyle}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.id}>
                {columns.map((col, colIndex) => (
                  <td
                    key={col.key}
                    className={isSelected(rowIndex, colIndex) ? 'selected-cell' : ''}
                    onMouseDown={() => handleMouseDown(rowIndex, colIndex)}
                    onMouseEnter={() => handleMouseEnter(rowIndex, colIndex)}
                  >
                    <input
                      className="cell-input"
                      style={{ minWidth: isCompactTable ? '72px' : '78px' }}
                      data-cell={`${rowIndex}-${colIndex}`}
                      type={col.type || 'text'}
                      value={row[col.key] ?? ''}
                      onFocus={() => selectCell(rowIndex, colIndex)}
                      onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                      onChange={(e) => setCell(rowIndex, col.key, e.target.value)}
                      onPaste={(e) => handlePaste(e, rowIndex, colIndex)}
                    />
                  </td>
                ))}
                <td className="delete-cell">
                  <button className="btn danger" onClick={() => onDeleteRow(row.id)}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}




function ProcessPlanMatrix({ stationRows, monthLabels, onUpdateStation }) {
  const [selection, setSelection] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [showPlanMonths, setShowPlanMonths] = useState(true)
  const tableRef = useRef(null)

  const tableStyle = {
    width: 'max-content',
    minWidth: '100%',
    tableLayout: 'auto'
  }

  const monthCellStyle = {
    padding: '4px 4px',
    whiteSpace: 'nowrap',
    width: '46px',
    minWidth: '46px',
    maxWidth: '46px',
    textAlign: 'center',
    overflow: 'visible',
    textOverflow: 'clip',
    fontSize: '12px'
  }

  const leftCellStyle = {
    padding: '4px 6px',
    whiteSpace: 'nowrap',
    width: '1%',
    minWidth: '1%',
    textAlign: 'center'
  }

  const stationNameCellStyle = {
    ...leftCellStyle,
    textAlign: 'left'
  }

  const inputStyle = {
    width: '100%',
    minWidth: '46px',
    height: '30px',
    padding: '0 2px',
    textAlign: 'center',
    boxSizing: 'border-box',
    fontSize: '12px'
  }

  const normalizeRange = (range) => {
    if (!range) return null
    return {
      startRow: Math.min(range.startRow, range.endRow),
      endRow: Math.max(range.startRow, range.endRow),
      startCol: Math.min(range.startCol, range.endCol),
      endCol: Math.max(range.startCol, range.endCol)
    }
  }

  const isSelected = (rowIndex, colIndex) => {
    const r = normalizeRange(selection)
    if (!r) return false
    return (
      rowIndex >= r.startRow &&
      rowIndex <= r.endRow &&
      colIndex >= r.startCol &&
      colIndex <= r.endCol
    )
  }

  const selectCell = (rowIndex, colIndex) => {
    setSelection({
      startRow: rowIndex,
      endRow: rowIndex,
      startCol: colIndex,
      endCol: colIndex
    })
  }

  const extendSelection = (rowIndex, colIndex) => {
    setSelection((prev) => {
      if (!prev) {
        return {
          startRow: rowIndex,
          endRow: rowIndex,
          startCol: colIndex,
          endCol: colIndex
        }
      }
      return {
        startRow: prev.startRow,
        endRow: rowIndex,
        startCol: prev.startCol,
        endCol: colIndex
      }
    })
  }

  const selectAll = () => {
    if (stationRows.length === 0) return
    setSelection({
      startRow: 0,
      endRow: stationRows.length - 1,
      startCol: 0,
      endCol: 17
    })
  }

  const getVisibleCellsForCopy = (row) => {
    return [
      row.station.classification || '일반 지점',
      row.station.groupName || '',
      row.station.code || '',
      row.station.name || '',
      fmt(row.planTotal, 0),
      ...row.actualValues.map((v) => (v ? String(v) : '')),
      fmt(row.actualTotal, 0)
    ]
  }

  const clearSelection = () => {
    if (showPlanMonths) return
    return
  }

  const copySelection = async () => {
    const r = normalizeRange(selection)
    if (!r) return

    const lines = []
    for (let rowIndex = r.startRow; rowIndex <= r.endRow; rowIndex += 1) {
      const row = stationRows[rowIndex]
      if (!row) continue

      const cells = getVisibleCellsForCopy(row)
      const selectedCells = []
      for (let colIndex = r.startCol; colIndex <= r.endCol; colIndex += 1) {
        selectedCells.push(String(cells[colIndex] ?? ''))
      }
      lines.push(selectedCells.join('\t'))
    }

    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const temp = document.createElement('textarea')
      temp.value = text
      document.body.appendChild(temp)
      temp.select()
      document.execCommand('copy')
      document.body.removeChild(temp)
    }
  }

  const pasteText = (text, rowIndex, colIndex) => {
    const lines = text.replace(/\r/g, '').split('\n')
    const matrix = lines
      .map((line) => line.split('\t'))
      .filter((line) => line.some((cell) => cell !== ''))

    if (matrix.length === 0) return

    matrix.forEach((line, rOffset) => {
      const targetRow = rowIndex + rOffset
      const row = stationRows[targetRow]
      if (!row) return

      const nextPlan = Array.from(
        { length: 12 },
        (_, idx) => String(row.station.processPlan?.[idx] ?? '')
      )
      line.forEach((cell, cOffset) => {
        const targetCol = colIndex + cOffset
        if (targetCol < 0 || targetCol >= 12) return
        nextPlan[targetCol] = cell
      })
      updateProcessPlanRow(row.station.id, nextPlan)
    })
  }

  const updateProcessPlan = (stationId, monthIndex, value) => {
    const nextValue = String(value)
    const target = stationRows.find((row) => row.station.id === stationId)
    const currentPlan = Array.isArray(target?.station?.processPlan)
      ? target.station.processPlan
      : Array.from({ length: 12 }, () => '')
    const nextPlan = currentPlan.slice(0, 12)
    nextPlan[monthIndex] = nextValue
    onUpdateStation(stationId, { processPlan: nextPlan })
  }

  const updateProcessPlanRow = (stationId, nextPlan) => {
    const normalized = Array.from({ length: 12 }, (_, idx) => String(nextPlan?.[idx] ?? ''))
    onUpdateStation(stationId, { processPlan: normalized })
  }

  const handleKeyDown = async (e, rowIndex, colIndex) => {
    if (!showPlanMonths) {
      const isMod = e.ctrlKey || e.metaKey

      if (isMod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        selectAll()
        return
      }

      if (isMod && e.key.toLowerCase() === 'c') {
        if (selection) {
          e.preventDefault()
          await copySelection()
        }
        return
      }

      return
    }

    const isMod = e.ctrlKey || e.metaKey

    if (isMod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selectAll()
      return
    }

    if (isMod && e.key.toLowerCase() === 'c') {
      if (selection) {
        e.preventDefault()
        await copySelection()
      }
      return
    }

    if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      selection &&
      (selection.startRow !== selection.endRow || selection.startCol !== selection.endCol)
    ) {
      e.preventDefault()
      clearSelection()
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      const nextRow = Math.min(rowIndex + 1, stationRows.length - 1)
      const nextInput = tableRef.current?.querySelector(`[data-plan-cell="${nextRow}-${colIndex}"]`)
      if (nextInput) nextInput.focus()
    }
  }

  const handlePaste = (event, rowIndex, colIndex) => {
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    pasteText(text, rowIndex, colIndex)
  }

  useEffect(() => {
    const stopDrag = () => setIsDragging(false)
    window.addEventListener('mouseup', stopDrag)
    return () => window.removeEventListener('mouseup', stopDrag)
  }, [])

  const visibleHeaders = [
    '분류',
    '그룹',
    '지점 코드',
    '지점명',
    '측정 계획',
    ...monthLabels,
    '총'
  ]

  const hiddenRows = useMemo(() => {
    return stationRows.map((row) => ({
      id: row.station.id,
      cells: getVisibleCellsForCopy(row)
    }))
  }, [stationRows])

  return (
    <section className="card">
      <div className="section-header">
        <h2>지점별 측정 계획 / 실적</h2>
        <div className="grid-actions">
          <button className="btn secondary" onClick={selectAll} disabled={showPlanMonths}>
            전체 선택
          </button>
          <button className="btn secondary" onClick={copySelection} disabled={showPlanMonths}>
            선택 복사
          </button>
          <button className="btn secondary" onClick={clearSelection} disabled={showPlanMonths}>
            선택 삭제
          </button>
          <button
            className="btn secondary"
            onClick={() => setShowPlanMonths((prev) => !prev)}
          >
            {showPlanMonths ? '측정 계획 숨기기' : '측정 계획 펼치기'}
          </button>
        </div>
      </div>

      <div
        className="table-wrap"
        ref={tableRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!showPlanMonths && selection) {
            const isMod = e.ctrlKey || e.metaKey
            if (isMod && e.key.toLowerCase() === 'c') {
              e.preventDefault()
              copySelection()
            }
            if (isMod && e.key.toLowerCase() === 'a') {
              e.preventDefault()
              selectAll()
            }
          }
        }}
      >
        {showPlanMonths ? (
          <table className="spreadsheet" style={tableStyle}>
            <thead>
              <tr>
                <th rowSpan={2} style={leftCellStyle}>분류</th>
                <th rowSpan={2} style={leftCellStyle}>그룹</th>
                <th rowSpan={2} style={leftCellStyle}>지점 코드</th>
                <th rowSpan={2} style={stationNameCellStyle}>지점명</th>
                <th colSpan={13}>측정 계획</th>
                <th colSpan={13}>유량측정 실적</th>
              </tr>
              <tr>
                {monthLabels.map((label) => (
                  <th key={`detail-plan-${label}`} style={monthCellStyle}>
                    {label}
                  </th>
                ))}
                <th style={monthCellStyle}>총</th>
                {monthLabels.map((label) => (
                  <th key={`detail-actual-${label}`} style={monthCellStyle}>
                    {label}
                  </th>
                ))}
                <th style={monthCellStyle}>총</th>
              </tr>
            </thead>
            <tbody>
              {stationRows.map(({ station, planValues, actualValues, planTotal, actualTotal }, rowIndex) => (
                <tr key={station.id}>
                  <td style={leftCellStyle}>{station.classification || '일반 지점'}</td>
                  <td style={leftCellStyle}>{station.groupName}</td>
                  <td style={leftCellStyle}>{station.code || ''}</td>
                  <td style={stationNameCellStyle}>{station.name || ''}</td>

                  {monthLabels.map((_, colIndex) => (
                    <td
                      key={`plan-${station.id}-${colIndex}`}
                      style={monthCellStyle}
                      className={isSelected(rowIndex, colIndex) ? 'selected-cell' : ''}
                      onMouseDown={() => {
                        setIsDragging(true)
                        selectCell(rowIndex, colIndex)
                      }}
                      onMouseEnter={() => {
                        if (!isDragging) return
                        extendSelection(rowIndex, colIndex)
                      }}
                    >
                      <input
                        className="cell-input"
                        style={inputStyle}
                        data-plan-cell={`${rowIndex}-${colIndex}`}
                        type="number"
                        min="0"
                        step="1"
                        value={station.processPlan?.[colIndex] ?? ''}
                        onFocus={() => selectCell(rowIndex, colIndex)}
                        onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                        onChange={(e) => updateProcessPlan(station.id, colIndex, e.target.value)}
                        onPaste={(e) => handlePaste(e, rowIndex, colIndex)}
                      />
                    </td>
                  ))}

                  <td style={monthCellStyle}>{fmt(planTotal, 0)}</td>

                  {monthLabels.map((_, idx) => (
                    <td key={`actual-${station.id}-${idx}`} style={monthCellStyle}>
                      {actualValues[idx] || ''}
                    </td>
                  ))}

                  <td style={monthCellStyle}>{fmt(actualTotal, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="spreadsheet plan-matrix-table" style={tableStyle}>
            <thead>
              <tr>
                {visibleHeaders.map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hiddenRows.map((row, rowIndex) => (
                <tr key={row.id}>
                  {row.cells.map((cell, colIndex) => (
                    <td
                      key={`${row.id}-${colIndex}`}
                      className={isSelected(rowIndex, colIndex) ? 'selected-cell' : ''}
                      onMouseDown={() => {
                        setIsDragging(true)
                        selectCell(rowIndex, colIndex)
                        tableRef.current?.focus()
                      }}
                      onMouseEnter={() => {
                        if (!isDragging) return
                        extendSelection(rowIndex, colIndex)
                      }}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

function ProcessRatePage({ groups, onUpdateStation }) {
  const currentYear = new Date().getFullYear()
  const [classificationFilter, setClassificationFilter] = useState('전체')
  const [groupFilter, setGroupFilter] = useState('전체')
  const [stationFilter, setStationFilter] = useState('전체')

  const monthLabels = useMemo(
    () => Array.from({ length: 12 }, (_, idx) => `${idx + 1}월`),
    []
  )

  const toNumber = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }

  const sum = (values) => values.reduce((acc, value) => acc + toNumber(value), 0)

  const groupOptions = useMemo(
    () => ['전체', ...groups.map((group) => group.name || '그룹 없음')],
    [groups]
  )

  const stationOptions = useMemo(() => {
    const flattened = groups.flatMap((group, groupIndex) => {
      if (groupFilter !== '전체' && (group.name || '그룹 없음') !== groupFilter) return []
      return (group.stations || []).map((station, stationIndex) => ({
        id: station.id,
        label: `${group.name || '그룹 없음'} / ${station.name || '지점 없음'}`,
        groupId: group.id,
        groupName: group.name || '그룹 없음',
        groupIndex,
        stationIndex
      }))
    })

    return ['전체', ...flattened]
  }, [groups, groupFilter])

  useEffect(() => {
    if (stationFilter === '전체') return
    const exists = stationOptions.some((option) => option !== '전체' && option.id === stationFilter)
    if (!exists) setStationFilter('전체')
  }, [stationOptions, stationFilter])

  const filteredStations = useMemo(() => {
    const flattened = groups.flatMap((group, groupIndex) =>
      (group.stations || []).map((station, stationIndex) => ({
        ...station,
        groupId: group.id,
        groupName: group.name || '그룹 없음',
        groupIndex,
        stationIndex
      }))
    )

    return flattened
      .filter((station) => groupFilter === '전체' || station.groupName === groupFilter)
      .filter((station) => {
        const classification = station.classification || '일반 지점'
        return classificationFilter === '전체' || classification === classificationFilter
      })
      .filter((station) => stationFilter === '전체' || station.id === stationFilter)
      .sort((a, b) => {
        if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex
        return a.stationIndex - b.stationIndex
      })
  }, [groups, groupFilter, classificationFilter, stationFilter])

  const stationRows = useMemo(() => {
    return filteredStations.map((station) => {
      const planValues = Array.from({ length: 12 }, (_, idx) => toNumber(station.processPlan?.[idx]))
      const actualValues = Array.from({ length: 12 }, () => 0)

      ;(station.measurements || []).forEach((measurement) => {
        const d = parseDateTime(measurement.datetime)
        if (!d || d.getFullYear() !== currentYear) return
        actualValues[d.getMonth()] += 1
      })

      const monthlyRates = planValues.map((plan, idx) =>
        plan > 0 ? (actualValues[idx] / plan) * 100 : null
      )
      const cumulativeRates = planValues.map((_, idx) => {
        const planSum = sum(planValues.slice(0, idx + 1))
        const actualSum = sum(actualValues.slice(0, idx + 1))
        return planSum > 0 ? (actualSum / planSum) * 100 : null
      })

      return {
        station,
        planValues,
        actualValues,
        monthlyRates,
        cumulativeRates,
        planTotal: sum(planValues),
        actualTotal: sum(actualValues)
      }
    })
  }, [filteredStations, currentYear])

const summary = useMemo(() => {
  const planTotals = Array.from({ length: 12 }, () => 0)
  const actualTotals = Array.from({ length: 12 }, () => 0)

  stationRows.forEach((row) => {
    row.planValues.forEach((value, idx) => {
      planTotals[idx] += toNumber(value)
    })
    row.actualValues.forEach((value, idx) => {
      actualTotals[idx] += toNumber(value)
    })
  })

  const cumulativePlanTotals = planTotals.map((_, idx) =>
    sum(planTotals.slice(0, idx + 1))
  )
  const cumulativeActualTotals = actualTotals.map((_, idx) =>
    sum(actualTotals.slice(0, idx + 1))
  )

  const monthlyRates = planTotals.map((plan, idx) =>
    plan > 0 ? (actualTotals[idx] / plan) * 100 : null
  )

  const cumulativeRates = planTotals.map((_, idx) => {
    const planSum = sum(planTotals.slice(0, idx + 1))
    const actualSum = sum(actualTotals.slice(0, idx + 1))
    return planSum > 0 ? (actualSum / planSum) * 100 : null
  })

  return {
    planTotals,
    actualTotals,
    cumulativePlanTotals,
    cumulativeActualTotals,
    monthlyRates,
    cumulativeRates,
    planGrandTotal: sum(planTotals),
    actualGrandTotal: sum(actualTotals),
    cumulativePlanGrandTotal: sum(planTotals),
    cumulativeActualGrandTotal: sum(actualTotals)
  }
}, [stationRows])

  const updateProcessPlan = (stationId, monthIndex, value) => {
    const nextValue = String(value)
    const target = filteredStations.find((station) => station.id === stationId)
    const currentPlan = Array.isArray(target?.processPlan)
      ? target.processPlan
      : Array.from({ length: 12 }, () => '')
    const nextPlan = currentPlan.slice(0, 12)
    nextPlan[monthIndex] = nextValue
    onUpdateStation(stationId, { processPlan: nextPlan })
  }

  const renderMonthCells = (values, options = {}) =>
    values.map((value, idx) => {
      const isPercent = Boolean(options.percent)
      const text =
        value === null || value === undefined
          ? ''
          : isPercent
            ? `${fmt(value, 1)}%`
            : fmt(value, 0)
      return <td key={idx}>{text}</td>
    })

  const renderGrandTotal = (value, options = {}) => {
    if (value === null || value === undefined) return ''
    return options.percent ? `${fmt(value, 1)}%` : fmt(value, 0)
  }

  return (
    <div>
      <section className="card">
        <h2>측정성과 공정률</h2>
        <div className="row">
  <label>
    그룹
    <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
      {groupOptions.map((groupName) => (
        <option key={groupName} value={groupName}>
          {groupName}
        </option>
      ))}
    </select>
  </label>

  <label>
    분류
    <select value={classificationFilter} onChange={(e) => setClassificationFilter(e.target.value)}>
      <option value="전체">전체</option>
      <option value="자동유량">자동유량</option>
      <option value="일반 지점">일반 지점</option>
    </select>
  </label>

  <label>
    지점
    <select value={stationFilter} onChange={(e) => setStationFilter(e.target.value)}>
      {stationOptions.map((stationOption) =>
        stationOption === '전체' ? (
          <option key="전체" value="전체">전체</option>
        ) : (
          <option key={stationOption.id} value={stationOption.id}>
            {stationOption.label}
          </option>
        )
      )}
    </select>
  </label>

  <div className="muted" style={{ alignSelf: 'end' }}>
    기준 연도: {currentYear}년
  </div>
</div>
      </section>

      <section className="card">
        <h2>측정성과 공정률 요약</h2>
        <CopyableMatrixTable
            headers={['구분', ...monthLabels, '총']}
            rows={[
              ['측정 계획', ...summary.planTotals.map((v) => fmt(v, 0)), renderGrandTotal(summary.planGrandTotal)],
              ['유량측정 실적', ...summary.actualTotals.map((v) => fmt(v, 0)), renderGrandTotal(summary.actualGrandTotal)],
              ['누적측정 계획', ...summary.cumulativePlanTotals.map((v) => fmt(v, 0)), renderGrandTotal(summary.cumulativePlanGrandTotal)],
              ['누적측정 실적', ...summary.cumulativeActualTotals.map((v) => fmt(v, 0)), renderGrandTotal(summary.cumulativeActualGrandTotal)],
              ['월별 공정률', ...summary.monthlyRates.map((v) => (v === null ? '' : `${fmt(v, 1)}%`)), renderGrandTotal(summary.monthlyRates[11] ?? null, { percent: true })],
              ['누적 공정률', ...summary.cumulativeRates.map((v) => (v === null ? '' : `${fmt(v, 1)}%`)), renderGrandTotal(summary.cumulativeRates[11] ?? null, { percent: true })]
            ]}
            tableClassName="spreadsheet"
            style={{ width: 'max-content', minWidth: '100%' }}
          />
      </section>
      <ProcessPlanMatrix stationRows={stationRows} monthLabels={monthLabels} onUpdateStation={onUpdateStation} />
    </div>
  )
}


function CurrentWaterLevelPage({ groups, hrfcoApiKey, onHrfcoApiKeyChange }) {
  const [classificationFilter, setClassificationFilter] = useState('전체')
  const [groupFilter, setGroupFilter] = useState('전체')
  const [stationFilter, setStationFilter] = useState('전체')
  const [currentWaterResults, setCurrentWaterResults] = useState({})
  const [isFetching, setIsFetching] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const topScrollRef = useRef(null)
  const bodyScrollRef = useRef(null)
  const [scrollContentWidth, setScrollContentWidth] = useState(0)

  const groupOptions = useMemo(
    () => ['전체', ...groups.map((group) => group.name || '그룹 없음')],
    [groups]
  )

  const stationOptions = useMemo(() => {
    const flattened = groups.flatMap((group, groupIndex) => {
      if (groupFilter !== '전체' && (group.name || '그룹 없음') !== groupFilter) return []
      return (group.stations || []).map((station, stationIndex) => ({
        id: station.id,
        label: `${group.name || '그룹 없음'} / ${station.name || '지점 없음'}`,
        groupId: group.id,
        groupName: group.name || '그룹 없음',
        groupIndex,
        stationIndex
      }))
    })

    return ['전체', ...flattened]
  }, [groups, groupFilter])

  useEffect(() => {
    if (stationFilter === '전체') return
    const exists = stationOptions.some((option) => option !== '전체' && option.id === stationFilter)
    if (!exists) setStationFilter('전체')
  }, [stationOptions, stationFilter])

  const filteredStations = useMemo(() => {
    const flattened = groups.flatMap((group, groupIndex) =>
      (group.stations || []).map((station, stationIndex) => ({
        ...station,
        groupId: group.id,
        groupName: group.name || '그룹 없음',
        groupIndex,
        stationIndex
      }))
    )

    return flattened
      .filter((station) => groupFilter === '전체' || station.groupName === groupFilter)
      .filter((station) => {
        const classification = station.classification || '일반 지점'
        return classificationFilter === '전체' || classification === classificationFilter
      })
      .filter((station) => stationFilter === '전체' || station.id === stationFilter)
      .sort((a, b) => {
        if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex
        return a.stationIndex - b.stationIndex
      })
  }, [groups, groupFilter, classificationFilter, stationFilter])

  const stationColumns = useMemo(() => {
    return filteredStations.map((station) => {
      const result = currentWaterResults[station.id] || {}
      return {
        station,
        currentWater: result.currentWater ?? null,
        currentTime: result.currentTime || '',
        error: result.error || '',
        entries: buildCurrentWaterEntries(station, result.currentWater, result.previousWater)
      }
    })
  }, [filteredStations, currentWaterResults])

  const maxRows = useMemo(() => {
    return stationColumns.reduce((max, col) => Math.max(max, col.entries.length), 0)
  }, [stationColumns])

  useEffect(() => {
    const measure = () => {
      const body = bodyScrollRef.current
      if (!body) return
      setScrollContentWidth(body.scrollWidth || body.clientWidth || 0)
    }

    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [stationColumns, maxRows])

  useEffect(() => {
    const top = topScrollRef.current
    const body = bodyScrollRef.current
    if (!top || !body) return

    let syncing = false

    const syncTop = () => {
      if (syncing) return
      syncing = true
      top.scrollLeft = body.scrollLeft
      syncing = false
    }

    const syncBody = () => {
      if (syncing) return
      syncing = true
      body.scrollLeft = top.scrollLeft
      syncing = false
    }

    top.addEventListener('scroll', syncBody)
    body.addEventListener('scroll', syncTop)

    return () => {
      top.removeEventListener('scroll', syncBody)
      body.removeEventListener('scroll', syncTop)
    }
  }, [stationColumns, maxRows, scrollContentWidth])

  const handleFetchCurrentWater = async () => {
    const apiKey = String(hrfcoApiKey || '').trim()
    if (!apiKey) {
      window.alert('API 키를 입력해 주세요.')
      return
    }
    if (filteredStations.length === 0) {
      window.alert('선택된 지점이 없습니다.')
      return
    }

    setIsFetching(true)
    setStatusMessage('현재 수위를 조회하는 중입니다...')

    try {
      const results = []
      for (const station of filteredStations) {
        const stationName = String(station.name || '').trim()
        const previous = currentWaterResults[station.id] || { currentWater: null, currentTime: '', previousWater: null, previousTime: '', error: '' }

        if (!stationName) {
          results.push([station.id, { ...previous, error: '지점명 없음' }])
          continue
        }

        try {
          const latest = await fetchLatestHrfcoWaterLevel(apiKey, stationName)
          if (latest && latest.current && latest.current.value !== null && latest.current.value !== undefined) {
            results.push([station.id, {
              currentWater: latest.current.value,
              currentTime: latest.current.ymdhm,
              previousWater: latest.previous?.value ?? null,
              previousTime: latest.previous?.ymdhm ?? '',
              error: ''
            }])
          } else {
            results.push([station.id, {
              ...previous,
              error: '최근 수위를 찾지 못했습니다.'
            }])
          }
        } catch (error) {
          results.push([station.id, {
            ...previous,
            error: error instanceof Error ? error.message : '조회 실패'
          }])
        }
      }

      setCurrentWaterResults((prev) => ({
        ...prev,
        ...Object.fromEntries(results)
      }))
      setStatusMessage('현재 수위 조회가 완료되었습니다.')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '현재 수위 조회 실패')
    } finally {
      setIsFetching(false)
    }
  }

  return (
    <div>
      <section className="card">
        <h2>계기수위-측정성과</h2>
        <div className="row">
          <label>
            그룹
            <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              {groupOptions.map((groupName) => (
                <option key={groupName} value={groupName}>
                  {groupName}
                </option>
              ))}
            </select>
          </label>

          <label>
            분류
            <select value={classificationFilter} onChange={(e) => setClassificationFilter(e.target.value)}>
              <option value="전체">전체</option>
              <option value="자동유량">자동유량</option>
              <option value="일반 지점">일반 지점</option>
            </select>
          </label>

          <label>
            지점
            <select value={stationFilter} onChange={(e) => setStationFilter(e.target.value)}>
              {stationOptions.map((stationOption) =>
                stationOption === '전체' ? (
                  <option key="전체" value="전체">전체</option>
                ) : (
                  <option key={stationOption.id} value={stationOption.id}>
                    {stationOption.label}
                  </option>
                )
              )}
            </select>
          </label>

          <label>
            API 키
            <input
              type="text"
              value={hrfcoApiKey}
              onChange={(e) => onHrfcoApiKeyChange(e.target.value)}
              placeholder="HRFCO API 키"
            />
          </label>

          <div className="grid-actions" style={{ alignSelf: 'end' }}>
            <button className="btn" onClick={handleFetchCurrentWater} disabled={isFetching}>
              {isFetching ? '조회 중...' : '현재 수위'}
            </button>
          </div>
        </div>

        <div className="muted" style={{ marginTop: '8px' }}>
          선택된 지점 수: {filteredStations.length}개
        </div>
        {statusMessage ? (
          <div className="muted" style={{ marginTop: '4px' }}>
            {statusMessage}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>지점별 현재 수위</h2>
        {stationColumns.length === 0 ? (
          <div className="muted">선택된 지점이 없습니다.</div>
        ) : (
          <>
            <div
              ref={topScrollRef}
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 4,
                backgroundColor: '#fff',
                overflowX: 'auto',
                overflowY: 'hidden',
                height: '16px',
                marginBottom: '8px'
              }}
            >
              <div
                style={{
                  width: `${Math.max(scrollContentWidth, stationColumns.length * 120)}px`,
                  height: '1px'
                }}
              />
            </div>

            <div ref={bodyScrollRef} className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="spreadsheet" style={{ tableLayout: 'auto', width: 'max-content' }}>
                <thead>
                  <tr>
                    {stationColumns.map((col) => (
                      <th
                        key={col.station.id}
                        style={{
                          position: 'sticky',
                          top: '16px',
                          zIndex: 3,
                          backgroundColor: '#eef4ff',
                          width: 'auto',
                          minWidth: '72px',
                          maxWidth: '96px',
                          padding: '4px 4px',
                          whiteSpace: 'normal',
                          wordBreak: 'break-word',
                          lineHeight: '1.2'
                        }}
                      >
                        <div>{col.station.name || '지점 없음'}</div>
                        <div className="muted" style={{ fontSize: '12px' }}>
                          {col.station.code || '코드 없음'}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: maxRows }).map((_, rowIndex) => (
                    <tr key={rowIndex}>
                      {stationColumns.map((col) => {
                        const entry = col.entries[rowIndex]
                        const isCurrent = Boolean(entry?.isCurrent)
                        const bg = isCurrent
                          ? (entry.exactMatch ? '#bfefff' : '#ff6b6b')
                          : undefined
                        const fg = isCurrent && !entry.exactMatch ? '#ffffff' : undefined
                        return (
                          <td
                            key={`${col.station.id}-${rowIndex}`}
                            style={{
                              textAlign: 'center',
                              width: 'auto',
                              minWidth: '64px',
                              maxWidth: '110px',
                              padding: '4px 4px',
                              whiteSpace: 'nowrap',
                              backgroundColor: bg,
                              color: fg,
                              fontWeight: isCurrent ? 700 : 400
                            }}
                          >
                            {entry ? entry.display : ''}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="muted" style={{ marginTop: '8px' }}>
          현재 수위가 기존 측정성과 값과 같으면 하늘색, 다르면 빨간색으로 표시됩니다.
        </p>
      </section>
    </div>
  )
}


export default function App() {
  const APP_STATE_ID = 'main'

  const [groups, setGroups] = useState(() => DEFAULT_GROUPS)
  const [stationsLoaded, setStationsLoaded] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState(() => DEFAULT_GROUPS[0].id)
  const [selectedStationId, setSelectedStationId] = useState(() => DEFAULT_GROUPS[0].stations[0].id)
  const [measurementYearFilter, setMeasurementYearFilter] = useState('전체')
  const [relativeErrorYearFilter, setRelativeErrorYearFilter] = useState('전체')
  const [relativeErrorSort, setRelativeErrorSort] = useState('기본')
  const [activeTab, setActiveTab] = useState('management')
  const [hrfcoApiKey, setHrfcoApiKey] = useState(() => localStorage.getItem(HRFCO_API_KEY_STORAGE_KEY) || '')

  useEffect(() => {
    const loadAppState = async () => {
      const { data, error } = await supabase
        .from('app_state')
        .select('payload')
        .eq('id', APP_STATE_ID)
        .maybeSingle()

      if (error) {
        console.error('loadStations error:', error)
        setStationsLoaded(true)
        return
      }

      const loadedGroups = data?.payload?.groups
      const loadedStations = data?.payload?.stations

      if (Array.isArray(loadedGroups) && loadedGroups.length > 0) {
        setGroups(normalizeGroups(loadedGroups))
      } else if (Array.isArray(loadedStations) && loadedStations.length > 0) {
        setGroups(
          normalizeGroups([
            {
              id: makeId(),
              name: '그룹 1',
              stations: loadedStations
            }
          ])
        )
      }

      setStationsLoaded(true)
    }

    loadAppState()
  }, [])

  useEffect(() => {
    if (!stationsLoaded) return

    const timer = setTimeout(async () => {
      const { error } = await supabase.from('app_state').upsert({
        id: APP_STATE_ID,
        payload: {
          groups,
          stations: flattenGroupsToStations(groups)
        },
        updated_at: new Date().toISOString()
      })

      if (error) {
        console.error('saveStations error:', error)
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [groups, stationsLoaded])

  const [chartConfig, setChartConfig] = useState(() => {
    const saved = localStorage.getItem(CHART_CONFIG_KEY)
    if (saved) {
      try {
        return JSON.parse(saved)
      } catch {
        return {
          xType: 'logarithmic',
          xMin: '0.1',
          xMax: '10000',
          yType: 'logarithmic',
          yMin: '0.1',
          yMax: '10'
        }
      }
    }
    return {
      xType: 'logarithmic',
      xMin: '0.1',
      xMax: '10000',
      yType: 'logarithmic',
      yMin: '0.1',
      yMax: '10'
    }
  })

  const [legendPos, setLegendPos] = useState(() => {
    const saved = localStorage.getItem(CHART_LEGEND_POS_KEY)
    if (saved) {
      try {
        return JSON.parse(saved)
      } catch {
        return { top: 16, left: 16 }
      }
    }
    return { top: 16, left: 16 }
  })

  const legendDragRef = useRef({
    dragging: false,
    offsetX: 0,
    offsetY: 0
  })

  const chartWrapperRef = useRef(null)
  const legendRef = useRef(null)

  const [curveTableOpen, setCurveTableOpen] = useState(true)
  const [chartZoomX, setChartZoomX] = useState(1)
  const [chartZoomY, setChartZoomY] = useState(1)

  const chartZoomMin = 0.5
  const chartZoomMax = 3
  const chartZoomStep = 0.25
  const chartZoomXPercent = Math.max(100, Math.round(chartZoomX * 100))
  const chartZoomYHeight = Math.max(320, Math.round(780 * chartZoomY))

  const changeChartZoomX = (nextZoom) => {
    const value = Number(nextZoom)
    if (!Number.isFinite(value)) return
    setChartZoomX(Math.min(chartZoomMax, Math.max(chartZoomMin, value)))
  }

  const changeChartZoomY = (nextZoom) => {
    const value = Number(nextZoom)
    if (!Number.isFinite(value)) return
    setChartZoomY(Math.min(chartZoomMax, Math.max(chartZoomMin, value)))
  }

  useEffect(() => {
    localStorage.setItem(CHART_CONFIG_KEY, JSON.stringify(chartConfig))
  }, [chartConfig])

  useEffect(() => {
    localStorage.setItem(CHART_LEGEND_POS_KEY, JSON.stringify(legendPos))
  }, [legendPos])

  useEffect(() => {
    localStorage.setItem(HRFCO_API_KEY_STORAGE_KEY, hrfcoApiKey)
  }, [hrfcoApiKey])

  useEffect(() => {
    if (!groups.length) return

    const currentGroup = groups.find((group) => group.id === selectedGroupId) || groups[0]
    if (currentGroup && currentGroup.id !== selectedGroupId) {
      setSelectedGroupId(currentGroup.id)
    }

    if (currentGroup) {
      const hasStation = currentGroup.stations.some((station) => station.id === selectedStationId)
      if (!hasStation) {
        setSelectedStationId(currentGroup.stations[0]?.id || '')
      }
    }
  }, [groups, selectedGroupId, selectedStationId])

  useEffect(() => {
    const handlePointerMove = (e) => {
      if (!legendDragRef.current.dragging) return
      const wrapper = chartWrapperRef.current
      if (!wrapper) return

      const rect = wrapper.getBoundingClientRect()
      const newLeft = e.clientX - rect.left - legendDragRef.current.offsetX
      const newTop = e.clientY - rect.top - legendDragRef.current.offsetY

      setLegendPos({
        left: Math.max(0, newLeft),
        top: Math.max(0, newTop)
      })
    }

    const handlePointerUp = () => {
      legendDragRef.current.dragging = false
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [])

  const handleLegendPointerDown = (e) => {
    e.preventDefault()
    const wrapper = chartWrapperRef.current
    const legend = legendRef.current
    if (!wrapper || !legend) return

    const wrapperRect = wrapper.getBoundingClientRect()
    const legendRect = legend.getBoundingClientRect()

    legendDragRef.current.dragging = true
    legendDragRef.current.offsetX = e.clientX - legendRect.left
    legendDragRef.current.offsetY = e.clientY - legendRect.top

    setLegendPos({
      left: legendRect.left - wrapperRect.left,
      top: legendRect.top - wrapperRect.top
    })
  }

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) || groups[0] || null
  const selectedGroupIndex = groups.findIndex((group) => group.id === selectedGroup?.id)
  const selectedGroupStations = selectedGroup?.stations || []
  const selectedStationIndex = selectedGroupStations.findIndex((station) => station.id === selectedStationId)
  const selectedStation =
    selectedGroupStations.find((station) => station.id === selectedStationId) ||
    selectedGroupStations[0] ||
    null
  const canMoveGroupUp = selectedGroupIndex > 0
  const canMoveGroupDown = selectedGroupIndex >= 0 && selectedGroupIndex < groups.length - 1
  const canMoveStationUp = selectedStationIndex > 0
  const canMoveStationDown =
    selectedStationIndex >= 0 && selectedStationIndex < selectedGroupStations.length - 1

  const updateSelectedGroup = (patch) => {
    if (!selectedGroup) return
    setGroups((prev) =>
      prev.map((group) => (group.id === selectedGroup.id ? { ...group, ...patch } : group))
    )
  }

  const moveSelectedGroup = (direction) => {
    if (!selectedGroup) return
    setGroups((prev) => {
      const index = prev.findIndex((group) => group.id === selectedGroup.id)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev
      return moveArrayItem(prev, index, nextIndex)
    })
  }

  const moveSelectedStation = (direction) => {
    if (!selectedGroup || !selectedStation) return
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== selectedGroup.id) return group
        const index = group.stations.findIndex((station) => station.id === selectedStation.id)
        const nextIndex = index + direction
        if (index < 0 || nextIndex < 0 || nextIndex >= group.stations.length) return group
        return {
          ...group,
          stations: moveArrayItem(group.stations, index, nextIndex)
        }
      })
    )
  }

  const updateStation = (stationId, patch) => {
    if (!selectedGroup) return
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== selectedGroup.id) return group
        return {
          ...group,
          stations: group.stations.map((station) =>
            station.id === stationId ? { ...station, ...patch } : station
          )
        }
      })
    )
  }

  const updateStationAcrossGroups = (stationId, patch) => {
    setGroups((prev) =>
      prev.map((group) => ({
        ...group,
        stations: group.stations.map((station) =>
          station.id === stationId ? { ...station, ...patch } : station
        )
      }))
    )
  }

  const updateSelectedSections = (nextSections) => {
    if (!selectedGroup || !selectedStation) return
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== selectedGroup.id) return group
        return {
          ...group,
          stations: group.stations.map((station) =>
            station.id === selectedStation.id ? { ...station, sections: nextSections } : station
          )
        }
      })
    )
  }

  const updateSelectedMeasurements = (nextMeasurements) => {
    if (!selectedGroup || !selectedStation) return
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== selectedGroup.id) return group
        return {
          ...group,
          stations: group.stations.map((station) =>
            station.id === selectedStation.id
              ? { ...station, measurements: nextMeasurements }
              : station
          )
        }
      })
    )
  }

  const addGroup = () => {
    const newGroup = createDefaultGroup(`그룹 ${groups.length + 1}`)
    setGroups((prev) => [...prev, newGroup])
    setSelectedGroupId(newGroup.id)
    setSelectedStationId(newGroup.stations[0].id)
  }

  const deleteSelectedGroup = () => {
    if (!selectedGroup) return

    const ok = window.confirm(
      `"${selectedGroup.name || '선택된 그룹'}"을(를) 삭제할까요?`
    )
    if (!ok) return

    const currentIndex = groups.findIndex((group) => group.id === selectedGroup.id)
    let nextGroups = groups.filter((group) => group.id !== selectedGroup.id)

    if (nextGroups.length === 0) {
      const fallback = createDefaultGroup('그룹 1')
      nextGroups = [fallback]
      setGroups(nextGroups)
      setSelectedGroupId(fallback.id)
      setSelectedStationId(fallback.stations[0].id)
      return
    }

    const fallbackGroup =
      nextGroups[currentIndex] || nextGroups[currentIndex - 1] || nextGroups[0]

    setGroups(nextGroups)
    setSelectedGroupId(fallbackGroup.id)
    setSelectedStationId(fallbackGroup.stations[0]?.id || '')
  }

  const addStation = () => {
    if (!selectedGroup) return

    const newStation = createEmptyStation(`새 지점 ${selectedGroupStations.length + 1}`)
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== selectedGroup.id) return group
        return {
          ...group,
          stations: [...group.stations, newStation]
        }
      })
    )
    setSelectedStationId(newStation.id)
  }

  const deleteSelectedStation = () => {
    if (!selectedGroup || !selectedStation) return

    const ok = window.confirm(
      `"${selectedStation.name || '선택된 지점'}"을(를) 삭제할까요?`
    )
    if (!ok) return

    const groupIndex = groups.findIndex((group) => group.id === selectedGroup.id)
    const updatedGroups = groups
      .map((group) => {
        if (group.id !== selectedGroup.id) return group
        return {
          ...group,
          stations: group.stations.filter((station) => station.id !== selectedStation.id)
        }
      })
      .filter((group) => group.stations.length > 0)

    if (updatedGroups.length === 0) {
      const fallback = createDefaultGroup('그룹 1')
      setGroups([fallback])
      setSelectedGroupId(fallback.id)
      setSelectedStationId(fallback.stations[0].id)
      return
    }

    const sameGroup = updatedGroups.find((group) => group.id === selectedGroup.id)
    if (sameGroup) {
      setGroups(updatedGroups)
      setSelectedGroupId(sameGroup.id)
      setSelectedStationId(sameGroup.stations[0]?.id || '')
      return
    }

    const fallbackGroup =
      updatedGroups[groupIndex] || updatedGroups[groupIndex - 1] || updatedGroups[0]

    setGroups(updatedGroups)
    setSelectedGroupId(fallbackGroup.id)
    setSelectedStationId(fallbackGroup.stations[0]?.id || '')
  }

  const handleGroupChange = (groupId) => {
    const nextGroup = groups.find((group) => group.id === groupId) || groups[0] || null
    setSelectedGroupId(groupId)
    setSelectedStationId(nextGroup?.stations[0]?.id || '')
  }

  const handleStationChange = (stationId) => {
    setSelectedStationId(stationId)
  }

  const selectedSections = selectedStation?.sections || []
  const selectedMeasurements = selectedStation?.measurements || []

  const tableAutoStyle = SHARED_TABLE_STYLE

  const handleMeasurementRowsChange = (nextVisibleRows) => {
    const visibleIds = new Set(filteredMeasurements.map((row) => row.id))
    const nextById = new Map(nextVisibleRows.map((row) => [row.id, row]))
    const updated = selectedMeasurements.map((row) => nextById.get(row.id) || row)
    const appended = nextVisibleRows.filter((row) => !visibleIds.has(row.id))
    updateSelectedMeasurements([...updated, ...appended])
  }

  const measurementGroups = useMemo(() => {
    const map = new Map()

    selectedMeasurements.forEach((measurement) => {
      const year = getYearLabel(measurement.datetime)
      const device = normalizeDeviceLabel(measurement.device)
      const key = `${year}__${device}`
      if (!map.has(key)) {
        map.set(key, {
          year,
          device,
          items: []
        })
      }
      map.get(key).items.push(measurement)
    })

    return Array.from(map.values())
      .sort((a, b) => compareYearLabel(a.year, b.year) || a.device.localeCompare(b.device, 'ko'))
      .map((group) => ({
        ...group,
        items: group.items
          .slice()
          .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
      }))
  }, [selectedMeasurements])

  const yearColorMap = useMemo(() => {
    const years = Array.from(new Set(measurementGroups.map((g) => g.year))).sort(
      compareYearLabel
    )
    const map = {}
    years.forEach((year, idx) => {
      map[year] = YEAR_COLORS[idx % YEAR_COLORS.length]
    })
    return map
  }, [measurementGroups])

  const curveRowsBySection = useMemo(() => {
    return selectedSections.map((section) => ({
      section,
      rows: genCurveRows(section)
    }))
  }, [selectedSections])

  const measurementYearOptions = useMemo(() => {
    const years = Array.from(
      new Set(
        selectedMeasurements
          .map((measurement) => getYearLabel(measurement.datetime))
          .filter((year) => year !== '미정')
      )
    ).sort(compareYearLabel)

    return ['전체', ...years]
  }, [selectedMeasurements])

  const filteredMeasurements = useMemo(() => {
    if (measurementYearFilter === '전체') return selectedMeasurements
    return selectedMeasurements.filter(
      (measurement) => getYearLabel(measurement.datetime) === measurementYearFilter
    )
  }, [selectedMeasurements, measurementYearFilter])

  const relativeErrorsRaw = useMemo(() => {
    return selectedMeasurements.map((measurement, index) => {
      const section = findSectionByH(
        measurement.h,
        selectedSections,
        measurement.datetime
      )
      const measuredQ = num(measurement.q)
      const curveQ = section ? calcQ(measurement.h, section) : null
      let error = null
      if (measuredQ !== null && curveQ !== null && curveQ !== 0) {
        error = ((measuredQ - curveQ) / curveQ) * 100
      }
      return {
        ...measurement,
        sectionName: section?.name || '',
        curveQ,
        error,
        measurementYear: getYearLabel(measurement.datetime),
        _order: index
      }
    })
  }, [selectedMeasurements, selectedSections])

  const filteredRelativeErrors = useMemo(() => {
    let rows = relativeErrorsRaw

    if (relativeErrorYearFilter !== '전체') {
      rows = rows.filter((row) => row.measurementYear === relativeErrorYearFilter)
    }

    if (relativeErrorSort === '오름차순') {
      rows = rows.slice().sort((a, b) => {
        const aH = num(a.h)
        const bH = num(b.h)
        const aValue = aH === null ? Number.POSITIVE_INFINITY : aH
        const bValue = bH === null ? Number.POSITIVE_INFINITY : bH
        const diff = aValue - bValue
        if (Number.isFinite(diff) && diff !== 0) return diff
        return a._order - b._order
      })
    } else if (relativeErrorSort === '내림차순') {
      rows = rows.slice().sort((a, b) => {
        const aH = num(a.h)
        const bH = num(b.h)
        const aValue = aH === null ? Number.NEGATIVE_INFINITY : aH
        const bValue = bH === null ? Number.NEGATIVE_INFINITY : bH
        const diff = bValue - aValue
        if (Number.isFinite(diff) && diff !== 0) return diff
        return a._order - b._order
      })
    } else {
      rows = rows.slice().sort((a, b) => a._order - b._order)
    }

    return rows
  }, [relativeErrorsRaw, relativeErrorYearFilter, relativeErrorSort])

  const curveDatasets = useMemo(() => {
    return selectedSections.flatMap((section, idx) => {
      const color = CURVE_COLORS[idx % CURVE_COLORS.length]
      const { datasets } = buildCurveSegments(section)

      return datasets.map((segment) => ({
        label: section.name || `구간${idx + 1}`,
        data: segment.rows.map((r) => ({ x: r.q, y: r.h })),
        showLine: true,
        pointRadius: 0,
        pointHoverRadius: 0,
        borderWidth: 3,
        borderColor: color,
        borderDash: segment.dashed ? [8, 5] : [],
        parsing: false,
        sectionId: section.id,
        legendColor: color,
        legendDashed: segment.dashed
      }))
    })
  }, [selectedSections, curveRowsBySection])

  const measurementDatasets = useMemo(() => {
    return measurementGroups.map((group) => {
      const color = yearColorMap[group.year] || YEAR_COLORS[0]
      const deviceStyle = DEVICE_STYLES[group.device] || DEVICE_STYLES.기타

      return {
        label: `${group.year}년 ${group.device} 측정성과`,
        data: group.items
          .map((measurement) => ({ x: num(measurement.q), y: num(measurement.h) }))
          .filter((point) => point.x !== null && point.y !== null),
        showLine: false,
        pointRadius: 5,
        pointHoverRadius: 6,
        borderWidth: 1,
        backgroundColor: color,
        borderColor: color,
        pointStyle: deviceStyle.pointStyle,
        parsing: false,
        legendSymbol: deviceStyle.symbol,
        legendColor: color
      }
    })
  }, [measurementGroups, yearColorMap])

  const legendItems = useMemo(() => {
    const items = []

    measurementDatasets.forEach((dataset) => {
      items.push({
        type: 'point',
        label: dataset.label,
        color: dataset.legendColor,
        symbol: dataset.legendSymbol
      })
    })

    selectedSections.forEach((section, idx) => {
      const color = CURVE_COLORS[idx % CURVE_COLORS.length]
      const lowThreshold = parseThreshold(section.lowNote)
      const highThreshold = parseThreshold(section.highNote)
      items.push({
        type: 'line',
        label: section.name || `구간${idx + 1}`,
        color,
        dash: lowThreshold !== null || highThreshold !== null
      })
    })

    return items
  }, [measurementDatasets, selectedSections])

  const chartData = useMemo(() => {
    return {
      datasets: [...curveDatasets, ...measurementDatasets]
    }
  }, [curveDatasets, measurementDatasets])

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: false
      },
      scales: {
        x: {
          type: chartConfig.xType,
          min: safeScaleNumber(chartConfig.xMin, chartConfig.xType),
          max: safeScaleNumber(chartConfig.xMax, chartConfig.xType),
          title: {
            display: true,
            text: '유량 Q(m³/s)',
            color: '#111',
            font: {
              size: 14,
              weight: '700'
            }
          },
          grid: {
            color: 'rgba(0,0,0,0.16)',
            lineWidth: 1
          },
          ticks: {
            color: '#222',
            callback: (value) => formatTick(value)
          }
        },
        y: {
          type: chartConfig.yType,
          min: safeScaleNumber(chartConfig.yMin, chartConfig.yType),
          max: safeScaleNumber(chartConfig.yMax, chartConfig.yType),
          title: {
            display: true,
            text: '수위 h(m)',
            color: '#111',
            font: {
              size: 14,
              weight: '700'
            }
          },
          grid: {
            color: 'rgba(0,0,0,0.16)',
            lineWidth: 1
          },
          ticks: {
            color: '#222',
            callback: (value) => formatTick(value)
          }
        }
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const x = ctx.parsed.x
              const y = ctx.parsed.y
              return `${ctx.dataset.label}: Q=${fmt(x, 3)}, h=${fmt(y, 3)}`
            }
          }
        }
      }
    }),
    [chartConfig]
  )

  const currentGroupName = selectedGroup?.name || ''
  const currentStationName = selectedStation?.name || ''
  const currentStationCode = selectedStation?.code || ''

  const sectionColumns = [
    { key: 'name', label: '구간명' },
    { key: 'hMin', label: '적용수위 시작' },
    { key: 'hMax', label: '적용수위 끝' },
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C' },
    { key: 'lowNote', label: '저수위 외삽' },
    { key: 'highNote', label: '고수위 외삽' },
    { key: 'periodStart', label: '적용시작' },
    { key: 'periodEnd', label: '적용종료' }
  ]

  const measurementColumns = [
    { key: 'datetime', label: '측정일시' },
    { key: 'h', label: '수위(h)' },
    { key: 'q', label: '유량(Q)' },
    { key: 'device', label: '측정장비' },
    { key: 'exclude', label: '제외' },
    { key: 'tide', label: '배수영향' },
    { key: 'vegetation', label: '조위영향' },
    { key: 'construction', label: '식생영향' },
    { key: 'partialOpen', label: '공사영향' }
  ]

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>수위-유량 곡선식 관리 PWA</h1>
          <p>셀 형태 입력, Excel 붙여넣기, 환산유량표, 그래프, 상대오차 계산</p>
        </div>
        <p className="muted">그룹과 지점을 선택해서 관리합니다.</p>
      </header>

      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '14px',
          flexWrap: 'wrap'
        }}
      >
        <button
          type="button"
          className="btn secondary"
          style={{
            background: activeTab === 'management' ? '#1f6feb' : '#6c757d'
          }}
          onClick={() => setActiveTab('management')}
        >
          측정성과 관리
        </button>
        <button
          type="button"
          className="btn secondary"
          style={{
            background: activeTab === 'process' ? '#1f6feb' : '#6c757d'
          }}
          onClick={() => setActiveTab('process')}
        >
          측정성과 공정률
        </button>
        <button
          type="button"
          className="btn secondary"
          style={{
            background: activeTab === 'instrument' ? '#1f6feb' : '#6c757d'
          }}
          onClick={() => setActiveTab('instrument')}
        >
          계기수위-측정성과
        </button>
      </div>

      <div style={{ display: activeTab === 'management' ? 'block' : 'none' }}>

      <section className="card">
        <h2>1. 그룹 / 지점 선택 / 기본정보</h2>
        <div className="row">
          <label>
            그룹 선택
            <select
              value={selectedGroupId}
              onChange={(e) => handleGroupChange(e.target.value)}
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name || '그룹 없음'}
                </option>
              ))}
            </select>
          </label>

          <label>
            그룹명
            <input
              value={currentGroupName}
              onChange={(e) => updateSelectedGroup({ name: e.target.value })}
            />
          </label>

          <div className="grid-actions" style={{ alignSelf: 'end' }}>
            <button className="btn" onClick={addGroup}>
              + 그룹 추가
            </button>
            <button className="btn danger" onClick={deleteSelectedGroup} disabled={!selectedGroup}>
              - 그룹 삭제
            </button>
            <button className="btn secondary" onClick={() => moveSelectedGroup(-1)} disabled={!canMoveGroupUp}>
              ▲ 그룹 위로
            </button>
            <button className="btn secondary" onClick={() => moveSelectedGroup(1)} disabled={!canMoveGroupDown}>
              ▼ 그룹 아래로
            </button>
          </div>
        </div>

        <div className="row" style={{ marginTop: '12px' }}>
          <label>
            지점 선택
            <select
              value={selectedStationId}
              onChange={(e) => handleStationChange(e.target.value)}
            >
              {selectedGroupStations.map((station) => (
                <option key={station.id} value={station.id}>
                  {station.name || '이름 없음'}
                </option>
              ))}
            </select>
          </label>

          <label>
            지점명
            <input
              value={currentStationName}
              onChange={(e) =>
                selectedStation && updateStation(selectedStation.id, { name: e.target.value })
              }
            />
          </label>

          <label>
            지점코드
            <input
              value={currentStationCode}
              onChange={(e) =>
                selectedStation && updateStation(selectedStation.id, { code: e.target.value })
              }
            />
          </label>

          <label>
            분류
            <select
              value={selectedStation?.classification || '일반 지점'}
              onChange={(e) =>
                selectedStation &&
                updateStation(selectedStation.id, { classification: e.target.value })
              }
            >
              <option value="자동유량">자동유량</option>
              <option value="일반 지점">일반 지점</option>
            </select>
          </label>

          <div className="grid-actions" style={{ alignSelf: 'end' }}>
            <button className="btn" onClick={addStation}>
              + 지점 추가
            </button>
            <button
              className="btn danger"
              onClick={deleteSelectedStation}
              disabled={!selectedStation}
            >
              - 지점 삭제
            </button>
            <button className="btn secondary" onClick={() => moveSelectedStation(-1)} disabled={!canMoveStationUp}>
              ▲ 지점 위로
            </button>
            <button className="btn secondary" onClick={() => moveSelectedStation(1)} disabled={!canMoveStationDown}>
              ▼ 지점 아래로
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <SpreadsheetGrid
          title="2. 곡선식 입력"
          columns={sectionColumns}
          rows={selectedSections}
          onRowsChange={updateSelectedSections}
          createEmptyRow={createEmptySection}
          onDeleteRow={(rowId) =>
            updateSelectedSections(selectedSections.filter((section) => section.id !== rowId))
          }
          addButtonLabel={{
            label: '+ 구간 추가',
            onClick: () =>
              updateSelectedSections([...selectedSections, createEmptySection()])
          }}
        />
      </section>

      <section className="card">
        <div className="grid-actions" style={{ justifyContent: 'flex-end', marginBottom: '10px' }}>
          <label>
            연도별
            <select
              value={measurementYearFilter}
              onChange={(e) => setMeasurementYearFilter(e.target.value)}
            >
              {measurementYearOptions.map((year) => (
                <option key={year} value={year}>
                  {year === '전체' ? '전체' : `${year}년`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <SpreadsheetGrid
          title="3. 측정성과 입력"
          columns={measurementColumns}
          rows={filteredMeasurements}
          onRowsChange={(nextVisibleRows) => {
            const visibleIds = new Set(filteredMeasurements.map((row) => row.id))
            const nextById = new Map(nextVisibleRows.map((row) => [row.id, row]))
            const updated = selectedMeasurements.map((row) => nextById.get(row.id) || row)
            const appended = nextVisibleRows.filter((row) => !visibleIds.has(row.id))
            updateSelectedMeasurements([...updated, ...appended])
          }}
          createEmptyRow={createEmptyMeasurement}
          onDeleteRow={(rowId) =>
            updateSelectedMeasurements(
              selectedMeasurements.filter((measurement) => measurement.id !== rowId)
            )
          }
          addButtonLabel={{
            label: '+ 측정성과 추가',
            onClick: () =>
              updateSelectedMeasurements([
                ...selectedMeasurements,
                createEmptyMeasurement()
              ])
          }}
        />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>4. 수위별 환산유량표</h2>
          <button
            className="btn secondary"
            onClick={() => setCurveTableOpen((prev) => !prev)}
          >
            {curveTableOpen ? '접기' : '펼치기'}
          </button>
        </div>

        {curveTableOpen &&
          curveRowsBySection.map(({ section, rows }) => (
            <div className="subcard" key={section.id}>
              <h3>
                {section.name} / {section.hMin} ≤ h ≤ {section.hMax}
              </h3>
              <p className="muted">
                Q = {section.a} × (h - {section.b})^{section.c}
                {section.lowNote ? ` / ${section.lowNote}` : ''}
                {section.highNote ? ` / ${section.highNote}` : ''}
              </p>
              <CopyableMatrixTable
                  headers={['수위(m)', '유량(m³/s)']}
                  rows={rows.map((r) => [fmt(r.h, 2), fmt(r.q, 3)])}
                  tableClassName="spreadsheet flow-table"
                  style={tableAutoStyle}
                />
            </div>
          ))}
      </section>

      <section className="card">
        <div className="section-header">
          <h2>5. 상대오차 계산</h2>
          <div className="grid-actions">
            <label>
              연도별
              <select
                value={relativeErrorYearFilter}
                onChange={(e) => setRelativeErrorYearFilter(e.target.value)}
              >
                {measurementYearOptions.map((year) => (
                  <option key={year} value={year}>
                    {year === '전체' ? '전체' : `${year}년`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              수위(h) 정렬
              <select
                value={relativeErrorSort}
                onChange={(e) => setRelativeErrorSort(e.target.value)}
              >
                <option value="기본">기본</option>
                <option value="오름차순">오름차순</option>
                <option value="내림차순">내림차순</option>
              </select>
            </label>
          </div>
        </div>
        <CopyableMatrixTable
            headers={['측정일시', '수위(h)', '측정유량', '곡선식 적용구간', '곡선식 유량', '상대오차(%)']}
            rows={filteredRelativeErrors.map((row) => [
              row.datetime,
              row.h,
              row.q,
              row.sectionName,
              row.curveQ === null ? '' : fmt(row.curveQ, 3),
              row.error === null ? '' : fmt(row.error, 2)
            ])}
            tableClassName="spreadsheet flow-table"
            style={tableAutoStyle}
          />
        <p className="muted">상대오차 = (측정 유량 - 곡선식 유량) / 곡선식 유량 × 100</p>
      </section>

      <section className="card chart-card">
        <h2>6. 그래프</h2>

        <div className="chart-settings">
          <div className="chart-setting-card">
            <h3>축 설정</h3>
            <div className="chart-setting-grid">
              <label>
                X축 종류
                <select
                  value={chartConfig.xType}
                  onChange={(e) =>
                    setChartConfig((prev) => ({ ...prev, xType: e.target.value }))
                  }
                >
                  <option value="logarithmic">logarithmic</option>
                  <option value="linear">linear</option>
                </select>
              </label>
              <label>
                X축 최소
                <input
                  type="number"
                  step="any"
                  value={chartConfig.xMin}
                  onChange={(e) =>
                    setChartConfig((prev) => ({ ...prev, xMin: e.target.value }))
                  }
                />
              </label>
              <label>
                X축 최대
                <input
                  type="number"
                  step="any"
                  value={chartConfig.xMax}
                  onChange={(e) =>
                    setChartConfig((prev) => ({ ...prev, xMax: e.target.value }))
                  }
                />
              </label>
              <label>
                Y축 종류
                <select
                  value={chartConfig.yType}
                  onChange={(e) =>
                    setChartConfig((prev) => ({ ...prev, yType: e.target.value }))
                  }
                >
                  <option value="logarithmic">logarithmic</option>
                  <option value="linear">linear</option>
                </select>
              </label>
              <label>
                Y축 최소
                <input
                  type="number"
                  step="any"
                  value={chartConfig.yMin}
                  onChange={(e) =>
                    setChartConfig((prev) => ({ ...prev, yMin: e.target.value }))
                  }
                />
              </label>
              <label>
                Y축 최대
                <input
                  type="number"
                  step="any"
                  value={chartConfig.yMax}
                  onChange={(e) =>
                    setChartConfig((prev) => ({ ...prev, yMax: e.target.value }))
                  }
                />
              </label>
            </div>
          </div>
        </div>

        <div
          className="chart-wrapper"
          ref={chartWrapperRef}
          style={{ overflow: 'auto', WebkitOverflowScrolling: 'touch' }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: '10px',
              marginBottom: '10px'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap'
              }}
            >
              <span className="muted" style={{ minWidth: '44px' }}>
                가로
              </span>
              <button
                type="button"
                className="btn secondary"
                onClick={() => changeChartZoomX(chartZoomX - chartZoomStep)}
              >
                -
              </button>
              <input
                type="range"
                min={chartZoomMin}
                max={chartZoomMax}
                step={chartZoomStep}
                value={chartZoomX}
                onChange={(e) => changeChartZoomX(e.target.value)}
                aria-label="그래프 가로 확대/축소"
                style={{ flex: '1 1 220px', minWidth: '180px' }}
              />
              <button
                type="button"
                className="btn secondary"
                onClick={() => changeChartZoomX(chartZoomX + chartZoomStep)}
              >
                +
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => changeChartZoomX(1)}
              >
                기본
              </button>
              <span className="muted">{chartZoomX.toFixed(2)}x</span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap'
              }}
            >
              <span className="muted" style={{ minWidth: '44px' }}>
                세로
              </span>
              <button
                type="button"
                className="btn secondary"
                onClick={() => changeChartZoomY(chartZoomY - chartZoomStep)}
              >
                -
              </button>
              <input
                type="range"
                min={chartZoomMin}
                max={chartZoomMax}
                step={chartZoomStep}
                value={chartZoomY}
                onChange={(e) => changeChartZoomY(e.target.value)}
                aria-label="그래프 세로 확대/축소"
                style={{ flex: '1 1 220px', minWidth: '180px' }}
              />
              <button
                type="button"
                className="btn secondary"
                onClick={() => changeChartZoomY(chartZoomY + chartZoomStep)}
              >
                +
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => changeChartZoomY(1)}
              >
                기본
              </button>
              <span className="muted">{chartZoomY.toFixed(2)}x</span>
            </div>
          </div>

          <div
            className="chart-legend"
            ref={legendRef}
            style={{ top: legendPos.top, left: legendPos.left, touchAction: 'none' }}
            onPointerDown={handleLegendPointerDown}
          >
            <div className="chart-legend-list">
              {legendItems.map((item) => (
                <div key={item.label} className="chart-legend-item">
                  {item.type === 'line' ? (
                    <span
                      className={`legend-line ${item.dash ? 'dashed' : ''}`}
                      style={{ borderTopColor: item.color }}
                    />
                  ) : (
                    <span className="legend-symbol" style={{ color: item.color }}>
                      {item.symbol}
                    </span>
                  )}
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div
            className="chart-box"
            style={{
              width: `${chartZoomXPercent}%`,
              minWidth: '100%',
              height: `${chartZoomYHeight}px`
            }}
          >
            <Scatter data={chartData} options={chartOptions} />
          </div>
        </div>
      </section>
      </div>

      <div style={{ display: activeTab === 'process' ? 'block' : 'none' }}>
        <ProcessRatePage groups={groups} onUpdateStation={updateStationAcrossGroups} />
      </div>

      <div style={{ display: activeTab === 'instrument' ? 'block' : 'none' }}>
        <CurrentWaterLevelPage
          groups={groups}
          hrfcoApiKey={hrfcoApiKey}
          onHrfcoApiKeyChange={setHrfcoApiKey}
        />
      </div>
    </div>
  )
}
