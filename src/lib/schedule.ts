import type { Arrival, DirectionBlock, LineRef, LineSchedule, SchedulePayload, TrainRow } from '../types.ts'

function destinationName(code: string | undefined, names: Record<string, string>): string {
  if (!code) return '未知終點'
  return names[code] ?? code
}

function minutesLabel(ttnt: string | undefined): string {
  if (ttnt === '0') return '即將到站'
  if (ttnt && /^\d+$/.test(ttnt)) return `${Number(ttnt)} 分鐘`
  return '時間未明'
}

function clockLabel(time: string | undefined): string {
  const match = time ? /(\d{2}:\d{2})/.exec(time) : null
  return match?.[1] ?? ''
}

function toRows(arrivals: Arrival[] | undefined, names: Record<string, string>): TrainRow[] {
  return [...(arrivals ?? [])]
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
    .map((item) => ({
      destination: destinationName(item.dest, names),
      minutesLabel: minutesLabel(item.ttnt),
      platform: item.plat?.trim() ?? '',
      clock: clockLabel(item.time),
      uncertain: item.valid === 'N',
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

export function presentLine(
  stationCode: string,
  line: LineRef,
  payload: SchedulePayload | null,
  failed: boolean,
  names: Record<string, string>,
): LineSchedule {
  const base = { code: line.code, name: line.name, color: line.color }

  if (failed || !payload) {
    return {
      ...base,
      delayed: false,
      notice: null,
      directions: [],
      emptyNote: '暫時取不到到站資料，請稍後再試。',
      updatedAt: null,
    }
  }

  const block = payload.data?.[`${line.code}-${stationCode}`]
  const delayed = payload.isdelay === 'Y'
  const rawTime = block?.sys_time && block.sys_time !== '-' ? block.sys_time : payload.sys_time
  const updatedAt = rawTime && rawTime !== '-' ? rawTime : null

  if (payload.status === 0) {
    const message = payload.message?.trim()
    return {
      ...base,
      delayed,
      notice: message && message.toLowerCase() !== 'successful' ? message : '港鐵現時有特別安排。',
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

  let emptyNote: string | null = null
  if (upEmpty && downEmpty) {
    emptyNote = '暫無即將到站班次。'
  } else if (line.terminus && (upEmpty || downEmpty)) {
    emptyNote = '此方向沒有班次。'
  } else if (upEmpty || downEmpty) {
    emptyNote = '另一方向暫無即將到站班次。'
  }

  return {
    ...base,
    delayed,
    notice: null,
    directions,
    emptyNote,
    updatedAt,
  }
}
