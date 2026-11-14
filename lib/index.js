/*!
 * dsh-turn-notify — Host half (node)
 *
 * Pops a card in the bottom-right corner of the desktop whenever an agent turn
 * reaches its terminal `turn/end` event.
 *
 * Why a PowerShell + WPF child process and not an in-process Electron window:
 * the dsh plugin host is a SEPARATE plain-node child process (the desktop shell
 * `spawn`s `dsh-desktop-host`), so `require('electron')` there yields no
 * `BrowserWindow` at all. Rendering has to cross the process boundary.
 *
 * Why not Windows toast:
 * an unpackaged Win32 process has no registered AppUserModelId shortcut, so
 * `ToastNotifier.Show()` reports success while Windows silently drops the
 * notification.
 *
 * Why no `-WindowStyle Hidden` / `windowsHide`:
 * HIPS products flag that exact combination as "hidden PowerShell execution"
 * and block the child, which silently kills the notification. The renderer is
 * launched as a normal (minimized) process instead.
 *
 * The renderer script must keep a UTF-8 BOM: PowerShell 5.1 reads a BOM-less
 * file as ANSI, which mangles the Chinese comments and breaks parsing.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'turn-notify'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')

function dshHome () {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const profile = process.env.USERPROFILE
  return profile ? join(profile, '.dsh') : undefined
}

// A silent no-op is the worst failure mode for a notifier, so every branch
// below leaves a line behind that can be read after the fact.
let logPath
let logDisabled = false
function debugLog (message) {
  if (logDisabled) return
  try {
    if (logPath === undefined) {
      const home = dshHome()
      if (home === undefined) {
        logDisabled = true
        return
      }
      logPath = join(home, 'turn-notify-debug.log')
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
  } catch {
    logDisabled = true
  }
}

/**
 * Path the WPF renderer should append its own trace to, or undefined to skip.
 *
 * Never return an empty string: `powershell -File x.ps1 -LogPath ""` is a parse
 * error, and the renderer dies instantly instead of drawing.
 */
function resolveRendererLog () {
  const home = dshHome()
  if (home === undefined || home.length === 0) return undefined
  return join(home, 'turn-notify-wpf.log')
}

function resolveScript (configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.length > 0) candidates.push(configured)
  candidates.push(join(PKG_ROOT, 'toast.ps1'))
  const home = dshHome()
  if (home !== undefined) candidates.push(join(home, 'plugins', 'dsh-turn-notify', 'toast.ps1'))
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

function reasonKind (reason) {
  if (reason === undefined || reason === null) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

function isErrorReason (reason) {
  const kind = reasonKind(reason)
  return kind === 'error' || kind === 'interrupted'
}

function sessionLabel (session, cfg) {
  if (!cfg.showSessionTitle) return 'DeepSeek Harness'
  try {
    const title = session?.header?.title
    if (typeof title === 'string' && title.trim().length > 0) {
      return `DeepSeek Harness · ${title.trim()}`
    }
  } catch {
    /* header shape is not guaranteed */
  }
  return 'DeepSeek Harness'
}

function clip (text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (max <= 0 || value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function fmtDuration (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m${sec}s`
  const hour = Math.floor(min / 60)
  return `${hour}h${min % 60}m`
}

export function apply (ctx, config) {
  debugLog(`apply() entered, platform=${process.platform}, pid=${process.pid}`)
  const cfg = {
    enabled: true,
    seconds: 6,
    width: 380,
    bottomMargin: 24,
    rightMargin: 24,
    notifyOnSuccess: true,
    notifyOnError: true,
    minDurationSec: 0,
    showSessionTitle: true,
    maxBodyChars: 160,
    debounceMs: 400,
    script: undefined,
    ...(config ?? {}),
  }

  if (!cfg.enabled) {
    debugLog('bail: cfg.enabled is false')
    return
  }
  if (process.platform !== 'win32') {
    debugLog(`bail: platform is ${process.platform}`)
    return
  }

  const script = resolveScript(cfg.script)
  if (script === undefined) {
    debugLog('bail: toast.ps1 not found')
    return
  }
  debugLog(`using renderer: ${script}`)

  const turnStartedAt = new Map()
  // One popup at a time; a newer turn replaces the queued payload rather than
  // stacking windows.
  let active
  let pending
  let lastShownAt = 0

  function spawnPopup (title, body) {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Title', title,
      '-Body', body,
      '-Seconds', String(Math.max(1, Math.round(cfg.seconds))),
      '-CardWidth', String(Math.max(160, Math.round(cfg.width))),
      '-BottomMargin', String(Math.max(0, Math.round(cfg.bottomMargin))),
      '-RightMargin', String(Math.max(0, Math.round(cfg.rightMargin))),
    ]
    // Only pass -LogPath when it is a real string: `powershell -File ... -LogPath ""`
    // is a parse error ("Missing an argument for parameter 'LogPath'"), and the
    // renderer then dies within milliseconds with exit code 1 — a popup that
    // spawns and instantly vanishes, which is easy to misread as "not shown".
    const rendererLog = resolveRendererLog()
    if (rendererLog !== undefined) args.push('-LogPath', rendererLog)
    try {
      // `detached: false` on purpose. With `detached: true` the exit event fires
      // as soon as the launcher hands off, so the plugin believes the popup died
      // in ~200ms while the real renderer keeps running detached — which makes
      // the queue logic and the diagnostics both lie. Staying attached costs one
      // live child for `seconds`, which is exactly what we want to observe.
      // No `windowsHide` either: see the header note on HIPS behaviour.
      const child = spawn('powershell.exe', args, {
        detached: false,
        stdio: 'ignore',
        windowsHide: false,
      })
      active = child
      child.on('error', (err) => {
        debugLog(`spawn error: ${err?.message}`)
        if (active === child) active = undefined
        flush()
      })
      child.on('exit', (code) => {
        debugLog(`renderer exited code=${code}`)
        if (active === child) active = undefined
        flush()
      })
      // Deliberately no `child.unref()`: the popup should end when its turn ends,
      // and an unref'd child would be reaped with the host process.
      // Never wedge the queue on a child that never reports exit.
      const guard = setTimeout(() => {
        if (active === child) {
          debugLog('renderer guard timeout; releasing')
          active = undefined
          flush()
        }
      }, (cfg.seconds + 30) * 1000)
      if (typeof guard.unref === 'function') guard.unref()
    } catch (err) {
      debugLog(`spawn threw: ${err?.message}`)
      active = undefined
    }
  }

  function flush () {
    if (active !== undefined) return
    if (pending === undefined) return
    const next = pending
    pending = undefined
    lastShownAt = Date.now()
    spawnPopup(next.title, next.body)
  }

  function request (title, body) {
    debugLog(`request: title="${title}" body="${body}"`)
    pending = { title, body }
    if (active !== undefined) return
    if (Date.now() - lastShownAt < cfg.debounceMs) {
      const timer = setTimeout(flush, cfg.debounceMs)
      if (typeof timer.unref === 'function') timer.unref()
      return
    }
    flush()
  }

  const seenTypes = new Set()

  ctx.on('session/event', (session, event) => {
    try {
      if (event === undefined || event === null) return
      const type = event.type
      if (type !== 'turn/start' && type !== 'turn/end') {
        if (type !== undefined && !seenTypes.has(type)) {
          seenTypes.add(type)
          debugLog(`observed other event: ${type}`)
        }
        return
      }

      const key = session?.header?.id !== undefined ? String(session.header.id) : 'default'

      if (type === 'turn/start') {
        turnStartedAt.set(key, Date.now())
        return
      }

      const startedAt = turnStartedAt.get(key)
      turnStartedAt.delete(key)
      const elapsedMs = startedAt === undefined ? undefined : Date.now() - startedAt

      if (cfg.minDurationSec > 0 && elapsedMs !== undefined && elapsedMs < cfg.minDurationSec * 1000) {
        debugLog(`skip: turn shorter than minDurationSec (${elapsedMs}ms)`)
        return
      }

      const reason = event.data?.reason
      const failed = isErrorReason(reason)
      debugLog(`turn/end key=${key} kind=${reasonKind(reason)} elapsed=${elapsedMs ?? 'n/a'}ms failed=${failed}`)

      if (failed && !cfg.notifyOnError) {
        debugLog('skip: notifyOnError is false')
        return
      }
      if (!failed && !cfg.notifyOnSuccess) {
        debugLog('skip: notifyOnSuccess is false')
        return
      }

      const kind = reasonKind(reason)
      const bits = []
      if (failed) bits.push('本轮失败')
      else if (kind === 'max-tokens') bits.push('达到 token 上限')
      else if (kind === 'blocked') bits.push('本轮已停止')
      else bits.push('消息完成')
      const duration = fmtDuration(elapsedMs)
      if (duration.length > 0) bits.push(`耗时 ${duration}`)

      request(sessionLabel(session, cfg), clip(bits.join(' · '), cfg.maxBodyChars))
    } catch (err) {
      debugLog(`handler threw: ${err?.stack ?? err}`)
    }
  })

  debugLog('subscribed to session/event — plugin armed')
}
