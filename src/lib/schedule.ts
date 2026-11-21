import type { Arrival, DirectionBlock, LineRef, LineSchedule, SchedulePayload, TrainRow } from '../types.ts'

function textOf(value: unknown): string {
  if (value == null) return ''
  return String(value).trim()
}

function destinationName(code: string | undefined, names: Record<string, string>): string {
  if (!code) return '未知終點'
  return names[code] ?? code
}

function minutesLabel(ttnt: unknown): string {
  const text = textOf(ttnt)
  if (text === '0') return '即將到站'
  if (/^\d+$/.test(text)) return `${Number(text)} 分鐘`
  return '時間未明'
}

function clockLabel(time: string | undefined): string {
  const match = time ? /(\d{2}:\d{2})/.exec(time) : null
  return match?.[1] ?? ''
}

function blankClock(value: string | undefined): boolean {
  return value == null || value.trim() === '' || value.trim() === '-'
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function toRows(arrivals: Arrival[] | undefined, names: Record<string, string>): TrainRow[] {
  return [...(arrivals ?? [])]
    .sort((a, b) => Number(textOf(a.seq) || 0) - Number(textOf(b.seq) || 0))
    .map((item) => ({
      destination: destinationName(item.dest, names),
      minutesLabel: minutesLabel(item.ttnt),
      platform: textOf(item.plat),
      clock: clockLabel(item.time),
      uncertain: textOf(item.valid) === 'N',
      viaRacecourse: textOf(item.route).toUpperCase() === 'RAC',
    }))
}

function asDirection(rows: TrainRow[]): DirectionBlock | null {
  if (rows.length === 0) return null
  const destinations: string[] = []
  for (const row of rows) {
    if (!destinations.includes(row.destination)) destinations.push(row.destination)
  }
  return {
    title: `往${destinations.join('、')}`,
    rows,
    repeatDestination: destinations.length > 1,
  }
}

function emptySchedule(line: LineRef, emptyNote: string): LineSchedule {
  return {
    code: line.code,
    name: line.name,
    color: line.color,
    delayed: false,
    notice: null,
    noticeUrl: null,
    directions: [],
    emptyNote,
    updatedAt: null,
  }
}

export function presentLine(
  stationCode: string,
  line: LineRef,
  payload: SchedulePayload | null,
  failed: boolean,
  names: Record<string, string>,
): LineSchedule {
  if (failed || !payload) {
    return emptySchedule(line, '暫時取不到到站資料，請稍後再試。')
  }

  const block = payload.data?.[`${line.code}-${stationCode}`]
  const delayed = payload.isdelay === 'Y'
  const rawTime = block?.sys_time && !blankClock(block.sys_time) ? block.sys_time : payload.sys_time
  const updatedAt = rawTime && !blankClock(rawTime) ? rawTime : null

  if (payload.status === 0) {
    const message = payload.message?.trim()
    return {
      code: line.code,
      name: line.name,
      color: line.color,
      delayed,
      notice: message && message.toLowerCase() !== 'successful' ? message : '港鐵現時有特別安排。',
      noticeUrl: httpsUrl(payload.url),
      directions: [],
      emptyNote: null,
      updatedAt,
    }
  }

  const directions = [asDirection(toRows(block?.UP, names)), asDirection(toRows(block?.DOWN, names))].filter(
    (item): item is DirectionBlock => item !== null,
  )
  const upEmpty = !block?.UP?.length
  const downEmpty = !block?.DOWN?.length
  const clocksMissing = blankClock(block?.sys_time) && blankClock(payload.sys_time)

  let emptyNote: string | null = null
  if (upEmpty && downEmpty) {
    emptyNote = clocksMissing ? '暫時沒有到站資料。' : '暫無即將到站班次。'
  } else if (line.terminus && (upEmpty || downEmpty)) {
    emptyNote = '終點站，沒有相反方向班次。'
  } else if (upEmpty || downEmpty) {
    emptyNote = '另一方向暫無即將到站班次。'
  }

  return {
    code: line.code,
    name: line.name,
    color: line.color,
    delayed,
    notice: null,
    noticeUrl: null,
    directions,
    emptyNote,
    updatedAt,
  }
}
