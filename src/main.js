// main.js — 화면 전환, 게임 세션 관리
import './style.css'
import { loadGeo, buildArena, REGIONS } from './geo.js'
import { createGame, MAP_RECT } from './game.js'

const $ = (s) => document.querySelector(s)
const screens = { home: $('#screen-home'), game: $('#screen-game') }
const overlay = $('#result-overlay')
const loading = $('#loading')

// ── 모바일 뷰포트 높이 보정 ─────────────────────────────────
// 모바일 브라우저의 100vh는 주소창/툴바를 포함해 계산되어 실제 보이는
// 영역보다 커지는 경우가 많다(특히 구형 iOS Safari에서 dvh 미지원 시).
// 실제 innerHeight를 --vh 변수로 저장해 CSS의 폴백으로 사용한다.
function setViewportHeightVar() {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`)
}
setViewportHeightVar()
window.addEventListener('resize', setViewportHeightVar)
window.addEventListener('orientationchange', () => setTimeout(setViewportHeightVar, 100))
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setViewportHeightVar)
}

const app = {
  timeMode: '20',      // '10' | '20' | '30' | 'custom' | 'random'
  mode: null,          // 'province' | 'city'
  game: null,
  lastResult: null,    // 결과 zone
}

function resolveDuration() {
  if (app.timeMode === 'random') return 1 + Math.floor(Math.random() * 60)
  if (app.timeMode === 'custom') {
    const v = Number(document.querySelector('#custom-time').value)
    return Math.max(1, Math.min(120, Math.round(v || 15)))
  }
  return Number(app.timeMode)
}

function show(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'))
  screens[name].classList.add('active')
}

// ── 홈 화면 ──────────────────────────────────────────────
// ── 시간 선택 (게임 화면) ─────────────────────────────────
function timerLabel() {
  if (app.timeMode === 'random') return '?'
  if (app.timeMode === 'custom') {
    const v = Number($('#custom-time').value)
    return Math.max(1, Math.min(120, Math.round(v || 15)))
  }
  return app.timeMode
}
document.querySelectorAll('.time-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (app.game && app.game.state.phase !== 'ready') return // 발사 후 변경 불가
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    app.timeMode = btn.dataset.time
    $('#custom-time-wrap').classList.toggle('hidden', app.timeMode !== 'custom')
    $('#random-time-hint').classList.toggle('hidden', app.timeMode !== 'random')
    if (app.timeMode === 'custom') $('#custom-time').focus()
    $('#timer-num').textContent = timerLabel()
  })
})
$('#custom-time')?.addEventListener('input', () => {
  if (app.timeMode === 'custom') $('#timer-num').textContent = timerLabel()
})

document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    const mode = card.dataset.mode
    if (mode === 'secret') {
      card.classList.add('shake')
      setTimeout(() => card.classList.remove('shake'), 500)
      return
    }
    startGame(mode === 'province' ? { mode: 'province' } : { mode: 'city-all' })
  })
})

// ── 게임 시작/종료 ───────────────────────────────────────
async function startGame({ mode, regionKey = null }) {
  loading.classList.remove('hidden')
  overlay.classList.remove('visible')
  try {
    await loadGeo()
    // 무거운 union 연산 전 렌더 프레임 양보
    await new Promise(r => setTimeout(r, 30))
    const arena = buildArena(mode, MAP_RECT, regionKey)
    destroyGame()
    show('game')
    $('#hint').classList.remove('hidden')

    app.mode = mode
    const region = regionKey ? REGIONS.find(r => r.key === regionKey) : null
    $('#game-title').textContent =
      mode === 'province' ? '🗺️ 간략한 지도'
      : mode === 'city-all' ? '📍 자세한 지도'
      : `🔎 ${region.name} 자세히 보기`

    $('#timer-num').textContent = timerLabel()
    $('#timer-fill').style.width = '100%'
    $('#timer-fill').classList.remove('danger')
    $('#time-select').classList.remove('locked')

    app.game = createGame($('#game-canvas'), arena, {
      duration: () => resolveDuration(),
      onEnter: () => $('#hint').classList.add('hidden'),
      onFinish: (zone) => showResult(zone),
    })
    window.__game = app.game // 디버그/테스트용

    // 타이머 UI 갱신
    const tick = setInterval(() => {
      if (!app.game || app.game.state.destroyed) { clearInterval(tick); return }
      const s = app.game.state
      if (s.phase !== 'ready') $('#time-select').classList.add('locked')
      if (s.phase === 'play' || s.phase === 'done') {
        $('#timer-num').textContent = Math.ceil(s.timeLeft)
        $('#timer-fill').style.width = `${(s.timeLeft / s.duration) * 100}%`
        $('#timer-fill').classList.toggle('danger', s.timeLeft < 4)
      } else if (s.phase === 'launched') {
        $('#timer-num').textContent = s.duration
      }
    }, 100)
  } finally {
    loading.classList.add('hidden')
  }
}

function destroyGame() {
  app.game?.destroy()
  app.game = null
}

// ── 결과 카드 ────────────────────────────────────────────
function showResult(zone) {
  app.lastResult = zone
  if (!zone) return
  $('#card-emoji').textContent = zone.emoji
  $('#card-region').textContent = zone.name
  $('#card-sub').textContent = zone.parent ? `${zone.parent}` : ''
  $('#card-desc').textContent = zone.desc || '이번 여행, 여기로 정해졌습니다!'
  // '더 자세히'는 8도 모드 결과에서만
  $('#btn-detail').style.display = app.mode === 'province' ? '' : 'none'
  overlay.classList.add('visible')
}

$('#btn-detail').addEventListener('click', () => {
  overlay.classList.remove('visible')
  startGame({ mode: 'city-of', regionKey: app.lastResult.key })
})

// ── 공유 ─────────────────────────────────────────────────
let toastTimer
function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

$('#btn-share').addEventListener('click', async () => {
  const z = app.lastResult
  if (!z) return
  const place = z.parent ? `${z.parent} ${z.name}` : z.name
  const modeName = app.mode === 'province' ? '팔도 유람' : app.mode === 'city-all' ? '전국 일주' : '자세히 정하기'
  const text = `🎱 Pinball Travel 결과 발표!\n${z.emoji} 이번 여행지는 「${place}」 (${modeName})\n핀볼이 정해준 곳으로 떠나요 ✈️`
  const shareData = { title: 'Pinball Travel · 한반도 핀볼 여행', text, url: location.origin }
  try {
    if (navigator.share) {
      await navigator.share(shareData)
      return
    }
    throw new Error('no web share')
  } catch (err) {
    if (err?.name === 'AbortError') return // 사용자가 공유 취소
    try {
      await navigator.clipboard.writeText(`${text}\n${location.origin}`)
      toast('📋 결과가 클립보드에 복사됐어요!')
    } catch {
      toast('공유에 실패했어요 😢')
    }
  }
})

$('#btn-retry').addEventListener('click', () => {
  overlay.classList.remove('visible')
  const regionKey = app.mode === 'city-of'
    ? REGIONS.find(r => r.codes.some(c => app.lastResult.key.startsWith(c)))?.key
    : null
  startGame({ mode: app.mode, regionKey })
})

$('#btn-home').addEventListener('click', () => {
  overlay.classList.remove('visible')
  destroyGame()
  show('home')
})

$('#btn-back').addEventListener('click', () => {
  destroyGame()
  overlay.classList.remove('visible')
  show('home')
})