import { SkyGrade, type SkyGradeKeyInput } from '@pmndrs/sky'

/** Ink colours tint the physical LUTs; the same grade reaches water and haze. */
export function createPrintGrade(strength: number) {
  const amount = Math.max(0, Math.min(1, strength))
  const keys: SkyGradeKeyInput[] = [
    {
      elevation: -14,
      ease: 'smooth',
      saturation: 1 - amount * 0.08,
      zones: {
        zenith: { color: '#152c52', amount },
        horizon: { color: '#567187', amount },
      },
      fill: { zenith: '#102747', horizon: '#617487', intensity: 1.3 * amount },
      ambient: { color: '#a0b9d1', groundColor: '#27353b', intensity: 0.48 },
    },
    {
      elevation: -7,
      ease: 'smooth',
      saturation: 1 - amount * 0.1,
      zones: {
        zenith: { color: '#263d5b', amount },
        horizon: { color: '#a98c93', amount: amount * 0.7 },
        sunward: { color: '#c78270', amount: amount * 0.55 },
      },
      fill: { zenith: '#173250', horizon: '#566879', intensity: 1.0 * amount },
      ambient: { color: '#afc2d0', groundColor: '#343e45', intensity: 0.55 },
    },
    {
      elevation: 1.2,
      ease: 'smooth',
      exposure: -0.25 * amount,
      saturation: 1 - amount * 0.14,
      shape: { horizonHeight: 14, glowSize: 8, sunwardWidth: 55 },
      zones: {
        zenith: { color: '#477889', amount: amount * 0.85 },
        horizon: { color: '#d78765', amount: amount * 0.72 },
        sunward: { color: '#f1bb7a', amount: amount * 0.6 },
        glow: { color: '#ffd7a1', amount: amount * 0.4 },
      },
      gradient: {
        stops: [
          { at: -5, color: '#b57063' },
          { at: 2, color: '#df9973', ease: 'smooth' },
          { at: 10, color: '#e6c19a', ease: 'smooth' },
          { at: 30, color: '#759295', ease: 'smooth' },
          { at: 90, color: '#31576c', ease: 'smooth' },
        ],
        amount: amount * 0.4,
        replace: amount * 0.16,
      },
      ambient: { color: '#d2c2ac', groundColor: '#555256', intensity: 0.3 },
    },
    {
      elevation: 6,
      ease: 'smooth',
      saturation: 1 - amount * 0.18,
      zones: {
        zenith: { color: '#6c9fa9', amount: amount * 0.8 },
        horizon: { color: '#e4c9a3', amount: amount * 0.7 },
        sunward: { color: '#f3d19e', amount: amount * 0.5 },
      },
      ambient: { color: '#d6d6c6', groundColor: '#666570', intensity: 0.25 },
    },
    {
      elevation: 30,
      ease: 'smooth',
      saturation: 1 - amount * 0.1,
      zones: {
        zenith: { color: '#487c9c', amount: amount * 0.7 },
        horizon: { color: '#cbd3ce', amount: amount * 0.45 },
      },
      ambient: { color: '#dae1df', groundColor: '#626b71', intensity: 0.2 },
    },
  ]
  return new SkyGrade({ name: 'Shichirigahama — evening woodblock', keys })
}
