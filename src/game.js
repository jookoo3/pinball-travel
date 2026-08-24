// game.js — Matter.js 물리 + 캔버스 렌더링 핀볼 게임
import Matter from 'matter-js'

const { Engine, World, Bodies, Body, Events, Composite } = Matter

export const CANVAS_W = 780
export const CANVAS_H = 940
export const MAP_RECT = { x: 36, y: 96, w: 596, h: 800 }
const LANE_L = CANVAS_W - 86   // 발사 레인 왼쪽 벽
const LANE_R = CANVAS_W - 20   // 발사 레인 오른쪽 벽
const LANE_CX = (LANE_L + LANE_R) / 2
const BALL_R = 9
const GAP_HALF = 26            // 북쪽 관문 반폭
const WALL_T = 12
const PLUNGER_TRAVEL = 108

function decimate(ring, minDist = 5) {
  const out = [ring[0]]
  for (const p of ring) {
    const last = out[out.length - 1]
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) out.push(p)
  }
  return out
}

// Chaikin 코너 라운딩: 뾰족한 해안 요철에 공이 끼는 것을 완화
function chaikin(ring, iterations = 1) {
  let pts = ring
  for (let k = 0; k < iterations; k++) {
    const out = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length]
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25])
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    pts = out
  }
  return pts
}

function segmentBodies(pts, closed, opts = {}) {
  const bodies = []
  const n = closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 0.5) continue
    bodies.push(Bodies.rectangle(
      (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, len + WALL_T * 0.9, WALL_T,
      { isStatic: true, angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
        restitution: 0.85, friction: 0, ...opts },
    ))
  }
  return bodies
}

function centroidOf(ring) {
  let x = 0, y = 0
  for (const p of ring) { x += p[0]; y += p[1] }
  return [x / ring.length, y / ring.length]
}

function pointInRing(pt, ring) {
  let inside = false
  const [x, y] = pt
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function randomLandPoint(ring, margin = 26) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of ring) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0])
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1])
  }
  for (let t = 0; t < 300; t++) {
    const pt = [minX + Math.random() * (maxX - minX), minY + Math.random() * (maxY - minY)]
    if (!pointInRing(pt, ring)) continue
    // 경계에서 margin 이상 떨어졌는지
    let ok = true
    for (let i = 0; i < ring.length; i += 3) {
      const d = Math.hypot(ring[i][0] - pt[0], ring[i][1] - pt[1])
      if (d < margin) { ok = false; break }
    }
    if (ok) return pt
  }
  return centroidOf(ring)
}

export function createGame(canvas, arena, { duration = 15, onFinish, onEnter }) {
  const ctx = canvas.getContext('2d')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H

  const engine = Engine.create()
  engine.gravity.y = 0.42
  engine.positionIterations = 10
  engine.velocityIterations = 8

  const mainRing = chaikin(decimate(arena.mainland.poly[0], 9))

  // ── 북쪽 관문(입구): 본토 최상단 지점 ──────────────────────
  let gapIdx = 0
  for (let i = 1; i < mainRing.length; i++) if (mainRing[i][1] < mainRing[gapIdx][1]) gapIdx = i
  const gap = mainRing[gapIdx]
  const gapY = gap[1]

  // 관문 주변을 뚫은 본토 벽
  const wallPts = []
  const gapSegs = []
  {
    let cur = []
    for (const p of mainRing) {
      if (Math.abs(p[0] - gap[0]) < GAP_HALF && p[1] < gapY + 34) {
        if (cur.length > 1) gapSegs.push(cur)
        cur = []
      } else cur.push(p)
    }
    if (cur.length > 1) gapSegs.push(cur)
    // 링이 관문에서 끊긴 열린 폴리라인들
  }
  const walls = []
  if (gapSegs.length === 1) {
    walls.push(...segmentBodies(gapSegs[0], false))
  } else if (gapSegs.length >= 2) {
    // 마지막 조각과 첫 조각은 원래 이어져 있었음 → 연결
    const joined = [...gapSegs[gapSegs.length - 1], ...gapSegs[0]]
    walls.push(...segmentBodies(joined, false))
    for (let i = 1; i < gapSegs.length - 1; i++) walls.push(...segmentBodies(gapSegs[i], false))
  } else {
    walls.push(...segmentBodies(mainRing, true))
  }
  // 본토 내부 구멍(호수 등)
  for (let r = 1; r < arena.mainland.poly.length; r++) {
    walls.push(...segmentBodies(chaikin(decimate(arena.mainland.poly[r], 8)), true))
  }

  // ── 발사 레인 + 항로(채널): 안쪽 벽은 관문 쪽으로 내리막 ──
  const chTop = 14
  const gapL = gap[0] - GAP_HALF, gapR = gap[0] + GAP_HALF
  const outerPath = [ // 레인 오른벽 → 상단 외곽 → 관문 왼쪽 봉인
    [LANE_R, CANVAS_H], [LANE_R, 80], [LANE_R - 8, 40], [LANE_R - 30, chTop + 6], [LANE_R - 60, chTop],
    [gapL + 4, chTop], [gapL - 2, gapY - 30], [gapL, gapY + 6],
  ]
  const innerPath = [ // 레인 왼벽 → 내리막 채널 바닥 → 관문 오른쪽 봉인
    [LANE_L, CANVAS_H], [LANE_L, 140], [LANE_L - 8, 96], [LANE_L - 30, 68], [LANE_L - 60, 56],
    [gapR + 8, gapY - 12], [gapR, gapY + 6],
  ]
  walls.push(...segmentBodies(outerPath, false, { restitution: 0.35 }))
  walls.push(...segmentBodies(innerPath, false, { restitution: 0.35 }))
  // 레인 바닥
  walls.push(Bodies.rectangle(LANE_CX, CANVAS_H - 4, LANE_R - LANE_L + 20, WALL_T, { isStatic: true }))

  // 가이드 레일 곡선 (레인 꼭대기 → 관문 상공)
  const railP0 = [LANE_CX, 96]
  const railP1 = [LANE_CX - 10, 26]      // 제어점: 꼭대기 커브
  const railP2 = [(LANE_CX + gap[0]) / 2, 26]
  const railP3 = [gap[0], gapY - 26]
  function railPoint(t) {
    const u = 1 - t
    return [
      u * u * u * railP0[0] + 3 * u * u * t * railP1[0] + 3 * u * t * t * railP2[0] + t * t * t * railP3[0],
      u * u * u * railP0[1] + 3 * u * u * t * railP1[1] + 3 * u * t * t * railP2[1] + t * t * t * railP3[1],
    ]
  }
  let railLen = 0
  {
    let prev = railPoint(0)
    for (let i = 1; i <= 40; i++) {
      const p = railPoint(i / 40)
      railLen += Math.hypot(p[0] - prev[0], p[1] - prev[1])
      prev = p
    }
  }

  // ── 섬 아레나 + 웜홀 ─────────────────────────────────────
  const portals = []
  const islandRings = []
  for (const isl of arena.islands) {
    const ring = chaikin(decimate(isl.poly[0], 7))
    islandRings.push(ring)
    walls.push(...segmentBodies(ring, true))
    const c = centroidOf(ring)
    const landP = randomLandPoint(mainRing, 30)
    portals.push({ a: landP, b: c, r: 15, cool: 0, hue: 180 + Math.random() * 120 })
  }

  // ── 스피너: 각 아레나(본토·섬) 중앙 고정, 공 속도에 비례해 회전 ──
  const spinners = []
  const spinnerBodies = []
  function ringBBox(ring) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of ring) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0])
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1])
    }
    return { minX, minY, maxX, maxY }
  }
  function makeSpinner(ring) {
    let c = centroidOf(ring)
    if (!pointInRing(c, ring)) c = randomLandPoint(ring, 24)
    const bb = ringBBox(ring)
    const len = Math.max(44, Math.min(84, Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY) * 0.34))
    const body = Bodies.rectangle(c[0], c[1], len, 9, {
      isStatic: true, label: 'spinner', restitution: 0.7, friction: 0,
    })
    spinners.push({ x: c[0], y: c[1], len, angle: Math.random() * Math.PI, spin: 0, flash: 0, body })
    spinnerBodies.push(body)
  }
  makeSpinner(mainRing)
  for (const r of islandRings) makeSpinner(r)

  // ── 범퍼 (XP 스페이스 카뎃 오마주): 맞으면 다른 위치로 이동 ──
  const bumpers = []
  const bumperBodies = []
  function freeBumperSpot(avoidBallDist = 0) {
    for (let t = 0; t < 40; t++) {
      const pt = randomLandPoint(mainRing, 34)
      if (portals.some(p => Math.hypot(p.a[0] - pt[0], p.a[1] - pt[1]) < 60)) continue
      if (spinners.some(s => Math.hypot(s.x - pt[0], s.y - pt[1]) < s.len / 2 + 44)) continue
      if (bumpers.some(b => Math.hypot(b.x - pt[0], b.y - pt[1]) < 80)) continue
      if (avoidBallDist && Math.hypot(ball.position.x - pt[0], ball.position.y - pt[1]) < avoidBallDist) continue
      return pt
    }
    return null
  }
  const nBump = 3
  for (let i = 0; i < nBump; i++) {
    const pt = freeBumperSpot()
    if (!pt) continue
    const r = 15 + Math.random() * 7
    const body = Bodies.circle(pt[0], pt[1], r, { isStatic: true, restitution: 1.2, label: 'bumper' })
    bumpers.push({ x: pt[0], y: pt[1], r, flash: 0, spawn: 1, body })
    bumperBodies.push(body)
  }

  // ── 공 ────────────────────────────────────────────────────
  const plungerRestY = CANVAS_H - 120
  const ball = Bodies.circle(LANE_CX, plungerRestY - BALL_R - 6, BALL_R, {
    restitution: 0.92, friction: 0, frictionAir: 0.0045, density: 0.0016, label: 'ball',
  })

  World.add(engine.world, [...walls, ...spinnerBodies, ...bumperBodies, ball])

  // ── 상태 ─────────────────────────────────────────────────
  const state = {
    phase: 'ready',        // ready → launched → play → done
    duration: typeof duration === 'function' ? 0 : duration,
    timeLeft: typeof duration === 'function' ? 0 : duration,
    plungerPull: 0,        // 0..1
    dragging: false,
    dragStartY: 0,
    trail: [],
    gateClosed: false,
    onRail: false,
    railT: 0,
    railSpeed: 0,
    slowTime: 0,
    resultZone: null,
    gustTimer: 1.6,
    topTime: 0, botTime: 0,
    stars: makeStars(),
    t: 0,
    destroyed: false,
  }

  Events.on(engine, 'collisionStart', (ev) => {
    for (const pair of ev.pairs) {
      const bump = pair.bodyA.label === 'bumper' ? pair.bodyA : pair.bodyB.label === 'bumper' ? pair.bodyB : null
      if (bump && state.phase !== 'done') {
        const b = bumpers.find(x => x.body === bump)
        if (b) b.flash = 1
        const dx = ball.position.x - bump.position.x
        const dy = ball.position.y - bump.position.y
        const d = Math.hypot(dx, dy) || 1
        Body.applyForce(ball, ball.position, { x: (dx / d) * 0.012, y: (dy / d) * 0.012 })
        // 튕겨낸 뒤 다른 위치로 순간이동
        if (b) setTimeout(() => {
          if (state.destroyed) return
          const pt = freeBumperSpot(90)
          if (!pt) return
          b.x = pt[0]; b.y = pt[1]; b.spawn = 0
          Body.setPosition(bump, { x: pt[0], y: pt[1] })
        }, 220)
      }
      const spinBody = pair.bodyA.label === 'spinner' ? pair.bodyA : pair.bodyB.label === 'spinner' ? pair.bodyB : null
      if (spinBody && state.phase !== 'done') {
        const s = spinners.find(x => x.body === spinBody)
        if (!s) continue
        const sp = Math.hypot(ball.velocity.x, ball.velocity.y)
        // 공이 지나간 방향(외적 부호)으로 속도에 비례해 회전
        const cross = (ball.position.x - s.x) * ball.velocity.y - (ball.position.y - s.y) * ball.velocity.x
        s.spin += Math.sign(cross || 1) * Math.min(14, 2 + sp * 0.75)
        s.spin = Math.max(-22, Math.min(22, s.spin))
        s.flash = 1
        // 날개 접선 방향으로 공을 쳐냄
        const dx = ball.position.x - s.x, dy = ball.position.y - s.y
        const d = Math.hypot(dx, dy) || 1
        const tang = Math.sign(s.spin)
        Body.applyForce(ball, ball.position, {
          x: (dx / d) * 0.006 + (-dy / d) * tang * 0.005,
          y: (dy / d) * 0.006 + (dx / d) * tang * 0.005,
        })
      }
    }
  })

  // ── 입력 (플런저) ─────────────────────────────────────────
  function canvasPos(e) {
    const r = canvas.getBoundingClientRect()
    const cx = (e.touches ? e.touches[0].clientX : e.clientX)
    const cy = (e.touches ? e.touches[0].clientY : e.clientY)
    return [(cx - r.left) * (CANVAS_W / r.width), (cy - r.top) * (CANVAS_H / r.height)]
  }
  function onDown(e) {
    if (state.phase !== 'ready') return
    const [x, y] = canvasPos(e)
    if (x > LANE_L - 30 && y > CANVAS_H - 340) {
      state.dragging = true
      state.dragStartY = y
      e.preventDefault()
    }
  }
  function onMove(e) {
    if (!state.dragging) return
    const [, y] = canvasPos(e)
    state.plungerPull = Math.max(0, Math.min(1, (y - state.dragStartY) / PLUNGER_TRAVEL))
    e.preventDefault()
  }
  function onUp() {
    if (!state.dragging) return
    state.dragging = false
    if (state.plungerPull > 0.05) {
      // 발사 시점에 플레이 시간 확정 (랜덤 모드 포함)
      state.duration = typeof duration === 'function' ? duration() : duration
      state.timeLeft = state.duration
      const v = 9 + state.plungerPull * 9
      Body.setVelocity(ball, { x: 0, y: -v })
      state.phase = 'launched'
    }
    state.plungerPull = 0
  }
  canvas.addEventListener('mousedown', onDown)
  canvas.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  canvas.addEventListener('touchstart', onDown, { passive: false })
  canvas.addEventListener('touchmove', onMove, { passive: false })
  window.addEventListener('touchend', onUp)

  // ── 루프 ─────────────────────────────────────────────────
  let raf
  let last = performance.now()
  function loop(now) {
    if (state.destroyed) return
    const dt = Math.min(32, now - last)
    last = now
    state.t += dt / 1000

    if (state.phase !== 'done') {
      // 서브스텝 2회로 터널링 방지
      Engine.update(engine, dt / 2)
      Engine.update(engine, dt / 2)
    }

    // 발사 튜브 효과: 레인 상승 중 중력 대부분 상쇄
    if (ball.position.x > LANE_L - 10 && !state.onRail) {
      Body.applyForce(ball, ball.position, { x: 0, y: -engine.gravity.y * ball.mass * 0.00082 })
    }

    // 가이드 레일: 레인 꼭대기 도달 → 곡선 항로를 따라 관문까지 유도
    if (state.phase === 'launched' && !state.onRail && ball.position.y < 110 && ball.position.x > LANE_L - 10 && ball.velocity.y < 0) {
      state.onRail = true
      state.railT = 0
      state.railSpeed = Math.max(7, Math.hypot(ball.velocity.x, ball.velocity.y) * 0.85)
    }
    if (state.onRail) {
      state.railT += (state.railSpeed * (dt / 16.6)) / railLen
      const t = Math.min(1, state.railT)
      const p = railPoint(t)
      Body.setPosition(ball, { x: p[0], y: p[1] })
      Body.setVelocity(ball, { x: 0, y: 0 })
      if (t >= 1) {
        state.onRail = false
        Body.setVelocity(ball, { x: (Math.random() - 0.5) * 3, y: Math.max(5, state.railSpeed * 0.55) })
      }
    }

    // 준비 상태: 공을 플런저 헤드 위에 고정
    if (state.phase === 'ready') {
      Body.setPosition(ball, { x: LANE_CX, y: plungerRestY + state.plungerPull * PLUNGER_TRAVEL - BALL_R - 8 })
      Body.setVelocity(ball, { x: 0, y: 0 })
    }

    // 속도 상한 (터널링 방지)
    const sp = Math.hypot(ball.velocity.x, ball.velocity.y)
    if (sp > 19) Body.setVelocity(ball, { x: (ball.velocity.x / sp) * 19, y: (ball.velocity.y / sp) * 19 })

    // 레인에서 굴러떨어진 공 복귀
    if (state.phase === 'launched' && ball.position.x > LANE_L && ball.position.y > plungerRestY - 60 && ball.velocity.y > -0.5) {
      state.phase = 'ready'
    }

    // 안전장치: 캔버스 밖으로 나간 공 복구
    if (ball.position.x < -30 || ball.position.x > CANVAS_W + 30 || ball.position.y < -30 || ball.position.y > CANVAS_H + 30) {
      if (state.phase === 'play') teleport(randomLandPoint(mainRing, 30))
      else state.phase = 'ready'
      state.trail.length = 0
    }

    // 아레나 진입 감지 → 타이머 시작 + 게이트 봉인 + 무중력 전환
    if ((state.phase === 'launched') && ball.position.y > gapY + 44 && ball.position.x < LANE_L - 30) {
      state.phase = 'play'
      engine.gravity.y = 0 // Zero-G: 위아래 치우침 없이 5:5로 떠다님
      if (!state.gateClosed) {
        state.gateClosed = true
        World.add(engine.world, Bodies.rectangle(gap[0], gapY + 2, GAP_HALF * 2 + 26, WALL_T,
          { isStatic: true, restitution: 0.85, angle: Math.atan2(
            mainRing[(gapIdx + 4) % mainRing.length][1] - mainRing[(gapIdx - 4 + mainRing.length) % mainRing.length][1],
            mainRing[(gapIdx + 4) % mainRing.length][0] - mainRing[(gapIdx - 4 + mainRing.length) % mainRing.length][0]) }))
      }
      onEnter?.()
    }

    if (state.phase === 'play') {
      state.timeLeft -= dt / 1000
      // 최소 순항 속도 유지: 무중력에서 공이 죽지 않고 계속 떠돌게
      if (sp < 4.2 && sp > 0.01) {
        const boost = 4.2 / sp
        Body.setVelocity(ball, { x: ball.velocity.x * boost, y: ball.velocity.y * boost })
      } else if (sp <= 0.01) {
        const a = Math.random() * Math.PI * 2
        Body.setVelocity(ball, { x: Math.cos(a) * 4.2, y: Math.sin(a) * 4.2 })
      }
      // 끼임 감지 워치독: 좁은 해안 요철에 갇히면 내륙으로 탈출 임펄스
      if (sp < 1.1) {
        state.slowTime += dt / 1000
        if (state.slowTime > 0.8) {
          state.slowTime = 0
          const curRing = islandRings.find(r => pointInRing([ball.position.x, ball.position.y], r)) ?? mainRing
          const target = randomLandPoint(curRing, curRing === mainRing ? 40 : 16)
          const dx = target[0] - ball.position.x, dy = target[1] - ball.position.y
          const d = Math.hypot(dx, dy) || 1
          Body.applyForce(ball, ball.position, {
            x: (dx / d) * 0.014, y: (dy / d) * 0.014,
          })
        }
      } else state.slowTime = 0
      // 상/하 체류 시간 추적 (5:5 밸런스용)
      const midY = MAP_RECT.y + MAP_RECT.h / 2
      if (ball.position.y < midY) state.topTime += dt / 1000
      else state.botTime += dt / 1000
      // 랜덤 돌풍 기믹 — 체류가 적은 절반 쪽으로 살짝 기울여 5:5 유지
      state.gustTimer -= dt / 1000
      if (state.gustTimer <= 0) {
        state.gustTimer = 1.4 + Math.random() * 1.6
        const total = state.topTime + state.botTime
        const imbalance = total > 2 ? (state.botTime - state.topTime) / total : 0 // +면 아래 과다
        const a = Math.random() * Math.PI * 2
        Body.applyForce(ball, ball.position, {
          x: Math.cos(a) * 0.009,
          y: Math.sin(a) * 0.009 - imbalance * 0.011,
        })
      }
      // 웜홀
      for (const p of portals) {
        p.cool = Math.max(0, p.cool - dt / 1000)
        if (p.cool > 0) continue
        const dA = Math.hypot(ball.position.x - p.a[0], ball.position.y - p.a[1])
        const dB = Math.hypot(ball.position.x - p.b[0], ball.position.y - p.b[1])
        if (dA < p.r) { teleport(p.b); p.cool = 1.2 }
        else if (dB < p.r) { teleport(p.a); p.cool = 1.2 }
      }
      if (state.timeLeft <= 0) {
        state.timeLeft = 0
        state.phase = 'done'
        Body.setVelocity(ball, { x: 0, y: 0 })
        state.resultZone = arena.findZone([ball.position.x, ball.position.y])
        setTimeout(() => { if (!state.destroyed) onFinish?.(state.resultZone) }, 900)
      }
    }

    // 트레일
    if (state.phase === 'launched' || state.phase === 'play') {
      state.trail.push({ x: ball.position.x, y: ball.position.y, a: 1 })
      if (state.trail.length > 26) state.trail.shift()
    }
    for (const t of state.trail) t.a *= 0.9

    for (const b of bumpers) {
      b.flash *= 0.9
      b.spawn = Math.min(1, b.spawn + dt / 350)
    }

    // 스피너 회전 갱신 (마찰 감쇠)
    for (const s of spinners) {
      s.angle += s.spin * (dt / 1000)
      s.spin *= Math.pow(0.55, dt / 1000)
      s.flash *= 0.92
      Body.setAngle(s.body, s.angle)
    }

    draw()
    raf = requestAnimationFrame(loop)
  }

  function teleport(to) {
    const v = ball.velocity
    Body.setPosition(ball, { x: to[0], y: to[1] - 20 })
    const sp = Math.max(4, Math.hypot(v.x, v.y) * 0.8)
    const a = Math.random() * Math.PI * 2
    Body.setVelocity(ball, { x: Math.cos(a) * sp * 0.6, y: Math.sin(a) * sp * 0.6 })
    state.trail.length = 0
  }

  // ── 렌더링 ────────────────────────────────────────────────
  function makeStars() {
    const s = []
    for (let i = 0; i < 90; i++) s.push({ x: Math.random() * CANVAS_W, y: Math.random() * CANVAS_H, r: Math.random() * 1.4 + 0.3, tw: Math.random() * 6 })
    return s
  }

  function tracePoly(poly) {
    for (const ring of poly) {
      ctx.moveTo(ring[0][0], ring[0][1])
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1])
      ctx.closePath()
    }
  }

  function draw() {
    // 심해 배경
    const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H)
    bg.addColorStop(0, '#070b1e')
    bg.addColorStop(0.55, '#0a1030')
    bg.addColorStop(1, '#0d0a26')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

    // 별
    for (const s of state.stars) {
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(state.t * 0.7 + s.tw))
      ctx.fillStyle = '#9db4ff'
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill()
    }
    ctx.globalAlpha = 1

    // 장식 섬
    ctx.fillStyle = 'rgba(90,120,200,0.25)'
    for (const d of arena.decor) { ctx.beginPath(); tracePoly(d.poly); ctx.fill('evenodd') }

    // 지역 채우기
    const done = state.phase === 'done'
    for (const z of arena.zones) {
      ctx.beginPath()
      for (const poly of z.polys) tracePoly(poly)
      const isWin = done && state.resultZone && z.key === state.resultZone.key
      const pulse = isWin ? 0.75 + 0.25 * Math.sin(state.t * 6) : 1
      ctx.globalAlpha = isWin ? pulse : done ? 0.25 : 0.8
      ctx.fillStyle = z.color
      ctx.fill('evenodd')
      ctx.globalAlpha = done && !isWin ? 0.15 : 0.5
      ctx.strokeStyle = '#0a1030'
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    // 해안선 네온
    ctx.save()
    ctx.shadowColor = '#5f7bff'
    ctx.shadowBlur = 14
    ctx.strokeStyle = 'rgba(140,165,255,0.9)'
    ctx.lineWidth = 2.4
    ctx.beginPath()
    tracePoly(arena.mainland.poly)
    for (const isl of arena.islands) tracePoly(isl.poly)
    ctx.stroke()
    ctx.restore()

    // 관문 표시
    if (!state.gateClosed) {
      ctx.save()
      ctx.strokeStyle = `rgba(255,220,120,${0.5 + 0.5 * Math.sin(state.t * 5)})`
      ctx.setLineDash([6, 6])
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(gapL, gapY); ctx.lineTo(gapR, gapY); ctx.stroke()
      ctx.restore()
    }

    // 항로(채널) 메탈/네온 렌더
    drawLaunchChannel()

    // 가이드 레일 (점선 곡선)
    ctx.save()
    ctx.strokeStyle = 'rgba(255,214,120,0.4)'
    ctx.setLineDash([4, 8])
    ctx.lineDashOffset = -state.t * 40
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(railP0[0], railP0[1])
    for (let i = 1; i <= 30; i++) { const p = railPoint(i / 30); ctx.lineTo(p[0], p[1]) }
    ctx.stroke()
    ctx.restore()

    // 웜홀
    for (const p of portals) {
      for (const [x, y] of [p.a, p.b]) drawPortal(x, y, p.r, p.hue)
      // 연결 점선
      ctx.save()
      ctx.strokeStyle = `hsla(${p.hue},90%,70%,0.18)`
      ctx.setLineDash([3, 9])
      ctx.lineDashOffset = -state.t * 30
      ctx.beginPath(); ctx.moveTo(p.a[0], p.a[1]); ctx.lineTo(p.b[0], p.b[1]); ctx.stroke()
      ctx.restore()
    }

    // 스피너
    for (const s of spinners) {
      const speed = Math.abs(s.spin)
      ctx.save()
      ctx.translate(s.x, s.y)
      ctx.rotate(s.angle)
      ctx.shadowColor = '#63e6be'
      ctx.shadowBlur = 8 + Math.min(26, speed * 2) + s.flash * 14
      const grad = ctx.createLinearGradient(-s.len / 2, 0, s.len / 2, 0)
      grad.addColorStop(0, 'rgba(99,230,190,0.9)')
      grad.addColorStop(0.5, '#eafff7')
      grad.addColorStop(1, 'rgba(99,230,190,0.9)')
      ctx.fillStyle = grad
      roundRect(-s.len / 2, -4.5, s.len, 9, 4.5)
      ctx.fill()
      // 잔상 (빠를수록 진하게)
      if (speed > 2) {
        ctx.globalAlpha = Math.min(0.4, speed * 0.02)
        ctx.rotate(-Math.sign(s.spin) * 0.35)
        roundRect(-s.len / 2, -4.5, s.len, 9, 4.5)
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.restore()
      // 중심 허브
      ctx.save()
      ctx.fillStyle = '#0d1233'
      ctx.strokeStyle = '#9ef5d9'
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(s.x, s.y, 6.5, 0, 7); ctx.fill(); ctx.stroke()
      ctx.restore()
    }

    // 범퍼
    for (const b of bumpers) {
      const g = ctx.createRadialGradient(b.x, b.y, 2, b.x, b.y, b.r)
      g.addColorStop(0, b.flash > 0.1 ? '#fff' : '#ffd6f2')
      g.addColorStop(1, `rgba(255,80,180,${0.55 + b.flash * 0.45})`)
      ctx.save()
      ctx.globalAlpha = b.spawn
      const rr = b.r * (0.6 + 0.4 * b.spawn)
      ctx.shadowColor = '#ff5fb4'
      ctx.shadowBlur = 10 + b.flash * 26
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(b.x, b.y, rr, 0, 7); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()
    }

    // 플런저
    drawPlunger()

    // 트레일 + 공
    for (let i = 0; i < state.trail.length; i++) {
      const t = state.trail[i]
      ctx.globalAlpha = t.a * 0.35 * (i / state.trail.length)
      ctx.fillStyle = '#9fd8ff'
      ctx.beginPath(); ctx.arc(t.x, t.y, BALL_R * (i / state.trail.length), 0, 7); ctx.fill()
    }
    ctx.globalAlpha = 1
    const bg2 = ctx.createRadialGradient(ball.position.x - 3, ball.position.y - 3, 1, ball.position.x, ball.position.y, BALL_R)
    bg2.addColorStop(0, '#ffffff')
    bg2.addColorStop(0.6, '#cfe0ff')
    bg2.addColorStop(1, '#7b93d8')
    ctx.save()
    ctx.shadowColor = '#bcd0ff'
    ctx.shadowBlur = 12
    ctx.fillStyle = bg2
    ctx.beginPath(); ctx.arc(ball.position.x, ball.position.y, BALL_R, 0, 7); ctx.fill()
    ctx.restore()

    // 좌상단 속도 HUD
    drawHUD()
  }

  function drawPath(pts, color) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 3.5
    ctx.shadowColor = color
    ctx.shadowBlur = 12
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    traceRoundedPath(pts)
    ctx.stroke()
    ctx.lineWidth = 1.25
    ctx.shadowBlur = 0
    ctx.strokeStyle = 'rgba(240,250,255,0.55)'
    ctx.beginPath()
    traceRoundedPath(pts)
    ctx.stroke()
    ctx.restore()
  }

  function drawPortal(x, y, r, hue) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(state.t * 2)
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = `hsla(${hue},95%,${65 + i * 8}%,${0.75 - i * 0.2})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(0, 0, r - i * 4, i * 2, i * 2 + 4.4)
      ctx.stroke()
    }
    ctx.restore()
  }

  function drawPlunger() {
    const pull = state.plungerPull * PLUNGER_TRAVEL
    const py = plungerRestY + pull
    const laneW = LANE_R - LANE_L

    // ── 레인 튜브: 유리관 느낌 배경 + 메탈 레일 ──
    const tube = ctx.createLinearGradient(LANE_L, 0, LANE_R, 0)
    tube.addColorStop(0, 'rgba(70,90,160,0.30)')
    tube.addColorStop(0.5, 'rgba(120,150,235,0.10)')
    tube.addColorStop(1, 'rgba(70,90,160,0.30)')
    ctx.fillStyle = tube
    ctx.fillRect(LANE_L, chTop, laneW, CANVAS_H)
    for (const rx of [LANE_L, LANE_R]) {
      const rail = ctx.createLinearGradient(rx - 3, 0, rx + 3, 0)
      rail.addColorStop(0, '#2a3566')
      rail.addColorStop(0.5, '#8fa3e8')
      rail.addColorStop(1, '#2a3566')
      ctx.fillStyle = rail
      ctx.fillRect(rx - 3, chTop, 6, CANVAS_H)
    }

    // 발사 준비 시 위로 흐르는 셰브런(∧) 유도등
    if (state.phase === 'ready') {
      ctx.save()
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      for (let i = 0; i < 6; i++) {
        const yy = plungerRestY - 80 - i * 88 + ((state.t * 60) % 88)
        if (yy < chTop + 30) continue
        const a = 0.15 + 0.55 * Math.abs(Math.sin(state.t * 2 + i))
        ctx.strokeStyle = `rgba(255,200,110,${a})`
        ctx.beginPath()
        ctx.moveTo(LANE_CX - 12, yy + 8)
        ctx.lineTo(LANE_CX, yy)
        ctx.lineTo(LANE_CX + 12, yy + 8)
        ctx.stroke()
      }
      ctx.restore()
    }

    // ── 스프링: 압축 반영, 투톤 메탈 코일 ──
    ctx.save()
    const springTop = py + 16
    const springBot = CANVAS_H - 30
    const coils = 9
    for (const pass of [
      { c: 'rgba(140,90,30,0.9)', w: 5, off: 1.5 },
      { c: '#ffb457', w: 3, off: 0 },
      { c: '#ffe2b0', w: 1.2, off: -1 },
    ]) {
      ctx.strokeStyle = pass.c
      ctx.lineWidth = pass.w
      ctx.beginPath()
      for (let i = 0; i <= coils * 10; i++) {
        const t2 = i / (coils * 10)
        const yy = springTop + t2 * (springBot - springTop) + pass.off
        const xx = LANE_CX + Math.sin(t2 * coils * Math.PI * 2) * (14 - state.plungerPull * 5)
        i === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy)
      }
      ctx.stroke()
    }
    ctx.restore()

    // ── 플런저 로드 + 헤드 ──
    ctx.save()
    // 로드(막대)
    const rod = ctx.createLinearGradient(LANE_CX - 5, 0, LANE_CX + 5, 0)
    rod.addColorStop(0, '#5a4630'); rod.addColorStop(0.5, '#d9b98a'); rod.addColorStop(1, '#5a4630')
    ctx.fillStyle = rod
    ctx.fillRect(LANE_CX - 5, py + 4, 10, 26)
    // 헤드(그립 노브)
    ctx.shadowColor = state.dragging ? '#ffd27a' : '#ffb457'
    ctx.shadowBlur = state.dragging ? 24 : 8
    const head = ctx.createLinearGradient(0, py - 8, 0, py + 12)
    head.addColorStop(0, state.dragging ? '#ffe3ae' : '#ffcd85')
    head.addColorStop(0.5, '#e8a24d')
    head.addColorStop(1, '#9c6524')
    ctx.fillStyle = head
    roundRect(LANE_L + 8, py - 8, laneW - 16, 20, 9)
    ctx.fill()
    ctx.shadowBlur = 0
    // 그립 라인
    ctx.strokeStyle = 'rgba(80,50,10,0.55)'
    ctx.lineWidth = 1.4
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath()
      ctx.moveTo(LANE_CX + i * 9 - 4, py - 4)
      ctx.lineTo(LANE_CX + i * 9 - 4, py + 8)
      ctx.stroke()
    }
    // 헤드 하이라이트
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    roundRect(LANE_L + 12, py - 6, laneW - 24, 5, 3)
    ctx.fill()
    ctx.restore()

    // ── 베이스 캡 ──
    ctx.save()
    const base = ctx.createLinearGradient(0, CANVAS_H - 30, 0, CANVAS_H)
    base.addColorStop(0, '#3a466f'); base.addColorStop(1, '#151b3a')
    ctx.fillStyle = base
    roundRect(LANE_L + 4, CANVAS_H - 28, laneW - 8, 24, 6)
    ctx.fill()
    ctx.strokeStyle = 'rgba(150,175,255,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()

    // ── 파워 게이지 (눈금 + 퍼센트) ──
    if (state.dragging) {
      const gh = 150, gx = LANE_L - 24, gy = CANVAS_H - 150 - gh
      ctx.save()
      ctx.fillStyle = 'rgba(10,16,48,0.8)'
      roundRect(gx - 4, gy - 6, 20, gh + 12, 8); ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.10)'
      roundRect(gx, gy, 12, gh, 6); ctx.fill()
      const ph = gh * state.plungerPull
      const pg = ctx.createLinearGradient(0, gy + gh, 0, gy)
      pg.addColorStop(0, '#63e6be'); pg.addColorStop(0.55, '#ffd43b'); pg.addColorStop(1, '#ff6b6b')
      ctx.shadowColor = '#ffd43b'
      ctx.shadowBlur = 10
      ctx.fillStyle = pg
      roundRect(gx, gy + gh - ph, 12, ph, 6); ctx.fill()
      ctx.shadowBlur = 0
      ctx.strokeStyle = 'rgba(10,16,48,0.6)'
      ctx.lineWidth = 1
      for (let i = 1; i < 5; i++) {
        ctx.beginPath()
        ctx.moveTo(gx, gy + (gh * i) / 5)
        ctx.lineTo(gx + 12, gy + (gh * i) / 5)
        ctx.stroke()
      }
      ctx.fillStyle = '#ffe9a8'
      ctx.font = 'bold 13px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`${Math.round(state.plungerPull * 100)}%`, gx + 6, gy - 14)
      ctx.restore()
    }

    if (state.phase === 'ready' && !state.dragging) {
      ctx.save()
      ctx.fillStyle = `rgba(255,220,140,${0.5 + 0.5 * Math.sin(state.t * 3)})`
      ctx.font = 'bold 14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('▼ PULL', LANE_CX, plungerRestY - 40)
      ctx.restore()
    }
  }

  function traceRoundedPath(pts) {
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length - 1; i++) {
      const curr = pts[i]
      const next = pts[i + 1]
      const mx = (curr[0] + next[0]) / 2
      const my = (curr[1] + next[1]) / 2
      ctx.quadraticCurveTo(curr[0], curr[1], mx, my)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last[0], last[1])
  }

  function drawLaunchChannel() {
    ctx.save()
    const fill = ctx.createLinearGradient(LANE_L, CANVAS_H, gap[0], chTop)
    fill.addColorStop(0, 'rgba(20,32,88,0.82)')
    fill.addColorStop(0.45, 'rgba(38,68,145,0.48)')
    fill.addColorStop(1, 'rgba(120,225,255,0.16)')
    ctx.fillStyle = fill
    ctx.beginPath()
    traceRoundedPath(outerPath)
    for (let i = innerPath.length - 1; i >= 0; i--) {
      const p = innerPath[i]
      i === innerPath.length - 1 ? ctx.lineTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
    ctx.fill()

    ctx.globalAlpha = 0.75
    drawPath(outerPath, 'rgba(120,220,255,0.72)')
    drawPath(innerPath, 'rgba(120,220,255,0.72)')
    ctx.globalAlpha = 1

    const beam = ctx.createLinearGradient(LANE_CX, CANVAS_H, gap[0], gapY)
    beam.addColorStop(0, 'rgba(255,255,255,0)')
    beam.addColorStop(0.5, 'rgba(195,240,255,0.16)')
    beam.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.strokeStyle = beam
    ctx.lineWidth = 9
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(LANE_CX - 8, 118)
    for (let i = 1; i <= 30; i++) {
      const p = railPoint(i / 30)
      ctx.lineTo(p[0], p[1])
    }
    ctx.stroke()
    ctx.restore()
  }

  // ── 좌상단 속도 HUD ──
  function drawHUD() {
    const sp = Math.hypot(ball.velocity.x, ball.velocity.y)
    const kmh = Math.round(sp * 11)
    const x = 18, y = 16, w = 158, h = 54
    ctx.save()
    ctx.fillStyle = 'rgba(10,16,48,0.72)'
    ctx.strokeStyle = 'rgba(140,165,255,0.35)'
    ctx.lineWidth = 1
    roundRect(x, y, w, h, 12)
    ctx.fill(); ctx.stroke()
    ctx.textAlign = 'left'
    ctx.fillStyle = '#8fa3e8'
    ctx.font = 'bold 10px sans-serif'
    ctx.fillText('BALL SPEED', x + 14, y + 17)
    ctx.fillStyle = sp > 14 ? '#ff8787' : sp > 7 ? '#ffd43b' : '#63e6be'
    ctx.font = '900 22px sans-serif'
    ctx.fillText(String(kmh), x + 14, y + 40)
    ctx.fillStyle = '#8fa3e8'
    ctx.font = 'bold 11px sans-serif'
    ctx.fillText('km/h', x + 14 + ctx.measureText(String(kmh)).width + 26, y + 40)
    // 속도 바
    const bw = w - 28, bx = x + 14, by = y + 46
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    roundRect(bx, by, bw, 4, 2); ctx.fill()
    const frac = Math.min(1, sp / 19)
    const bg3 = ctx.createLinearGradient(bx, 0, bx + bw, 0)
    bg3.addColorStop(0, '#63e6be'); bg3.addColorStop(0.55, '#ffd43b'); bg3.addColorStop(1, '#ff6b6b')
    ctx.fillStyle = bg3
    roundRect(bx, by, Math.max(3, bw * frac), 4, 2); ctx.fill()
    ctx.restore()
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  raf = requestAnimationFrame(loop)

  return {
    get state() { return state },
    get ball() { return { x: ball.position.x, y: ball.position.y, vx: ball.velocity.x, vy: ball.velocity.y } },
    debug: { gap, gapY, gapL, gapR },
    destroy() {
      state.destroyed = true
      cancelAnimationFrame(raf)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('touchstart', onDown)
      canvas.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
      Composite.clear(engine.world, false)
      Engine.clear(engine)
    },
  }
}
