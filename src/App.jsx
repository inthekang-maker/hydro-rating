import * as XLSX from 'xlsx'
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

const sanitizeExcelSheetName = (name) => {
  const raw = String(name || '').trim().replace(/[\/:?*\[\]]/g, ' ').replace(/\s+/g, ' ')
  const trimmed = raw.replace(/^'+|'+$/g, '').trim()
  return (trimmed || 'Sheet').slice(0, 31)
}

const formatMeasurementDatetimeForExport = (value) => {
  const parsed = parseDateTime(value)
  return parsed ? formatDateTimeDisplay(parsed) : String(value || '')
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

function calcQBase(h, section) {
  const hValue = num(h)
  const A = num(section.a)
  const B = num(section.b)
  const C = num(section.c)

  if (hValue === null || A === null || B === null || C === null) return null

  const x = hValue - B
  if (x < 0) return null

  const q = A * Math.pow(x, C)
  return Number.isFinite(q) ? q : null
}

function calcQ(h, section) {
  const hValue = num(h)
  const offset = num(section.hOffset) ?? 0
  const A = num(section.a)
  const B = num(section.b)
  const C = num(section.c)

  if (hValue === null || A === null || B === null || C === null) return null

  const H = hValue + offset
  const x = H - B
  if (x < 0) return null

  const q = A * Math.pow(x, C)
  return Number.isFinite(q) ? q : null
}

function findSectionByH(h, sections, measurementDatetime = null) {
  const hValue = num(h)
  if (hValue === null) return null

  const applicableSections = sections.filter((section) => {
    const hMin = num(section.hMin)
    const hMax = num(section.hMax)
    const offset = num(section.hOffset) ?? 0
    const H = hValue + offset

    if (hMin === null || hMax === null) return false
    if (H < hMin || H > hMax) return false
    if (!measurementDatetime) return true
    return isMeasurementApplicableToSection(measurementDatetime, section)
  })

  const exact = applicableSections.find((s) => {
    const hMin = num(s.hMin)
    const hMax = num(s.hMax)
    const H = hValue + (num(s.hOffset) ?? 0)
    return hMin !== null && hMax !== null && H >= hMin && H <= hMax
  })
  if (exact) return exact

  let best = null
  let bestDist = Infinity
  for (const s of applicableSections) {
    const hMin = num(s.hMin)
    const hMax = num(s.hMax)
    if (hMin === null || hMax === null) continue

    const H = hValue + (num(s.hOffset) ?? 0)
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
    const q = calcQBase(h, section)
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

  // 이미 Date 객체면 그대로 사용
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  const s = String(value).trim()

  // HRFCO ymdhm 형식: 202607240810
  if (/^\d{12}$/.test(s)) {
    const yyyy = Number(s.slice(0, 4))
    const mm = Number(s.slice(4, 6))
    const dd = Number(s.slice(6, 8))
    const hh = Number(s.slice(8, 10))
    const mi = Number(s.slice(10, 12))

    const d = new Date(yyyy, mm - 1, dd, hh, mi, 0, 0)
    return Number.isNaN(d.getTime()) ? null : d
  }

  const d = new Date(s)
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
    sections: Array.isArray(station.sections)
      ? station.sections.map((section) => ({
          ...section,
          hOffset: section.hOffset ?? '0'
        }))
      : [],
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
    hOffset: '0',
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

const sortGroupsAndStationsByOrder = (groups) => {
  return (Array.isArray(groups) ? groups : [])
    .slice()
    .sort((a, b) => {
      const ao = num(a?.order ?? a?.groupOrder ?? 0)
      const bo = num(b?.order ?? b?.groupOrder ?? 0)

      if (ao !== null && bo !== null && ao !== bo) return ao - bo
      if (ao !== null && bo === null) return -1
      if (ao === null && bo !== null) return 1

      return String(a?.name || '').localeCompare(String(b?.name || ''), 'ko')
    })
    .map((group) => ({
      ...group,
      stations: (Array.isArray(group.stations) ? group.stations : [])
        .slice()
        .sort((a, b) => {
          const ao = num(a?.order ?? a?.stationOrder ?? 0)
          const bo = num(b?.order ?? b?.stationOrder ?? 0)

          if (ao !== null && bo !== null && ao !== bo) return ao - bo
          if (ao !== null && bo === null) return -1
          if (ao === null && bo !== null) return 1

          return String(a?.name || '').localeCompare(String(b?.name || ''), 'ko')
        })
    }))
}

const applyDraftOrderToGroups = (loadedGroups, draftGroups) => {
  const draftGroupOrder = new Map()
  const draftStationOrder = new Map()

  ;(Array.isArray(draftGroups) ? draftGroups : []).forEach((group, groupIndex) => {
    draftGroupOrder.set(group.id, groupIndex)
    draftStationOrder.set(
      group.id,
      new Map(
        (Array.isArray(group.stations) ? group.stations : []).map((station, stationIndex) => [
          station.id,
          stationIndex
        ])
      )
    )
  })

  const fallbackGroupOrder = (group) => num(group?.order ?? group?.groupOrder ?? 0)
  const fallbackStationOrder = (station) => num(station?.order ?? station?.stationOrder ?? 0)

  return (Array.isArray(loadedGroups) ? loadedGroups : [])
    .slice()
    .sort((a, b) => {
      const ai = draftGroupOrder.has(a.id) ? draftGroupOrder.get(a.id) : null
      const bi = draftGroupOrder.has(b.id) ? draftGroupOrder.get(b.id) : null

      if (ai !== null && bi !== null && ai !== bi) return ai - bi
      if (ai !== null) return -1
      if (bi !== null) return 1

      const ao = fallbackGroupOrder(a)
      const bo = fallbackGroupOrder(b)
      if (ao !== null && bo !== null && ao !== bo) return ao - bo
      if (ao !== null && bo === null) return -1
      if (ao === null && bo !== null) return 1

      return String(a?.name || '').localeCompare(String(b?.name || ''), 'ko')
    })
    .map((group) => {
      const draftStations = draftStationOrder.get(group.id) || new Map()

      return {
        ...group,
        stations: (Array.isArray(group.stations) ? group.stations : [])
          .slice()
          .sort((a, b) => {
            const ai = draftStations.has(a.id) ? draftStations.get(a.id) : null
            const bi = draftStations.has(b.id) ? draftStations.get(b.id) : null

            if (ai !== null && bi !== null && ai !== bi) return ai - bi
            if (ai !== null) return -1
            if (bi !== null) return 1

            const ao = fallbackStationOrder(a)
            const bo = fallbackStationOrder(b)
            if (ao !== null && bo !== null && ao !== bo) return ao - bo
            if (ao !== null && bo === null) return -1
            if (ao === null && bo !== null) return 1

            return String(a?.name || '').localeCompare(String(b?.name || ''), 'ko')
          })
      }
    })
}

const DEFAULT_GROUPS = normalizeGroups(buildInitialGroups())


const APP_STATE_LEGACY_ID = 'main'
const APP_STATE_STATION_ROW_SUFFIX = '::station::'
const APP_STATE_STATION_ROW_VARIANTS = {
  INFO: 'info',
  SECTIONS: 'sections',
  MEASUREMENTS: 'measurements',
  PROCESS_PLAN: 'processPlan'
}

const APP_STATE_DRAFT_KEY = 'hydro-pwa-app-state-draft-v4'
const APP_STATE_SYNC_KEY = 'hydro-pwa-app-state-sync-v4'
const APP_STATE_CLIENT_ID_KEY = 'hydro-pwa-app-client-id-v1'
const APP_STATE_SAVE_DEBOUNCE_MS = 700
const APP_STATE_SAVE_RETRY_MS = 5000

const makeScopedStationRowId = (
  scope,
  stationId,
  variant = APP_STATE_STATION_ROW_VARIANTS.INFO
) =>
  `app_state::${sanitizeStorageScope(scope)}${APP_STATE_STATION_ROW_SUFFIX}${String(stationId || '').trim()}::${String(variant || APP_STATE_STATION_ROW_VARIANTS.INFO).trim()}`

const makeScopedStationRowPrefix = (scope) =>
  `app_state::${sanitizeStorageScope(scope)}${APP_STATE_STATION_ROW_SUFFIX}`

const parseScopedStationRowId = (rowId) => {
  const raw = String(rowId || '')
  const markerIndex = raw.indexOf(APP_STATE_STATION_ROW_SUFFIX)
  if (markerIndex < 0) return null

  const tail = raw.slice(markerIndex + APP_STATE_STATION_ROW_SUFFIX.length)
  if (!tail) return null

  const parts = tail.split('::').filter(Boolean)
  if (parts.length === 0) return null

  const stationId = String(parts[0] || '').trim()
  const variant = String(parts[1] || APP_STATE_STATION_ROW_VARIANTS.INFO).trim() || APP_STATE_STATION_ROW_VARIANTS.INFO

  return {
    stationId,
    variant,
    isVariantRow: parts.length > 1
  }
}

const toSafeRevision = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

const isDuplicateKeyError = (error) => {
  const code = String(error?.code || '')
  const message = String(error?.message || error?.details || '').toLowerCase()
  return code === '23505' || message.includes('duplicate key')
}

const isMissingRevisionColumnError = (error) => {
  const message = String(error?.message || error?.details || '').toLowerCase()
  return (
    message.includes('revision') &&
    (message.includes('does not exist') || message.includes('column'))
  )
}

const getAppStorageScope = () => {
  if (typeof window === 'undefined') return 'default'
  const host = String(window.location.hostname || 'default').trim().toLowerCase()
  return host || 'default'
}

const sanitizeStorageScope = (value) =>
  String(value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '_') || 'default'

const makeScopedStorageKey = (baseKey, scope) => `${baseKey}::${sanitizeStorageScope(scope)}`

const makeScopedAppStateId = (scope) => `app_state::${sanitizeStorageScope(scope)}`

const safeReadJson = (key, fallback = null) => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

const safeWriteJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

const safeRemoveKey = (key) => {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

const makeClientId = () => `client_${Math.random().toString(36).slice(2, 10)}`

const getStoredClientId = (scope = 'default') => {
  const storageKey = makeScopedStorageKey(APP_STATE_CLIENT_ID_KEY, scope)
  try {
    const existing = localStorage.getItem(storageKey)
    if (existing) return existing
    const next = makeClientId()
    localStorage.setItem(storageKey, next)
    return next
  } catch {
    return makeClientId()
  }
}

const toTimeValue = (value) => {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

const buildAppStatePayload = (groups, clientId) => {
  const now = new Date().toISOString()
  return {
    groups: normalizeGroups(groups),
    stations: flattenGroupsToStations(groups),
    savedAt: now,
    clientId
  }
}

const extractGroupsFromAppStatePayload = (payload) => {
  const loadedGroups = payload?.groups
  const loadedStations = payload?.stations

  if (Array.isArray(loadedGroups) && loadedGroups.length > 0) {
    return normalizeGroups(loadedGroups)
  }

  if (Array.isArray(loadedStations) && loadedStations.length > 0) {
    return normalizeGroups([
      {
        id: makeId(),
        name: '그룹 1',
        stations: loadedStations
      }
    ])
  }

  return null
}

const pickStationCore = (station) => ({
  id: String(station?.id || '').trim(),
  name: String(station?.name || ''),
  code: String(station?.code || ''),
  classification: station?.classification || '일반 지점'
})

const normalizeSectionForStorage = (section) => ({
  ...section,
  hOffset: section?.hOffset ?? '0'
})

const normalizeMeasurementForStorage = (measurement) => ({
  ...measurement
})

const normalizeProcessPlanForStorage = (processPlan) =>
  Array.from({ length: 12 }, (_, idx) => String(processPlan?.[idx] ?? ''))

const buildStationRecordPayload = (group, groupIndex, station, stationIndex, rowType) => {
  const normalizedStation = normalizeStation(station)
  const stationCore = pickStationCore(normalizedStation)

  const common = {
    version: 4,
    rowType,
    groupId: group.id,
    groupName: group.name || '그룹 없음',
    groupOrder: groupIndex,
    stationOrder: stationIndex,
    stationId: stationCore.id,
    station: stationCore
  }

  if (rowType === APP_STATE_STATION_ROW_VARIANTS.INFO) {
    return common
  }

  if (rowType === APP_STATE_STATION_ROW_VARIANTS.SECTIONS) {
    return {
      ...common,
      sections: normalizedStation.sections.map(normalizeSectionForStorage)
    }
  }

  if (rowType === APP_STATE_STATION_ROW_VARIANTS.MEASUREMENTS) {
    return {
      ...common,
      measurements: normalizedStation.measurements.map(normalizeMeasurementForStorage)
    }
  }

  if (rowType === APP_STATE_STATION_ROW_VARIANTS.PROCESS_PLAN) {
    return {
      ...common,
      processPlan: normalizeProcessPlanForStorage(normalizedStation.processPlan)
    }
  }

  return common
}

const buildStationRecordDescriptors = (groups, scope) => {
  const records = []
  normalizeGroups(groups).forEach((group, groupIndex) => {
    (group.stations || []).forEach((station, stationIndex) => {
      const normalizedStation = normalizeStation(station)
      ;[
        APP_STATE_STATION_ROW_VARIANTS.INFO,
        APP_STATE_STATION_ROW_VARIANTS.SECTIONS,
        APP_STATE_STATION_ROW_VARIANTS.MEASUREMENTS,
        APP_STATE_STATION_ROW_VARIANTS.PROCESS_PLAN
      ].forEach((variant) => {
        records.push({
          rowId: makeScopedStationRowId(scope, normalizedStation.id, variant),
          stationId: normalizedStation.id,
          groupId: group.id,
          groupName: group.name || '그룹 없음',
          groupOrder: groupIndex,
          stationOrder: stationIndex,
          rowType: variant,
          payload: buildStationRecordPayload(
            group,
            groupIndex,
            normalizedStation,
            stationIndex,
            variant
          )
        })
      })
    })
  })
  return records
}

const extractGroupsFromStationRows = (rows) => {
  const safeRows = Array.isArray(rows) ? rows : []
  const stationsById = new Map()

  safeRows.forEach((row, fallbackIndex) => {
    const payload = row?.payload || {}
    const rowMeta = parseScopedStationRowId(row?.id)
    const stationFromPayload = isPlainObject(payload.station) ? payload.station : {}
    const stationId = String(
      payload.stationId ||
      stationFromPayload.id ||
      rowMeta?.stationId ||
      ''
    ).trim() || makeId()

    if (!stationsById.has(stationId)) {
      stationsById.set(stationId, {
        stationId,
        rows: {
          info: null,
          sections: null,
          measurements: null,
          processPlan: null
        },
        legacyRows: [],
        order: fallbackIndex,
        groupId: '',
        groupName: '그룹 없음',
        groupOrder: fallbackIndex,
        stationOrder: fallbackIndex
      })
    }

    const bucket = stationsById.get(stationId)
    bucket.order = Math.min(bucket.order ?? fallbackIndex, fallbackIndex)

    const groupOrderValue = num(payload.groupOrder)
    const stationOrderValue = num(payload.stationOrder)
    if (groupOrderValue !== null) {
      bucket.groupOrder = Math.min(bucket.groupOrder ?? groupOrderValue, groupOrderValue)
    }
    if (stationOrderValue !== null) {
      bucket.stationOrder = Math.min(bucket.stationOrder ?? stationOrderValue, stationOrderValue)
    }

    const variant =
      String(payload.rowType || rowMeta?.variant || '').trim() ||
      (payload.version >= 4 ? APP_STATE_STATION_ROW_VARIANTS.INFO : 'legacy')

    const entry = {
      row,
      fallbackIndex
    }

    if (variant === APP_STATE_STATION_ROW_VARIANTS.INFO) {
      bucket.rows.info = entry
    } else if (variant === APP_STATE_STATION_ROW_VARIANTS.SECTIONS) {
      bucket.rows.sections = entry
    } else if (variant === APP_STATE_STATION_ROW_VARIANTS.MEASUREMENTS) {
      bucket.rows.measurements = entry
    } else if (variant === APP_STATE_STATION_ROW_VARIANTS.PROCESS_PLAN) {
      bucket.rows.processPlan = entry
    } else {
      bucket.legacyRows.push(entry)
    }
  })

  const stationEntries = Array.from(stationsById.values()).map((bucket) => {
    const rowCandidates = [
      bucket.rows.info?.row,
      bucket.rows.sections?.row,
      bucket.rows.measurements?.row,
      bucket.rows.processPlan?.row,
      bucket.legacyRows[0]?.row
    ].filter(Boolean)

    const baseRow = rowCandidates[0] || null
    const basePayload = baseRow?.payload || {}

    const coreCandidates = [
      bucket.rows.info?.row?.payload?.station,
      bucket.rows.sections?.row?.payload?.station,
      bucket.rows.measurements?.row?.payload?.station,
      bucket.rows.processPlan?.row?.payload?.station,
      bucket.legacyRows[0]?.row?.payload?.station,
      basePayload.station
    ].filter(isPlainObject)

    const mergedCore = coreCandidates.reduce(
      (acc, candidate) => ({
        ...acc,
        ...pickStationCore(candidate)
      }),
      {
        id: bucket.stationId,
        name: '',
        code: '',
        classification: '일반 지점'
      }
    )

    const sectionsPayload =
      bucket.rows.sections?.row?.payload?.sections ||
      bucket.legacyRows[0]?.row?.payload?.station?.sections ||
      basePayload.station?.sections ||
      []

    const measurementsPayload =
      bucket.rows.measurements?.row?.payload?.measurements ||
      bucket.legacyRows[0]?.row?.payload?.station?.measurements ||
      basePayload.station?.measurements ||
      []

    const processPlanPayload =
      bucket.rows.processPlan?.row?.payload?.processPlan ||
      bucket.legacyRows[0]?.row?.payload?.station?.processPlan ||
      basePayload.station?.processPlan ||
      []

    const station = normalizeStation({
      ...mergedCore,
      sections: Array.isArray(sectionsPayload) ? sectionsPayload : [],
      measurements: Array.isArray(measurementsPayload) ? measurementsPayload : [],
      processPlan: Array.isArray(processPlanPayload) ? processPlanPayload : []
    })

    const groupId = String(
      bucket.rows.info?.row?.payload?.groupId ||
      bucket.rows.sections?.row?.payload?.groupId ||
      bucket.rows.measurements?.row?.payload?.groupId ||
      bucket.rows.processPlan?.row?.payload?.groupId ||
      bucket.legacyRows[0]?.row?.payload?.groupId ||
      basePayload.groupId ||
      ''
    ).trim() || `group_${bucket.order}`

    const groupName = String(
      bucket.rows.info?.row?.payload?.groupName ||
      bucket.rows.sections?.row?.payload?.groupName ||
      bucket.rows.measurements?.row?.payload?.groupName ||
      bucket.rows.processPlan?.row?.payload?.groupName ||
      bucket.legacyRows[0]?.row?.payload?.groupName ||
      basePayload.groupName ||
      '그룹 없음'
    ).trim() || '그룹 없음'

      const preferredPayload =
      bucket.rows.info?.row?.payload ||
      bucket.rows.sections?.row?.payload ||
      bucket.rows.measurements?.row?.payload ||
      bucket.rows.processPlan?.row?.payload ||
      bucket.legacyRows[0]?.row?.payload ||
      basePayload

    const groupOrder = num(preferredPayload?.groupOrder)
    const stationOrder = num(preferredPayload?.stationOrder)

    return {
      id: bucket.stationId,
      station,
      groupId,
      groupName,
      groupOrder: groupOrder ?? bucket.groupOrder ?? bucket.order,
      stationOrder: stationOrder ?? bucket.stationOrder ?? bucket.order
    }
  })

  const grouped = new Map()

  stationEntries.forEach((entry) => {
    if (!grouped.has(entry.groupId)) {
      grouped.set(entry.groupId, {
        id: entry.groupId,
        name: entry.groupName || '그룹 없음',
        order: entry.groupOrder ?? entry.stationOrder ?? 0,
        stations: []
      })
    }

    const group = grouped.get(entry.groupId)
    group.name = group.name || entry.groupName || '그룹 없음'
    group.order = Math.min(
      group.order ?? entry.groupOrder ?? entry.stationOrder ?? 0,
      entry.groupOrder ?? entry.stationOrder ?? 0
    )
    group.stations.push({ station: entry.station, order: entry.stationOrder ?? 0 })
  })

  const result = Array.from(grouped.values()).map((group) => ({
    ...group,
    stations: group.stations.map(({ station, order }) => ({
      ...station,
      order
    }))
  }))

  return sortGroupsAndStationsByOrder(result)
}
const cloneSerializable = (value) => {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isIdObjectArray = (value) =>
  Array.isArray(value) && value.every((item) => isPlainObject(item) && 'id' in item)

const deepEqualSerializable = (a, b) => {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

const mergeThreeWaySerializable = (base, current, remote) => {
  if (deepEqualSerializable(current, base)) {
    return cloneSerializable(remote)
  }

  if (deepEqualSerializable(remote, base)) {
    return cloneSerializable(current)
  }

  if (Array.isArray(base) || Array.isArray(current) || Array.isArray(remote)) {
    if (isIdObjectArray(base) && isIdObjectArray(current) && isIdObjectArray(remote)) {
      return mergeIdObjectArrayThreeWay(base, current, remote)
    }

    return mergeArrayByIndexThreeWay(base, current, remote)
  }

  if (isPlainObject(base) || isPlainObject(current) || isPlainObject(remote)) {
    const baseObj = isPlainObject(base) ? base : {}
    const currentObj = isPlainObject(current) ? current : {}
    const remoteObj = isPlainObject(remote) ? remote : {}
    const keys = new Set([
      ...Object.keys(baseObj),
      ...Object.keys(currentObj),
      ...Object.keys(remoteObj)
    ])

    const result = {}
    keys.forEach((key) => {
      result[key] = mergeThreeWaySerializable(baseObj[key], currentObj[key], remoteObj[key])
    })
    return result
  }

  return cloneSerializable(current !== undefined ? current : remote)
}

const mergeArrayByIndexThreeWay = (base = [], current = [], remote = []) => {
  const baseArr = Array.isArray(base) ? base : []
  const currentArr = Array.isArray(current) ? current : []
  const remoteArr = Array.isArray(remote) ? remote : []
  const maxLength = Math.max(baseArr.length, currentArr.length, remoteArr.length)
  const merged = []

  for (let i = 0; i < maxLength; i += 1) {
    merged.push(mergeThreeWaySerializable(baseArr[i], currentArr[i], remoteArr[i]))
  }

  return merged
}

const mergeIdObjectArrayThreeWay = (base = [], current = [], remote = []) => {
  const baseMap = new Map((Array.isArray(base) ? base : []).map((item) => [item.id, item]))
  const currentMap = new Map((Array.isArray(current) ? current : []).map((item) => [item.id, item]))
  const remoteMap = new Map((Array.isArray(remote) ? remote : []).map((item) => [item.id, item]))

  const orderedIds = []
  const pushIds = (items) => {
    ;(Array.isArray(items) ? items : []).forEach((item) => {
      if (!item || item.id === undefined || item.id === null) return
      if (!orderedIds.includes(item.id)) orderedIds.push(item.id)
    })
  }

  pushIds(current)
  pushIds(remote)
  pushIds(base)

  const merged = []
  orderedIds.forEach((id) => {
    const baseItem = baseMap.get(id)
    const currentExists = currentMap.has(id)
    const remoteExists = remoteMap.has(id)

    if (!currentExists && !remoteExists) return

    if (!currentExists && baseItem) {
      return
    }

    if (currentExists && !remoteExists) {
      merged.push(cloneSerializable(currentMap.get(id)))
      return
    }

    if (!currentExists && remoteExists && !baseItem) {
      merged.push(cloneSerializable(remoteMap.get(id)))
      return
    }

    if (currentExists && remoteExists) {
      merged.push(
        mergeThreeWaySerializable(baseItem, currentMap.get(id), remoteMap.get(id))
      )
    }
  })

  return merged
}

const SHARED_TABLE_STYLE = {
  tableLayout: 'auto',
  width: 'max-content',
  minWidth: '100%'
}


const HRFCO_API_KEY_STORAGE_KEY = 'hrfco-api-key-v1'
const SAVE_METRICS_KEY = 'hydro-pwa-save-metrics-v1'

const DEFAULT_SAVE_METRICS = {
  attempts: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  mergeSuccesses: 0,
  totalMs: 0,
  lastDurationMs: 0,
  lastOutcome: '',
  lastError: '',
  lastSavedAt: '',
  lastReason: ''
}

const createDefaultSaveMetrics = () => ({
  ...DEFAULT_SAVE_METRICS
})

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

const normalizeHrfcoStationName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_.·•,()\[\]{}<>/\|:;~`'"!?@#$%^&*=+]/g, '')

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

const floorToTenMinuteSlot = (date) => {
  const d = new Date(date.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() - (d.getMinutes() % 10))
  return d
}

const getHrfcoQueryEndTime = (referenceTime = new Date()) => {
  const base = referenceTime instanceof Date && !Number.isNaN(referenceTime.getTime())
    ? new Date(referenceTime.getTime())
    : new Date()

  // 최근 완료된 10분 시점까지만 조회한다.
  // 예) 15:01~15:09 -> 15:00, 15:10~15:19 -> 15:10
  return floorToTenMinuteSlot(base)
}

const fetchLatestHrfcoWaterLevel = async (apiKey, stationName, referenceTime = new Date()) => {
  const trimmedApiKey = String(apiKey || '').trim()
  const trimmedStationName = String(stationName || '').trim()
  const clickTime = referenceTime instanceof Date && !Number.isNaN(referenceTime.getTime())
    ? new Date(referenceTime.getTime())
    : new Date()

  if (!trimmedApiKey) {
    throw new Error('API 키가 비어 있습니다.')
  }
  if (!trimmedStationName) {
    throw new Error('지점명이 비어 있습니다.')
  }

  const stationCode = await findHrfcoStationCodeByName(trimmedApiKey, trimmedStationName)
  const queryEndTime = getHrfcoQueryEndTime(clickTime)

  const fallbackWindows = [72, 24, 6] // hours
  const rowMap = new Map()

  for (const hours of fallbackWindows) {
    const start = new Date(queryEndTime.getTime() - hours * 60 * 60 * 1000)
    const url = `https://api.hrfco.go.kr/${encodeURIComponent(trimmedApiKey)}/waterlevel/list/10M/${encodeURIComponent(stationCode)}/${formatHrfcoDateTime(start)}/${formatHrfcoDateTime(queryEndTime)}.xml`

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

const buildCurrentWaterEntries = (station, currentValue, previousValue, currentTime = '') => {
  const historicalEntries = (station.measurements || [])
    .map((measurement) => {
      const value = roundTo(measurement.h, 2)
      if (value === null) return null

      return {
        value,
        display: fmt(value, 2),
        isCurrent: false,
        exactMatch: false,
        trend: '',
        currentTime: '',
        measurementYear: getYearLabel(measurement.datetime)
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.value - b.value)

  const entries = historicalEntries

  if (currentValue !== null && currentValue !== undefined) {
    const currentRounded = roundTo(currentValue, 2)
    if (currentRounded !== null) {
      const exactMatch = historicalEntries.some((item) => item.value === currentRounded)
      const previousRounded = roundTo(previousValue, 2)

      let symbol = '-'
      if (previousRounded !== null) {
        if (currentRounded > previousRounded) symbol = '▲'
        else if (currentRounded < previousRounded) symbol = '▼'
      }

      entries.push({
        value: currentRounded,
        display: `${fmt(currentRounded, 2)} ${symbol}`,
        isCurrent: true,
        exactMatch,
        trend: symbol === '▲' ? 'up' : symbol === '▼' ? 'down' : 'same',
        currentTime,
        measurementYear: getYearLabel(currentTime || new Date())
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

function calcInstrumentConvertedFlow(station, waterLevel, measurementDatetime = null) {
  const hValue = num(waterLevel)
  if (hValue === null) return null

  const sections = Array.isArray(station?.sections) ? station.sections : []
  const section = findSectionByH(hValue, sections, measurementDatetime)
  if (!section) return null

  const q = calcQ(hValue, section)
  return q === null ? null : q
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
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 768 : false
  )

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768)
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const getColumnMinWidth = (col) => {
    const baseWidth = col.width || col.minWidth || (isCompactTable ? '72px' : '78px')

    if (!isMobile) {
      return isCompactTable ? baseWidth : baseWidth
    }

    if (col.key === 'periodStart' || col.key === 'periodEnd') {
      return col.mobileWidth || col.mobileMinWidth || '340px'
    }

    if (col.key === 'datetime') {
      return col.mobileWidth || col.mobileMinWidth || '320px'
    }

    return col.mobileWidth || col.mobileMinWidth || baseWidth
  }

  const getColumnWidth = (col) => {
    if (!isMobile && isCompactTable) {
      return undefined
    }

    const baseWidth = col.width || col.minWidth || (isCompactTable ? '72px' : '78px')

    if (!isMobile) return baseWidth

    if (col.key === 'periodStart' || col.key === 'periodEnd') {
      return col.mobileWidth || col.mobileMinWidth || '340px'
    }

    if (col.key === 'datetime') {
      return col.mobileWidth || col.mobileMinWidth || '320px'
    }

    return col.mobileWidth || col.mobileMinWidth || baseWidth
  }

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

  const tableStyle = isCompactTable && !isMobile
    ? {
        tableLayout: 'auto',
        width: '100%',
        minWidth: '100%'
      }
    : {
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
              {columns.map((col) => {
                const cellMinWidth = getColumnMinWidth(col)
                const cellWidth = getColumnWidth(col)
                const isStretchDesktop = isCompactTable && !isMobile

                return (
                  <th
                    key={col.key}
                    style={{
                      minWidth: cellMinWidth,
                      ...(cellWidth ? { width: cellWidth } : {}),
                      ...(isStretchDesktop ? { width: 'auto' } : {}),
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {col.label}
                  </th>
                )
              })}
              <th style={{ width: isCompactTable && !isMobile ? '56px' : undefined }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.id}>
                {columns.map((col, colIndex) => {
                  const cellMinWidth = getColumnMinWidth(col)
                  const cellWidth = getColumnWidth(col)
                  const isStretchDesktop = isCompactTable && !isMobile

                  return (
                    <td
                      key={col.key}
                      className={isSelected(rowIndex, colIndex) ? 'selected-cell' : ''}
                      onMouseDown={() => handleMouseDown(rowIndex, colIndex)}
                      onMouseEnter={() => handleMouseEnter(rowIndex, colIndex)}
                      style={{
                        minWidth: cellMinWidth,
                        ...(cellWidth ? { width: cellWidth } : {}),
                        ...(isStretchDesktop ? { width: 'auto' } : {})
                      }}
                    >
                      <input
                        className="cell-input"
                        style={{
  display: 'block',
  minWidth: cellMinWidth,
  width: isStretchDesktop ? '100%' : (cellWidth || '100%'),
  boxSizing: 'border-box',

  minHeight: isMobile ? '34px' : '35px',
  padding: isMobile ? '4px' : '6px',

  fontSize: isMobile ? '12px' : '13px',
  fontWeight: '400'
}}
                        data-cell={`${rowIndex}-${colIndex}`}
                        type={col.type || 'text'}
                        value={row[col.key] ?? ''}
                        onFocus={() => selectCell(rowIndex, colIndex)}
                        onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                        onChange={(e) => setCell(rowIndex, col.key, e.target.value)}
                        onPaste={(e) => handlePaste(e, rowIndex, colIndex)}
                      />
                    </td>
                  )
                })}
                <td
                  className="delete-cell"
                  style={{ width: isCompactTable && !isMobile ? '56px' : undefined }}
                >
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



const formatYmdhm = (ymdhm) => {
  const s = String(ymdhm || '')
  if (s.length < 12) return ''
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`
}

const formatMonthLabel = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

const formatDateTimeDisplay = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

const formatDateTimeLocal = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`
}

const getChartDefaultRange = () => {
  const today6 = new Date()
  today6.setHours(6, 0, 0, 0)

  const yesterday6 = new Date(today6)
  yesterday6.setDate(today6.getDate() - 1)

  return {
    start: formatDateTimeLocal(yesterday6),
    end: formatDateTimeLocal(today6)
  }
}

const cloneDate = (date) => new Date(date.getTime())

const getInstrumentReferenceDate = (referenceTime = new Date()) => {
  if (referenceTime instanceof Date && !Number.isNaN(referenceTime.getTime())) {
    return cloneDate(referenceTime)
  }
  return new Date()
}

const getInstrumentQueryEndTime = (referenceTime = new Date()) => {
  const base = getInstrumentReferenceDate(referenceTime)
  return floorToTenMinuteSlot(base)
}

const getInstrumentYearStart = (referenceTime = new Date()) => {
  const base = getInstrumentReferenceDate(referenceTime)
  return new Date(base.getFullYear(), 0, 1, 0, 10, 0, 0)
}

const getMonthStart = (date) => {
  const base = getInstrumentReferenceDate(date)
  return new Date(base.getFullYear(), base.getMonth(), 1, 0, 10, 0, 0)
}

const addMonths = (date, months) => {
  const base = getInstrumentReferenceDate(date)
  return new Date(base.getFullYear(), base.getMonth() + months, 1, 0, 10, 0, 0)
}

const getMonthEnd = (monthStart, referenceTime = new Date()) => {
  const start = getInstrumentReferenceDate(monthStart)
  const nextMonthStart = new Date(start.getFullYear(), start.getMonth() + 1, 1, 0, 0, 0, 0)
  const monthEnd = floorToTenMinuteSlot(new Date(nextMonthStart.getTime() - 10 * 60 * 1000))
  const queryEnd = getInstrumentQueryEndTime(referenceTime)

  if (start.getFullYear() === queryEnd.getFullYear() && start.getMonth() === queryEnd.getMonth()) {
    return queryEnd
  }

  return monthEnd
}

const sortYmdhmList = (values, ascending = true) => {
  const unique = Array.from(new Set((values || []).filter(Boolean)))
  unique.sort((a, b) => String(a).localeCompare(String(b)))
  return ascending ? unique : unique.reverse()
}

const buildInstrumentFilteredStations = (groups, groupFilter, classificationFilter, stationSelection) => {
  const flattened = Array.isArray(groups)
    ? groups.flatMap((group, groupIndex) =>
        (group.stations || []).map((station, stationIndex) => ({
          ...station,
          groupId: group.id,
          groupName: group.name || '그룹 없음',
          groupIndex,
          stationIndex
        }))
      )
    : []

  return flattened
    .filter((station) => groupFilter === '전체' || station.groupName === groupFilter)
    .filter((station) => {
      const classification = station.classification || '일반 지점'
      return classificationFilter === '전체' || classification === classificationFilter
    })
    .filter((station) => {
      if (Array.isArray(stationSelection)) {
        if (stationSelection.length === 0) return false
        return stationSelection.includes(station.id)
      }
      return stationSelection === '전체' || station.id === stationSelection
    })
    .sort((a, b) => {
      if (a.groupIndex !== b.groupIndex) return a.groupIndex - b.groupIndex
      return a.stationIndex - b.stationIndex
    })
}
const buildInstrumentStationOptions = (groups, groupFilter) => {
  const flattened = Array.isArray(groups)
    ? groups.flatMap((group, groupIndex) => {
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
    : []

  return ['전체', ...flattened]
}

const INSTRUMENT_CHART_BASE_YEAR = 2026

const makeInstrumentDate = (year, monthIndex, day, hour, minute) =>
  new Date(year, monthIndex, day, hour, minute, 0, 0)

const INSTRUMENT_CHART_PERIOD_OPTIONS = [
  {
    key: 'all',
    label: '전체기간',
    start: makeInstrumentDate(2026, 0, 1, 0, 10),
    end: makeInstrumentDate(2027, 0, 1, 0, 0)
  },
  {
    key: 'q1',
    label: '1분기',
    start: makeInstrumentDate(2026, 0, 1, 0, 10),
    end: makeInstrumentDate(2026, 3, 1, 0, 0)
  },
  {
    key: 'q2',
    label: '2분기',
    start: makeInstrumentDate(2026, 3, 1, 0, 10),
    end: makeInstrumentDate(2026, 6, 1, 0, 0)
  },
  {
    key: 'q3',
    label: '3분기',
    start: makeInstrumentDate(2026, 6, 1, 0, 10),
    end: makeInstrumentDate(2026, 9, 1, 0, 0)
  },
  {
    key: 'q4',
    label: '4분기',
    start: makeInstrumentDate(2026, 9, 1, 0, 10),
    end: makeInstrumentDate(2027, 0, 1, 0, 0)
  }
]

const INSTRUMENT_CHART_CUSTOM_PERIOD = {
  key: 'custom',
  label: '사용자 지정 기간'
}

const parseInstrumentChartDateTime = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime())
  }

  return parseDateTime(value)
}

const formatChartLinearTick = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return `${value}`
  const date = new Date(n)
  if (Number.isNaN(date.getTime())) return `${value}`
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const formatChartTooltipDateTime = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return `${value}`
  const date = new Date(n)
  if (Number.isNaN(date.getTime())) return `${value}`
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

const parseYmdhmToDate = (ymdhm) => {
  const s = String(ymdhm || '')
  if (s.length < 12) return null

  const yyyy = Number(s.slice(0, 4))
  const mm = Number(s.slice(4, 6))
  const dd = Number(s.slice(6, 8))
  const hh = Number(s.slice(8, 10))
  const mi = Number(s.slice(10, 12))

  if (![yyyy, mm, dd, hh, mi].every((n) => Number.isFinite(n))) return null
  const date = new Date(yyyy, mm - 1, dd, hh, mi, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

const splitInstrumentChartRangeByMonth = (startTime, endTime) => {
  const start = parseInstrumentChartDateTime(startTime)
  const end = parseInstrumentChartDateTime(endTime)
  if (!start || !end || start > end) return []

  const ranges = []
  let cursor = new Date(start.getTime())

  while (cursor < end) {
    const nextMonthStart = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      1,
      0,
      0,
      0,
      0
    )
    const chunkEnd = nextMonthStart < end ? nextMonthStart : new Date(end.getTime())

    ranges.push({
      start: new Date(cursor.getTime()),
      end: new Date(chunkEnd.getTime())
    })

    if (chunkEnd.getTime() === end.getTime()) break
    cursor = chunkEnd
  }

  return ranges
}

const getInstrumentChartPeriodRange = (periodKey, customStartTime, customEndTime) => {
  if (periodKey === INSTRUMENT_CHART_CUSTOM_PERIOD.key) {
    const start = parseInstrumentChartDateTime(customStartTime)
    const end = parseInstrumentChartDateTime(customEndTime)
    if (!start || !end) return null

    return {
      key: 'custom',
      label: `${formatDateTimeDisplay(start)} ~ ${formatDateTimeDisplay(end)}`,
      start,
      end
    }
  }

  const preset = INSTRUMENT_CHART_PERIOD_OPTIONS.find((option) => option.key === periodKey)
  if (!preset) return INSTRUMENT_CHART_PERIOD_OPTIONS[0]

  return {
    ...preset,
    start: new Date(preset.start.getTime()),
    end: new Date(preset.end.getTime())
  }
}

const buildInstrumentWaterLevelChartOptions = (
  range,
  yMinValue,
  yMaxValue,
  yAxisTitle = '수위 h(m)',
  tooltipValueLabel = 'h'
) => {
  const min = range?.start instanceof Date && !Number.isNaN(range.start.getTime())
    ? range.start.getTime()
    : undefined
  const max = range?.end instanceof Date && !Number.isNaN(range.end.getTime())
    ? range.end.getTime()
    : undefined
  const yMin = safeScaleNumber(yMinValue, 'linear')
  const yMax = safeScaleNumber(yMaxValue, 'linear')

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'nearest',
      intersect: false
    },
    scales: {
      x: {
        type: 'linear',
        min,
        max,
        title: {
          display: true,
          text: '시간',
          color: '#111',
          font: {
            size: 14,
            weight: '700'
          }
        },
        grid: {
          color: 'rgba(0,0,0,0.14)',
          lineWidth: 1
        },
        ticks: {
          color: '#222',
          callback: (value) => formatChartLinearTick(value)
        }
      },
      y: {
        type: 'linear',
        min: yMin,
        max: yMax,
        title: {
          display: true,
          text: yAxisTitle,
          color: '#111',
          font: {
            size: 14,
            weight: '700'
          }
        },
        grid: {
          color: 'rgba(0,0,0,0.14)',
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
        display: true,
        position: 'right',
        labels: {
          usePointStyle: true,
          boxWidth: 12,
          boxHeight: 12
        }
      },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const x = ctx.parsed.x
            const y = ctx.parsed.y
            return `${ctx.dataset.label}: ${formatChartTooltipDateTime(x)} / ${tooltipValueLabel}=${fmt(y, 3)}`
          }
        }
      }
    }
  }
}

function InstrumentWaterLevelChart({
  title,
  subtitle,
  datasets,
  range,
  height = 460,
  yMin,
  yMax,
  yAxisTitle = '수위 h(m)',
  tooltipValueLabel = 'h',
  zoomX = 1,
  zoomY = 1
}) {
  const options = useMemo(
    () => buildInstrumentWaterLevelChartOptions(range, yMin, yMax, yAxisTitle, tooltipValueLabel),
    [range, yMin, yMax, yAxisTitle, tooltipValueLabel]
  )

  return (
    <div className="subcard" style={{ marginBottom: '16px' }}>
      <h3 style={{ marginBottom: '6px' }}>{title}</h3>
      {subtitle ? <p className="muted" style={{ marginBottom: '10px' }}>{subtitle}</p> : null}
      <div style={{ overflow: 'auto' }}>
        <div
          style={{
            width: `${Math.max(100, Math.round(zoomX * 100))}%`,
            minWidth: '100%',
            height: `${Math.max(320, Math.round(height * zoomY))}px`
          }}
        >
          <Scatter data={{ datasets }} options={options} />
        </div>
      </div>
    </div>
  )
}

const runWithConcurrency = async (items, limit, worker) => {
  const safeItems = Array.isArray(items) ? items : []
  if (safeItems.length === 0) return []

  const results = new Array(safeItems.length)
  let nextIndex = 0

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit || 1, safeItems.length)) },
    async () => {
      while (nextIndex < safeItems.length) {
        const index = nextIndex
        nextIndex += 1
        try {
          results[index] = await worker(safeItems[index], index)
        } catch (error) {
          results[index] = { error }
        }
      }
    }
  )

  await Promise.all(runners)
  return results
}

const fetchHrfcoWaterLevelRowsBetween = async (apiKey, stationName, startTime, endTime) => {
  const trimmedApiKey = String(apiKey || '').trim()
  const trimmedStationName = String(stationName || '').trim()
  const start = startTime instanceof Date && !Number.isNaN(startTime.getTime()) ? cloneDate(startTime) : null
  const end = endTime instanceof Date && !Number.isNaN(endTime.getTime()) ? cloneDate(endTime) : null

  if (!trimmedApiKey) {
    throw new Error('API 키가 비어 있습니다.')
  }
  if (!trimmedStationName) {
    throw new Error('지점명이 비어 있습니다.')
  }
  if (!start || !end) {
    throw new Error('조회 기간이 올바르지 않습니다.')
  }

  const stationCode = await findHrfcoStationCodeByName(trimmedApiKey, trimmedStationName)
  const url = `https://api.hrfco.go.kr/${encodeURIComponent(trimmedApiKey)}/waterlevel/list/10M/${encodeURIComponent(stationCode)}/${formatHrfcoDateTime(start)}/${formatHrfcoDateTime(end)}.xml`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`수위 자료 조회 실패 (${response.status})`)
  }

  const xmlText = await response.text()
  const rows = extractHrfcoWaterLevelRowsFromXml(xmlText, stationCode, trimmedStationName)
  rows.sort((a, b) => b.ymdhm.localeCompare(a.ymdhm))
  return rows
}

const mergeRowsByStation = (baseRowsByStation, additions) => {
  const next = { ...(baseRowsByStation || {}) }
  Object.entries(additions || {}).forEach(([stationId, rowsMap]) => {
    next[stationId] = {
      ...(next[stationId] || {}),
      ...(rowsMap || {})
    }
  })
  return next
}

function VirtualizedHistoryTable({ stationColumns, times, ascending = false, showConvertedFlow = false }) {
  const containerRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const rowHeight = showConvertedFlow ? 44 : 34
  const height = 560
  const overscan = 10
  const totalRows = times.length
  const visibleCount = Math.ceil(height / rowHeight) + overscan * 2
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const endIndex = Math.min(totalRows, startIndex + visibleCount)
  const visibleTimes = times.slice(startIndex, endIndex)
  const topSpacer = startIndex * rowHeight
  const bottomSpacer = Math.max(0, (totalRows - endIndex) * rowHeight)
  const colCount = 1 + stationColumns.reduce((acc, col) => acc + (showConvertedFlow ? 2 : 1), 0)

  // 첫 번째 헤더줄 높이만큼 두 번째 줄을 내려줌
  const headerRowHeight = 56
  const subHeaderTop = showConvertedFlow ? headerRowHeight : 0

  useEffect(() => {
    setScrollTop(0)
    if (containerRef.current) {
      containerRef.current.scrollTop = 0
    }
  }, [stationColumns, times, ascending, showConvertedFlow])

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{
        maxHeight: `${height}px`,
        overflow: 'auto',
        border: '1px solid rgba(0,0,0,0.12)',
        borderRadius: '10px'
      }}
    >
      <table
        className="spreadsheet"
        style={{ tableLayout: 'auto', width: 'max-content', minWidth: '100%' }}
      >
        <thead>
          <tr>
            <th
              rowSpan={showConvertedFlow ? 2 : 1}
              style={{
                position: 'sticky',
                top: 0,
                left: 0,
                zIndex: 6,
                background: '#fff',
                whiteSpace: 'nowrap'
              }}
            >
              시간
            </th>

            {stationColumns.map((col) => (
              <th
                key={col.station.id}
                colSpan={showConvertedFlow ? 2 : 1}
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 5,
                  background: '#fff',
                  whiteSpace: 'nowrap',
                  minWidth: showConvertedFlow ? '184px' : '96px'
                }}
              >
                <div>{col.station.name || '지점 없음'}</div>
                <div className="muted" style={{ fontSize: '12px' }}>
                  {col.station.code || '코드 없음'}
                </div>
              </th>
            ))}
          </tr>

          {showConvertedFlow ? (
            <tr>
              {stationColumns.map((col) => (
                <React.Fragment key={`${col.station.id}-subheader`}>
                  <th
                    style={{
                      position: 'sticky',
                      top: subHeaderTop,
                      zIndex: 4,
                      background: '#fff',
                      whiteSpace: 'nowrap',
                      minWidth: '92px'
                    }}
                  >
                    수위(h)
                  </th>
                  <th
                    style={{
                      position: 'sticky',
                      top: subHeaderTop,
                      zIndex: 4,
                      background: '#fff',
                      whiteSpace: 'nowrap',
                      minWidth: '92px'
                    }}
                  >
                    환산유량(Q)
                  </th>
                </React.Fragment>
              ))}
            </tr>
          ) : null}
        </thead>

        <tbody>
          {topSpacer > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={colCount} style={{ height: `${topSpacer}px`, padding: 0, border: 'none' }} />
            </tr>
          ) : null}

          {visibleTimes.map((time) => (
            <tr key={time} style={{ height: `${rowHeight}px` }}>
              <td
                style={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 2,
                  background: '#fff',
                  whiteSpace: 'nowrap',
                  fontWeight: 600
                }}
              >
                {formatYmdhm(time)}
              </td>

              {stationColumns.map((col) =>
                showConvertedFlow ? (
                  <React.Fragment key={`${col.station.id}-${time}`}>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                      {col.rowsMap?.[time] === null ||
                      col.rowsMap?.[time] === undefined ||
                      col.rowsMap?.[time] === ''
                        ? ''
                        : fmt(col.rowsMap[time], 2)}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                      {col.flowRowsMap?.[time] === null ||
                      col.flowRowsMap?.[time] === undefined ||
                      col.flowRowsMap?.[time] === ''
                        ? ''
                        : fmt(col.flowRowsMap[time], 3)}
                    </td>
                  </React.Fragment>
                ) : (
                  <td key={`${col.station.id}-${time}`} style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                    {col.rowsMap?.[time] === null ||
                    col.rowsMap?.[time] === undefined ||
                    col.rowsMap?.[time] === ''
                      ? ''
                      : fmt(col.rowsMap[time], 2)}
                  </td>
                )
              )}
            </tr>
          ))}

          {bottomSpacer > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={colCount} style={{ height: `${bottomSpacer}px`, padding: 0, border: 'none' }} />
            </tr>
          ) : null}
        </tbody>
      </table>
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
  const [currentWaterBaseTime, setCurrentWaterBaseTime] = useState('')
  const topScrollRef = useRef(null)
  const bodyScrollRef = useRef(null)
  const [scrollContentWidth, setScrollContentWidth] = useState(0)
  const currentYear = String(new Date().getFullYear())

  const groupOptions = useMemo(() => ['전체', ...groups.map((group) => group.name || '그룹 없음')], [groups])

  const stationOptions = useMemo(
    () => buildInstrumentStationOptions(groups, groupFilter),
    [groups, groupFilter]
  )

  useEffect(() => {
    if (stationFilter === '전체') return
    const exists = stationOptions.some((option) => option !== '전체' && option.id === stationFilter)
    if (!exists) setStationFilter('전체')
  }, [stationOptions, stationFilter])

  const filteredStations = useMemo(
    () => buildInstrumentFilteredStations(groups, groupFilter, classificationFilter, stationFilter),
    [groups, groupFilter, classificationFilter, stationFilter]
  )

  const stationColumns = useMemo(() => {
    return filteredStations.map((station) => {
      const result = currentWaterResults[station.id] || {}
      return {
        station,
        currentWater: result.currentWater ?? null,
        currentTime: result.currentTime || '',
        error: result.error || '',
        entries: buildCurrentWaterEntries(
          station,
          result.currentWater,
          result.previousWater,
          result.currentTime
        )
      }
    })
  }, [filteredStations, currentWaterResults])

  const maxRows = useMemo(() => stationColumns.reduce((max, col) => Math.max(max, col.entries.length), 0), [stationColumns])

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
    setCurrentWaterBaseTime('')

    try {
      const results = await Promise.all(
        filteredStations.map(async (station) => {
          const stationName = String(station.name || '').trim()
          const previous = currentWaterResults[station.id] || {
            currentWater: null,
            currentTime: '',
            previousWater: null,
            previousTime: '',
            error: ''
          }

          if (!stationName) {
            return [station.id, { ...previous, error: '지점명 없음' }]
          }

          try {
            const latest = await fetchLatestHrfcoWaterLevel(apiKey, stationName, new Date())
            if (latest && latest.current && latest.current.value !== null && latest.current.value !== undefined) {
              return [station.id, {
                currentWater: latest.current.value,
                currentTime: latest.current.ymdhm,
                previousWater: latest.previous?.value ?? null,
                previousTime: latest.previous?.ymdhm ?? '',
                error: ''
              }]
            }

            return [station.id, {
              ...previous,
              error: '최근 수위를 찾지 못했습니다.'
            }]
          } catch (error) {
            return [station.id, {
              ...previous,
              error: error instanceof Error ? error.message : '조회 실패'
            }]
          }
        })
      )

      const firstSuccess = results.find(([, data]) => data?.currentTime)
      if (firstSuccess?.[1]?.currentTime) {
        setCurrentWaterBaseTime(firstSuccess[1].currentTime)
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
        <h2>빈수위 찾기</h2>
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

          <div
            className="grid-actions"
            style={{ alignSelf: 'end', display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <button className="btn" onClick={handleFetchCurrentWater} disabled={isFetching}>
              {isFetching ? '조회 중...' : '현재 수위'}
            </button>

            {currentWaterBaseTime ? (
              <span className="muted" style={{ fontSize: '14px' }}>
                {`${formatYmdhm(currentWaterBaseTime)} 기준`}
              </span>
            ) : null}
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
                overflowX: 'auto',
                overflowY: 'hidden',
                height: '16px',
                marginBottom: '6px'
              }}
            >
              <div style={{ width: `${Math.max(scrollContentWidth, stationColumns.length * 120)}px`, height: '1px' }} />
            </div>

            <div ref={bodyScrollRef} className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="spreadsheet" style={{ tableLayout: 'auto', width: 'max-content' }}>
                <thead>
                  <tr>
                    {stationColumns.map((col) => (
                      <th
                        key={col.station.id}
                        style={{
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
                        const isThisYear = entry?.measurementYear === currentYear

const bg = isCurrent
  ? (entry.exactMatch ? '#bfefff' : '#ff6b6b')
  : isThisYear
    ? '#fff8cc'
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

function InstrumentMeasurementPage({ groups, hrfcoApiKey, onHrfcoApiKeyChange }) {
  const [classificationFilter, setClassificationFilter] = useState('전체')
  const [groupFilter, setGroupFilter] = useState('전체')
  const [stationDraftIds, setStationDraftIds] = useState([])
  const [stationSelectedIds, setStationSelectedIds] = useState([])
  const [stationPickerOpen, setStationPickerOpen] = useState(false)
  const stationSelectionInitializedRef = useRef(false)
  const [periodKey, setPeriodKey] = useState('3h')
  const [customStartTime, setCustomStartTime] = useState('')
  const [customEndTime, setCustomEndTime] = useState('')

  const [historyRowsByStation, setHistoryRowsByStation] = useState({})
  const [historyTimes, setHistoryTimes] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyStatus, setHistoryStatus] = useState('')
  const [historyMode, setHistoryMode] = useState('period')
  const [historyLoadedLabel, setHistoryLoadedLabel] = useState('')
  const [showConvertedFlow, setShowConvertedFlow] = useState(false)
  const [chartPeriodKey, setChartPeriodKey] = useState('all')
  const defaultChartRange = getChartDefaultRange()
  const [chartCustomStartTime, setChartCustomStartTime] = useState(defaultChartRange.start)
  const [chartCustomEndTime, setChartCustomEndTime] = useState(defaultChartRange.end)
  const [chartSeparateCharts, setChartSeparateCharts] = useState(false)
  const [chartLoading, setChartLoading] = useState(false)
  const [chartStatus, setChartStatus] = useState('')
  const [generatedCharts, setGeneratedCharts] = useState([])
  const [generatedChartLabel, setGeneratedChartLabel] = useState('')
  const [flowChartLoading, setFlowChartLoading] = useState(false)
  const [flowChartStatus, setFlowChartStatus] = useState('')
  const [generatedFlowCharts, setGeneratedFlowCharts] = useState([])
  const [generatedFlowChartLabel, setGeneratedFlowChartLabel] = useState('')
  const [waterChartYMin, setWaterChartYMin] = useState('')
  const [waterChartYMax, setWaterChartYMax] = useState('')
  const [flowChartYMin, setFlowChartYMin] = useState('')
  const [flowChartYMax, setFlowChartYMax] = useState('')
  const [instrumentChartZoomX, setInstrumentChartZoomX] = useState(1)
  const [instrumentChartZoomY, setInstrumentChartZoomY] = useState(1)

  const periodOptions = useMemo(
    () => [
      { key: '3h', label: '3시간', hours: 3 },
      { key: '6h', label: '6시간', hours: 6 },
      { key: '12h', label: '12시간', hours: 12 },
      { key: '1d', label: '1일', hours: 24 },
      { key: 'all', label: '전체', hours: null },
      { key: 'custom', label: '사용자 지정 기간', hours: null }
    ],
    []
  )

  const periodMap = useMemo(() => Object.fromEntries(periodOptions.map((item) => [item.key, item])), [periodOptions])

  const groupOptions = useMemo(() => ['전체', ...groups.map((group) => group.name || '그룹 없음')], [groups])

  const stationOptions = useMemo(
    () => buildInstrumentStationOptions(groups, groupFilter).filter((item) => item !== '전체'),
    [groups, groupFilter]
  )

  useEffect(() => {
    const validIds = new Set(stationOptions.map((s) => s.id))
    setStationDraftIds((prev) => prev.filter((id) => validIds.has(id)))
    setStationSelectedIds((prev) => prev.filter((id) => validIds.has(id)))
  }, [stationOptions])

  useEffect(() => {
    if (stationSelectionInitializedRef.current) return
    if (stationOptions.length === 0) return

    const ids = stationOptions.map((s) => s.id)
    setStationSelectedIds(ids)
    setStationDraftIds(ids)
    stationSelectionInitializedRef.current = true
  }, [stationOptions])

  const filteredStations = useMemo(
    () =>
      buildInstrumentFilteredStations(
        groups,
        groupFilter,
        classificationFilter,
        stationSelectedIds
      ),
    [groups, groupFilter, classificationFilter, stationSelectedIds]
  )

  const handleStationPickerToggle = () => {
    if (stationPickerOpen) {
      setStationPickerOpen(false)
      return
    }
    setStationDraftIds(stationSelectedIds)
    setStationPickerOpen(true)
  }

  const toggleStationDraft = (stationId) => {
    setStationDraftIds((prev) =>
      prev.includes(stationId) ? prev.filter((id) => id !== stationId) : [...prev, stationId]
    )
  }

  const selectAllStations = () => {
    setStationDraftIds(stationOptions.map((station) => station.id))
  }

  const clearAllStations = () => {
    setStationDraftIds([])
  }

  const confirmStationSelection = () => {
    setStationSelectedIds(stationDraftIds)
    setStationPickerOpen(false)
  }

const stationColumns = useMemo(
    () =>
      filteredStations.map((station) => {
        const rowsMap = historyRowsByStation[station.id] || {}
        const flowRowsMap = {}

        Object.entries(rowsMap).forEach(([ymdhm, value]) => {
          const q = calcInstrumentConvertedFlow(station, value, ymdhm)
          if (q !== null) {
            flowRowsMap[ymdhm] = q
          }
        })

        return { station, rowsMap, flowRowsMap }
      }),
    [filteredStations, historyRowsByStation]
  )
const resetHistory = () => {
    setHistoryRowsByStation({})
    setHistoryTimes([])
    setHistoryLoadedLabel('')
  }

  const fetchHistorySlice = async (startTime, endTime, ascending = false) => {
    const apiKey = String(hrfcoApiKey || '').trim()
    if (!apiKey) {
      throw new Error('API 키를 입력해 주세요.')
    }
    if (filteredStations.length === 0) {
      throw new Error('선택된 지점이 없습니다.')
    }

    const results = await runWithConcurrency(filteredStations, 3, async (station) => {
      const rows = await fetchHrfcoWaterLevelRowsBetween(apiKey, station.name, startTime, endTime)
      return { stationId: station.id, rows }
    })

    const rowsByStation = {}
    const times = []
    let failCount = 0

    results.forEach((result, index) => {
      const station = filteredStations[index]
      if (!result || result.error || !station) {
        failCount += 1
        rowsByStation[station?.id || `missing-${index}`] = {}
        return
      }

      const map = {}
      ;(result.rows || []).forEach((row) => {
        map[row.ymdhm] = row.value
        times.push(row.ymdhm)
      })
      rowsByStation[result.stationId] = map
    })

    return {
      rowsByStation,
      times: sortYmdhmList(times, ascending),
      failCount
    }
  }

  const fetchInstrumentChartHistorySlice = async (startTime, endTime) => {
    const apiKey = String(hrfcoApiKey || '').trim()
    if (!apiKey) {
      throw new Error('API 키를 입력해 주세요.')
    }
    if (filteredStations.length === 0) {
      throw new Error('선택된 지점이 없습니다.')
    }

    const ranges = splitInstrumentChartRangeByMonth(startTime, endTime)
    if (ranges.length === 0) {
      throw new Error('차트 기간을 올바르게 입력해 주세요.')
    }

    const results = await runWithConcurrency(filteredStations, 3, async (station) => {
      const rowMap = new Map()

      for (const range of ranges) {
        try {
          const rows = await fetchHrfcoWaterLevelRowsBetween(
            apiKey,
            station.name,
            range.start,
            range.end
          )
          ;(rows || []).forEach((row) => {
            if (!rowMap.has(row.ymdhm)) {
              rowMap.set(row.ymdhm, row.value)
            }
          })
        } catch {
          // 월 단위 중 일부가 실패해도 나머지 구간은 계속 시도한다.
        }
      }

      if (rowMap.size === 0) {
        throw new Error('수위 자료를 찾지 못했습니다.')
      }

      return {
        stationId: station.id,
        rows: Array.from(rowMap.entries()).map(([ymdhm, value]) => ({
          ymdhm,
          value
        }))
      }
    })

    const rowsByStation = {}
    const times = []
    let failCount = 0

    results.forEach((result, index) => {
      const station = filteredStations[index]
      if (!result || result.error || !station) {
        failCount += 1
        rowsByStation[station?.id || `missing-${index}`] = {}
        return
      }

      const map = {}
      ;(result.rows || []).forEach((row) => {
        map[row.ymdhm] = row.value
        times.push(row.ymdhm)
      })
      rowsByStation[result.stationId] = map
    })

    return {
      rowsByStation,
      times: sortYmdhmList(times, true),
      failCount
    }
  }

  const applyHistorySlice = async (startTime, endTime, mode, ascending = false, append = false, sliceLabel = '') => {
    setHistoryLoading(true)
    setHistoryStatus(`${sliceLabel || '수위 자료'}를 조회하는 중입니다...`)

    try {
      const result = await fetchHistorySlice(startTime, endTime, ascending)
      const label = sliceLabel || '조회'

      setPeriodKey(mode)
      setHistoryMode(mode === 'all' ? 'all' : 'period')
      setHistoryRowsByStation((prev) => (append ? mergeRowsByStation(prev, result.rowsByStation) : result.rowsByStation))
      setHistoryTimes((prev) => (append ? sortYmdhmList([...prev, ...result.times], ascending) : result.times))
      setHistoryLoadedLabel(sliceLabel)
      setHistoryStatus(`${label} 완료${result.failCount > 0 ? ` (실패 ${result.failCount}개 지점)` : ''}`)
      return true
    } catch (error) {
      setHistoryStatus(error instanceof Error ? error.message : '수위 자료 조회 실패')
      return false
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadAllHistoryUntilCurrent = async () => {
    const apiKey = String(hrfcoApiKey || '').trim()
    if (!apiKey) {
      window.alert('API 키를 입력해 주세요.')
      return false
    }
    if (filteredStations.length === 0) {
      window.alert('선택된 지점이 없습니다.')
      return false
    }

    const referenceTime = new Date()
    const yearStart = getInstrumentYearStart(referenceTime)
    const currentMonthStart = getMonthStart(referenceTime)

    const monthStarts = []
    for (let cursor = getMonthStart(yearStart); cursor <= currentMonthStart; cursor = addMonths(cursor, 1)) {
      monthStarts.push(new Date(cursor.getTime()))
    }

    setHistoryLoading(true)
    setHistoryMode('all')
    setPeriodKey('all')
    resetHistory()
    setHistoryStatus('전체 자료를 월별로 불러오는 중입니다...')

    try {
      const aggregatedRowsByStation = {}
      const aggregatedTimes = []
      let failCount = 0

      for (let i = 0; i < monthStarts.length; i += 1) {
        const monthStart = monthStarts[i]
        const monthEnd = getMonthEnd(monthStart, referenceTime)
        setHistoryStatus(`${formatMonthLabel(monthStart)} 자료를 불러오는 중입니다...`)

        const result = await fetchHistorySlice(monthStart, monthEnd, true)
        failCount += result.failCount

        Object.entries(result.rowsByStation).forEach(([stationId, rowsMap]) => {
          aggregatedRowsByStation[stationId] = {
            ...(aggregatedRowsByStation[stationId] || {}),
            ...rowsMap
          }
        })
        aggregatedTimes.push(...result.times)
      }

      setHistoryRowsByStation(aggregatedRowsByStation)
      setHistoryTimes(sortYmdhmList(aggregatedTimes, true))
      setHistoryLoadedLabel(
        monthStarts.length > 0
          ? `${formatMonthLabel(monthStarts[0])} ~ ${formatMonthLabel(monthStarts[monthStarts.length - 1])} 자료`
          : '전체 자료'
      )
      setHistoryStatus(`전체 자료 불러오기 완료${failCount > 0 ? ` (실패 ${failCount}개 지점)` : ''}`)
      return true
    } catch (error) {
      setHistoryStatus(error instanceof Error ? error.message : '전체 자료 조회 실패')
      return false
    } finally {
      setHistoryLoading(false)
    }
  }

  const handleLoadPeriod = async (key) => {
    const selected = periodMap[key]
    if (!selected) return

    if (selected.key === 'all') {
      await loadAllHistoryUntilCurrent()
      return
    }

    const queryEnd = getInstrumentQueryEndTime(new Date())
    const queryStart = new Date(queryEnd.getTime() - selected.hours * 60 * 60 * 1000)
    setHistoryMode('period')
    setPeriodKey(selected.key)
    resetHistory()
    await applyHistorySlice(queryStart, queryEnd, selected.key, false, false, `${selected.label} 자료`)
  }

  const handleLoadCustomPeriod = async () => {
  const startTimeRaw = parseDateTime(customStartTime)
  const endTimeRaw = parseDateTime(customEndTime)

  if (!startTimeRaw || !endTimeRaw) {
    window.alert('시작 시간과 종료 시간을 모두 입력해 주세요.')
    return
  }

  const startTime = floorToTenMinuteSlot(startTimeRaw)
  const endTime = floorToTenMinuteSlot(endTimeRaw)

  if (!startTime || !endTime) {
    window.alert('시간 형식이 올바르지 않습니다.')
    return
  }

  if (startTime > endTime) {
    window.alert('시작 시간은 종료 시간보다 이전이어야 합니다.')
    return
  }

  setHistoryMode('period')
  setPeriodKey('custom')
  resetHistory()
  await applyHistorySlice(
    startTime,
    endTime,
    'custom',
    false,
    false,
    `${formatDateTimeDisplay(startTime)} ~ ${formatDateTimeDisplay(endTime)} 자료`
  )
}

  const handleDownloadHistoryXlsx = () => {
  if (historyTimes.length === 0 || stationColumns.length === 0) {
    window.alert('내보낼 수위 자료가 없습니다.')
    return
  }

  const headers = ['시간']
  stationColumns.forEach((col) => {
    const name = col.station.name || '지점 없음'
    const code = col.station.code ? ` (${col.station.code})` : ''
    if (showConvertedFlow) {
      headers.push(`${name}${code} 수위(h)`)
      headers.push(`${name}${code} 환산유량(Q)`)
    } else {
      headers.push(`${name}${code}`)
    }
  })

  const rows = historyTimes.map((time) => {
    const row = [formatYmdhm(time)]
    stationColumns.forEach((col) => {
      const waterValue = col.rowsMap?.[time]
      row.push(
        waterValue === null ||
        waterValue === undefined ||
        waterValue === ''
          ? ''
          : fmt(waterValue, 2)
      )

      if (showConvertedFlow) {
        const flowValue = col.flowRowsMap?.[time]
        row.push(
          flowValue === null ||
          flowValue === undefined ||
          flowValue === ''
            ? ''
            : fmt(flowValue, 3)
        )
      }
    })
    return row
  })

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '수위자료')

  const fileName = `수위자료_${formatDateTimeDisplay(new Date()).replace(/[:\s]/g, '_')}.xlsx`
  XLSX.writeFile(workbook, fileName)
}

  const chartPeriodRange = useMemo(
    () => getInstrumentChartPeriodRange(chartPeriodKey, chartCustomStartTime, chartCustomEndTime),
    [chartPeriodKey, chartCustomStartTime, chartCustomEndTime]
  )

  const chartPeriodOptions = [...INSTRUMENT_CHART_PERIOD_OPTIONS, INSTRUMENT_CHART_CUSTOM_PERIOD]

  const buildInstrumentChartDatasets = useMemo(() => {
    const chartColorPalette = [...YEAR_COLORS, ...CURVE_COLORS, '#0ea5e9', '#f97316']
    const measurementPointColor = '#d946ef'

    const makeLineDataset = (station, stationIndex, points) => {
      const color = chartColorPalette[stationIndex % chartColorPalette.length]
      return {
        label: `${station.name || '지점 없음'} 수위`,
        data: points,
        showLine: true,
        spanGaps: true,
        pointRadius: 0,
        pointHoverRadius: 0,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: color,
        parsing: false,
        order: 2
      }
    }

    const makeMeasurementDataset = (station, points) => ({
      label: `${station.name || '지점 없음'} 측정성과`,
      data: points,
      showLine: false,
      pointRadius: 5,
      pointHoverRadius: 6,
      borderWidth: 1,
      borderColor: measurementPointColor,
      backgroundColor: measurementPointColor,
      pointStyle: 'rectRot',
      parsing: false,
      order: 1
    })

    const buildStationPoints = (station, rowsByStation, range) => {
      const rawWaterRows = rowsByStation?.[station.id] || {}
      const waterPoints = Object.entries(rawWaterRows)
        .map(([ymdhm, value]) => {
          const date = parseYmdhmToDate(ymdhm)
          const n = Number(value)
          if (!date || !Number.isFinite(n)) return null
          if (range?.start && range?.end && (date < range.start || date > range.end)) return null
          return { x: date.getTime(), y: n }
        })
        .filter(Boolean)
        .sort((a, b) => a.x - b.x)

      const measurementPoints = (station.measurements || [])
        .map((measurement) => {
          const date = parseInstrumentChartDateTime(measurement.datetime)
          const y = num(measurement.h)
          if (!date || y === null) return null
          if (range?.start && range?.end && (date < range.start || date > range.end)) return null
          return { x: date.getTime(), y }
        })
        .filter(Boolean)
        .sort((a, b) => a.x - b.x)

      return { waterPoints, measurementPoints }
    }

    return { makeLineDataset, makeMeasurementDataset, buildStationPoints }
  }, [])

  const generateInstrumentCharts = async () => {
    const apiKey = String(hrfcoApiKey || '').trim()
    if (!apiKey) {
      window.alert('API 키를 입력해 주세요.')
      return
    }
    if (filteredStations.length === 0) {
      window.alert('선택된 지점이 없습니다.')
      return
    }

    if (!chartPeriodRange || !chartPeriodRange.start || !chartPeriodRange.end) {
      window.alert('차트 기간을 올바르게 입력해 주세요.')
      return
    }

    if (chartPeriodRange.start > chartPeriodRange.end) {
      window.alert('시작 시간은 종료 시간보다 이전이어야 합니다.')
      return
    }

    setChartLoading(true)
    setChartStatus('차트 자료를 불러오는 중입니다...')

    try {
      const result = await fetchInstrumentChartHistorySlice(chartPeriodRange.start, chartPeriodRange.end)
      const rowsByStation = result.rowsByStation || {}
      const charts = []
      const datasetBuilder = buildInstrumentChartDatasets

      if (chartSeparateCharts) {
        filteredStations.forEach((station, stationIndex) => {
          const { waterPoints, measurementPoints } = datasetBuilder.buildStationPoints(station, rowsByStation, chartPeriodRange)
          const datasets = []

          if (waterPoints.length > 0) {
            datasets.push(datasetBuilder.makeLineDataset(station, stationIndex, waterPoints))
          }

          if (measurementPoints.length > 0) {
            datasets.push(datasetBuilder.makeMeasurementDataset(station, measurementPoints))
          }

          if (datasets.length > 0) {
            charts.push({
              id: station.id,
              title: `${station.name || '지점 없음'} ${station.code ? `(${station.code})` : ''}`.trim(),
              subtitle: `${chartPeriodRange.label} · ${station.groupName || ''}`.trim(),
              range: chartPeriodRange,
              datasets,
              height: 460
            })
          }
        })
      } else {
        const datasets = []
        filteredStations.forEach((station, stationIndex) => {
          const { waterPoints, measurementPoints } = datasetBuilder.buildStationPoints(station, rowsByStation, chartPeriodRange)

          if (waterPoints.length > 0) {
            datasets.push(datasetBuilder.makeLineDataset(station, stationIndex, waterPoints))
          }

          if (measurementPoints.length > 0) {
            datasets.push(datasetBuilder.makeMeasurementDataset(station, measurementPoints))
          }
        })

        if (datasets.length > 0) {
          charts.push({
            id: 'combined',
            title: `수위 그래프 ${chartPeriodRange.label ? `(${chartPeriodRange.label})` : ''}`.trim(),
            subtitle: `${filteredStations.length}개 지점`,
            range: chartPeriodRange,
            datasets,
            height: 620
          })
        }
      }

      setGeneratedCharts(charts)
      setGeneratedChartLabel(chartPeriodRange.label)
      setChartStatus(
        charts.length > 0
          ? `차트 생성 완료${result.failCount > 0 ? ` (수위 자료 조회 실패 ${result.failCount}개 지점)` : ''}`
          : '해당 기간에 생성할 차트 자료가 없습니다.'
      )
    } catch (error) {
      setChartStatus(error instanceof Error ? error.message : '차트 생성 실패')
      setGeneratedCharts([])
    } finally {
      setChartLoading(false)
    }
  }


  const generateInstrumentFlowCharts = async () => {
    const apiKey = String(hrfcoApiKey || '').trim()
    if (!apiKey) {
      window.alert('API 키를 입력해 주세요.')
      return
    }
    if (filteredStations.length === 0) {
      window.alert('선택된 지점이 없습니다.')
      return
    }

    if (!chartPeriodRange || !chartPeriodRange.start || !chartPeriodRange.end) {
      window.alert('차트 기간을 올바르게 입력해 주세요.')
      return
    }

    if (chartPeriodRange.start > chartPeriodRange.end) {
      window.alert('시작 시간은 종료 시간보다 이전이어야 합니다.')
      return
    }

    setFlowChartLoading(true)
    setFlowChartStatus('환산유량 차트를 생성하는 중입니다...')

    try {
      const result = await fetchInstrumentChartHistorySlice(chartPeriodRange.start, chartPeriodRange.end)
      const rowsByStation = result.rowsByStation || {}
      const charts = []
      const chartColorPalette = [...YEAR_COLORS, ...CURVE_COLORS, '#0ea5e9', '#f97316']
      const measurementPointColor = '#d946ef'

      const buildStationPoints = (station, rowsMap, range) => {
        const flowPoints = Object.entries(rowsMap || {})
          .map(([ymdhm, value]) => {
            const date = parseYmdhmToDate(ymdhm)
            const q = calcInstrumentConvertedFlow(station, value, ymdhm)
            if (!date || q === null || !Number.isFinite(Number(q))) return null
            if (range?.start && range?.end && (date < range.start || date > range.end)) return null
            return { x: date.getTime(), y: Number(q) }
          })
          .filter(Boolean)
          .sort((a, b) => a.x - b.x)

        const measurementPoints = (station.measurements || [])
          .map((measurement) => {
            const date = parseInstrumentChartDateTime(measurement.datetime)
            const y = num(measurement.q)
            if (!date || y === null) return null
            if (range?.start && range?.end && (date < range.start || date > range.end)) return null
            return { x: date.getTime(), y }
          })
          .filter(Boolean)
          .sort((a, b) => a.x - b.x)

        return { flowPoints, measurementPoints }
      }

      const makeFlowDataset = (station, stationIndex, points) => {
        const color = chartColorPalette[stationIndex % chartColorPalette.length]
        return {
          label: `${station.name || '지점 없음'} 환산유량`,
          data: points,
          showLine: true,
          spanGaps: true,
          pointRadius: 0,
          pointHoverRadius: 0,
          borderWidth: 1,
          borderColor: color,
          backgroundColor: color,
          parsing: false,
          order: 2
        }
      }

      const makeMeasurementDataset = (station, points) => ({
        label: `${station.name || '지점 없음'} 측정유량`,
        data: points,
        showLine: false,
        pointRadius: 5,
        pointHoverRadius: 6,
        borderWidth: 1,
        borderColor: measurementPointColor,
        backgroundColor: measurementPointColor,
        pointStyle: 'rectRot',
        parsing: false,
        order: 1
      })

      if (chartSeparateCharts) {
        filteredStations.forEach((station, stationIndex) => {
          const { flowPoints, measurementPoints } = buildStationPoints(
            station,
            rowsByStation[station.id] || {},
            chartPeriodRange
          )

          const datasets = []

          if (flowPoints.length > 0) {
            datasets.push(makeFlowDataset(station, stationIndex, flowPoints))
          }

          if (measurementPoints.length > 0) {
            datasets.push(makeMeasurementDataset(station, measurementPoints))
          }

          if (datasets.length > 0) {
            charts.push({
              id: station.id,
              title: `${station.name || '지점 없음'} ${station.code ? `(${station.code})` : ''}`.trim(),
              subtitle: `${chartPeriodRange.label} · ${station.groupName || ''}`.trim(),
              range: chartPeriodRange,
              datasets,
              height: 460
            })
          }
        })
      } else {
        const datasets = []
        filteredStations.forEach((station, stationIndex) => {
          const { flowPoints, measurementPoints } = buildStationPoints(
            station,
            rowsByStation[station.id] || {},
            chartPeriodRange
          )

          if (flowPoints.length > 0) {
            datasets.push(makeFlowDataset(station, stationIndex, flowPoints))
          }

          if (measurementPoints.length > 0) {
            datasets.push(makeMeasurementDataset(station, measurementPoints))
          }
        })

        if (datasets.length > 0) {
          charts.push({
            id: 'combined-flow',
            title: `환산유량 그래프 ${chartPeriodRange.label ? `(${chartPeriodRange.label})` : ''}`.trim(),
            subtitle: `${filteredStations.length}개 지점`,
            range: chartPeriodRange,
            datasets,
            height: 620
          })
        }
      }

      setGeneratedFlowCharts(charts)
      setGeneratedFlowChartLabel(chartPeriodRange.label)
      setFlowChartStatus(
        charts.length > 0
          ? `환산유량 차트 생성 완료${result.failCount > 0 ? ` (수위 자료 조회 실패 ${result.failCount}개 지점)` : ''}`
          : '해당 기간에 생성할 환산유량 차트 자료가 없습니다.'
      )
    } catch (error) {
      setFlowChartStatus(error instanceof Error ? error.message : '환산유량 차트 생성 실패')
      setGeneratedFlowCharts([])
    } finally {
      setFlowChartLoading(false)
    }
  }

  const sectionColumns = [
  { key: 'name', label: '구간명', minWidth: '86px' },
  { key: 'hMin', label: '적용수위 시작', minWidth: '96px' },
  { key: 'hMax', label: '적용수위 끝', minWidth: '96px' },
  { key: 'hOffset', label: 'H = h + ( )', type: 'number', minWidth: '96px' },
  { key: 'a', label: 'A', minWidth: '64px' },
  { key: 'b', label: 'B', minWidth: '64px' },
  { key: 'c', label: 'C', minWidth: '64px' },
  { key: 'lowNote', label: '저수위 외삽', minWidth: '120px' },
  { key: 'highNote', label: '고수위 외삽', minWidth: '120px' },
  { key: 'periodStart', label: '적용시작', minWidth: '250px', mobileMinWidth: '130px' },
  { key: 'periodEnd', label: '적용종료', minWidth: '250px', mobileMinWidth: '130px' }
]

  const measurementColumns = [
    { key: 'datetime', label: '측정일시', minWidth: '250px', mobileMinWidth: '130px' },
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
    <div>
      <section className="card">
        <div className="section-header">
          <h2>계기수위-측정성과</h2>
          <div className="grid-actions">
            <button
              className={periodKey === '3h' ? 'btn' : 'btn secondary'}
              onClick={() => handleLoadPeriod('3h')}
            >
              3시간
            </button>

            <button
              className={periodKey === '6h' ? 'btn' : 'btn secondary'}
              onClick={() => handleLoadPeriod('6h')}
            >
              6시간
            </button>

            <button
              className={periodKey === '12h' ? 'btn' : 'btn secondary'}
              onClick={() => handleLoadPeriod('12h')}
            >
              12시간
            </button>

            <button
              className={periodKey === '1d' ? 'btn' : 'btn secondary'}
              onClick={() => handleLoadPeriod('1d')}
            >
              1일
            </button>

            <button
              className={periodKey === 'all' ? 'btn' : 'btn secondary'}
              onClick={() => handleLoadPeriod('all')}
            >
              전체
            </button>
          </div>
        </div>

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
            <button
              type="button"
              className="btn secondary"
              onClick={handleStationPickerToggle}
              disabled={stationOptions.length === 0}
            >
              {stationOptions.length === 0
                ? '지점 없음'
                : stationSelectedIds.length === 0
                  ? '선택 없음'
                  : stationSelectedIds.length === stationOptions.length
                    ? '전체 선택됨'
                    : `${stationSelectedIds.length}개 선택됨`}
            </button>
          </label>

          {stationPickerOpen ? (
            <div
              style={{
                border: '1px solid #d0d7de',
                borderRadius: '8px',
                padding: '10px',
                background: '#fff',
                marginTop: '8px',
                maxWidth: '520px'
              }}
            >
              <div className="grid-actions" style={{ marginBottom: '8px' }}>
                <button type="button" className="btn secondary" onClick={selectAllStations}>
                  전체 선택
                </button>
                <button type="button" className="btn secondary" onClick={clearAllStations}>
                  선택 해제
                </button>
              </div>

              <div
                style={{
                  display: 'grid',
                  gap: '4px',
                  maxHeight: '240px',
                  overflowY: 'auto',
                  paddingRight: '2px'
                }}
              >
              {stationOptions.map((station) => {
  const checked = stationDraftIds.includes(station.id)

  return (
    <button
      key={station.id}
      type="button"
      onClick={() => toggleStationDraft(station.id)}
      style={{
        display: 'grid',
        gridTemplateColumns: '18px 1fr',
        alignItems: 'center',
        columnGap: '8px',
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        border: '1px solid #d0d7de',
        borderRadius: '6px',
        background: checked ? '#e8f1ff' : '#fff',
        boxSizing: 'border-box',
        minHeight: '40px'
      }}
    >
      <input
        type="checkbox"
        readOnly
        checked={checked}
        style={{
          width: '14px',
          height: '14px',
          margin: 0,
          accentColor: '#1f6feb',
          justifySelf: 'center'
        }}
      />

      <span
        style={{
          fontSize: '13px',
          lineHeight: '1.3',
          whiteSpace: 'normal',
          wordBreak: 'keep-all',
          overflowWrap: 'break-word'
        }}
      >
        {station.label}
      </span>
    </button>
  )
})}  
              </div>

              <div className="grid-actions" style={{ marginTop: '8px' }}>
                <button type="button" className="btn" onClick={confirmStationSelection}>
                  확인
                </button>
              </div>
            </div>
          ) : null}

<label>
            API 키
            <input
              type="text"
              value={hrfcoApiKey}
              onChange={(e) => onHrfcoApiKeyChange(e.target.value)}
              placeholder="HRFCO API 키"
            />
          </label>
        </div>

        <div className="row" style={{ marginTop: '12px', alignItems: 'end' }}>
          <div className="muted" style={{ minWidth: '120px', fontWeight: 600, paddingBottom: '2px' }}>
            사용자 지정 기간
          </div>

          <label style={{ minWidth: '250px' }}>
  시작시간
  <input
    type="datetime-local"
    step="600"
    value={customStartTime}
    onChange={(e) => {
      const d = parseDateTime(e.target.value)
      if (!d) {
        setCustomStartTime('')
        return
      }
      const rounded = floorToTenMinuteSlot(d)
      setCustomStartTime(formatDateTimeLocal(rounded))
    }}
     style={{
      width: '240px',
      maxWidth: '100%'
    }}
  />
</label>

<label style={{ minWidth: '250px' }}>
  종료시간
  <input
    type="datetime-local"
    step="600"
    value={customEndTime}
    onChange={(e) => {
      const d = parseDateTime(e.target.value)
      if (!d) {
        setCustomEndTime('')
        return
      }
      const rounded = floorToTenMinuteSlot(d)
      setCustomEndTime(formatDateTimeLocal(rounded))
    }}
     style={{
      width: '240px',
      maxWidth: '100%'
    }}
  />
</label>

          <div className="grid-actions" style={{ alignSelf: 'end' }}>
            <button className="btn secondary" onClick={handleLoadCustomPeriod} disabled={historyLoading}>
              기간 불러오기
            </button>
          </div>
        </div>

        <div className="muted" style={{ marginTop: '8px' }}>
          선택된 지점 수: {filteredStations.length}개 · 현재 탭: {periodMap[periodKey]?.label || '미선택'}
          {historyLoadedLabel ? ` · 불러온 구간: ${historyLoadedLabel}` : ''}
        </div>
        {historyStatus ? (
          <div className="muted" style={{ marginTop: '4px' }}>
            {historyStatus}
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="section-header">
          <h2>수위 자료</h2>
          <div className="grid-actions">
  <button
    className="btn secondary"
    onClick={handleDownloadHistoryXlsx}
    disabled={historyTimes.length === 0}
  >
    엑셀 저장
  </button>

  <button
    className="btn secondary"
    onClick={() => setShowConvertedFlow((prev) => !prev)}
    disabled={historyTimes.length === 0}
  >
    {showConvertedFlow ? '환산유량 숨기기' : '환산유량 추가'}
  </button>
</div>
        </div>
        {stationColumns.length === 0 ? (
          <div className="muted">선택된 지점이 없습니다.</div>
        ) : historyTimes.length === 0 ? (
          <div className="muted">조회 버튼을 눌러 수위 자료를 불러오세요.</div>
        ) : (
          <VirtualizedHistoryTable
            stationColumns={stationColumns}
            times={historyTimes}
            ascending={historyMode === 'all'}
            showConvertedFlow={showConvertedFlow}
          />
        )}
        <p className="muted" style={{ marginTop: '8px' }}>
          3시간, 6시간, 12시간, 1일은 최근 시각 기준 내림차순으로 불러오고, 전체는 올해 1월 1일 00:10부터 현재 시각까지 월 단위로 자동으로 이어서 불러옵니다. 사용자 지정 기간은 시작 시간과 종료 시간을 입력해 조회합니다.
        </p>
      </section>

      <section className="card">
        <div className="section-header">
          <h2>차트 생성</h2>
          <div className="grid-actions">
            <button className="btn secondary" onClick={generateInstrumentCharts} disabled={chartLoading}>
              {chartLoading ? '생성 중...' : '수위 차트 생성'}
            </button>
            <button className="btn secondary" onClick={generateInstrumentFlowCharts} disabled={flowChartLoading}>
              {flowChartLoading ? '생성 중...' : '유량 차트 생성'}
            </button>
          </div>
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: '220px', display: 'flex', flexDirection: 'column' }}>
  <div className="muted" style={{ fontWeight: 600, marginBottom: '6px' }}>
    기간 선택
  </div>

  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
    {chartPeriodOptions.map((option) => (
      <label
        key={option.key}
        style={{
          display: 'grid',
          gridTemplateColumns: '18px auto',
          alignItems: 'center',
          columnGap: '6px',
          margin: 0,
          cursor: 'pointer',
          lineHeight: 1.2
        }}
      >
        <input
          type="radio"
          name="instrument-chart-period"
          value={option.key}
          checked={chartPeriodKey === option.key}
          onChange={() => setChartPeriodKey(option.key)}
          style={{
            margin: 0,
            width: '14px',
            height: '14px'
          }}
        />
        <span style={{ margin: 0 }}>{option.label}</span>
      </label>
    ))}
    <label
  style={{
    display: 'grid',
    gridTemplateColumns: '18px auto',
    alignItems: 'center',
    columnGap: '6px',
    margin: 0,
    cursor: 'pointer',
    lineHeight: 1.2
  }}
>
  <input
    type="checkbox"
    checked={chartSeparateCharts}
    onChange={(e) => setChartSeparateCharts(e.target.checked)}
    style={{
      margin: 0,
      width: '14px',
      height: '14px'
    }}
  />
  <span style={{ margin: 0 }}>각각 차트 생성</span>
</label>
  </div>
</div>

          <div style={{ minWidth: '220px', display: 'grid', gap: '10px' }}>
            <label>
  시작시간
  <input
    type="datetime-local"
    step="600"
    value={chartCustomStartTime}
    onChange={(e) => {
      const d = parseDateTime(e.target.value)
      if (!d) {
        setChartCustomStartTime('')
        return
      }
      const rounded = floorToTenMinuteSlot(d)
      setChartCustomStartTime(formatDateTimeLocal(rounded))
    }}
    disabled={chartPeriodKey !== 'custom'}
     style={{
    width: '240px'
  }}
  />
</label>

<label>
  종료시간
  <input
    type="datetime-local"
    step="600"
    value={chartCustomEndTime}
    onChange={(e) => {
      const d = parseDateTime(e.target.value)
      if (!d) {
        setChartCustomEndTime('')
        return
      }
      const rounded = floorToTenMinuteSlot(d)
      setChartCustomEndTime(formatDateTimeLocal(rounded))
    }}
    disabled={chartPeriodKey !== 'custom'}
    style={{
    width: '240px'
  }}
  />
</label>
          </div>
        </div>

        {generatedChartLabel ? (
          <div className="muted" style={{ marginTop: '4px' }}>
            선택 기간: {generatedChartLabel}
          </div>
        ) : null}

        {chartStatus ? (
          <div className="muted" style={{ marginTop: '4px' }}>
            {chartStatus}
          </div>
        ) : null}
        {flowChartStatus ? (
          <div className="muted" style={{ marginTop: '4px' }}>
            {flowChartStatus}
          </div>
        ) : null}

        <div className="chart-settings">
  <div className="chart-setting-card">
    <h3>수위 그래프 축 설정</h3>
    <div className="chart-setting-grid">
      <label>
        Y축 최소
        <input
          type="number"
          step="any"
          value={waterChartYMin}
          onChange={(e) => setWaterChartYMin(e.target.value)}
        />
      </label>
      <label>
        Y축 최대
        <input
          type="number"
          step="any"
          value={waterChartYMax}
          onChange={(e) => setWaterChartYMax(e.target.value)}
        />
      </label>
    </div>
  </div>

  <div className="chart-setting-card">
    <h3>환산유량 그래프 축 설정</h3>
    <div className="chart-setting-grid">
      <label>
        Y축 최소
        <input
          type="number"
          step="any"
          value={flowChartYMin}
          onChange={(e) => setFlowChartYMin(e.target.value)}
        />
      </label>
      <label>
        Y축 최대
        <input
          type="number"
          step="any"
          value={flowChartYMax}
          onChange={(e) => setFlowChartYMax(e.target.value)}
        />
      </label>
    </div>
  </div>
</div>


        <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span className="muted" style={{ minWidth: '44px' }}>가로</span>
            <button type="button" className="btn secondary" onClick={() => setInstrumentChartZoomX((prev) => Math.max(0.5, Number((prev - 0.25).toFixed(2))))}>-</button>
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.25"
              value={instrumentChartZoomX}
              onChange={(e) => setInstrumentChartZoomX(Number(e.target.value))}
              aria-label="계기수위 그래프 가로 확대/축소"
              style={{ flex: '1 1 220px', minWidth: '180px' }}
            />
            <button type="button" className="btn secondary" onClick={() => setInstrumentChartZoomX((prev) => Math.min(3, Number((prev + 0.25).toFixed(2))))}>+</button>
            <button type="button" className="btn secondary" onClick={() => setInstrumentChartZoomX(1)}>기본</button>
            <span className="muted">{instrumentChartZoomX.toFixed(2)}x</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span className="muted" style={{ minWidth: '44px' }}>세로</span>
            <button type="button" className="btn secondary" onClick={() => setInstrumentChartZoomY((prev) => Math.max(0.5, Number((prev - 0.25).toFixed(2))))}>-</button>
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.25"
              value={instrumentChartZoomY}
              onChange={(e) => setInstrumentChartZoomY(Number(e.target.value))}
              aria-label="계기수위 그래프 세로 확대/축소"
              style={{ flex: '1 1 220px', minWidth: '180px' }}
            />
            <button type="button" className="btn secondary" onClick={() => setInstrumentChartZoomY((prev) => Math.min(3, Number((prev + 0.25).toFixed(2))))}>+</button>
            <button type="button" className="btn secondary" onClick={() => setInstrumentChartZoomY(1)}>기본</button>
            <span className="muted">{instrumentChartZoomY.toFixed(2)}x</span>
          </div>
        </div>

        {generatedCharts.length > 0 ? (
          <div style={{ marginTop: '14px' }}>
            {generatedCharts.map((chart) => (
             <InstrumentWaterLevelChart
  key={chart.id}
  title={chart.title}
  subtitle={chart.subtitle}
  datasets={chart.datasets}
  range={chart.range}
  height={chart.height}
  yMin={waterChartYMin}
  yMax={waterChartYMax}
  yAxisTitle="수위 h(m)"
  tooltipValueLabel="h"
  zoomX={instrumentChartZoomX}
  zoomY={instrumentChartZoomY}
/> 
            ))}
          </div>
        ) : null}

        {generatedFlowCharts.length > 0 ? (
          <div style={{ marginTop: '14px' }}>
            <h3 style={{ marginBottom: '8px' }}>유량 차트 {generatedFlowChartLabel ? `(${generatedFlowChartLabel})` : ''}</h3>
            {generatedFlowCharts.map((chart) => (
  <InstrumentWaterLevelChart
  key={chart.id}
  title={chart.title}
  subtitle={chart.subtitle}
  datasets={chart.datasets}
  range={chart.range}
  height={chart.height}
  yMin={flowChartYMin}
  yMax={flowChartYMax}
  yAxisTitle="환산유량 Q(m³/s)"
  tooltipValueLabel="Q"
  zoomX={instrumentChartZoomX}
  zoomY={instrumentChartZoomY}
/>
))}
          </div>
        ) : null}
      </section>
    </div>
  )
}
export default function App() {
  const storageScope = useMemo(() => getAppStorageScope(), [])
  const APP_STATE_ID = useMemo(() => makeScopedAppStateId(storageScope), [storageScope])
  const APP_STATE_DRAFT_STORAGE_KEY = useMemo(
    () => makeScopedStorageKey(APP_STATE_DRAFT_KEY, storageScope),
    [storageScope]
  )
  const APP_STATE_SYNC_STORAGE_KEY = useMemo(
    () => makeScopedStorageKey(APP_STATE_SYNC_KEY, storageScope),
    [storageScope]
  )
  const HRFCO_API_KEY_STORAGE_KEY_SCOPED = useMemo(
    () => makeScopedStorageKey(HRFCO_API_KEY_STORAGE_KEY, storageScope),
    [storageScope]
  )
  const SAVE_METRICS_STORAGE_KEY = useMemo(
    () => makeScopedStorageKey(SAVE_METRICS_KEY, storageScope),
    [storageScope]
  )
  const CLIENT_ID = useMemo(() => getStoredClientId(storageScope), [storageScope])

  const [groups, setGroups] = useState(() => DEFAULT_GROUPS)
  const [stationsLoaded, setStationsLoaded] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState(() => DEFAULT_GROUPS[0].id)
  const [selectedStationId, setSelectedStationId] = useState(() => DEFAULT_GROUPS[0].stations[0].id)
  const [measurementYearFilter, setMeasurementYearFilter] = useState('전체')
  const [relativeErrorYearFilter, setRelativeErrorYearFilter] = useState('전체')
  const [relativeErrorSort, setRelativeErrorSort] = useState('기본')
  const [activeTab, setActiveTab] = useState('management')
  const [instrumentSubTab, setInstrumentSubTab] = useState('current')
  const [swipeStart, setSwipeStart] = useState(null)
    const tabFlow = useMemo(
    () => [
      { activeTab: 'management', instrumentSubTab: null },
      { activeTab: 'process', instrumentSubTab: null },
      { activeTab: 'instrument', instrumentSubTab: 'current' },
      { activeTab: 'instrument', instrumentSubTab: 'history' }
    ],
    []
  )

  const getCurrentSwipeIndex = () => {
    return tabFlow.findIndex((item) => {
      if (item.activeTab !== activeTab) return false
      if (item.activeTab === 'instrument') {
        return item.instrumentSubTab === instrumentSubTab
      }
      return true
    })
  }

  const moveSwipeTab = (direction) => {
    const currentIndex = getCurrentSwipeIndex()
    if (currentIndex < 0) return

    const nextIndex = currentIndex + direction
    if (nextIndex < 0 || nextIndex >= tabFlow.length) return

    const next = tabFlow[nextIndex]
    setActiveTab(next.activeTab)
    if (next.activeTab === 'instrument') {
      setInstrumentSubTab(next.instrumentSubTab || 'current')
    }
  }

  const shouldIgnoreSwipeTarget = (target) => {
    if (!(target instanceof Element)) return true
    return Boolean(
      target.closest(
        'input, select, textarea, button, .table-wrap, .chart-wrapper, .chart-box, .chart-legend'
      )
    )
  }

  const handleTouchStart = (e) => {
    if (typeof window === 'undefined' || window.innerWidth > 768) return
    if (shouldIgnoreSwipeTarget(e.target)) return

    const touch = e.touches[0]
    if (!touch) return

    setSwipeStart({
      x: touch.clientX,
      y: touch.clientY
    })
  }

  const handleTouchEnd = (e) => {
    if (typeof window === 'undefined' || window.innerWidth > 768) return
    if (!swipeStart) return

    const touch = e.changedTouches[0]
    if (!touch) {
      setSwipeStart(null)
      return
    }

    const dx = touch.clientX - swipeStart.x
    const dy = touch.clientY - swipeStart.y

    const minDistance = 50
    if (Math.abs(dx) < minDistance || Math.abs(dx) < Math.abs(dy)) {
      setSwipeStart(null)
      return
    }

    if (dx < 0) {
      moveSwipeTab(1)
    } else {
      moveSwipeTab(-1)
    }

    setSwipeStart(null)
  }

  const handleTouchCancel = () => {
    setSwipeStart(null)
  }
  const [hrfcoApiKey, setHrfcoApiKey] = useState(() => {
    try {
      return localStorage.getItem(HRFCO_API_KEY_STORAGE_KEY_SCOPED) || ''
    } catch {
      return ''
    }
  })
  const [saveStatus, setSaveStatus] = useState('저장 대기 중')
  const [lastSavedAt, setLastSavedAt] = useState('')
  const [saveMetrics, setSaveMetrics] = useState(() => {
    const loaded = safeReadJson(SAVE_METRICS_STORAGE_KEY, null)
    return {
      ...createDefaultSaveMetrics(),
      ...(isPlainObject(loaded) ? loaded : {})
    }
  })

  const groupsRef = useRef(groups)
  const lastCommittedGroupsRef = useRef(cloneSerializable(groups))
  const lastServerUpdatedAtRef = useRef('')
  const lastServerRevisionRef = useRef(null)
  const supportsRevisionRef = useRef(null)
  const appStateReadyRef = useRef(false)
  const saveTimerRef = useRef(null)
  const retryTimerRef = useRef(null)
  const saveInFlightRef = useRef(false)
  const dirtyRef = useRef(false)
  const suppressNextPersistRef = useRef(false)
  const savingReasonRef = useRef('')
  const saveMetricsRef = useRef(saveMetrics)

  useEffect(() => {
    saveMetricsRef.current = saveMetrics
    safeWriteJson(SAVE_METRICS_STORAGE_KEY, saveMetrics)
  }, [saveMetrics, SAVE_METRICS_STORAGE_KEY])

  const pushSaveMetrics = (updater) => {
    setSaveMetrics((prev) => {
      const base = isPlainObject(prev) ? prev : createDefaultSaveMetrics()
      const next = typeof updater === 'function' ? updater(base) : { ...base, ...updater }
      const normalized = {
        ...createDefaultSaveMetrics(),
        ...(isPlainObject(next) ? next : {})
      }
      saveMetricsRef.current = normalized
      return normalized
    })
  }

  const queueNextSave = (delay = APP_STATE_SAVE_DEBOUNCE_MS, reason = 'queued') => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void flushAppStateSave(reason)
    }, delay)
  }

  const readServerAppState = async (id) => {
    const selectFields =
      supportsRevisionRef.current === false ? 'payload, updated_at' : 'payload, updated_at, revision'

    let response = await supabase
      .from('app_state')
      .select(selectFields)
      .eq('id', id)
      .maybeSingle()

    if (
      response.error &&
      supportsRevisionRef.current !== false &&
      isMissingRevisionColumnError(response.error)
    ) {
      supportsRevisionRef.current = false
      response = await supabase
        .from('app_state')
        .select('payload, updated_at')
        .eq('id', id)
        .maybeSingle()
    }

    if (response.error) {
      throw response.error
    }

    return response.data || null
  }

  const readServerStationRows = async () => {
    const selectFields =
      supportsRevisionRef.current === false ? 'id, payload, updated_at' : 'id, payload, updated_at, revision'
    const prefix = makeScopedStationRowPrefix(storageScope)

    let response = await supabase
      .from('app_state')
      .select(selectFields)
      .like('id', `${prefix}%`)
      .order('id', { ascending: true })

    if (
      response.error &&
      supportsRevisionRef.current !== false &&
      isMissingRevisionColumnError(response.error)
    ) {
      supportsRevisionRef.current = false
      response = await supabase
        .from('app_state')
        .select('id, payload, updated_at')
        .like('id', `${prefix}%`)
        .order('id', { ascending: true })
    }

    if (response.error) {
      throw response.error
    }

    return response.data || []
  }

  const readServerStationRow = async (rowId) => {
    const selectFields =
      supportsRevisionRef.current === false ? 'id, payload, updated_at' : 'id, payload, updated_at, revision'

    let response = await supabase
      .from('app_state')
      .select(selectFields)
      .eq('id', rowId)
      .maybeSingle()

    if (
      response.error &&
      supportsRevisionRef.current !== false &&
      isMissingRevisionColumnError(response.error)
    ) {
      supportsRevisionRef.current = false
      response = await supabase
        .from('app_state')
        .select('id, payload, updated_at')
        .eq('id', rowId)
        .maybeSingle()
    }

    if (response.error) {
      throw response.error
    }

    return response.data || null
  }

  const persistStationRow = async ({
    rowId,
    payload,
    expectedUpdatedAt = '',
    expectedRevision = null,
    allowInsert = true
  }) => {
    const startedAt = new Date().toISOString()
    const revisionSupported = supportsRevisionRef.current !== false
    const safeExpectedRevision = toSafeRevision(expectedRevision)

    if (revisionSupported) {
      if (safeExpectedRevision === null && allowInsert) {
        const insertedRevision = 1
        const { data, error } = await supabase
          .from('app_state')
          .insert({
            id: rowId,
            payload,
            updated_at: startedAt,
            revision: insertedRevision
          })
          .select('id, updated_at, payload, revision')
          .maybeSingle()

        if (error) {
          if (isMissingRevisionColumnError(error)) {
            supportsRevisionRef.current = false
            return persistStationRow({
              rowId,
              payload,
              expectedUpdatedAt,
              expectedRevision: null,
              allowInsert
            })
          }

          if (isDuplicateKeyError(error)) {
            return null
          }

          throw error
        }

        return data || null
      }

      if (safeExpectedRevision !== null) {
        const nextRevision = safeExpectedRevision + 1
        const query = supabase
          .from('app_state')
          .update({
            payload,
            updated_at: startedAt,
            revision: nextRevision
          })
          .eq('id', rowId)
          .eq('revision', safeExpectedRevision)

        const { data, error } = await query.select('id, updated_at, payload, revision').maybeSingle()
        if (error) {
          if (isMissingRevisionColumnError(error)) {
            supportsRevisionRef.current = false
            return persistStationRow({
              rowId,
              payload,
              expectedUpdatedAt,
              expectedRevision: null,
              allowInsert
            })
          }
          throw error
        }
        return data || null
      }
    }

    if (!expectedUpdatedAt && allowInsert) {
      const { data, error } = await supabase
        .from('app_state')
        .upsert(
          {
            id: rowId,
            payload,
            updated_at: startedAt
          },
          { onConflict: 'id' }
        )
        .select('id, updated_at, payload')
        .maybeSingle()

      if (error) throw error
      return data || null
    }

    const query = supabase
      .from('app_state')
      .update({
        payload,
        updated_at: startedAt
      })
      .eq('id', rowId)

    if (expectedUpdatedAt) {
      query.eq('updated_at', expectedUpdatedAt)
    }

    const { data, error } = await query.select('id, updated_at, payload').maybeSingle()
    if (error) throw error
    return data || null
  }

  const deleteStationRow = async (rowId) => {
    const { error } = await supabase.from('app_state').delete().eq('id', rowId)
    if (error) throw error
    return true
  }

  const applyLoadedState = (nextGroups, nextUpdatedAt = '', nextRevision = null, message = '서버 값을 다시 불러왔습니다.') => {
    const normalizedGroups = normalizeGroups(nextGroups)
    suppressNextPersistRef.current = true
    groupsRef.current = normalizedGroups
    setGroups(normalizedGroups)
    lastCommittedGroupsRef.current = cloneSerializable(normalizedGroups)
    lastServerUpdatedAtRef.current = String(nextUpdatedAt || lastServerUpdatedAtRef.current || '')
    lastServerRevisionRef.current = toSafeRevision(nextRevision)
    dirtyRef.current = false
    setSaveStatus(message)
  }

  const flushAppStateSave = async (reason = 'manual', retryCount = 0) => {
    if (!stationsLoaded || !appStateReadyRef.current) return
    if (saveInFlightRef.current) {
      dirtyRef.current = true
      return
    }

    const saveStartedAt = typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now()

    pushSaveMetrics((prev) => ({
      ...prev,
      attempts: (prev.attempts || 0) + 1,
      lastReason: reason,
      lastOutcome: 'saving',
      lastError: ''
    }))

    clearTimeout(saveTimerRef.current)
    clearTimeout(retryTimerRef.current)
    saveTimerRef.current = null
    retryTimerRef.current = null

    if (!dirtyRef.current && reason !== 'force' && reason !== 'retry') {
      return
    }

    saveInFlightRef.current = true
    savingReasonRef.current = reason
    setSaveStatus(reason === 'retry' ? '저장 재시도 중...' : '저장 중...')

    const currentGroups = normalizeGroups(groupsRef.current)
    const currentRecords = buildStationRecordDescriptors(currentGroups, storageScope)
    const baseRecords = buildStationRecordDescriptors(lastCommittedGroupsRef.current || [], storageScope)
    const currentMap = new Map(currentRecords.map((record) => [record.rowId, record]))
    const baseMap = new Map(baseRecords.map((record) => [record.rowId, record]))

    try {
      const latestStationRows = await readServerStationRows().catch(() => [])
      const latestStationMap = new Map(
        (Array.isArray(latestStationRows) ? latestStationRows : []).map((row) => [String(row.id || ''), row])
      )
      const latestHasV3Rows = latestStationRows.length > 0

      const saveOneRecord = async (currentRecord, baseRecord, remoteRow, depth = 0) => {
        const basePayload = baseRecord?.payload ?? null
        const currentPayload = currentRecord.payload
        const remotePayload = remoteRow?.payload ?? null
        const currentEqualsBase = baseRecord ? deepEqualSerializable(currentPayload, basePayload) : false
        const remoteEqualsBase = baseRecord ? deepEqualSerializable(remotePayload, basePayload) : false

        if (remoteRow && currentEqualsBase) {
          return true
        }

        let payloadToSave = currentPayload
        let expectedUpdatedAt = String(remoteRow?.updated_at || '')
        let expectedRevision = toSafeRevision(remoteRow?.revision)
        let allowInsert = !remoteRow

        if (remoteRow && baseRecord && !currentEqualsBase && !remoteEqualsBase) {
          payloadToSave = mergeThreeWaySerializable(basePayload, currentPayload, remotePayload)
          hadConflictMerge = true
        }

        const saved = await persistStationRow({
          rowId: currentRecord.rowId,
          payload: payloadToSave,
          expectedUpdatedAt,
          expectedRevision,
          allowInsert
        })

        if (saved) {
          return true
        }

        if (depth >= 1) {
          return false
        }

        const latestRow = await readServerStationRow(currentRecord.rowId).catch(() => null)
        if (latestRow) {
          return saveOneRecord(currentRecord, baseRecord, latestRow, depth + 1)
        }

        if (!remoteRow) {
          const retryInsert = await persistStationRow({
            rowId: currentRecord.rowId,
            payload: currentPayload,
            expectedUpdatedAt: '',
            expectedRevision: null,
            allowInsert: true
          })
          if (retryInsert) return true
        }

        return false
      }

      let hadConflictMerge = false
      let changedCount = 0
      let deletedCount = 0

      for (const currentRecord of currentRecords) {
        const baseRecord = baseMap.get(currentRecord.rowId) || null
        const remoteRow = latestStationMap.get(currentRecord.rowId) || null
        const basePayload = baseRecord?.payload ?? null
        const currentPayload = currentRecord.payload
        const currentEqualsBase = baseRecord ? deepEqualSerializable(currentPayload, basePayload) : false

        if (remoteRow && currentEqualsBase) {
          continue
        }

        if (!remoteRow && currentEqualsBase && latestHasV3Rows) {
          // 서버에 해당 행이 사라진 경우에는 현재 값을 복구한다.
        }

        const saved = await saveOneRecord(currentRecord, baseRecord, remoteRow)
        if (!saved) {
          throw new Error('저장 충돌이 발생했습니다.')
        }
        changedCount += 1
      }

      const deletedRowIds = baseRecords
        .map((record) => record.rowId)
        .filter((rowId) => !currentMap.has(rowId))

      for (const rowId of deletedRowIds) {
        await deleteStationRow(rowId)
        deletedCount += 1
      }

      const savedAt = new Date().toISOString()
      const durationMs = Math.max(0, Math.round((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - saveStartedAt))
      lastCommittedGroupsRef.current = cloneSerializable(currentGroups)
      lastServerUpdatedAtRef.current = savedAt
      lastServerRevisionRef.current = null
      setLastSavedAt(savedAt)
      setSaveStatus(hadConflictMerge ? '충돌 자동 병합 후 저장 완료' : '저장 완료')
      dirtyRef.current = false
      pushSaveMetrics((prev) => ({
        ...prev,
        successes: (prev.successes || 0) + 1,
        mergeSuccesses: (prev.mergeSuccesses || 0) + (hadConflictMerge ? 1 : 0),
        totalMs: (prev.totalMs || 0) + durationMs,
        lastDurationMs: durationMs,
        lastOutcome: hadConflictMerge ? 'merged-success' : 'success',
        lastError: '',
        lastSavedAt: savedAt
      }))

      safeWriteJson(APP_STATE_SYNC_STORAGE_KEY, {
        savedAt,
        serverUpdatedAt: lastServerUpdatedAtRef.current,
        serverRevision: lastServerRevisionRef.current,
        clientId: CLIENT_ID,
        scope: storageScope,
        format: 'v4',
        changedCount,
        deletedCount
      })
      safeRemoveKey(APP_STATE_DRAFT_STORAGE_KEY)
    } catch (error) {
      console.error('saveStations error:', error)
      const errorMessage = error instanceof Error ? error.message : '저장 실패 - 다시 시도해 주세요'
      const durationMs = Math.max(0, Math.round((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - saveStartedAt))
      setSaveStatus(errorMessage)
      pushSaveMetrics((prev) => ({
        ...prev,
        failures: (prev.failures || 0) + 1,
        totalMs: (prev.totalMs || 0) + durationMs,
        lastDurationMs: durationMs,
        lastOutcome: 'failure',
        lastError: errorMessage,
        lastSavedAt: prev.lastSavedAt || ''
      }))
      if (retryCount < 1) {
        pushSaveMetrics((prev) => ({
          ...prev,
          retries: (prev.retries || 0) + 1,
          lastOutcome: 'retry-scheduled'
        }))
        retryTimerRef.current = setTimeout(() => {
          void flushAppStateSave('retry', retryCount + 1)
        }, APP_STATE_SAVE_RETRY_MS)
      }
    } finally {
      saveInFlightRef.current = false
      savingReasonRef.current = ''
      if (dirtyRef.current && !retryTimerRef.current) {
        queueNextSave(APP_STATE_SAVE_DEBOUNCE_MS, 'queued')
      }
    }
  }

  useEffect(() => {
    const loadAppState = async () => {
      let stationRows = []
      let scopedData = null
      let legacyData = null
      let loadedFromV4 = false

      try {
        stationRows = await readServerStationRows()
      } catch (error) {
        console.error('loadStations v3 error:', error)
      }

      if (Array.isArray(stationRows) && stationRows.length > 0) {
        loadedFromV4 = true
      } else {
        try {
          scopedData = await readServerAppState(APP_STATE_ID)
        } catch (error) {
          console.error('loadStations scoped error:', error)
        }

        if (!scopedData) {
          try {
            legacyData = await readServerAppState(APP_STATE_LEGACY_ID)
          } catch (error) {
            console.error('loadStations legacy error:', error)
          }
        }
      }

      const localDraft = safeReadJson(APP_STATE_DRAFT_STORAGE_KEY, null)
      const localSync = safeReadJson(APP_STATE_SYNC_STORAGE_KEY, null)

      let nextGroups = DEFAULT_GROUPS
      let sourceLabel = '기본값'
      let savedAt = ''
      let serverUpdatedAt = ''
      let serverRevision = null
      let shouldMigrate = false

      if (loadedFromV4) {
  const serverGroups = extractGroupsFromStationRows(stationRows) || DEFAULT_GROUPS
  const draftGroups = Array.isArray(localDraft?.groups)
    ? normalizeGroups(localDraft.groups)
    : null

  nextGroups =
    draftGroups && draftGroups.length > 0
      ? applyDraftOrderToGroups(serverGroups, draftGroups)
      : serverGroups
        savedAt = String(
          stationRows.reduce((latest, row) => {
            const ts = String(row?.updated_at || '')
            if (!latest) return ts
            return String(ts) > String(latest) ? ts : latest
          }, '')
        )
        serverUpdatedAt = String(
          stationRows.reduce((latest, row) => {
            const ts = String(row?.updated_at || '')
            if (!latest) return ts
            return String(ts) > String(latest) ? ts : latest
          }, '')
        )
        const revisions = stationRows.map((row) => toSafeRevision(row?.revision)).filter((v) => v !== null)
        serverRevision = revisions.length > 0 ? Math.max(...revisions) : null
        sourceLabel = '서버 V4'
      } else {
        const chosenServerData = scopedData || legacyData
        const serverGroups = chosenServerData ? extractGroupsFromAppStatePayload(chosenServerData.payload) : null

        if (serverGroups && serverGroups.length > 0) {
          nextGroups = serverGroups
          savedAt = String(chosenServerData?.payload?.savedAt || chosenServerData?.updated_at || '')
          serverUpdatedAt = String(chosenServerData?.updated_at || '')
          serverRevision = toSafeRevision(chosenServerData?.revision)
          sourceLabel = scopedData ? '서버' : '서버(레거시 이관)'
          shouldMigrate = true
        } else {
          const localDraftGroups = Array.isArray(localDraft?.groups) ? normalizeGroups(localDraft.groups) : null
          if (localDraftGroups && localDraftGroups.length > 0) {
            nextGroups = localDraftGroups
            savedAt = String(localDraft?.updatedAt || localSync?.savedAt || '')
            sourceLabel = '로컬 복구'
            shouldMigrate = true
          } else {
            savedAt = String(localSync?.savedAt || '')
          }
        }
      }

      suppressNextPersistRef.current = true
      groupsRef.current = nextGroups
      setGroups(nextGroups)
      setLastSavedAt(savedAt)
      setSaveStatus(`${sourceLabel} 불러옴`)
      lastCommittedGroupsRef.current = cloneSerializable(nextGroups)
      lastServerUpdatedAtRef.current = serverUpdatedAt
      lastServerRevisionRef.current = serverRevision
      supportsRevisionRef.current = supportsRevisionRef.current === false ? false : true
      appStateReadyRef.current = true
      setStationsLoaded(true)

      if (shouldMigrate) {
        dirtyRef.current = true
        queueNextSave(0, 'migrate')
      }
    }

    loadAppState()
  }, [APP_STATE_DRAFT_STORAGE_KEY, APP_STATE_ID, APP_STATE_SYNC_STORAGE_KEY])

  useEffect(() => {
    groupsRef.current = groups
    if (suppressNextPersistRef.current) {
      suppressNextPersistRef.current = false
      return
    }
    if (!stationsLoaded || !appStateReadyRef.current) return

    const updatedAt = new Date().toISOString()
    safeWriteJson(APP_STATE_DRAFT_STORAGE_KEY, {
      groups: normalizeGroups(groups),
      updatedAt,
      clientId: CLIENT_ID,
      scope: storageScope
    })

    dirtyRef.current = true
    setSaveStatus(saveInFlightRef.current ? '저장 중...' : '저장 대기 중')

    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void flushAppStateSave('debounce')
    }, APP_STATE_SAVE_DEBOUNCE_MS)
  }, [groups, stationsLoaded, CLIENT_ID, storageScope, APP_STATE_DRAFT_STORAGE_KEY])
  useEffect(() => {
    const flushNow = () => {
      if (dirtyRef.current) {
        void flushAppStateSave('visibility')
      }
    }

    const handlePageHide = () => flushNow()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushNow()
      }
    }

    window.addEventListener('pagehide', handlePageHide)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    return () => {
      clearTimeout(saveTimerRef.current)
      clearTimeout(retryTimerRef.current)
    }
  }, [])

  const [chartConfig, setChartConfig] = useState(() => {
    const saved = localStorage.getItem(CHART_CONFIG_KEY)
    const fallback = {
      xType: 'logarithmic',
      xMin: '0.1',
      xMax: '10000',
      yType: 'logarithmic',
      yMin: '0.1',
      yMax: '10'
    }

    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        return {
          xType: parsed?.xType ?? fallback.xType,
          xMin: parsed?.xMin ?? fallback.xMin,
          xMax: parsed?.xMax ?? fallback.xMax,
          yType: parsed?.yType ?? fallback.yType,
          yMin: parsed?.yMin ?? fallback.yMin,
          yMax: parsed?.yMax ?? fallback.yMax
        }
      } catch {
        return fallback
      }
    }

    return fallback
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
    try {
      localStorage.setItem(HRFCO_API_KEY_STORAGE_KEY_SCOPED, hrfcoApiKey)
    } catch {
      // ignore storage quota / privacy mode errors
    }
  }, [hrfcoApiKey, HRFCO_API_KEY_STORAGE_KEY_SCOPED])

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

  const handleExportSelectedGroupMeasurements = () => {
    if (!selectedGroup) {
      window.alert('내보낼 그룹을 선택해 주세요.')
      return
    }

    const workbook = XLSX.utils.book_new()
    const stations = Array.isArray(selectedGroup.stations) ? selectedGroup.stations : []
    const usedNames = new Map()
    const yearFilter = measurementYearFilter

    stations.forEach((station, index) => {
      const baseName = sanitizeExcelSheetName(station?.name || `지점 ${index + 1}`)
      let sheetName = baseName
      let suffix = 2
      while (usedNames.has(sheetName)) {
        const extra = `_${suffix}`
        sheetName = sanitizeExcelSheetName(`${baseName.slice(0, 31 - extra.length)}${extra}`)
        suffix += 1
      }
      usedNames.set(sheetName, true)

      const headers = ['측정일시', '수위(h)', '유량(Q)', '측정장비']
      const rows = (Array.isArray(station.measurements) ? station.measurements : [])
        .filter((measurement) => {
          if (yearFilter === '전체') return true
          return getYearLabel(measurement?.datetime) === yearFilter
        })
        .slice()
        .sort((a, b) => {
          const ad = parseDateTime(a?.datetime)?.getTime() ?? 0
          const bd = parseDateTime(b?.datetime)?.getTime() ?? 0
          if (ad !== bd) return ad - bd
          return String(a?.datetime || '').localeCompare(String(b?.datetime || ''))
        })
        .map((measurement) => [
          formatMeasurementDatetimeForExport(measurement?.datetime),
          measurement?.h ?? '',
          measurement?.q ?? '',
          measurement?.device ?? ''
        ])

      const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
    })

    const groupName = sanitizeExcelSheetName(selectedGroup.name || '그룹')
    const yearLabel = yearFilter === '전체' ? '전체' : `${yearFilter}년`
    const fileName = `${groupName}_측정성과입력_${yearLabel}_${formatDateTimeDisplay(new Date()).replace(/[:\s]/g, '_')}.xlsx`
    XLSX.writeFile(workbook, fileName)
  }

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
    const rawH = num(measurement.h)
    const section = findSectionByH(
      measurement.h,
      selectedSections,
      measurement.datetime
    )

    const offset = section ? (num(section.hOffset) ?? 0) : 0
    const H = rawH === null ? null : rawH + offset

    const measuredQ = num(measurement.q)
    const curveQ = section && rawH !== null ? calcQ(measurement.h, section) : null

    let error = null
    if (measuredQ !== null && curveQ !== null && curveQ !== 0) {
      error = ((measuredQ - curveQ) / curveQ) * 100
    }

    return {
      ...measurement,
      H,
      sectionName: section?.name || '',
      curveQ,
      error,
      measurementYear: getYearLabel(measurement.datetime),
      _order: index
    }
  })
}, [selectedMeasurements, selectedSections])

  const graphMeasurementGroups = useMemo(() => {
  const map = new Map()

  relativeErrorsRaw.forEach((measurement) => {
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
      items: group.items.slice().sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
    }))
}, [relativeErrorsRaw])

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
  return graphMeasurementGroups.map((group) => {
    const color = yearColorMap[group.year] || YEAR_COLORS[0]
    const deviceStyle = DEVICE_STYLES[group.device] || DEVICE_STYLES.기타

    return {
      label: `${group.year}년 ${group.device} 측정성과`,
      data: group.items
        .map((measurement) => ({
          x: num(measurement.q),
          y: num(measurement.H)
        }))
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
}, [graphMeasurementGroups, yearColorMap])

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
  { key: 'name', label: '구간명', minWidth: '86px' },
  { key: 'hMin', label: '적용수위 시작', minWidth: '96px' },
  { key: 'hMax', label: '적용수위 끝', minWidth: '96px' },
  { key: 'hOffset', label: 'H = h + ( )', type: 'number', minWidth: '96px' },
  { key: 'a', label: 'A', minWidth: '64px' },
  { key: 'b', label: 'B', minWidth: '64px' },
  { key: 'c', label: 'C', minWidth: '64px' },
  { key: 'lowNote', label: '저수위 외삽', minWidth: '120px' },
  { key: 'highNote', label: '고수위 외삽', minWidth: '120px' },
  { key: 'periodStart', label: '적용시작', minWidth: '250px', mobileMinWidth: '130px' },
  { key: 'periodEnd', label: '적용종료', minWidth: '250px', mobileMinWidth: '130px' }
]

  const measurementColumns = [
    { key: 'datetime', label: '측정일시', minWidth: '250px', mobileMinWidth: '130px' },
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
    <div
      className="app"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <header className="header">
        <div>
          <h1>지점별 자료 관리 PWA</h1>
          <p>셀 형태 입력, Excel 붙여넣기, 환산유량표, 그래프, 상대오차 계산</p>
        </div>
        <p className="muted">그룹과 지점을 선택해서 관리합니다.</p>
        <div style={{ marginTop: '8px', fontSize: '13px', fontWeight: 600 }}>
          저장 상태: {saveStatus}
          {lastSavedAt ? ` · ${formatDateTimeDisplay(new Date(lastSavedAt))}` : ''}
        </div>
        <div style={{ marginTop: '4px', fontSize: '12px', color: '#555' }}>
          저장 진단: 성공 {saveMetrics.successes}회 · 실패 {saveMetrics.failures}회 · 재시도 {saveMetrics.retries}회 · 자동병합 {saveMetrics.mergeSuccesses}회 · 평균 {saveMetrics.attempts > 0 ? Math.round(saveMetrics.totalMs / saveMetrics.attempts) : 0}ms · 마지막 {saveMetrics.lastOutcome || '없음'}
        </div>
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
          빈수위 찾기
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
        <div className="section-header">
          <h2>3. 측정성과 입력</h2>
          <div className="grid-actions">
            <button
              className="btn secondary"
              onClick={handleExportSelectedGroupMeasurements}
              disabled={!selectedGroup}
            >
              그룹 엑셀 저장
            </button>
          </div>
        </div>
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
  headers={[
    '측정일시',
    '수위(h)',
    '수위(H)',
    '측정유량',
    '곡선식 적용구간',
    '곡선식 유량',
    '상대오차(%)'
  ]}
  rows={filteredRelativeErrors.map((row) => [
    row.datetime,
    row.h,
    row.H === null ? '' : fmt(row.H, 2),
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
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn secondary"
            style={{ background: instrumentSubTab === 'current' ? '#1f6feb' : '#6c757d' }}
            onClick={() => setInstrumentSubTab('current')}
          >
            빈수위 찾기
          </button>
          <button
            type="button"
            className="btn secondary"
            style={{ background: instrumentSubTab === 'history' ? '#1f6feb' : '#6c757d' }}
            onClick={() => setInstrumentSubTab('history')}
          >
            계기수위-측정성과
          </button>
        </div>

        <div style={{ display: instrumentSubTab === 'current' ? 'block' : 'none' }}>
          <CurrentWaterLevelPage
            groups={groups}
            hrfcoApiKey={hrfcoApiKey}
            onHrfcoApiKeyChange={setHrfcoApiKey}
          />
        </div>

        <div style={{ display: instrumentSubTab === 'history' ? 'block' : 'none' }}>
          <InstrumentMeasurementPage
            groups={groups}
            hrfcoApiKey={hrfcoApiKey}
            onHrfcoApiKeyChange={setHrfcoApiKey}
          />
        </div>
      </div>
    </div>
  )
}
