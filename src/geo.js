// geo.js — GeoJSON 로딩, 투영, 해안선 병합(union), 지역 판정
import polygonClipping from 'polygon-clipping'

// ── 8도 지역 정의 (시·도 코드 → 지역 그룹) ──────────────────────
export const REGIONS = [
  { key: 'seoul',     name: '서울',       emoji: '🏙️', color: '#ff6b9d', codes: ['11'],                    desc: '한강의 야경, 골목의 미식. 도시 그 자체가 여행.' },
  { key: 'gyeonggi',  name: '경기·인천',  emoji: '🎡', color: '#ffa94d', codes: ['31', '23'],              desc: '수원 화성부터 인천 바다까지, 가까운 대탈출.' },
  { key: 'gangwon',   name: '강원도',     emoji: '⛰️', color: '#69db7c', codes: ['32'],                    desc: '설악의 능선과 동해의 파도. 사계절 자연 맛집.' },
  { key: 'chungcheong', name: '충청도',   emoji: '🌾', color: '#ffd43b', codes: ['33', '34', '25', '29'],  desc: '느긋한 호수와 온천, 백제의 숨결까지.' },
  { key: 'jeolla',    name: '전라도',     emoji: '🍲', color: '#74c0fc', codes: ['35', '36', '24'],        desc: '맛의 수도. 남도 밥상 앞에선 누구나 행복해진다.' },
  { key: 'gyeongbuk', name: '경상북도',   emoji: '🏯', color: '#b197fc', codes: ['37', '22'],              desc: '천년 고도 경주와 안동, 그리고 울릉도의 신비.' },
  { key: 'gyeongnam', name: '경상남도',   emoji: '🌉', color: '#66d9e8', codes: ['38', '21', '26'],        desc: '부산 바다, 통영 다도해, 지리산 자락의 낭만.' },
  { key: 'jeju',      name: '제주도',     emoji: '🏝️', color: '#63e6be', codes: ['39'],                    desc: '섬 전체가 휴양지. 오름과 바다, 감귤빛 하루.' },
]

export const PROVINCE_LABEL = {
  11: '서울', 21: '부산', 22: '대구', 23: '인천', 24: '광주', 25: '대전',
  26: '울산', 29: '세종', 31: '경기도', 32: '강원도', 33: '충청북도', 34: '충청남도',
  35: '전라북도', 36: '전라남도', 37: '경상북도', 38: '경상남도', 39: '제주도',
}

let provincesGeo = null
let municipalitiesGeo = null

export async function loadGeo() {
  if (provincesGeo) return
  const base = import.meta.env.BASE_URL
  const [p, m] = await Promise.all([
    fetch(`${base}data/provinces.json`).then(r => r.json()),
    fetch(`${base}data/municipalities.json`).then(r => r.json()),
  ])
  provincesGeo = p
  municipalitiesGeo = m
}

function regionOfCode(code) {
  return REGIONS.find(r => r.codes.some(c => code.startsWith(c)))
}

// ── 투영: 경위도 → 캔버스 좌표 (위도 보정 등장방형) ─────────────
function makeProjector(features, rect) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const scan = (coords) => {
    for (const ring of coords) for (const [lon, lat] of ring) {
      const x = lon, y = lat
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  for (const f of features) {
    if (f.geometry.type === 'Polygon') scan(f.geometry.coordinates)
    else for (const poly of f.geometry.coordinates) scan(poly)
  }
  const latMid = (minY + maxY) / 2
  const kx = Math.cos((latMid * Math.PI) / 180)
  const geoW = (maxX - minX) * kx
  const geoH = maxY - minY
  const scale = Math.min(rect.w / geoW, rect.h / geoH)
  const offX = rect.x + (rect.w - geoW * scale) / 2
  const offY = rect.y + (rect.h - geoH * scale) / 2
  return ([lon, lat]) => [offX + (lon - minX) * kx * scale, offY + (maxY - lat) * scale]
}

function projectFeature(f, proj) {
  const g = f.geometry
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  return polys.map(poly => poly.map(ring => ring.map(proj)))
}

function ringArea(ring) {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2)
}

function ringCentroid(ring) {
  let x = 0, y = 0
  for (const p of ring) { x += p[0]; y += p[1] }
  return [x / ring.length, y / ring.length]
}

export function pointInRing(pt, ring) {
  let inside = false
  const [x, y] = pt
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function pointInPolys(pt, polys) {
  // polys: [poly][ring][pt] — ring0 외곽, 나머지 구멍
  for (const poly of polys) {
    if (pointInRing(pt, poly[0])) {
      let inHole = false
      for (let r = 1; r < poly.length; r++) if (pointInRing(pt, poly[r])) { inHole = true; break }
      if (!inHole) return true
    }
  }
  return false
}

/**
 * 아레나 생성: 피처들을 투영→병합해 물리 경계·지역 목록을 만든다.
 * mode: 'province'(8도) | 'city-all'(전국 시군) | 'city-of'(특정 지역의 시군)
 */
export function buildArena(mode, rect, regionKey = null) {
  let features, zones
  if (mode === 'province') {
    features = provincesGeo.features
  } else if (mode === 'city-all') {
    features = municipalitiesGeo.features
  } else {
    const region = REGIONS.find(r => r.key === regionKey)
    features = municipalitiesGeo.features.filter(f =>
      region.codes.some(c => f.properties.code.startsWith(c)))
  }
  const proj = makeProjector(features, rect)

  // zones: 결과 판정 단위
  if (mode === 'province') {
    zones = REGIONS.map(r => ({ ...r, polys: [] }))
    for (const f of provincesGeo.features) {
      const region = regionOfCode(f.properties.code)
      const zone = zones.find(z => z.key === region.key)
      zone.polys.push(...projectFeature(f, proj))
    }
  } else {
    zones = features.map((f, i) => {
      const region = regionOfCode(f.properties.code)
      return {
        key: f.properties.code,
        name: f.properties.name,
        parent: PROVINCE_LABEL[f.properties.code.slice(0, 2)],
        emoji: region?.emoji ?? '📍',
        color: zoneColor(region?.color ?? '#74c0fc', i),
        desc: region?.desc ?? '',
        polys: projectFeature(f, proj),
      }
    })
  }

  // 해안선 병합 → 물리 경계
  const allPolys = zones.flatMap(z => z.polys)
  let unioned
  try {
    unioned = polygonClipping.union(...allPolys)
  } catch {
    unioned = allPolys
  }

  // 면적순 정렬: [0]=본토, 나머지=섬
  const pieces = unioned
    .map(poly => ({ poly, area: ringArea(poly[0]) }))
    .sort((a, b) => b.area - a.area)

  const MIN_ARENA_AREA = pieces[0].area * 0.004
  const mainland = pieces[0]
  const mainMaxX = Math.max(...mainland.poly[0].map(p => p[0]))
  // 제주급 큰 섬, 또는 본토 동쪽 바다에 고립된 섬(울릉도)은 아레나로 승격
  const islands = pieces.slice(1).filter(p => {
    const c = ringCentroid(p.poly[0])
    return p.area >= MIN_ARENA_AREA ||
      (c[0] > mainMaxX - 12 && p.area >= mainland.area * 0.0012)
  })
  const decor = pieces.slice(1).filter(p => !islands.includes(p))

  // 섬 아레나 확대: 공(r=9)이 놀 수 있는 최소 크기 보장 (렌더/판정 좌표 함께 변환)
  const demoted = []
  for (const isl of islands) {
    const ring = isl.poly[0]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of ring) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0])
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1])
    }
    const minDim = Math.min(maxX - minX, maxY - minY)
    const f = Math.max(1, Math.min(6, 90 / Math.max(minDim, 1)))
    if (minDim * f < 42) { demoted.push(isl); continue }
    if (f <= 1.01) continue
    const c = ringCentroid(ring)
    const tf = (pt) => [c[0] + (pt[0] - c[0]) * f, c[1] + (pt[1] - c[1]) * f]
    for (const z of zones) {
      z.polys = z.polys.map(poly =>
        pointInRing(ringCentroid(poly[0]), ring) ? poly.map(r => r.map(tf)) : poly)
    }
    isl.poly = isl.poly.map(r => r.map(tf))
  }
  const finalIslands = islands.filter(i => !demoted.includes(i))
  decor.push(...demoted)

  return {
    mode,
    zones,
    mainland,
    islands: finalIslands,
    decor,
    findZone(pt) {
      for (const z of zones) if (pointInPolys(pt, z.polys)) return z
      // 근접 탐색(경계 오차 보정)
      let best = null, bestD = Infinity
      for (const z of zones) for (const poly of z.polys) for (const p of poly[0]) {
        const d = (p[0] - pt[0]) ** 2 + (p[1] - pt[1]) ** 2
        if (d < bestD) { bestD = d; best = z }
      }
      return best
    },
  }
}

function zoneColor(base, i) {
  // 같은 지역 색을 살짝씩 변주해 시·군 구분
  const h = hexToHsl(base)
  const l = Math.max(28, Math.min(72, h.l + ((i * 13) % 24) - 12))
  return `hsl(${h.h}, ${h.s}%, ${l}%)`
}

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}
