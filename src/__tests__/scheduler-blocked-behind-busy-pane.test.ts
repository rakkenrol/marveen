import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeBlockedBehindPane } from '../web/schedule-runner.js'

// SCHEDBLOCKED1024. The busy-pane notice named its instrument but not its cost.
// Measured 2026-10-24 on peet: the reggeli-napindito round finished its work at
// 07:32:28 and the agent made zero tool calls for the next 55 minutes, yet the
// pane read not-ready throughout -- so the 08:00 kanban-audit round was deferred
// 109 times (08:00:13 -> 08:27:11) and fired 27.5 minutes late. The notice said
// only "the pane has been busy 56 minutes", the agent checked out healthy, and
// the deferred round was findable only in dashboard.log, because
// pending_task_retries is emptied on delivery.

const ROOT = join(__dirname, '..', '..')
const RUNNER_SRC = readFileSync(join(ROOT, 'src', 'web', 'schedule-runner.ts'), 'utf-8')
const codeLines = RUNNER_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

const row = (task: string, agent: string, firstAttempt: number, attempts: number) =>
  ({ task_name: task, agent_name: agent, first_attempt: firstAttempt, attempt_count: attempts })

const NOW = 1_792_823_246_101 // 2026-10-24 08:27:26 CEST, the measured case

describe('describeBlockedBehindPane names the deferred rounds behind the pane', () => {
  it('reports the count, the oldest task, its wait in minutes and its attempt count', () => {
    const rows = [row('kanban-audit', 'peet', NOW - 27.5 * 60_000, 109)]
    const s = describeBlockedBehindPane(rows, 'peet', NOW, 'reggeli-napindito')
    expect(s).toContain('1 ütemezett kör vár kézbesítésre')
    expect(s).toContain('"kanban-audit"')
    expect(s).toContain('27 perce')
    expect(s).toContain('109 próbálkozás')
  })

  it('is empty when nothing is deferred -- the notice then gains no line', () => {
    expect(describeBlockedBehindPane([], 'peet', NOW)).toBe('')
  })

  it('counts only the SAME session: another agent queue is not this pane cost', () => {
    const rows = [row('ledger-live-drain', 'envibot', NOW - 60_000, 52)]
    expect(describeBlockedBehindPane(rows, 'peet', NOW)).toBe('')
    expect(describeBlockedBehindPane(rows, 'envibot', NOW)).toContain('"ledger-live-drain"')
  })

  it('excludes the in-flight task itself, so a redelivery row never reports itself as its own victim', () => {
    const rows = [row('reggeli-napindito', 'peet', NOW - 60_000, 4)]
    expect(describeBlockedBehindPane(rows, 'peet', NOW, 'reggeli-napindito')).toBe('')
  })

  it('picks the OLDEST by first_attempt, not the first row or the highest attempt count', () => {
    const rows = [
      row('kanban-audit', 'peet', NOW - 5 * 60_000, 900),
      row('dream-engine', 'peet', NOW - 40 * 60_000, 3),
    ]
    const s = describeBlockedBehindPane(rows, 'peet', NOW)
    expect(s).toContain('2 ütemezett kör vár')
    expect(s).toContain('"dream-engine"')
    expect(s).toContain('40 perce')
  })

  it('a clock that moved backwards reads 0 minutes, never a negative wait', () => {
    const rows = [row('kanban-audit', 'peet', NOW + 90_000, 1)]
    expect(describeBlockedBehindPane(rows, 'peet', NOW)).toContain('0 perce')
  })
})

describe('both alert builders carry the line, and the refusal names the state', () => {
  it('the main-agent notice and the owner alert both append blockedBehindLine', () => {
    const notice = codeLines.slice(
      codeLines.indexOf('function sendTaskInflightMainAgentNotice('),
      codeLines.indexOf('function sendTaskTimeoutAlert('),
    )
    const alert = codeLines.slice(
      codeLines.indexOf('function sendTaskTimeoutAlert('),
      codeLines.indexOf('export const SCHEDULE_TICK_MS'),
    )
    expect(notice).toContain('...blockedBehindLine(entry, Date.now())')
    expect(alert).toContain('...blockedBehindLine(entry, Date.now())')
  })

  it('the pending-retry read can never throw into the sweep', () => {
    const start = codeLines.indexOf('function blockedBehindLine(')
    expect(start).toBeGreaterThan(-1)
    const wrapper = codeLines.slice(start, codeLines.indexOf('function sendTaskInflightMainAgentNotice('))
    expect(wrapper).toContain('try {')
    expect(wrapper).toContain('catch (err)')
  })

  it('the busy-refusal warn line logs the measured pane state', () => {
    expect(codeLines).toMatch(
      /paneState = notReadyPane != null \? detectPaneState\(notReadyPane\) : null/,
    )
    expect(codeLines).toMatch(
      /logger\.warn\(\{ task: task\.name, agent: agentName, session, paneState \}, 'Schedule target session busy or has pending input, will retry'\)/,
    )
  })

  it('the refusal reuses the capture already taken for the first-run gate (no extra tmux read)', () => {
    const start = codeLines.indexOf('const notReadyPane = capturePane(session, host)')
    expect(start).toBeGreaterThan(-1)
    const gate = codeLines.slice(start, codeLines.indexOf("return 'busy'", start))
    expect(gate.match(/capturePane\(session, host\)/g)).toHaveLength(1)
    expect(gate).toContain('detectPaneState(notReadyPane)')
  })
})
