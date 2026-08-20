/**
 * What kind of instance is this? (o3d-l89a)
 *
 * THE HOLE THIS EXISTS TO CLOSE. Several controls in this repo need to know whether they are running
 * on the production instance, and every one of them answers the question the same ad-hoc way: read
 * `NODE_ENV`, and treat `E2E_TEST_MODE=1` as an override because the full-chain rig serves a PRODUCTION
 * build and therefore reports `NODE_ENV=production` (see `lib/cron-rate-limit.ts` and
 * `lib/security/external-url-safety.ts`, which both say so in prose).
 *
 * Those two signals classify the dev box, the full-chain rig and a restored dump on a laptop. They do
 * NOT classify an instance that serves a production build, sets `NODE_ENV=production`, and does not set
 * `E2E_TEST_MODE`. To that code it is indistinguishable from production — and stage is exactly that, as
 * is a second production-shaped copy, as is the rig on the day `E2E_TEST_MODE` falls out of its `.env`.
 * That last case is not hypothetical: o3d-t74p was a rig whose only surviving control was one it did
 * not have, and it invoiced 553 objects into the LIVE Xero organisation over eleven days.
 *
 * `NODE_ENV` cannot be fixed into carrying this. It is set by the BUILD — `next build` and `next start`
 * both mean `production` regardless of which machine they run on — so it describes the artefact, not the
 * deployment. A separate declaration is the only way an instance can say something the build cannot
 * overwrite.
 *
 * WHY NOTHING HERE FAILS CLOSED YET, AND WHAT FLIPS IT. A declaration is only worth having if ABSENT
 * reads as "not production". But every instance alive today, production included, is absent — so a
 * check that fails closed on absence, shipped in one step, takes production's Xero connection (or its
 * boot) with it. So this lands in two steps, and `INSTANCE_ROLE_DECLARATION_REQUIRED` is the switch:
 *
 *   Step 1 (this change). `IMS_INSTANCE_ROLE` is read, documented, written by `scripts/install.sh`, and
 *     asserted by `lib/ops/production-preflight.ts` — as a WARNING when absent, so an existing
 *     production host still passes, and as a FAILURE when it is present and says something other than
 *     `production`, which no existing host can be. An absent declaration falls back to exactly the
 *     `E2E_TEST_MODE`/`NODE_ENV` reading described above, so no caller's behaviour changes today.
 *   Step 2 (after production's `.env` carries the line). Flip `INSTANCE_ROLE_DECLARATION_REQUIRED` to
 *     true, and the fallback stops applying: undeclared becomes non-production everywhere that passes
 *     `requireDeclaration`. `instanceIsNonProduction` already takes both paths, and both are tested, so
 *     step 2 is the constant and nothing else.
 *
 * THE VERDICT IS NOT A BOOLEAN, IT IS A BOOLEAN PLUS ITS BASIS. `readInstanceIdentity` reports HOW it
 * decided, because "this instance is production" reached by falling back to `NODE_ENV` is a materially
 * weaker claim than the same answer reached from a declaration, and a caller that refuses on the weak
 * one needs to be able to say which it got. A guard that cannot explain itself gets switched off.
 */

export const INSTANCE_ROLE_ENV_VAR = 'IMS_INSTANCE_ROLE'

/**
 * The declarable roles. Deliberately short, and deliberately NOT open-ended: an unrecognised value is
 * refused rather than mapped to the nearest thing, because the whole point of the declaration is that
 * it means something specific. `stage` is named separately from `development` because a stage instance
 * is the one that looks most like production and is therefore the one this file is for.
 */
export const INSTANCE_ROLES = ['production', 'stage', 'development', 'e2e'] as const

export type InstanceRole = (typeof INSTANCE_ROLES)[number]

/**
 * How the production/non-production verdict was reached.
 *
 * - `declaration` — `IMS_INSTANCE_ROLE` named a known role and nothing contradicted it.
 * - `e2e-test-mode` — `E2E_TEST_MODE=1`, which OVERRIDES a declaration. A rig that was handed a copy of
 *   production's `.env` carries `IMS_INSTANCE_ROLE=production` with it; the e2e flag is the half that
 *   did not come from production, and it is the half that has to win.
 * - `invalid-declaration` — the variable is set to something that is not a role. Treated as
 *   non-production, because a typo must not be a promotion.
 * - `node-env-fallback` — nothing was declared, so the pre-o3d-l89a `NODE_ENV` reading was used. This is
 *   the basis that carries the hole; `undeclared` is set alongside it.
 */
export type InstanceIdentityBasis = 'declaration' | 'e2e-test-mode' | 'invalid-declaration' | 'node-env-fallback'

export type InstanceIdentity = {
  /** The declared role, or null when the variable is absent, blank, or not a known role. */
  declaredRole: InstanceRole | null
  /** Exactly what was set, trimmed — quoted back in refusals so a typo is visible. */
  rawDeclaration: string
  /** The variable is set to something that is not a known role. */
  invalidDeclaration: boolean
  /** The variable is absent or blank. The state the two-step rollout exists to remove. */
  undeclared: boolean
  /** `E2E_TEST_MODE=1`, recorded separately because it overrides a declaration. */
  e2eTestMode: boolean
  /** `NODE_ENV` as read, trimmed — reported so a refusal can show both signals at once. */
  nodeEnv: string
  /** Is this the production instance? See `basis` for the strength of the claim. */
  isProduction: boolean
  basis: InstanceIdentityBasis
}

/**
 * Step 2's switch. See the header. While this is false, an absent declaration is answered by the old
 * `NODE_ENV` reading and no caller changes behaviour; flipping it to true makes absence mean
 * non-production for every caller that passes `requireDeclaration`.
 *
 * It is a constant rather than an environment variable ON PURPOSE. A guard whose fail-closed behaviour
 * can be turned off from the same `.env` it is meant to police is not a guard — an operator who hits
 * the refusal would unset it and move on, which is the outcome this whole family of controls is built
 * to prevent. Changing it is a code change, reviewed once, for everyone.
 */
export const INSTANCE_ROLE_DECLARATION_REQUIRED = false

function isKnownRole(value: string): value is InstanceRole {
  return (INSTANCE_ROLES as readonly string[]).includes(value)
}

/**
 * Classify this instance from its environment.
 *
 * Reads the injected `env` rather than `process.env` so the question is answerable in a test — the
 * o3d-t74p rig is precisely an instance whose environment nobody could interrogate after the fact.
 */
export function readInstanceIdentity(env: Record<string, string | undefined>): InstanceIdentity {
  const rawDeclaration = (env[INSTANCE_ROLE_ENV_VAR] ?? '').trim()
  const nodeEnv = (env.NODE_ENV ?? '').trim()
  const e2eTestMode = (env.E2E_TEST_MODE ?? '').trim() === '1'

  const normalised = rawDeclaration.toLowerCase()
  const declaredRole = isKnownRole(normalised) ? normalised : null

  if (rawDeclaration === '') {
    // Undeclared: the pre-o3d-l89a reading, preserved exactly. An absent NODE_ENV counts as
    // non-production — "we cannot tell" is not "this is production", and production sets it explicitly
    // (.env.example), so the absent case is never the production one.
    return {
      declaredRole: null,
      rawDeclaration,
      invalidDeclaration: false,
      undeclared: true,
      e2eTestMode,
      nodeEnv,
      isProduction: !e2eTestMode && nodeEnv === 'production',
      basis: e2eTestMode ? 'e2e-test-mode' : 'node-env-fallback',
    }
  }

  if (!declaredRole) {
    return {
      declaredRole: null,
      rawDeclaration,
      invalidDeclaration: true,
      undeclared: false,
      e2eTestMode,
      nodeEnv,
      isProduction: false,
      basis: 'invalid-declaration',
    }
  }

  if (e2eTestMode) {
    // The declaration lost. See `InstanceIdentityBasis.e2e-test-mode`: a rig running a copy of
    // production's .env declares itself production, and the e2e flag is the only signal that did not
    // come out of that copy.
    return {
      declaredRole,
      rawDeclaration,
      invalidDeclaration: false,
      undeclared: false,
      e2eTestMode,
      nodeEnv,
      isProduction: false,
      basis: 'e2e-test-mode',
    }
  }

  return {
    declaredRole,
    rawDeclaration,
    invalidDeclaration: false,
    undeclared: false,
    e2eTestMode,
    nodeEnv,
    isProduction: declaredRole === 'production',
    basis: 'declaration',
  }
}

/**
 * The question every existing caller actually asks, in the shape they already ask it.
 *
 * `requireDeclaration` is step 2. With it false (today's default) an undeclared instance is answered by
 * the `NODE_ENV` fallback, which is what those callers do now; with it true, undeclared is
 * non-production and the o3d-l89a hole is closed. Both paths are exercised by
 * `tests/ops/instance-identity.test.ts`, so flipping `INSTANCE_ROLE_DECLARATION_REQUIRED` does not
 * arrive untested.
 */
export function instanceIsNonProduction(
  env: Record<string, string | undefined>,
  options: { requireDeclaration?: boolean } = {},
): boolean {
  const identity = readInstanceIdentity(env)
  const requireDeclaration = options.requireDeclaration ?? INSTANCE_ROLE_DECLARATION_REQUIRED
  if (requireDeclaration && identity.undeclared) return true
  return !identity.isProduction
}

/** The allowed values, for refusal messages, so the remedy is never a search through the docs. */
export function instanceRoleOptions(): string {
  return INSTANCE_ROLES.join(' | ')
}

/**
 * Why an instance that set `IMS_INSTANCE_ROLE` to something unrecognised is refused.
 *
 * Named values only, and no "did you mean" — the operator has to state which of the four this is,
 * because a guess that lands on `production` is the failure this file exists to make impossible.
 */
export function invalidInstanceRoleRefusal(identity: InstanceIdentity): string {
  return (
    `${INSTANCE_ROLE_ENV_VAR}=${JSON.stringify(identity.rawDeclaration)} is not a role this build knows. `
    + `Set one of: ${instanceRoleOptions()}. Until it names a role, this instance is treated as `
    + 'NON-PRODUCTION, because a typo must not read as a promotion.'
  )
}

/**
 * Why an undeclared instance is being reported.
 *
 * Worded as the thing that is MISSING rather than as a failure, because in step 1 this is a warning on
 * a host that is almost certainly the real production instance. It still has to say what the absence
 * costs, or nobody sets it and step 2 never happens.
 */
export function undeclaredInstanceNotice(identity: InstanceIdentity): string {
  return (
    `${INSTANCE_ROLE_ENV_VAR} is not set, so this instance is being classified from NODE_ENV`
    + `${identity.nodeEnv ? `=${identity.nodeEnv}` : ' (unset)'}`
    + `${identity.e2eTestMode ? ' and E2E_TEST_MODE=1' : ''}. NODE_ENV is set by the build, not by the `
    + 'deployment, so it cannot tell production apart from a stage instance or any other '
    + `production-shaped copy (o3d-l89a). Add ${INSTANCE_ROLE_ENV_VAR}=production to this server's .env `
    + `(other instances: ${instanceRoleOptions()}) — it will become mandatory.`
  )
}
