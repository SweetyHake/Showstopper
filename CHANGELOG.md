# Changelog

## 14.4.3

- Add Automated Animations sync setting (`aaSync`) to align melee lunges, ranged shots, and target reactions with AA workflows
- Defer attack animations until damage roll when Automated Animations "Play on Damage" is enabled
- Avoid duplicate VFX, sound effects, screen shake, and token motion when handled by Automated Animations

## 14.4.2

- Add noticeable 360° 3D camera parallax for airborne tokens starting from low elevations
- Keep low-altitude tokens crisp (no Depth-of-Field blur up to 20 ft) and soften high-altitude blur

## 14.4.1

- Fix duplicate fall plunge animation when lowering elevation to 0
- Include CSS underscore partials (`styles/app/_variables.css`) in release archive

## 14.4.0

- Initial public release for Foundry VTT v14
- Dynamic blood splatters, arterial bursts, trails, bloodied token overlay, and canvas trail brush
- 2.5D token movement, jump arcs, aerial flight physics, and granular elevation perspective settings
- Combat choreography with melee lunges, ranged recoils, hitstop, and optional Sequencer/JB2A VFX
- Real-time GLSL token status shaders (`frozen`, `petrified`, `burning`, `corrupted`, `gilded`, `bloodrage`, `glitch`)
- Player portrait panel with voice indicators, live token drag preview, screen vignette, smooth camera, floating damage numbers, and inventory notifications
- Session and campaign roll statistics tracker
- Extensible cut-in and finisher developer SDK (`globalThis.showstopper`)
