// main.js — 화면 전환, 게임 세션 관리
// style.css는 FOUC 방지를 위해 index.html에서 <link>로 직접 로드한다
import { loadGeo, buildArena, REGIONS } from './geo.js'
import { createGame, MAP_RECT } from './game.js'
import { isMuted, setMuted } from './audio.js'

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
  startMode: 'random', // 'random' | 'pick' — 착지 지점을 랜덤으로 뽑는지 직접 고를지
  mode: null,          // 'province' | 'city'
  game: null,
  lastResult: null,    // 결과 zone
}

// ── 소리 끄기/켜기 (설정은 localStorage에 저장되어 다음 방문에도 유지) ───────
function renderMuteBtn() {
  const m = isMuted()
  const btn = $('#btn-mute')
  btn.textContent = m ? '🔇' : '🔊'
  btn.classList.toggle('muted', m)
  btn.setAttribute('aria-pressed', String(m))
  btn.title = btn.ariaLabel = m ? '소리 켜기' : '소리 끄기'
}
$('#btn-mute').addEventListener('click', () => {
  setMuted(!isMuted())
  renderMuteBtn()
  toast(isMuted() ? '🔇 효과음을 꺼었어요' : '🔊 효과음을 켰어요')
})
renderMuteBtn()

// ── 공유 링크로 들어온 경우: 친구가 뽑은 결과 배너 표시 ────────
function encodeShareResult({ place, emoji, modeName }) {
  const payload = JSON.stringify([place, emoji, modeName])
  const bytes = new TextEncoder().encode(payload)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeShareResult(value) {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    const [place, emoji, modeName] = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof place !== 'string' || typeof emoji !== 'string' || typeof modeName !== 'string') return null
    return { place: place.slice(0, 40), emoji: emoji.slice(0, 8), modeName: modeName.slice(0, 20) }
  } catch {
    return null
  }
}

// 이전 버전의 r/e/m 링크가 공유 앱에서 한 번 더 인코딩된 경우도 복구한다.
function safelyDecode(value) {
  let decoded = value || ''
  for (let index = 0; index < 2 && /%[0-9a-f]{2}/i.test(decoded); index++) {
    try { decoded = decodeURIComponent(decoded) } catch { break }
  }
  return decoded
}

// 사용자 입력으로 만들어진 값은 innerHTML이 아닌 textContent로만 출력한다.
function showSharedResultBanner() {
  const params = new URLSearchParams(location.search)
  const compact = decodeShareResult(params.get('s') || '')
  const place = compact?.place || safelyDecode(params.get('r')).slice(0, 40)
  if (!place) return
  const emoji = compact?.emoji || safelyDecode(params.get('e')).slice(0, 8) || '🎯'
  const modeName = compact?.modeName || safelyDecode(params.get('m')).slice(0, 20)

  const banner = document.createElement('div')
  banner.className = 'shared-banner'

  const emojiEl = document.createElement('span')
  emojiEl.className = 'shared-banner-emoji'
  emojiEl.textContent = emoji

  const textEl = document.createElement('span')
  textEl.className = 'shared-banner-text'
  const strong = document.createElement('b')
  strong.textContent = `친구가 뽑은 여행지는 「${place}」!`
  textEl.append(strong, `${modeName ? ` (${modeName})` : ''} 너도 핀볼 굴려서 도전해봐`)

  const closeBtn = document.createElement('button')
  closeBtn.className = 'shared-banner-close'
  closeBtn.setAttribute('aria-label', '닫기')
  closeBtn.textContent = '✕'
  closeBtn.addEventListener('click', () => banner.remove())

  banner.append(emojiEl, textEl, closeBtn)
  document.body.appendChild(banner)
  history.replaceState(null, '', location.pathname) // 새로고침 시 배너 재노출 방지
}
showSharedResultBanner()

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

// ── 착지 지점 선택 (게임 화면) ──────────────────────────────────
const HINT_LAUNCH = '🎯 플런저를 <b>아래로 당겼다 놓아</b> 발사하세요'
const HINT_PICK = '👆 <b>지도를 눌러 착지 지점</b>을 정한 뒤 발사하세요'
function applyStartMode() {
  const pick = app.startMode === 'pick'
  $('#btn-reroll').classList.toggle('hidden', pick)
  $('#hint').innerHTML = pick ? HINT_PICK : HINT_LAUNCH // 상수 문자열만 삽입(사용자 입력 없음)
  app.game?.setPickMode(pick)
}
document.querySelectorAll('.start-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (app.game && app.game.state.phase !== 'ready') return
    document.querySelectorAll('.start-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    app.startMode = btn.dataset.start
    applyStartMode()
  })
})
$('#btn-reroll').addEventListener('click', () => {
  if (!app.game || app.game.state.phase !== 'ready') return
  app.game.rerollEntry()
  toast('🔀 착지 지점을 다시 뽑았어요')
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
    $('#start-select').classList.remove('locked')

    app.game = createGame($('#game-canvas'), arena, {
      duration: () => resolveDuration(),
      onEnter: () => $('#hint').classList.add('hidden'),
      onFinish: (zone) => showResult(zone),
      onPick: (ok) => toast(ok ? '📍 착지 지점 설정!' : '육지 위를 선택해주세요'),
    })
    window.__game = app.game // 디버그/테스트용
    applyStartMode()

    // 타이머 UI 갱신
    const tick = setInterval(() => {
      if (!app.game || app.game.state.destroyed) { clearInterval(tick); return }
      const s = app.game.state
      if (s.phase !== 'ready') {
        $('#time-select').classList.add('locked')
        $('#start-select').classList.add('locked')
        $('#game-canvas').classList.remove('picking')
      }
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

// 공유 시 매번 랜덤으로 고르는 유도 멘트 (받는 사람이 "나도 해봐야지" 싶게)
const SHARE_COMMENTS = [
  (place, emoji) => `${emoji} 나는 「${place}」 뽑았는데 너도 한번 해봐`,
  (place, emoji) => `${emoji} 어 「${place}」 떴다ㅋㅋ 너도 핀볼 굴려봐`,
  (place, emoji) => `여기 「${place}」 나왔는데... 바로 여행 ㄱ? ${emoji}`,
  (place, emoji) => `핀볼 결과 「${place}」! ${emoji} 너는 어디 나올지 안 궁금해?`,
]

$('#btn-share').addEventListener('click', async () => {
  const z = app.lastResult
  if (!z) return
  const place = z.parent ? `${z.parent} ${z.name}` : z.name
  const modeName = app.mode === 'province' ? '팔도 유람' : app.mode === 'city-all' ? '전국 일주' : '자세히 정하기'
  const pick = SHARE_COMMENTS[Math.floor(Math.random() * SHARE_COMMENTS.length)]
  const comment = pick(place, z.emoji || '🎯')
  // 결과를 UTF-8 Base64URL 하나로 묶어 한글 퍼센트 인코딩 링크보다 짧고 견고하게 공유한다.
  const url = `${location.origin}/?s=${encodeShareResult({ place, emoji: z.emoji || '🎯', modeName })}`
  const text = `${comment}\n${url}`
  const title = 'Pinball Travel · 한반도 핀볼 여행'

  try {
    if (navigator.share) {
      await navigator.share({ title, text })
      return
    }
    throw new Error('no web share')
  } catch (err) {
    if (err?.name === 'AbortError') return // 사용자가 공유 취소
    try {
      await navigator.clipboard.writeText(text)
      toast('📋 결과 링크가 클립보드에 복사됐어요!')
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