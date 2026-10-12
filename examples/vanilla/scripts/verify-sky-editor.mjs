/** Run against the vanilla server: BASE=http://127.0.0.1:5186/ node scripts/verify-sky-editor.mjs */
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5186/'
const OUT = new URL('./.verify-out/', import.meta.url).pathname
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist', '--use-angle=metal'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const result = {}
try {
  await page.goto(BASE + '26-floating-sky-editor.html', { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__tool, null, { timeout: 60000 })
  assert.equal(await page.evaluate(() => window.__sky.grade), null)
  await page.getByRole('button', { name: 'Sky Editor', exact: true }).click()
  await page.getByRole('region', { name: 'Sky Editor' }).waitFor()
  assert.equal(await page.evaluate(() => window.__sky.grade), null)
  result.openPreservesPhysicalSky = true

  await page.getByLabel('Sun navigation mode', { exact: true }).selectOption('manual')
  await page.getByLabel('Sun elevation', { exact: true }).fill('5')
  await page.getByLabel('Sun elevation', { exact: true }).press('Tab')
  await page.evaluate(() => window.__sky.setGrade([{ elevation: 0 }, { elevation: 10 }]))
  await page.getByLabel('Exposure value', { exact: true }).fill('0.8')
  await page.getByLabel('Exposure value', { exact: true }).press('Tab')
  assert.equal(await page.evaluate(() => window.__sky.grade.keys.length), 3)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__sky.grade.keys.length), 2)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__sky.grade.keys.length), 3)
  result.authoringAndHistory = true

  const grade = await page.evaluate(() => window.__tool.getGradeJSON())
  await page.getByRole('button', { name: 'Physical', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__sky.grade), null)
  assert.deepEqual(await page.evaluate(() => window.__tool.getGradeJSON()), grade)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__sky.grade.keys.length), 3)
  assert.equal(await page.evaluate(() => window.__controls.enabled), true)
  result.comparisonAndClose = true

  await page.getByRole('button', { name: 'Sky Editor', exact: true }).click()
  await page.getByRole('tab', { name: 'Sun and Atmosphere' }).click()
  await page.getByLabel('Atmosphere preset', { exact: true }).selectOption('mars')
  assert.equal(await page.evaluate(() => window.__sky.getSettings().preset), 'mars')
  await page.getByLabel('Turbidity value', { exact: true }).fill('2')
  await page.getByLabel('Turbidity value', { exact: true }).press('Tab')
  assert.equal(await page.evaluate(() => window.__sky.getSettings().turbidity), 2)
  assert.equal(await page.evaluate(() => window.__lastSavedSettings.turbidity), 2)
  await page.getByLabel('Ground albedo R', { exact: true }).fill('0.3')
  await page.getByLabel('Ground albedo R', { exact: true }).press('Tab')
  assert.equal(await page.evaluate(() => window.__sky.getSettings().atmosphere.groundAlbedo[0]), 0.3)
  assert.deepEqual(await page.evaluate(() => window.__tool.getGradeJSON()), grade)
  result.physicalEnvironmentControls = true
  await page.screenshot({ path: OUT + 'sky-editor-atmosphere.png' })

  await page.getByRole('tab', { name: 'Grade', exact: true }).click()
  await page.screenshot({ path: OUT + 'sky-editor-grade.png' })
  const guarded = await page.evaluate(() => {
    const r = window.__renderer,
      T = window.__THREE
    const canvas = r.getCanvasTarget()
    const target = new T.RenderTarget(16, 16)
    const mrt = r.getMRT()
    r.setRenderTarget(target)
    const viewport = r.getViewport(new T.Vector4()).toArray()
    const scissor = r.getScissor(new T.Vector4()).toArray()
    r.autoClear = false
    window.__sky.setExposure(41)
    window.__sky.update(null)
    window.__tool.render()
    const ok =
      r.getCanvasTarget() === canvas &&
      r.getRenderTarget() === target &&
      r.getMRT() === mrt &&
      !r.autoClear &&
      JSON.stringify(viewport) === JSON.stringify(r.getViewport(new T.Vector4()).toArray()) &&
      JSON.stringify(scissor) === JSON.stringify(r.getScissor(new T.Vector4()).toArray())
    r.setRenderTarget(null)
    r.autoClear = true
    target.dispose()
    return ok
  })
  assert.equal(guarded, true)
  result.rendererStateRestored = true

  // Interaction outside the floating window must remain usable while it is open.
  await page.mouse.click(420, 120)
  assert.equal(await page.evaluate(() => window.__controls.enabled), true)
  await page.evaluate(() => {
    window.__hostKeys = 0
    window.addEventListener('keydown', () => {
      window.__hostKeys++
    })
    window.__tool.element.shadowRoot.querySelector('.window').focus()
  })
  await page.keyboard.press('b')
  assert.equal(await page.evaluate(() => window.__hostKeys), 0)
  assert.equal(await page.evaluate(() => window.__sky.grade), null)
  await page.keyboard.press('b')
  assert.equal(await page.evaluate(() => window.__sky.grade.keys.length), 3)
  result.inputIsolated = true

  const canvasSize = await page.evaluate(() => [
    window.__renderer.domElement.width,
    window.__renderer.domElement.height,
  ])
  const resize = await page.locator('[data-sky-editor] >> .resize').boundingBox()
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2)
  await page.mouse.down()
  await page.mouse.move(resize.x - 100, resize.y - 70)
  await page.mouse.up()
  assert.deepEqual(
    await page.evaluate(() => [window.__renderer.domElement.width, window.__renderer.domElement.height]),
    canvasSize,
  )
  result.resizeKeepsMainCanvas = true

  const cleanup = await page.evaluate(() => {
    window.__tool.dispose()
    window.__tool.dispose()
    return !document.querySelector('[data-sky-editor]') && window.__sky.state !== 'disposed'
  })
  assert.equal(cleanup, true)
  result.disposeKeepsHostAlive = true
  const repeated = await page.evaluate(() => {
    const sky = window.__sky
    const listeners = sky.baker._gradeListeners.size
    const gradeListeners = sky.grade._listeners.size
    for (let i = 0; i < 5; i++) {
      const editor = window.__createSkyEditor({ sky, renderer: window.__renderer, open: false })
      editor.open()
      editor.render()
      editor.close()
      editor.dispose()
    }
    return (
      sky.baker._gradeListeners.size === listeners &&
      sky.grade._listeners.size === gradeListeners &&
      !document.querySelector('[data-sky-editor]')
    )
  })
  assert.equal(repeated, true)
  result.repeatedMountCleanup = true
  await page.waitForTimeout(150)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, ...result, consoleErrors: errors }, null, 2))
} finally {
  if (errors.length) console.error(errors)
  await browser.close()
}
