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
  '#db2777',
  '#7c3aed',
  '#ea580c',
  '#0891b2',
  '#dc2626',
  '#4f46e5'
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

function findSectionByH(h, sections) {
  const H = num(h)
  if (H === null) return null

  const exact = sections.find((s) => {
    const hMin = num(s.hMin)
    const hMax = num(s.hMax)
    return hMin !== null && hMax !== null && H >= hMin && H <= hMax
  })
  if (exact) return exact

  let best = null
  let bestDist = Infinity
  for (const s of sections) {
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

function buildInitialStations() {
  return [
    {
      id: makeId(),
      name: '진천군 (가산교)',
      code: '3011520',
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

    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
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
        <table className="spreadsheet">
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

export default function App() {
const APP_STATE_ID = 'main'

const [stations, setStations] = useState(() => buildInitialStations())
const [stationsLoaded, setStationsLoaded] = useState(false)

useEffect(() => {
  const loadStations = async () => {
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

    const loadedStations = data?.payload?.stations
    if (Array.isArray(loadedStations) && loadedStations.length > 0) {
      setStations(loadedStations)
    }

    setStationsLoaded(true)
  }

  loadStations()
}, [])

useEffect(() => {
  if (!stationsLoaded) return

  const timer = setTimeout(async () => {
    const { error } = await supabase.from('app_state').upsert({
      id: APP_STATE_ID,
      payload: { stations },
      updated_at: new Date().toISOString()
    })

    if (error) {
      console.error('saveStations error:', error)
    }
  }, 500)

  return () => clearTimeout(timer)
}, [stations, stationsLoaded])

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

  const [selectedId, setSelectedId] = useState(() => stations[0]?.id || '')
  const [curveTableOpen, setCurveTableOpen] = useState(true)
  useEffect(() => {
    localStorage.setItem(CHART_CONFIG_KEY, JSON.stringify(chartConfig))
  }, [chartConfig])

  useEffect(() => {
    localStorage.setItem(CHART_LEGEND_POS_KEY, JSON.stringify(legendPos))
  }, [legendPos])

  useEffect(() => {
    if (!selectedId && stations[0]) setSelectedId(stations[0].id)
  }, [selectedId, stations])

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

  const selectedStation = stations.find((s) => s.id === selectedId) || stations[0]

  const updateStation = (stationId, patch) => {
    setStations((prev) =>
      prev.map((s) => (s.id === stationId ? { ...s, ...patch } : s))
    )
  }

  const updateSelectedSections = (nextSections) => {
    setStations((prev) =>
      prev.map((s) =>
        s.id === selectedStation.id ? { ...s, sections: nextSections } : s
      )
    )
  }

  const updateSelectedMeasurements = (nextMeasurements) => {
    setStations((prev) =>
      prev.map((s) =>
        s.id === selectedStation.id ? { ...s, measurements: nextMeasurements } : s
      )
    )
  }

  const measurementGroups = useMemo(() => {
    const map = new Map()

    selectedStation.measurements.forEach((m) => {
      const year = getYearLabel(m.datetime)
      const device = normalizeDeviceLabel(m.device)
      const key = `${year}__${device}`
      if (!map.has(key)) {
        map.set(key, {
          year,
          device,
          items: []
        })
      }
      map.get(key).items.push(m)
    })

    return Array.from(map.values())
      .sort((a, b) => compareYearLabel(a.year, b.year) || a.device.localeCompare(b.device, 'ko'))
      .map((group) => ({
        ...group,
        items: group.items.slice().sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
      }))
  }, [selectedStation.measurements])

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
    return selectedStation.sections.map((section) => ({
      section,
      rows: genCurveRows(section)
    }))
  }, [selectedStation.sections])

  const relativeErrors = useMemo(() => {
    return selectedStation.measurements.map((m) => {
      const section = findSectionByH(m.h, selectedStation.sections)
      const measuredQ = num(m.q)
      const curveQ = section ? calcQ(m.h, section) : null
      let error = null
      if (measuredQ !== null && curveQ !== null && curveQ !== 0) {
        error = ((measuredQ - curveQ) / curveQ) * 100
      }
      return {
        ...m,
        sectionName: section?.name || '',
        curveQ,
        error
      }
    })
  }, [selectedStation.measurements, selectedStation.sections])

  const curveDatasets = useMemo(() => {
    return selectedStation.sections.map((section, idx) => {
      const isLowExtrapolation = String(section.lowNote || '').includes('외삽')
      const isHighExtrapolation = String(section.highNote || '').includes('외삽')
      const color = CURVE_COLORS[idx % CURVE_COLORS.length]

      return {
        label: section.name || `구간${idx + 1}`,
        data: (curveRowsBySection[idx]?.rows || []).map((r) => ({ x: r.q, y: r.h })),
        showLine: true,
        pointRadius: 0,
        borderWidth: 3,
        borderColor: color,
        borderDash: isLowExtrapolation || isHighExtrapolation ? [8, 5] : [],
        parsing: false,
        legendVisible: isLowExtrapolation || isHighExtrapolation,
        legendLabel: isLowExtrapolation
          ? '저수위 외삽'
          : isHighExtrapolation
            ? '고수위 외삽'
            : null
      }
    })
  }, [selectedStation.sections, curveRowsBySection])

  const measurementDatasets = useMemo(() => {
    return measurementGroups.map((group) => {
      const color = yearColorMap[group.year] || YEAR_COLORS[0]
      const deviceStyle = DEVICE_STYLES[group.device] || DEVICE_STYLES.기타

      return {
        label: `${group.year}년 ${group.device} 측정성과`,
        data: group.items
          .map((m) => ({ x: num(m.q), y: num(m.h) }))
          .filter((p) => p.x !== null && p.y !== null),
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

    measurementDatasets.forEach((ds) => {
      items.push({
        type: 'point',
        label: ds.label,
        color: ds.legendColor,
        symbol: ds.legendSymbol
      })
    })

    curveDatasets.forEach((ds) => {
      if (!ds.legendVisible || !ds.legendLabel) return
      items.push({
        type: 'line',
        label: ds.legendLabel,
        color: ds.borderColor,
        dash: Array.isArray(ds.borderDash) && ds.borderDash.length > 0
      })
    })

    return items
  }, [measurementDatasets, curveDatasets])

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

  if (!selectedStation) {
    return <div className="app">지점을 먼저 추가하세요.</div>
  }

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
        <button
          className="btn"
          onClick={() => {
            const newStation = {
              id: makeId(),
              name: '새 지점',
              code: '',
              sections: [],
              measurements: []
            }
            setStations((prev) => [...prev, newStation])
            setSelectedId(newStation.id)
          }}
        >
          + 지점 추가
        </button>
      </header>

      <section className="card">
        <h2>1. 지점 선택 / 기본정보</h2>
        <div className="row">
          <label>
            지점 선택
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || '이름 없음'}
                </option>
              ))}
            </select>
          </label>

          <label>
            지점명
            <input
              value={selectedStation.name}
              onChange={(e) =>
                updateStation(selectedStation.id, { name: e.target.value })
              }
            />
          </label>

          <label>
            지점코드
            <input
              value={selectedStation.code}
              onChange={(e) =>
                updateStation(selectedStation.id, { code: e.target.value })
              }
            />
          </label>
        </div>
      </section>

      <section className="card">
        <SpreadsheetGrid
          title="2. 곡선식 입력"
          columns={sectionColumns}
          rows={selectedStation.sections}
          onRowsChange={updateSelectedSections}
          createEmptyRow={createEmptySection}
          onDeleteRow={(rowId) =>
            updateSelectedSections(selectedStation.sections.filter((s) => s.id !== rowId))
          }
          addButtonLabel={{
            label: '+ 구간 추가',
            onClick: () =>
              updateSelectedSections([...selectedStation.sections, createEmptySection()])
          }}
        />
      </section>

      <section className="card">
        <SpreadsheetGrid
          title="3. 측정성과 입력"
          columns={measurementColumns}
          rows={selectedStation.measurements}
          onRowsChange={updateSelectedMeasurements}
          createEmptyRow={createEmptyMeasurement}
          onDeleteRow={(rowId) =>
            updateSelectedMeasurements(selectedStation.measurements.filter((m) => m.id !== rowId))
          }
          addButtonLabel={{
            label: '+ 측정성과 추가',
            onClick: () =>
              updateSelectedMeasurements([
                ...selectedStation.measurements,
                createEmptyMeasurement()
              ])
          }}
        />
      </section>

      <section className="card">
        <h2>4. 수위별 환산유량표</h2>
        {curveRowsBySection.map(({ section, rows }) => (
          <div className="subcard" key={section.id}>
            <h3>
              {section.name} / {section.hMin} ≤ h ≤ {section.hMax}
            </h3>
            <p className="muted">
              Q = {section.a} × (h - {section.b})^{section.c}
              {section.lowNote ? ` / ${section.lowNote}` : ''}
              {section.highNote ? ` / ${section.highNote}` : ''}
            </p>
            <div className="table-wrap small">
              <table className="spreadsheet">
                <thead>
                  <tr>
                    <th>수위(m)</th>
                    <th>유량(m³/s)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 40).map((r, idx) => (
                    <tr key={idx}>
                      <td>{fmt(r.h, 2)}</td>
                      <td>{fmt(r.q, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>5. 상대오차 계산</h2>
        <div className="table-wrap">
          <table className="spreadsheet">
            <thead>
              <tr>
                <th>측정일시</th>
                <th>수위(h)</th>
                <th>측정유량</th>
                <th>곡선식 적용구간</th>
                <th>곡선식 유량</th>
                <th>상대오차(%)</th>
              </tr>
            </thead>
            <tbody>
              {relativeErrors.map((r) => (
                <tr key={r.id}>
                  <td>{r.datetime}</td>
                  <td>{r.h}</td>
                  <td>{r.q}</td>
                  <td>{r.sectionName}</td>
                  <td>{r.curveQ === null ? '' : fmt(r.curveQ, 3)}</td>
                  <td>{r.error === null ? '' : fmt(r.error, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

        <div className="chart-wrapper" ref={chartWrapperRef}>
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

          <div className="chart-box">
            <Scatter data={chartData} options={chartOptions} />
          </div>
        </div>
      </section>
    </div>
  )
}