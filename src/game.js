// game.js — Matter.js 물리 + 캔버스 렌더링 핀볼 게임
import Matter from 'matter-js'
import { playHit, playWarp } from './audio.js'

const { Engine, World, Bodies, Body, Events, Composite } = Matter

export const CANVAS_W = 780
export const CANVAS_H = 940
export const MAP_RECT = { x: 36, y: 96, w: 596, h: 800 }
const LANE_L = CANVAS_W - 86   // 발사 레인 왼쪽 벽
const LANE_R = CANVAS_W - 20   // 발사 레인 오른쪽 벽
const LANE_CX = (LANE_L + LANE_R) / 2
const BALL_R = 9
const WALL_T = 12
const LANE_PORTAL_Y = 90       // 발사 레인 끝 — 여기 닿으면 진입 포탈을 타고 지도로 이동
const PLUNGER_MARGIN = 210     // 발사대(플런저) 하단 여유 공간 — 기존 120에서 확대해 당기고 쏘는 조작감을 개선
const PLUNGER_TRAVEL = 115     // 플런저가 눌리는 최대 시각적 이동 거리 — 기존 70
const PLUNGER_DRAG_DIST = 175  // 100% 파워가 되는 데 필요한 드래그 거리(px) — 기존 150
const PLUNGER_ZONE = PLUNGER_MARGIN + 170 // 플런저 발사 제스처를 인식하는 터치 영역 높이 — 기존 320

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

export function createGame(canvas, arena, { duration = 15, onFinish, onEnter, onPick }) {
  const ctx = canvas.getContext('2d')

  // ── 모바일 레티나 대응 ───────────────────────────────────
  // canvas.width/height는 논리 좌표(CANVAS_W/H)로 고정하되, 실제 픽셀
  // 버퍼는 devicePixelRatio만큼 키우고 컨텍스트를 스케일해서 그린다.
  // 물리 연산과 터치 좌표 변환(canvasPos)은 CSS 표시 크기 기준이라
  // 영향을 받지 않고, 고해상도(레티나) 모바일 화면에서도 선명하게 보인다.
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = CANVAS_W * dpr
  canvas.height = CANVAS_H * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const engine = Engine.create()
  engine.gravity.y = 0.42
  engine.positionIterations = 10
  engine.velocityIterations = 8

  const mainRing = chaikin(decimate(arena.mainland.poly[0], 9))

  // 본토 해안선은 이제 완전히 닫힌 하나의 고리다 — 예전엔 북쪽에 구멍을 뚫어
  // 곡선 레일로 이어야 했지만, 지금은 발사 레인 끝의 포탈로 곧장 순간이동하므로
  // 입구가 필요 없다(어정쩡하게 넓어지고 좁아지던 통로 문제도 함께 사라진다).
  const walls = [...segmentBodies(mainRing, true)]

  // 본토 내부 구멍(호수 등) — 렌더링과 물리 벽이 반드시 같은 좌표를 쓰도록 보관
  const mainHoleRings = []
  for (let r = 1; r < arena.mainland.poly.length; r++) {
    const hole = chaikin(decimate(arena.mainland.poly[r], 8))
    mainHoleRings.push(hole)
    walls.push(...segmentBodies(hole, true))
  }

  // ── 발사 레인: 처음부터 끝까지 곧게 뻗은 외길, 끝에는 진입 포탈이 있다 ──
  walls.push(Bodies.rectangle(LANE_L, (CANVAS_H + LANE_PORTAL_Y) / 2, WALL_T, CANVAS_H - LANE_PORTAL_Y, { isStatic: true, restitution: 0.35 }))
  walls.push(Bodies.rectangle(LANE_R, (CANVAS_H + LANE_PORTAL_Y) / 2, WALL_T, CANVAS_H - LANE_PORTAL_Y, { isStatic: true, restitution: 0.35 }))
  // 레인 바닥
  walls.push(Bodies.rectangle(LANE_CX, CANVAS_H - 4, LANE_R - LANE_L + 20, WALL_T, { isStatic: true }))

  // 발사 레인 끝(진입 포탈) ↔ 지도 위 착지 지점을 잇는 메인 포탈.
  // 다른 웜홀보다 크고 화려하게(hue=골드 계열) 그려 "이게 메인 입구"임을 알려준다.
  const entryPortal = { a: [LANE_CX, LANE_PORTAL_Y], b: randomLandPoint(mainRing, 40), r: 30, hue: 46 }
  // 사용자가 직접 고른 지점이 "공이 갇히지 않고 내려설 수 있는 육지"인지 확인
  function isLandable(pt) {
    const rings = [mainRing, ...islandRings]
    const ring = rings.find(r => pointInRing(pt, r))
    if (!ring) return false
    if (mainHoleRings.some(h => pointInRing(pt, h))) return false
    const margin = ring === mainRing ? 18 : 14
    for (let i = 0; i < ring.length; i++) {
      if (Math.hypot(ring[i][0] - pt[0], ring[i][1] - pt[1]) < margin) return false
    }
    return true
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
    spinners.push({
      x: c[0], y: c[1], len, angle: Math.random() * Math.PI, spin: 0, flash: 0, body,
      ghost: false, ghostUntil: 0, // 한 번 맞으면 잠시 반투명 통과 상태가 됨
    })
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
      if (Math.hypot(entryPortal.b[0] - pt[0], entryPortal.b[1] - pt[1]) < 60) continue
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

  let lastHitSoundT = -1 // 충돌음이 한 프레임에 여러 번 겹쳐 울리지 않도록 쿨다운

  // ── 공 ────────────────────────────────────────────────────
  const plungerRestY = CANVAS_H - PLUNGER_MARGIN
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
    pickMode: false,       // true면 발사 전에 지도를 눌러 착지 지점을 직접 정한다
    pickFlash: 0,          // 착지 지점 변경 직후 번쩍 연출
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
        if (!s || s.ghost) continue // 통과 상태인 스피너는 충돌 무시
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
        // 한 번 맞으면 1~5초간 반투명 통과 상태로 전환
        s.ghost = true
        s.ghostUntil = state.t + 1 + Math.random() * 4
        s.body.isSensor = true
      }

      // 벽·스피너·범퍼에 부딪힐 때 나는 공통 타격음(속도에 비례, 너무 잦으면 쿨다운)
      if ((pair.bodyA === ball || pair.bodyB === ball) && state.phase !== 'done') {
        const sp = Math.hypot(ball.velocity.x, ball.velocity.y)
        if (sp > 1.5 && state.t - lastHitSoundT > 0.05) {
          lastHitSoundT = state.t
          playHit(Math.min(1, sp / 14))
        }
      }
    }
  })

  // ── 입력 (플런저) ─────────────────────────────────────────
  function canvasPos(e) {
    const r = canvas.getBoundingClientRect()
    const cx = (e.touches ? e.touches[0].clientX : e.clientX)
    const cy = (e.touches ? e.touches[0].clientY : e.clientY)
    // r.width/height는 CSS 표시 크기이므로 devicePixelRatio와 무관하게
    // 항상 논리 좌표(CANVAS_W/H) 기준으로 정확히 변환된다.
    return [(cx - r.left) * (CANVAS_W / r.width), (cy - r.top) * (CANVAS_H / r.height)]
  }
  function onDown(e) {
    if (state.phase !== 'ready') return
    const [x, y] = canvasPos(e)
    if (x > LANE_L - 20 && y > CANVAS_H - PLUNGER_ZONE) {
      state.dragging = true
      state.dragStartY = y
      e.preventDefault()
      return
    }
    // 직접 선택 모드: 지도를 눌러 착지 지점 지정
    if (state.pickMode && x < LANE_L - 10) {
      const ok = isLandable([x, y])
      if (ok) { entryPortal.b = [x, y]; state.pickFlash = 1 }
      onPick?.(ok)
      e.preventDefault()
    }
  }
  function onMove(e) {
    if (!state.dragging) return
    const [, y] = canvasPos(e)
    state.plungerPull = Math.max(0, Math.min(1, (y - state.dragStartY) / PLUNGER_DRAG_DIST))
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
  // 드래그 중 다른 손가락으로 화면을 만지거나(핀치줌) 취소되는 경우 대비
  window.addEventListener('touchcancel', onUp)

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
    if (ball.position.x > LANE_L - 10) {
      Body.applyForce(ball, ball.position, { x: 0, y: -engine.gravity.y * ball.mass * 0.00082 })
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

    // 레인 끝 진입 포탈 도달 → 지도 위 착지 지점으로 순간이동 + 무중력 전환
    if (state.phase === 'launched' && ball.velocity.y < 0 && ball.position.y <= entryPortal.a[1] + 4) {
      teleport(entryPortal.b, 0)
      state.phase = 'play'
      engine.gravity.y = 0 // Zero-G: 위아래 치우침 없이 5:5로 떠다님
      playWarp()
      onEnter?.()
    }

    if (state.phase === 'play') {
      state.timeLeft -= dt / 1000
      // 최소 순항 속도 유지: 무중력에서 공이 완전히 멈추진 않게 하되,
      // 매번 같은 목표 속도(4.2)로 스냅되면 "고정된 느낌"이 나므로
      // 임계값을 낮추고 목표 속도를 매번 다르게 흔들어 자연스럽게 만듦
      const MIN_CRUISE = 2.4
      if (sp < MIN_CRUISE && sp > 0.01) {
        const target = MIN_CRUISE + Math.random() * 2.6 // 2.4~5.0 사이 무작위
        const boost = target / sp
        Body.setVelocity(ball, { x: ball.velocity.x * boost, y: ball.velocity.y * boost })
      } else if (sp <= 0.01) {
        const a = Math.random() * Math.PI * 2
        const target = MIN_CRUISE + Math.random() * 2.6
        Body.setVelocity(ball, { x: Math.cos(a) * target, y: Math.sin(a) * target })
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
        if (dA < p.r) { teleport(p.b); p.cool = 1 + Math.random() * 2; playWarp() }
        else if (dB < p.r) { teleport(p.a); p.cool = 1 + Math.random() * 2; playWarp() }
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
    state.pickFlash *= 0.92

    // 스피너 회전 갱신 (마찰 감쇠) + 통과 상태 해제
    for (const s of spinners) {
      s.angle += s.spin * (dt / 1000)
      s.spin *= Math.pow(0.55, dt / 1000)
      s.flash *= 0.92
      Body.setAngle(s.body, s.angle)
      if (s.ghost && state.t >= s.ghostUntil) {
        s.ghost = false
        s.body.isSensor = false
      }
    }

    draw()
    raf = requestAnimationFrame(loop)
  }

  function teleport(to, offsetY = -20) {
    const v = ball.velocity
    Body.setPosition(ball, { x: to[0], y: to[1] + offsetY })
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
    // 실제 충돌 벽(mainRing/mainHoleRings/islandRings)과 100% 동일한 좌표를 그려서
    // "보이는 해안선"과 "물리적 벽"이 어긋나 생기던 투명 벽 버그를 근본적으로 제거한다.
    ctx.save()
    ctx.shadowColor = '#5f7bff'
    ctx.shadowBlur = 14
    ctx.strokeStyle = 'rgba(140,165,255,0.9)'
    ctx.lineWidth = 2.4
    ctx.beginPath()
    tracePoly([mainRing, ...mainHoleRings, ...islandRings])
    ctx.stroke()
    ctx.restore()

    // 메인 진입 포탈: 레인 끝(정면)과 지도 위 착지 지점(바닥에 놓인 원반 + 빛기둥)
    drawMainPortal(entryPortal.a[0], entryPortal.a[1], entryPortal.r, entryPortal.hue, { squash: 1 })
    drawMainPortal(entryPortal.b[0], entryPortal.b[1], entryPortal.r, entryPortal.hue, { squash: 0.55, beam: true })
    if (state.phase === 'ready' && state.pickMode) drawPickReticle(entryPortal.b[0], entryPortal.b[1], entryPortal.r)

    // 발사 레인: 처음부터 포탈까지 곧게 뻗은 유리관 (폭이 절대 변하지 않는다)
    drawLaneTube()

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
      ctx.globalAlpha = s.ghost ? 0.35 : 1 // 통과 상태면 반투명으로 표시
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
      ctx.globalAlpha = s.ghost ? 0.35 : 1
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


  // 발사 레인: 처음부터 진입 포탈까지 곧게 뻗은 유리관 (폭이 LANE_L~LANE_R로 고정이라
  // 절대 넓어지거나 좁아지지 않는다) + 포탈 방향(위쪽)으로 흐르는 빛 입자
  function drawLaneTube() {
    const laneW = LANE_R - LANE_L
    const tube = ctx.createLinearGradient(LANE_L, 0, LANE_R, 0)
    tube.addColorStop(0, 'rgba(70,90,160,0.30)')
    tube.addColorStop(0.5, 'rgba(120,150,235,0.10)')
    tube.addColorStop(1, 'rgba(70,90,160,0.30)')
    ctx.fillStyle = tube
    ctx.fillRect(LANE_L, LANE_PORTAL_Y, laneW, CANVAS_H - LANE_PORTAL_Y)
    for (const rx of [LANE_L, LANE_R]) {
      const rail = ctx.createLinearGradient(rx - 3, 0, rx + 3, 0)
      rail.addColorStop(0, '#2a3566')
      rail.addColorStop(0.5, '#8fa3e8')
      rail.addColorStop(1, '#2a3566')
      ctx.fillStyle = rail
      ctx.fillRect(rx - 3, LANE_PORTAL_Y, 6, CANVAS_H - LANE_PORTAL_Y)
    }

    for (let i = 0; i < 3; i++) {
      const t = (state.t * 0.35 + i / 3) % 1
      const y = CANVAS_H - t * (CANVAS_H - LANE_PORTAL_Y)
      ctx.save()
      ctx.globalAlpha = 0.25 + 0.55 * Math.sin(t * Math.PI)
      ctx.shadowColor = '#ffd478'
      ctx.shadowBlur = 11
      ctx.fillStyle = '#fff3d6'
      ctx.beginPath(); ctx.arc(LANE_CX, y, 3.2, 0, 7); ctx.fill()
      ctx.restore()
    }
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

  // 메인 진입 포탈 — 3D 소용돌이 느낌.
  // squash<1이면 원을 세로로 눌러 "바닥에 놓인 원반"으로 보이게 하고(원근 효과),
  // 어두운 중심→밝은 테두리 깔때기 + 나선 팔 + 깊이별 링 + 림 하이라이트 + 밖에서 안으로
  // 다이빙 들어가는 입자로 입체감을 만든다.
  function drawMainPortal(x, y, r, hue, { squash = 1, beam = false } = {}) {
    const t = state.t
    const flash = state.pickFlash

    // 바닥 포탈 위로 솟아오르는 빛기둥
    if (beam) {
      const bh = r * 4.6
      ctx.save()
      const g = ctx.createLinearGradient(0, y, 0, y - bh)
      g.addColorStop(0, `hsla(${hue},100%,78%,${0.34 + flash * 0.3})`)
      g.addColorStop(0.5, `hsla(${hue},100%,78%,0.12)`)
      g.addColorStop(1, `hsla(${hue},100%,78%,0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(x - r * 0.62, y); ctx.lineTo(x + r * 0.62, y)
      ctx.lineTo(x + r * 0.22, y - bh); ctx.lineTo(x - r * 0.22, y - bh)
      ctx.closePath(); ctx.fill()
      // 기둥 안을 떠오르는 반짝이
      for (let i = 0; i < 4; i++) {
        const p = (t * 0.45 + i / 4) % 1
        const px = x + Math.sin(t * 3 + i * 2) * r * 0.3 * (1 - p)
        const py = y - p * bh
        ctx.globalAlpha = (1 - p) * 0.8
        ctx.fillStyle = '#fff8e6'
        ctx.beginPath(); ctx.arc(px, py, 1.6, 0, 7); ctx.fill()
      }
      ctx.restore()
    }

    ctx.save()
    ctx.translate(x, y)
    ctx.scale(1, squash)

    // 바깥 후광
    const halo = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.1)
    halo.addColorStop(0, `hsla(${hue},95%,70%,${0.32 + flash * 0.3})`)
    halo.addColorStop(1, `hsla(${hue},95%,60%,0)`)
    ctx.fillStyle = halo
    ctx.beginPath(); ctx.arc(0, 0, r * 2.1, 0, 7); ctx.fill()

    // 깔때기: 중심은 깊고 어둡게, 가장자리로 갈수록 밝게 → 움푹 파인 입체감
    const funnel = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
    funnel.addColorStop(0, '#04061a')
    funnel.addColorStop(0.42, `hsla(${hue},70%,22%,0.95)`)
    funnel.addColorStop(0.78, `hsla(${hue},92%,55%,0.95)`)
    funnel.addColorStop(1, `hsla(${hue},100%,86%,0.75)`)
    ctx.fillStyle = funnel
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill()

    // 나선 팔 3개 — 안으로 휘감기며 회전
    ctx.save()
    ctx.rotate(t * 1.5)
    ctx.lineCap = 'round'
    for (let arm = 0; arm < 3; arm++) {
      const a0 = arm * ((Math.PI * 2) / 3)
      for (let k = 0; k < 14; k++) {
        const k0 = k / 14, k1 = (k + 1) / 14
        const r0 = r * (0.14 + 0.82 * k0), r1 = r * (0.14 + 0.82 * k1)
        const ang0 = a0 + k0 * 4.2, ang1 = a0 + k1 * 4.2
        ctx.strokeStyle = `hsla(${hue},100%,${80 - k0 * 30}%,${0.85 - k0 * 0.7})`
        ctx.lineWidth = 1.2 + k0 * 2.2
        ctx.beginPath()
        ctx.moveTo(Math.cos(ang0) * r0, Math.sin(ang0) * r0)
        ctx.lineTo(Math.cos(ang1) * r1, Math.sin(ang1) * r1)
        ctx.stroke()
      }
    }
    ctx.restore()

    // 깊이 링: 안쪽으로 갈수록 작고 흐릿하게(원근)
    for (let i = 0; i < 4; i++) {
      const rr = r * (0.94 - i * 0.2)
      ctx.strokeStyle = `hsla(${hue},95%,${75 - i * 8}%,${0.55 - i * 0.11})`
      ctx.lineWidth = 1.4
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, 7); ctx.stroke()
    }

    // 림 하이라이트: 위쪽 테두리가 더 밝게 → 위에서 받는 조명 느낌
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth = 2.2
    ctx.shadowColor = '#fff'
    ctx.shadowBlur = 8
    ctx.beginPath(); ctx.arc(0, 0, r, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke()
    ctx.shadowBlur = 0

    // 밑쪽 그림자 테두리
    ctx.strokeStyle = `hsla(${hue},80%,35%,0.8)`
    ctx.lineWidth = 2.4
    ctx.beginPath(); ctx.arc(0, 0, r, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke()
    ctx.restore()

    // 밖에서 안으로 나선을 그리며 빨려 들어가는 입자
    for (let i = 0; i < 9; i++) {
      const p = (t * 0.55 + i / 9) % 1
      const rad = r * (1.9 - 1.75 * p)
      const ang = p * 7 + i * 0.75 + t * 0.4
      const px = x + Math.cos(ang) * rad
      const py = y + Math.sin(ang) * rad * squash
      ctx.save()
      ctx.globalAlpha = 0.15 + 0.85 * p
      ctx.shadowColor = `hsla(${hue},100%,80%,0.9)`
      ctx.shadowBlur = 6
      ctx.fillStyle = p > 0.7 ? '#ffffff' : '#fff2cc'
      ctx.beginPath(); ctx.arc(px, py, 1.2 + 1.6 * p, 0, 7); ctx.fill()
      ctx.restore()
    }
  }

  // 직접 선택 모드에서 착지 지점 위에 떠 있는 조준선
  function drawPickReticle(x, y, r) {
    const R = r * 1.55 + 3 * Math.sin(state.t * 4)
    ctx.save()
    ctx.translate(x, y)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 1.6
    ctx.setLineDash([6, 6])
    ctx.lineDashOffset = -state.t * 30
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.stroke()
    ctx.setLineDash([])
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath()
      ctx.moveTo(dx * (R - 8), dy * (R - 8)); ctx.lineTo(dx * (R + 8), dy * (R + 8))
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(10,16,48,0.85)'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    const label = '착지 지점 — 지도를 눌러 변경'
    const w = ctx.measureText(label).width + 16
    roundRect(-w / 2, -R - 26, w, 18, 9); ctx.fill()
    ctx.fillStyle = '#ffe9a8'
    ctx.fillText(label, 0, -R - 13)
    ctx.restore()
  }

  function drawPlunger() {
    const pull = state.plungerPull * PLUNGER_TRAVEL
    const py = plungerRestY + pull
    const laneW = LANE_R - LANE_L

    // 레인 유리관 자체는 drawLaneTube()에서 이미 그렸으므로(포탈까지 한 번에 이어지는
    // 통로) 여기서는 발사대(스프링·로드·베이스) 부속만 그린다.

    // 발사 준비 시 위로 흐르는 셰브런(∧) 유도등
    if (state.phase === 'ready') {
      ctx.save()
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      for (let i = 0; i < 6; i++) {
        const yy = plungerRestY - 80 - i * 88 + ((state.t * 60) % 88)
        if (yy < LANE_PORTAL_Y + 30) continue
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
    debug: { entryPortal },
    setPickMode(on) {
      state.pickMode = !!on
      canvas.classList.toggle('picking', state.pickMode && state.phase === 'ready')
    },
    rerollEntry() {
      if (state.phase !== 'ready') return
      entryPortal.b = randomLandPoint(mainRing, 40)
      state.pickFlash = 1
    },
    destroy() {
      state.destroyed = true
      cancelAnimationFrame(raf)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('touchstart', onDown)
      canvas.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
      window.removeEventListener('touchcancel', onUp)
      Composite.clear(engine.world, false)
      Engine.clear(engine)
    },
  }
}