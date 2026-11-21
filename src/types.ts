export type LineRef = {
  code: string
  name: string
  color: string
  terminus: boolean
  seq: number
}

export type Station = {
  code: string
  name: string
  nameEn: string
  lng: number
  lat: number
  lines: LineRef[]
}

export type LineStyle = {
  code: string
  name: string
  color: string
}

export type RouteCollection = {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    properties: { code: string; name: string; color: string }
    geometry: { type: 'LineString'; coordinates: number[][] }
  }>
}

export type Network = {
  lines: LineStyle[]
  stations: Station[]
  routes: RouteCollection
}

export type CameraSite = {
  key: string
  region: string
  district: string
  description: string
  lat: number
  lng: number
  url: string
}

export type Arrival = {
  seq?: string | number
  dest?: string
  plat?: string | number
  time?: string
  ttnt?: string | number
  valid?: string
  route?: string
}

export type SchedulePayload = {
  status?: number
  message?: string
  url?: string
  isdelay?: string
  sys_time?: string
  data?: Record<
    string,
    {
      UP?: Arrival[]
      DOWN?: Arrival[]
      sys_time?: string
    }
  >
}

export type TrainRow = {
  destination: string
  minutesLabel: string
  platform: string
  clock: string
  uncertain: boolean
  viaRacecourse: boolean
}

export type DirectionBlock = {
  title: string
  rows: TrainRow[]
  repeatDestination: boolean
}

export type LineSchedule = {
  code: string
  name: string
  color: string
  delayed: boolean
  notice: string | null
  noticeUrl: string | null
  directions: DirectionBlock[]
  emptyNote: string | null
  updatedAt: string | null
}
