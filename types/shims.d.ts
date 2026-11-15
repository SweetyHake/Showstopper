/**
 * Ambient shims for Foundry VTT / PIXI / Sequencer globals during the TS migration.
 * Foundry and PIXI surfaces are intentionally `any`: full strict typing is a
 * separate effort layered on top of this migration (see AGENTS.md, build section).
 * Rule: add any new unrecognized global HERE (`declare var`), rather than
 * working around it in code. `declare var` enables both reading and writing
 * (`globalThis.X = ...`, `window.X = ...`).
 */

// Foundry core
declare var game: any;
declare var canvas: any;
declare var Hooks: any;
declare var foundry: any;
declare var ui: any;
declare var CONFIG: any;
declare var CONST: any;
declare var ApplicationV2: any;
declare var Dialog: any;
declare var Roll: any;
declare var AudioHelper: any;
declare var CanvasAnimation: any;
declare var renderTemplate: any;
declare var localize: any;
declare var fromUuid: any;
declare var fromUuidSync: any;
declare var Color: any;
declare var FilePicker: any;
declare var jQuery: any;
declare var TextEditor: any;
declare var ChatMessage: any;
declare var Actor: any;
declare var Item: any;
declare var Token: any;
declare var Scene: any;
declare var User: any;
declare var Folder: any;
declare var TokenDocument: any;
declare var ActiveEffect: any;
declare var MeasuredTemplate: any;
declare var Tile: any;
declare var RegionBehavior: any;
declare var CanvasShakeEffect: any;
declare var AudioContext: any;
declare var duplicate: any;
declare var deepClone: any;
declare var mergeObject: any;
declare var getProperty: any;
declare var setProperty: any;
declare var hasProperty: any;
declare var expandObject: any;
declare var randomID: any;

// Libraries
declare var PIXI: any;
declare var Sequencer: any;
declare var Sequence: any;
declare var libWrapper: any;

// Browser environment (lib.dom is intentionally NOT enabled: DOM typing is a
// separate effort; all window/DOM globals remain `any`, matching plain JS)
declare var window: any;
declare var document: any;
declare var self: any;
declare var location: any;
declare var history: any;
declare var navigator: any;
declare var screen: any;
declare var requestAnimationFrame: any;
declare var cancelAnimationFrame: any;
declare var getComputedStyle: any;
declare var matchMedia: any;
declare var localStorage: any;
declare var sessionStorage: any;
declare var Image: any;
declare var Audio: any;
declare var DOMParser: any;
declare var XMLSerializer: any;
declare var FileReader: any;
declare var MutationObserver: any;
declare var ResizeObserver: any;
declare var IntersectionObserver: any;
declare var CustomEvent: any;
declare var Event: any;
declare var KeyboardEvent: any;
declare var PointerEvent: any;
declare var HTMLElement: any;
declare var SVGElement: any;
declare var canvas2d: any;
declare var requestIdleCallback: any;
declare var cancelIdleCallback: any;

// DOM names used in TYPE positions (annotations): `declare var` only provides
// a value binding, so type alias declarations are also needed
type HTMLImageElement = any;
type HTMLVideoElement = any;
type HTMLElement = any;
type SVGElement = any;
type DataTransfer = any;
type DragEvent = any;
declare var HTMLImageElement: any;
declare var HTMLVideoElement: any;
declare var DataTransfer: any;
declare var DragEvent: any;

// Writable globals owned by this module (globalThis.showstopper = ...)
declare var showstopper: any;

// System / browser globals added during TS migration
declare var CSS: any;
declare var dnd5e: any;
