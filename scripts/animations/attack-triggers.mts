/**
 * Automatic combat attack animation triggers from midi-qol (`midi-qol.AttackRollComplete`).
 *
 * Hit/miss is read directly from the workflow (`workflow.hitTargets` — midi's already-resolved hits),
 * critical hit from `workflow.isCritical`, and attack total from `workflow.attackTotal`. This is more
 * accurate than the "total vs AC" heuristic in the dnd5e path of `attack.mjs`, which stays silent
 * whenever the midi trigger is active (`sAnimSettings.midiTrigger`, enabled by default) — otherwise
 * animations would play twice (both hooks fire on the rolling client).
 * The miss branch uses `determineMissState`: a midi miss (cover, Shield reaction, natural 1) can have
 * ANY total, so a `total >= AC` heuristic is forbidden on that branch.
 *
 * Automatic finisher playback when HP drops to 0 (`midi-qol.RollComplete`) is provided by
 * the `showstopper-plus` expansion module.
 */
import {
  aaDefersAttackToDamage,
  classifyItemAttack,
  deferAttackForDamageRoll,
  flushUnclaimedAATicketsForToken,
  getAnimSettings,
  isDnd5e,
  resolveToken,
  determineMissState,
  midiTriggerActive,
  playAttackAnimation
} from "./attack.mjs";

function midiActive() {
  return game.modules.get("midi-qol")?.active ?? false;
}

Hooks.on("midi-qol.AttackRollComplete", async (workflow) => {
  if (!midiActive() || !isDnd5e()) return;
  const settings = getAnimSettings();
  if (!midiTriggerActive(settings)) return;

  const attacker = resolveToken(workflow.token);
  if (!attacker) return;

  // Melee, ranged, and spell attacks — shared classifier with the dnd5e path.
  const item = workflow.item ?? null;
  const attackType = workflow.activity?.attack?.type?.value
    ?? workflow.activity?.actionType
    ?? item?.system?.actionType;
  const classification = workflow.activity?.attack?.type?.classification ?? null;
  const delivery = classifyItemAttack(item, attackType, classification);

  const targetRef = [...(workflow.targets ?? [])][0] ?? null;
  const target = resolveToken(targetRef);
  if (!delivery || !target || attacker.id === target.id) {
    flushUnclaimedAATicketsForToken(attacker.id);
    return;
  }

  const total = Number(workflow.attackTotal ?? 0);
  const AC = target.actor?.system?.attributes?.ac?.value;
  const isHit = workflow.hitTargets?.size
    ? (workflow.hitTargets.has(targetRef) || workflow.hitTargetsEC?.has?.(targetRef) === true)
    : (AC != null && total >= AC);
  let attackState;
  if (isHit) {
    attackState = workflow.isCritical === true ? "crit" : "hit";
  } else if (AC != null) {
    attackState = determineMissState(total, AC, target);
  } else {
    attackState = "miss";
  }

  if ((attackState === "hit" || attackState === "crit") && aaDefersAttackToDamage(workflow.activity, settings)) {
    deferAttackForDamageRoll({
      attacker,
      target,
      attackState,
      item,
      delivery,
      activity: workflow.activity
    });
    return;
  }

  // Deliberate await: callMidiHooks awaits handlers so midi's damage phase
  // (autoRollDamage) and subsequent hooks start AFTER the cinematic, not on top of it.
  await playAttackAnimation({ attacker, target, attackState, item, delivery });
});

for (const hookName of ["midi-qol.preCleanup", "midi-qol.RollComplete"]) {
  Hooks.on(hookName, (workflow) => {
    const tok = resolveToken(workflow?.token);
    if (tok) flushUnclaimedAATicketsForToken(tok.id, { abort: Boolean(workflow?.aborted) });
  });
}
