/**
 * A REGISTRATION'S KEY CONSTRAINS ITS FACTORY'S CONNECTOR
 * (o3d-remove-shiphero round 14, Codex HIGH 1).
 *
 * THE DEFECT. Round 12 made the registration record TOTAL over `WmsConnectorId`, so a registered id
 * with no definition stopped compiling. It spelled that totality `Record<Id,
 * WmsConnectorRegistration<Id>>` — and `Record` gives EVERY entry the WHOLE id union. With two ids
 * the `acme-wms` entry's factory was typed `() => WmsRegistrableConnector<'mintsoft' | 'acme-wms'>`,
 * so a factory returning the MINTSOFT connector typechecked under Acme's key, and `getConnector`
 * handed it back without ever looking at what it had built. Production would have resolved Acme and
 * sent every operation to Mintsoft: the order push, the ASN create, the stock read, the dispatch
 * poll — against the wrong warehouse, recorded under Acme's link rows, cursors and audit trail, and
 * reported to the operator as Acme's. Nothing downstream can detect it, because every layer below
 * the registry is told which connector it is talking to by the registry.
 *
 * THE THREE HOLES, AND WHERE EACH IS CLOSED.
 *
 *   1. THE VALUE TYPE. `WmsConnectorRegistrations<Id>` is a MAPPED type (`[K in Id]`), so entry `K`
 *      holds `WmsConnectorRegistration<K>` and `WmsConnector`'s `readonly id: Id` carries that
 *      literal into the factory's return type. Cross-wiring does not compile.
 *   2. WHY THE TYPE HAS TO BE THE PRIMARY ANSWER. Factories are not invoked until request time, so
 *      the round-12 LOAD-TIME guard cannot see inside one — it can only see that an id has an entry.
 *      The case at the bottom of this file proves that directly: a cross-wired registry ASSEMBLES
 *      without complaint. `assertWmsConnectorIdentity` therefore fires at CONSTRUCTION, the one
 *      moment every dispatch passes through, and is the backstop for the callers `tsc` never sees.
 *   3. THE SPREAD. `createRegisteredWmsConnectorRegistry` built each def as `{ id, ...registration }`,
 *      so a registration carrying an `id` of its own OVERWROTE the key it was filed under. The type
 *      forbids writing one; JavaScript, `JSON.parse` and a cast do not. It is now
 *      `{ ...registration, id }`: the key wins because it is applied last.
 *
 * WHAT IS REAL HERE. `createWmsConnectorRegistry`, `createRegisteredWmsConnectorRegistry`,
 * `findWmsConnector` and `isWmsConnectorConfigured` — the shipped functions, unmocked. The
 * connectors are stubs, because the property under test is about WHICH connector comes back, not
 * about what any of them does.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRegisteredWmsConnectorRegistry,
  createWmsConnectorRegistry,
  findWmsConnector,
  isWmsConnectorConfigured,
  type WmsConnectorRegistration,
  type WmsConnectorRegistrations,
  type WmsRegistrableConnector,
} from '../lib/connectors/wms/registry.ts'
import { ACME_WMS_ID, ACME_WMS_LABEL, type SeamWmsConnectorId } from './helpers/fictitious-wms-connector.ts'

/**
 * A registrable connector for exactly the id it is given.
 *
 * THE CAST IS INSIDE, AND PARAMETERISED BY `Id`, which is what makes the compile-time cases below
 * real: the helper's RETURN TYPE is `WmsRegistrableConnector<Id>` with `Id` bound at the call site,
 * so `identityStubConnector('mintsoft')` is a `WmsRegistrableConnector<'mintsoft'>` and nothing
 * about the cast weakens the check at the point of registration. A cast written at the call site
 * instead — which is what the seam fixtures did until round 14 — erases exactly the error under
 * test.
 */
function identityStubConnector<Id extends string>(id: Id): WmsRegistrableConnector<Id> {
  return {
    id,
    name: `stub:${id}`,
    // TRUE, deliberately: `isWmsConnectorConfigured` answering `false` below can then only be the
    // identity refusal, never a stub that was never configured. Without this the containment case
    // would pass on a fixture where nothing was ever wrong.
    isConfigured: async () => true,
  } as unknown as WmsRegistrableConnector<Id>
}

function registrationFor(id: string, connectorId: string): WmsConnectorRegistration<string> {
  return {
    label: id === ACME_WMS_ID ? ACME_WMS_LABEL : id,
    available: true,
    createReplayPolicy: 'client-side-dedupe-only',
    create: () => identityStubConnector(connectorId),
  }
}

// ---------------------------------------------------------------------------------------------
// THE COMPILE-TIME HALF — the whole point is that these lines do not compile
// ---------------------------------------------------------------------------------------------

type TwoWmsIds = SeamWmsConnectorId

test('[round 14 HIGH 1] a registration whose factory builds ANOTHER connector does not compile', () => {
  // The positive control first: correctly wired, both entries, no error. Without it a fix that
  // simply made the record impossible to satisfy would pass every case below.
  const wellWired: WmsConnectorRegistrations<TwoWmsIds> = {
    mintsoft: {
      label: 'Mintsoft',
      available: true,
      createReplayPolicy: 'remote-refuses-duplicate',
      create: () => identityStubConnector('mintsoft'),
    },
    [ACME_WMS_ID]: {
      label: ACME_WMS_LABEL,
      available: true,
      createReplayPolicy: 'client-side-dedupe-only',
      create: () => identityStubConnector(ACME_WMS_ID),
    },
  }
  assert.equal(wellWired[ACME_WMS_ID].create().id, ACME_WMS_ID)
  assert.equal(wellWired.mintsoft.create().id, 'mintsoft')

  // THE MUTATION THIS DETECTS: replacing the mapped type with `Record<Id,
  // WmsConnectorRegistration<Id>>` — round 12's shape — makes BOTH lines below legal, and this file
  // then fails to compile because the `@ts-expect-error`s are unused. Each value is kept on ONE line
  // so the suppression cannot drift off the construct it is about.
  const crossWired: WmsConnectorRegistrations<TwoWmsIds> = {
    // @ts-expect-error o3d-remove-shiphero r14 (Codex HIGH 1): a MINTSOFT entry may not build Acme's
    // connector. Widening the record back to `Record<Id, …>` makes this compile.
    mintsoft: { label: 'Mintsoft', available: true, createReplayPolicy: 'remote-refuses-duplicate', create: () => identityStubConnector(ACME_WMS_ID) },
    // @ts-expect-error o3d-remove-shiphero r14 (Codex HIGH 1): and the computed-key half — an ACME
    // entry may not build the Mintsoft connector, which is the direction that would have sent every
    // Acme operation to a live Mintsoft warehouse.
    [ACME_WMS_ID]: { label: ACME_WMS_LABEL, available: true, createReplayPolicy: 'client-side-dedupe-only', create: () => identityStubConnector('mintsoft') },
  }

  // The values still EXIST at runtime — the refusal is a type refusal, and the runtime cases below
  // are what stands where the compiler does not reach.
  assert.equal(crossWired.mintsoft.create().id, ACME_WMS_ID)
  assert.equal(crossWired[ACME_WMS_ID].create().id, 'mintsoft')

  // AND THROUGH THE DERIVATION'S OWN PARAMETER, not only through the alias. Mutation testing found
  // this gap: re-annotating `createRegisteredWmsConnectorRegistry`'s `registrations` parameter (or
  // `BUILT_IN_WMS_CONNECTOR_REGISTRATIONS`) as `Record<Id, WmsConnectorRegistration<Id>>` while
  // leaving the alias alone reverted the fix at the one call site that builds the SHIPPED registry,
  // and the two cases above stayed green. The argument position is checked here, so both spellings
  // of the revert are caught.
  const built = createRegisteredWmsConnectorRegistry<TwoWmsIds>(['mintsoft', ACME_WMS_ID], {
    mintsoft: {
      label: 'Mintsoft',
      available: true,
      createReplayPolicy: 'remote-refuses-duplicate',
      create: () => identityStubConnector('mintsoft'),
    },
    // @ts-expect-error o3d-remove-shiphero r14 (Codex HIGH 1): the derivation's registrations
    // parameter is keyed per entry too — this Acme entry may not build the Mintsoft connector.
    [ACME_WMS_ID]: { label: ACME_WMS_LABEL, available: true, createReplayPolicy: 'client-side-dedupe-only', create: () => identityStubConnector('mintsoft') },
  })
  assert.throws(() => built.getConnector(ACME_WMS_ID), /acme-wms/, 'and the runtime check still stands behind it')
  assert.equal(built.getConnector('mintsoft').id, 'mintsoft')
})

test('[round 14 HIGH 1] a registration still cannot carry an id of its own', () => {
  // `WmsConnectorRegistration` is `Omit<WmsConnectorDef, 'id'>`, and this is what keeps the
  // spread-order fix from being the ONLY thing standing between a definition and a second id.
  const registration: WmsConnectorRegistration<'mintsoft'> = {
    label: 'Mintsoft',
    available: true,
    createReplayPolicy: 'remote-refuses-duplicate',
    create: () => identityStubConnector('mintsoft'),
    // @ts-expect-error o3d-remove-shiphero r14 (Codex HIGH 1): the id comes from the KEY. Putting
    // `id` back on `WmsConnectorRegistration` makes this legal, and the spread order is then the
    // only defence left.
    id: 'acme-wms',
  }
  assert.equal(registration.label, 'Mintsoft')
})

// ---------------------------------------------------------------------------------------------
// THE RUNTIME HALF — for the callers tsc never sees
// ---------------------------------------------------------------------------------------------

/** A cross-wired registry, reached the way JavaScript or a mock would reach it. */
function crossWiredRegistry() {
  return createRegisteredWmsConnectorRegistry<string>(
    [ACME_WMS_ID],
    { [ACME_WMS_ID]: registrationFor(ACME_WMS_ID, 'mintsoft') },
  )
}

test('[round 14 HIGH 1] getConnector REFUSES a connector that is not the one asked for', () => {
  const registry = crossWiredRegistry()

  // Before the fix this returned the MINTSOFT connector for `acme-wms`, and every caller below the
  // registry believed it was Acme's.
  assert.throws(
    () => registry.getConnector(ACME_WMS_ID),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, new RegExp(ACME_WMS_ID), 'the id that was ASKED for is named')
      assert.match(message, /mintsoft/, 'and the id that was BUILT — a deploy needs both to act')
      return true
    },
  )

  // The correctly wired registry is not merely "does not throw": it hands back the right connector.
  const wired = createRegisteredWmsConnectorRegistry<string>(
    [ACME_WMS_ID],
    { [ACME_WMS_ID]: registrationFor(ACME_WMS_ID, ACME_WMS_ID) },
  )
  assert.equal(wired.getConnector(ACME_WMS_ID).id, ACME_WMS_ID)
})

test('[round 14 HIGH 1] findWmsConnector refuses it too — it does NOT go through getConnector', () => {
  // `findWmsConnector` resolves `findDef(id)?.create()` itself, over a STRUCTURAL source that carries
  // no id for the compiler to constrain, and it is the path `isWmsConnectorConfigured` takes. Without
  // its own check the /sync panel and the onboarding wizard would read "is it set up?" off whichever
  // connector the factory happened to build.
  const registry = crossWiredRegistry()
  assert.throws(() => findWmsConnector(ACME_WMS_ID, registry), /acme-wms/)

  // And a structural source, which is how the generic reads inject one.
  assert.throws(
    () => findWmsConnector('acme', { findDef: () => ({ create: () => identityStubConnector('mintsoft') }) }),
    /"acme"/,
  )

  // An id this build does not ship is still `null`, not a throw: a link row from a removed connector
  // must degrade inside a read. The identity check did not turn that into an error.
  assert.equal(findWmsConnector('not-registered-at-all', registry), null)
})

test('[round 14 HIGH 1] the UI facades see "not configured", never another warehouse\'s answer', async () => {
  const registry = crossWiredRegistry()

  // CONTAINED, not propagated. `/onboarding` gathers its reads with `Promise.all` and `/sync` with
  // twenty-one others, so a rejection here is the whole wizard and the whole dashboard — the round-10
  // defect arriving through a new throw. The stub's own `isConfigured()` returns TRUE, so `false`
  // here can only be the identity refusal.
  assert.equal(await isWmsConnectorConfigured(ACME_WMS_ID, registry), false)
  await assert.doesNotReject(() => isWmsConnectorConfigured(ACME_WMS_ID, registry))

  // NON-VACUITY: the same stub, correctly wired, answers TRUE. Without this the case above would
  // pass on a fixture whose predicate was never going to say anything else.
  const wired = createRegisteredWmsConnectorRegistry<string>(
    [ACME_WMS_ID],
    { [ACME_WMS_ID]: registrationFor(ACME_WMS_ID, ACME_WMS_ID) },
  )
  assert.equal(await isWmsConnectorConfigured(ACME_WMS_ID, wired), true)
})

test('[round 14 HIGH 1] the KEY is the id, even when the registration smuggles one in', () => {
  // The `{ id, ...registration }` hole. A registration written in JavaScript, parsed from JSON, or
  // cast — none of which `Omit<…, 'id'>` reaches — carried an id that BECAME the definition's id, so
  // the connector was filed, listed and looked up under a name nobody registered. It also defeated
  // the identity check: the check compares against `def.id`, which was the smuggled value.
  const smuggled = {
    ...registrationFor(ACME_WMS_ID, ACME_WMS_ID),
    id: 'mintsoft',
  } as unknown as WmsConnectorRegistration<string>

  const registry = createRegisteredWmsConnectorRegistry<string>(
    [ACME_WMS_ID],
    { [ACME_WMS_ID]: smuggled },
  )

  assert.deepEqual(registry.ids(), [ACME_WMS_ID], 'the registry lists the id it was given')
  assert.equal(registry.getDef(ACME_WMS_ID).id, ACME_WMS_ID, 'and the definition carries that id')
  assert.equal(registry.has('mintsoft'), false, 'the smuggled id was never registered')
  assert.equal(registry.findDef('mintsoft'), null)
  // And the connector resolves, because the key it was filed under is the id its factory builds.
  assert.equal(registry.getConnector(ACME_WMS_ID).id, ACME_WMS_ID)
})

test('[round 14 HIGH 1] a cross-wired registry ASSEMBLES — which is why the type has to be the fix', () => {
  // THE LOAD-TIME GUARD CANNOT SEE THIS, and saying so is the point of the case. Round 12's guard
  // walks the id list and checks each id HAS an entry; it cannot look inside a factory, because a
  // factory is not invoked until a request needs a warehouse. So construction succeeds, the ids are
  // right, the labels are right, and nothing is wrong until the first dispatch.
  const registry = crossWiredRegistry()
  assert.deepEqual(registry.ids(), [ACME_WMS_ID])
  assert.equal(registry.getDef(ACME_WMS_ID).label, ACME_WMS_LABEL)

  // The same is true of the raw array constructor, which production does not use but tests do.
  const fromDefs = createWmsConnectorRegistry<string>([
    { id: ACME_WMS_ID, ...registrationFor(ACME_WMS_ID, 'mintsoft') },
  ])
  assert.deepEqual(fromDefs.ids(), [ACME_WMS_ID], 'assembled happily…')
  assert.throws(() => fromDefs.getConnector(ACME_WMS_ID), /acme-wms/, '…and refused on construction')
})
