// audio.js — 외부 음원 없이 Web Audio로 즉석 합성하는 간단한 효과음
let ctx = null

const MUTE_KEY = 'pinball-travel:muted'
let muted = localStorage.getItem(MUTE_KEY) === '1'

export function isMuted() { return muted }
export function setMuted(v) {
  muted = !!v
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
}

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

/** 벽·장애물에 부딪힐 때 나는 짧은 타격음. strength(0~1)가 클수록 크고 낮게 울린다 */
export function playHit(strength = 0.5) {
  if (muted) return
  const ac = getCtx()
  const t0 = ac.currentTime
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(240 - strength * 60 + Math.random() * 30, t0)
  osc.frequency.exponentialRampToValueAtTime(80, t0 + 0.08)
  gain.gain.setValueAtTime(0.05 + Math.min(1, strength) * 0.16, t0)
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09)
  osc.connect(gain); gain.connect(ac.destination)
  osc.start(t0); osc.stop(t0 + 0.1)
}

/** 웜홀 순간이동 시 나는 상승하는 워프음 */
export function playWarp() {
  if (muted) return
  const ac = getCtx()
  const t0 = ac.currentTime
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(180, t0)
  osc.frequency.exponentialRampToValueAtTime(920, t0 + 0.22)
  gain.gain.setValueAtTime(0.001, t0)
  gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.04)
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.26)
  osc.connect(gain); gain.connect(ac.destination)
  osc.start(t0); osc.stop(t0 + 0.28)
}
