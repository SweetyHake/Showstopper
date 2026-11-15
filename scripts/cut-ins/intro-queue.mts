import { MODULE_ID } from '../config.mjs';
import { stopAllSynthSounds } from './utils/sound-synth.mjs';

class IntroductionQueue {
  #queue = [];
  #isPlaying = false;
  #currentCleanup = null;

  get isPlaying() {
    return this.#isPlaying;
  }

  add(executeFunc, cleanupFunc = null) {
    this.#queue.push({ execute: executeFunc, cleanup: cleanupFunc });
    this.#processQueue();
  }

  /**
   * Allows the active intro to register a force-close callback right after
   * creating its DOM overlay or application window.
   * @param {Function|null} cleanupFunc
   */
  setCurrentCleanup(cleanupFunc) {
    if (this.#isPlaying) {
      this.#currentCleanup = cleanupFunc;
    }
  }

  async #processQueue() {
    if (this.#isPlaying || this.#queue.length === 0) return;

    this.#isPlaying = true;
    const { execute, cleanup } = this.#queue.shift();
    this.#currentCleanup = cleanup;

    try {
      await execute();
    } catch (error) {
      console.error(`${MODULE_ID} | Error playing introduction:`, error);
      // If execute() throws, the effect won't call complete() — reset the slot
      // ourselves, otherwise the queue stays permanently blocked.
      try {
        cleanup?.();
      } catch (e) {
        console.error(`${MODULE_ID} | Intro cleanup failed:`, e);
      }
      this.#isPlaying = false;
      this.#currentCleanup = null;
      this.#processQueue();
    }
  }

  complete() {
    // Guard against double complete(): after the error path resets the slot,
    // a late complete() from the failed effect must not advance over the next item.
    if (!this.#isPlaying) return;
    this.#isPlaying = false;
    this.#currentCleanup = null;
    this.#processQueue();
  }

  skip() {
    if (this.#currentCleanup) {
      const cleanup = this.#currentCleanup;
      this.#currentCleanup = null;
      try {
        cleanup();
      } catch (e) {
        console.error(`${MODULE_ID} | Intro skip cleanup failed:`, e);
      }
    }
    // Synthesized sounds aren't bound to effect instances — stop them explicitly,
    // otherwise a skipped intro keeps playing audio for 3+ seconds.
    stopAllSynthSounds();
  }

  clear() {
    this.#queue = [];
    this.skip();
  }
}

export const introQueue = new IntroductionQueue();
