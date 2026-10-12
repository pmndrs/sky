import { Color } from 'three/webgpu'
import { presets } from '../presets'
import { SUN_COLORS } from '../Sky'
import { element, select } from './dom'
import type { SkyEditorController } from './controller'
import type { SkySettings, SkyAtmosphereSettings } from '../settings'

/** Runtime atmosphere controls. These operate on the simulation, independently
 * of the authored grade. Advanced coefficient inputs retain their physical units. */
export class SettingsPanel {
  private refreshers: (() => void)[] = []
  private abort = new AbortController()
  constructor(
    readonly root: HTMLElement,
    private controller: SkyEditorController,
    private run: (action: () => void) => void,
  ) {
    const sky = controller.sky
    root.append(
      element(
        'p',
        { class: 'notice' },
        'These controls change the physical environment. Grade files save color authoring only; environment settings are saved separately by your app.',
      ),
    )
    root.append(element('h4', {}, 'Atmosphere'))
    const preset = select('Atmosphere preset', [
      ['', 'Custom atmosphere'],
      ...Object.keys(presets).map((name): [string, string] => [name, name]),
    ])
    this.row('Planet preset', preset)
    preset.addEventListener(
      'change',
      () =>
        this.run(() => {
          if (preset.value) sky.setPreset(preset.value)
          controller.commitSettings()
        }),
      { signal: this.abort.signal },
    )
    this.refreshers.push(() => {
      preset.value = controller.settings.preset ?? ''
    })
    this.number(
      'Sky exposure',
      'exposure',
      0,
      1000,
      0.1,
      (s) => s.exposure,
      (v) => sky.setExposure(v),
      '×',
    )
    this.number(
      'Turbidity',
      'turbidity',
      0,
      20,
      0.01,
      (s) => s.turbidity,
      (v) => sky.setTurbidity(v),
      '×',
    )
    this.vector('Ground albedo', 'groundAlbedo', 0, 1, 0.01)
    this.number(
      'Multi-scattering',
      'multiScatteringFactor',
      0,
      10,
      0.01,
      (s) => s.atmosphere.multiScatteringFactor,
      (v) => sky.setMultiScatteringFactor(v),
      '×',
    )
    const mirror = element('input', { type: 'checkbox', 'aria-label': 'Mirror sky below horizon' })
    this.row('Mirror below horizon', mirror)
    mirror.addEventListener(
      'change',
      () =>
        this.run(() => {
          sky.setMirrorBelowHorizon(mirror.checked)
          controller.commitSettings()
        }),
      { signal: this.abort.signal },
    )
    this.refreshers.push(() => {
      mirror.checked = controller.settings.mirrorBelowHorizon
    })

    root.append(element('h4', {}, 'Sun appearance'))
    const colors = select('Sun color preset', [
      ['', 'Custom color'],
      ...Object.keys(SUN_COLORS).map((name): [string, string] => [name, name]),
    ])
    this.row('Sun color preset', colors)
    colors.addEventListener(
      'change',
      () =>
        this.run(() => {
          if (colors.value) sky.setSunColor(colors.value)
          controller.commitSettings()
        }),
      { signal: this.abort.signal },
    )
    const color = element('input', { type: 'color', 'aria-label': 'Sun color' })
    this.row('Sun color', color)
    color.addEventListener(
      'input',
      () =>
        this.run(() => {
          const value = color.value
          controller.queueSetting('sunColor', () => sky.setSunColor(value))
        }),
      { signal: this.abort.signal },
    )
    color.addEventListener('change', () => this.run(() => controller.commitSettings()), { signal: this.abort.signal })
    this.refreshers.push(() => {
      const rgb = controller.settings.sun.color
      if (!this.focused(color)) color.value = '#' + new Color(...rgb).getHexString()
      colors.value =
        Object.keys(SUN_COLORS).find((name) => SUN_COLORS[name].every((v, i) => Math.abs(v - rgb[i]) < 1e-6)) ?? ''
    })
    const disc = element('input', { type: 'checkbox', 'aria-label': 'Visible sun disc' })
    this.row('Visible sun disc', disc)
    disc.addEventListener(
      'change',
      () =>
        this.run(() => {
          sky.setSunDisc(disc.checked)
          controller.commitSettings()
        }),
      { signal: this.abort.signal },
    )
    this.refreshers.push(() => {
      disc.checked = controller.settings.sun.disc.visible
    })
    this.number(
      'Disc diameter',
      'discDiameter',
      0.01,
      10,
      0.01,
      (s) => (s.sun.disc.angularDiameter * 180) / Math.PI,
      (v) => sky.setSunDisc({ angularDiameter: (v * Math.PI) / 180 }),
      '°',
    )
    this.number(
      'Disc softness',
      'discSoftness',
      0,
      1,
      0.01,
      (s) => s.sun.disc.edgeSoftness,
      (v) => sky.setSunDisc({ angularDiameter: controller.settings.sun.disc.angularDiameter, edgeSoftness: v }),
    )
    this.number(
      'Disc intensity',
      'discIntensity',
      0,
      100,
      0.1,
      (s) => s.sun.disc.intensity,
      (v) => sky.setSunDisc({ intensity: v }),
    )

    root.append(element('h4', {}, 'Solar position'))
    root.append(
      element(
        'p',
        { class: 'notice' },
        'Time and elevation navigation are in the toolbar. Solar settings acquire editor sun control before changing the app sky.',
      ),
    )
    this.number(
      'Latitude',
      'latitude',
      -90,
      90,
      0.1,
      (s) => s.sun.latitude,
      (v) => {
        controller.setTime(controller.settings.sun.timeOfDay)
        sky.setLatitude(v)
      },
      '°',
    )
    this.number(
      'Day of year',
      'dayOfYear',
      1,
      366,
      1,
      (s) => s.sun.dayOfYear,
      (v) => {
        controller.setTime(controller.settings.sun.timeOfDay)
        sky.setDayOfYear(v)
      },
    )
    this.number(
      'North heading',
      'north',
      0,
      360,
      1,
      (s) => s.sun.north,
      (v) => sky.setNorth(v),
      '°',
    )

    const advanced = element('details', {}, element('summary', {}, 'Advanced physical atmosphere'))
    const target = element('div')
    advanced.append(
      element(
        'p',
        { class: 'notice' },
        'RGB coefficients are linear values in 1/km. Mie fields edit the turbidity-1 baseline and reset turbidity to 1. Density scales are negative inverse kilometers.',
      ),
      target,
    )
    root.append(advanced)
    for (const [key, label] of [
      ['rayleighScattering', 'Rayleigh RGB'],
      ['mieScattering', 'Mie scattering RGB'],
      ['mieExtinction', 'Mie extinction RGB'],
      ['mieAbsorption', 'Mie absorption RGB'],
      ['absorptionExtinction', 'Absorption RGB'],
    ] as [keyof SkyAtmosphereSettings, string][]) {
      this.vector(label, key, 0, 1, 0.0001, target)
    }
    for (const [key, label, min, max, step, unit] of [
      ['miePhaseG', 'Mie anisotropy', -0.99, 0.99, 0.01, ''],
      ['rayleighDensityExpScale', 'Rayleigh density', -10, -0.0001, 0.0001, '1/km'],
      ['mieDensityExpScale', 'Mie density', -10, -0.0001, 0.0001, '1/km'],
      ['bottomRadius', 'Planet radius', 1, 100000, 0.1, 'km'],
      ['topRadius', 'Atmosphere radius', 1, 100001, 0.1, 'km'],
      ['absorptionDensity0LayerWidth', 'Absorption layer', 0, 1000, 0.1, 'km'],
      ['absorptionDensity0ConstantTerm', 'Lower absorption', -100, 100, 0.01, ''],
      ['absorptionDensity0LinearTerm', 'Lower slope', -10, 10, 0.001, '1/km'],
      ['absorptionDensity1ConstantTerm', 'Upper absorption', -100, 100, 0.01, ''],
      ['absorptionDensity1LinearTerm', 'Upper slope', -10, 10, 0.001, '1/km'],
    ] as [keyof SkyAtmosphereSettings, string, number, number, number, string][]) {
      this.number(
        label,
        key,
        min,
        max,
        step,
        (s) => s.atmosphere[key] as number,
        (v) => {
          const a = controller.sky.getSettings().atmosphere
          if ((key === 'topRadius' && v <= a.bottomRadius) || (key === 'bottomRadius' && v >= a.topRadius)) {
            throw new Error('Atmosphere radius must exceed planet radius')
          }
          sky.setAtmosphere({ [key]: v })
        },
        unit,
        target,
      )
    }
    this.refresh()
    const construction = controller.settings
    root.append(
      element(
        'p',
        { class: 'notice' },
        `Construction settings: ${construction.quality} quality, ${construction.cubeSize}px sky cube. Change these when your app creates the sky.`,
      ),
    )
  }

  private focused(node: Element) {
    return (this.root.getRootNode() as ShadowRoot).activeElement === node
  }
  private row(label: string, input: Node, parent = this.root) {
    parent.append(element('div', { class: 'setting' }, element('span', {}, label), input, element('span')))
  }

  private number(
    label: string,
    key: string,
    min: number,
    max: number,
    step: number,
    read: (s: SkySettings) => number,
    apply: (v: number) => void,
    unit = '',
    parent = this.root,
  ) {
    const range = element('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      'aria-label': label,
    })
    const input = element('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      step: String(step),
      'aria-label': label + ' value',
      title: unit,
    })
    parent.append(
      element('div', { class: 'setting' }, element('span', {}, label + (unit ? ' (' + unit + ')' : '')), range, input),
    )
    const edit = (v: number, commit: boolean) =>
      this.run(() => {
        if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${label} must be between ${min} and ${max}`)
        controllerQueue(v)
        if (commit) this.controller.commitSettings()
      })
    const controllerQueue = (v: number) => this.controller.queueSetting(key, () => apply(v))
    range.addEventListener(
      'input',
      () => {
        input.value = range.value
        edit(+range.value, false)
      },
      { signal: this.abort.signal },
    )
    range.addEventListener('change', () => edit(+range.value, true), { signal: this.abort.signal })
    input.addEventListener('change', () => edit(+input.value, true), { signal: this.abort.signal })
    this.refreshers.push(() => {
      const v = read(this.controller.settings)
      if (!this.focused(range)) range.value = String(v)
      if (!this.focused(input)) input.value = String(+v.toFixed(6))
    })
  }

  private vector(
    label: string,
    key: keyof SkyAtmosphereSettings,
    min: number,
    max: number,
    step: number,
    parent = this.root,
  ) {
    const inputs = ['R', 'G', 'B'].map((channel) =>
      element('input', {
        type: 'number',
        min: String(min),
        max: String(max),
        step: String(step),
        'aria-label': label + ' ' + channel,
      }),
    )
    const group = element('div', { class: 'vector wide' }, ...inputs)
    parent.append(element('div', { class: 'setting' }, element('span', {}, label), group))
    for (const input of inputs) {
      input.addEventListener(
        'change',
        () =>
          this.run(() => {
            const rgb = inputs.map((node) => +node.value)
            if (rgb.some((v) => !Number.isFinite(v) || v < min || v > max)) {
              throw new Error(`${label} channels must be between ${min} and ${max}`)
            }
            this.controller.queueSetting(key, () => this.controller.sky.setAtmosphere({ [key]: rgb }))
            this.controller.commitSettings()
          }),
        { signal: this.abort.signal },
      )
    }
    this.refreshers.push(() => {
      const s = this.controller.settings
      const baseline: Partial<Record<keyof SkyAtmosphereSettings, number[]>> = {
        mieScattering: s.baseMie.scattering,
        mieExtinction: s.baseMie.extinction,
        mieAbsorption: s.baseMie.absorption,
      }
      const values = baseline[key] ?? (s.atmosphere[key] as number[])
      inputs.forEach((input, i) => {
        if (!this.focused(input)) input.value = String(+values[i].toFixed(6))
      })
    })
  }

  refresh() {
    for (const refresh of this.refreshers) refresh()
  }
  dispose() {
    this.abort.abort()
    this.refreshers = []
  }
}
