import { useMemo, useState } from 'react'
import type { CameraSite, LineSchedule, Network, Station } from '../types.ts'

function placeName(description: string): string {
  return description.replace(/\s*\[[^\]]+\]\s*$/, '')
}

function foldName(value: string): string {
  return value.replaceAll('\u8318', '\u8354').replaceAll('\u7864', '\u5cfd').toLowerCase()
}

function channel(value: number): number {
  const normalized = value / 255
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex: string): number {
  const color = hex.replace('#', '')
  const red = channel(Number.parseInt(color.slice(0, 2), 16))
  const green = channel(Number.parseInt(color.slice(2, 4), 16))
  const blue = channel(Number.parseInt(color.slice(4, 6), 16))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(background: number, foreground: number): number {
  const lighter = Math.max(background, foreground)
  const darker = Math.min(background, foreground)
  return (lighter + 0.05) / (darker + 0.05)
}

function chipText(hex: string): string {
  const background = relativeLuminance(hex)
  const white = contrastRatio(background, 1)
  const ink = contrastRatio(background, relativeLuminance('#1c1915'))
  return white >= ink ? '#ffffff' : '#1c1915'
}

type Props = {
  network: Network
  cameras: CameraSite[]
  station: Station | null
  camera: CameraSite | null
  schedules: LineSchedule[]
  loading: boolean
  onPickStation: (station: Station) => void
  onPickCamera: (camera: CameraSite) => void
  onClose: () => void
  onRetry: () => void
}

export function SidePanel({
  network,
  cameras,
  station,
  camera,
  schedules,
  loading,
  onPickStation,
  onPickCamera,
  onClose,
  onRetry,
}: Props) {
  const [query, setQuery] = useState('')
  const trimmed = query.trim()
  const stationHits = useMemo(() => {
    if (!trimmed) return []
    const needle = foldName(trimmed)
    return network.stations
      .filter(
        (item) =>
          foldName(item.name).includes(needle) ||
          item.nameEn.toLowerCase().includes(needle) ||
          item.code.toLowerCase() === needle,
      )
      .slice(0, 6)
  }, [network.stations, trimmed])
  const cameraHits = useMemo(() => {
    if (!trimmed) return []
    const needle = foldName(trimmed)
    return cameras
      .filter(
        (item) =>
          foldName(item.description).includes(needle) ||
          foldName(item.district).includes(needle) ||
          foldName(item.region).includes(needle),
      )
      .slice(0, 5)
  }, [cameras, trimmed])

  return (
    <aside className="flex h-full flex-col overflow-hidden rounded-2xl border border-[#e4ddd2] bg-[#fffcf8]/95 shadow-[0_16px_40px_rgba(28,25,21,0.16)] backdrop-blur-sm">
      <div className="border-b border-[#efe8dc] p-4">
        <label className="block text-sm font-medium" htmlFor="place-search">
          搜尋車站或快拍點
        </label>
        <input
          id="place-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="例如將軍澳、香港仔"
          className="mt-2 w-full rounded-xl border border-[#e4ddd2] bg-white px-3 py-2 text-base outline-none ring-[#1c1915] placeholder:text-[#8a8175] focus:ring-2"
        />
        {trimmed ? (
          <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-[#efe8dc] bg-white">
            {stationHits.length === 0 && cameraHits.length === 0 ? (
              <p className="px-3 py-3 text-sm text-[#6b645c]">找不到相符的車站或快拍點。</p>
            ) : null}
            {stationHits.map((item) => (
              <button
                key={item.code}
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-[#f6f1e6]"
                onClick={() => {
                  onPickStation(item)
                  setQuery('')
                }}
              >
                <span className="font-medium">{item.name}</span>
                <span className="ml-2 text-sm text-[#6b645c]">車站</span>
              </button>
            ))}
            {cameraHits.map((item) => (
              <button
                key={item.key}
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-[#f6f1e6]"
                onClick={() => {
                  onPickCamera(item)
                  setQuery('')
                }}
              >
                <span className="font-medium">{placeName(item.description)}</span>
                <span className="ml-2 text-sm text-[#6b645c]">快拍</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {station ? (
          <StationDetail
            station={station}
            schedules={schedules}
            loading={loading}
            onClose={onClose}
            onRetry={onRetry}
          />
        ) : camera ? (
          <CameraDetail key={camera.key} camera={camera} onClose={onClose} />
        ) : (
          <Intro network={network} cameraCount={cameras.length} />
        )}
      </div>
    </aside>
  )
}

function Intro({ network, cameraCount }: { network: Network; cameraCount: number }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">怎樣使用</h2>
      <p className="mt-2 text-sm leading-6 text-[#3f3a34]">
        點選車站，查看即將到站的列車。彩色圓點會沿路軌移動，位置是按到站時間估算，不是列車的真實定位。點選橙色快拍點，查看該處最新路面照片。
      </p>
      <p className="mt-3 text-sm leading-6 text-[#3f3a34]">
        地圖有十條港鐵綫、{network.stations.length} 個車站（包括馬場站）和 {cameraCount.toLocaleString('zh-Hant')} 個交通快拍點。暫時沒有班次或照片時，畫面會直接說明。
      </p>
      <ul className="mt-4 grid grid-cols-2 gap-2">
        {network.lines.map((line) => (
          <li key={line.code} className="flex items-center gap-2 text-sm">
            <span className="h-2.5 w-6 rounded-full" style={{ background: line.color }} />
            {line.name}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs leading-5 text-[#6b645c]">
        底圖來自 OpenFreeMap 和 OpenStreetMap。到站資料來自港鐵公司，約每十秒更新。快拍圖像來自運輸署，約每兩分鐘更新。車站和路軌曲線都來自 OpenStreetMap，路軌沿真實走線繪出。
      </p>
    </div>
  )
}

function StationDetail({
  station,
  schedules,
  loading,
  onClose,
  onRetry,
}: {
  station: Station
  schedules: LineSchedule[]
  loading: boolean
  onClose: () => void
  onRetry: () => void
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-[#6b645c]">港鐵車站</p>
          <h2 className="text-2xl font-semibold">{station.name}</h2>
          <p className="text-sm text-[#6b645c]">{station.nameEn}</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-full px-3 py-1 text-sm whitespace-nowrap hover:bg-[#f6f1e6]"
          onClick={onClose}
        >
          關閉
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {station.lines.map((line) => (
          <span
            key={line.code}
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: line.color, color: chipText(line.color) }}
          >
            {line.name}
          </span>
        ))}
      </div>
      {station.code === 'RAC' ? (
        <p className="mt-3 rounded-xl bg-[#f6f1e6] px-3 py-2 text-sm leading-6">
          馬場站通常只在賽馬日開出列車。
        </p>
      ) : null}
      {loading && schedules.length === 0 ? <p className="mt-4 text-sm">正在查詢到站班次…</p> : null}
      <div className="mt-4 space-y-3">
        {schedules.map((schedule) => (
          <article key={schedule.code} className="rounded-2xl border border-[#efe8dc] bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-semibold">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: schedule.color }} />
                {schedule.name}
              </h3>
              {schedule.delayed ? (
                <span className="rounded-full bg-[#fff4d6] px-2 py-0.5 text-xs font-medium">現有延誤</span>
              ) : null}
            </div>
            {schedule.updatedAt ? (
              <p className="mt-1 text-xs text-[#6b645c]">資料時間 {schedule.updatedAt.slice(11) || schedule.updatedAt}</p>
            ) : null}
            {schedule.notice ? (
              <p className="mt-3 rounded-xl bg-[#f6f1e6] px-3 py-2 text-sm leading-6">
                港鐵提示：{schedule.notice}
                {schedule.noticeUrl ? (
                  <>
                    {' '}
                    <a
                      className="font-medium underline"
                      href={schedule.noticeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      查看詳情
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {schedule.directions.map((direction) => (
              <div key={direction.title} className="mt-3">
                <h4 className="text-sm font-medium">{direction.title}</h4>
                <ul className="mt-1 space-y-1">
                  {direction.rows.map((row, index) => (
                    <li key={`${direction.title}-${index}`} className="text-sm leading-6 text-[#3f3a34]">
                      {direction.repeatDestination ? `${row.destination} · ` : ''}
                      {row.minutesLabel}
                      {row.platform ? ` · ${row.platform} 號月台` : ''}
                      {row.clock ? ` · ${row.clock}` : ''}
                      {row.viaRacecourse ? ' · 經馬場' : ''}
                      {row.uncertain ? ' · 時間未確定' : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {schedule.emptyNote ? (
              <p
                className={`mt-3 rounded-xl px-3 py-2 text-sm leading-6 ${
                  schedule.emptyNote.startsWith('暫時取不到') ? 'bg-[#fde8e4]' : 'bg-[#f6f1e6]'
                }`}
              >
                {schedule.emptyNote}
              </p>
            ) : null}
            {schedule.emptyNote?.startsWith('暫時取不到') ? (
              <button
                type="button"
                className="mt-2 rounded-full bg-[#1c1915] px-3 py-1.5 text-sm text-[#f7f4ee]"
                onClick={onRetry}
              >
                再試一次
              </button>
            ) : null}
          </article>
        ))}
      </div>
      <p className="mt-4 text-xs leading-5 text-[#6b645c]">到站資料來自港鐵公司。車站位置來自 OpenStreetMap。</p>
    </div>
  )
}

function CameraDetail({ camera, onClose }: { camera: CameraSite; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const src = `${camera.url}${camera.url.includes('?') ? '&' : '?'}t=${attempt}`

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-[#6b645c]">交通快拍</p>
          <h2 className="text-xl font-semibold leading-7">{placeName(camera.description)}</h2>
          <p className="mt-1 text-sm text-[#6b645c]">
            {camera.region} · {camera.district}
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-full px-3 py-1 text-sm whitespace-nowrap hover:bg-[#f6f1e6]"
          onClick={onClose}
        >
          關閉
        </button>
      </div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-[#efe8dc] bg-[#f6f1e6]">
        {failed ? (
          <p className="px-4 py-10 text-center text-sm leading-6">暫時未能顯示這張快拍。</p>
        ) : (
          <img
            key={src}
            src={src}
            alt={placeName(camera.description)}
            referrerPolicy="no-referrer"
            className="max-h-32 w-full object-cover md:aspect-[4/3] md:max-h-none"
            onError={() => setFailed(true)}
            onLoad={() => setFailed(false)}
          />
        )}
      </div>
      <p className="mt-3 text-sm leading-6 text-[#3f3a34]">運輸署約每兩分鐘更新這張照片。若部門暫停提供影像，可能會看到「暫時未能提供服務」的圖，或上面的說明。</p>
      <button
        type="button"
        className="mt-3 rounded-full bg-[#1c1915] px-3 py-1.5 text-sm text-[#f7f4ee]"
        onClick={() => {
          setFailed(false)
          setAttempt((value) => value + 1)
        }}
      >
        重新載入照片
      </button>
    </div>
  )
}
