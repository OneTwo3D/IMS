/**
 * A REGISTERED ID WITH NO DEFINITION MUST NOT PRODUCE A BUILD
 * (o3d-remove-shiphero round 12, Codex HIGH 1).
 *
 * THE DEFECT. `WMS_CONNECTOR_IDS` is the canonical list every derived thing hangs off — the plugin
 * id union, the setting keys, the exclusivity group, the settings toggles, the /sync cards, the
 * panel record. Rounds 6 and 8 made the PANELS and the TOGGLES total over it, so a registered id
 * with no screen does not compile. Nothing applied the same rule to the `WmsConnectorDef` list,
 * which is the one list that has to be complete for anything to work: `BUILT_IN_WMS_CONNECTORS`
 * was `readonly WmsConnectorDef[]`, so adding an id, a panel and a form while omitting the
 * definition typechecked. The settings screen then offered the connector, the writer persisted it,
 * the resolver selected it, and every route that reached `getWmsConnector` threw
 * `Unknown WMS connector` at REQUEST time — in the order push, the dispatch sweep, the ASN actions
 * and the /sync facade. A half-registration is worse than a missing one, because the operator is
 * told it worked.
 *
 * WHAT THIS FILE DRIVES. The SHIPPED registry module, under a build whose id list registers an id
 * nobody defined. It must refuse at module evaluation — where a deploy sees it — rather than
 * assembling a registry that is missing an entry and failing later, per request, per flow.
 *
 * WHY IT IS ITS OWN FILE. The refusal is a throw during module EVALUATION, so once it has happened
 * the module is poisoned for this process and nothing else here could import it. The positive
 * statements — the record is total at compile time, the shipped registry covers the shipped list,
 * the derivation accepts a matched pair — live in tests/wms-second-connector-seam.test.ts, which
 * runs against the real id list.
 *
 * NOTHING UNDER TEST IS IMPORTED STATICALLY: `mock.module` only reaches a module that has not been
 * evaluated yet, and a static import of the registry (directly, or through the seam helpers, which
 * import it) would bind it under the REAL id list before the mock below ran. The case would then
 * pass by never reaching the code it is about.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// The id list itself is safe to import statically — it is an import-free module of constants, and
// mocking it afterwards still intercepts the REGISTRY's own import of it (same file URL). What must
// not be imported statically is anything that PULLS the registry in.
import * as realTypes from '../lib/connectors/wms/types.ts'

/** Registered in the id list, defined nowhere. The shape a half-done registration leaves behind. */
const GHOST_WMS_ID = 'ghost-wms'

/**
 * The canonical id list, widened by one id with no definition.
 *
 * The rest of the module is passed through, so the ONLY difference between this build and the
 * shipped one is the thing under test. A hand-written stand-in would also have to re-state
 * `isWmsConnectorId`, `WmsCreateReplayPolicy` and everything else the registry's own imports need.
 */
mock.module('@/lib/connectors/wms/types', {
  namedExports: {
    ...realTypes,
    WMS_CONNECTOR_IDS: ['mintsoft', GHOST_WMS_ID],
    isWmsConnectorId: (value: string | null | undefined): boolean =>
      value === 'mintsoft' || value === GHOST_WMS_ID,
  },
})

test('[round 12 HIGH 1] the shipped registry REFUSES to load when an id has no definition', async () => {
  // Before the fix this RESOLVED: `BUILT_IN_WMS_CONNECTORS` was a literal array that never consulted
  // the id list at all, so the module loaded happily, `wmsConnectorRegistry.ids()` disagreed with
  // `WMS_CONNECTOR_IDS`, and the first request that resolved `ghost-wms` threw from inside a flow.
  await assert.rejects(
    () => import('../lib/connectors/wms/registry.ts'),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(
        message, new RegExp(GHOST_WMS_ID),
        'the failure must name the id — it is the only thing a deploy can act on',
      )
      assert.match(
        message, /no definition/i,
        'and say what is missing, so it is not mistaken for the unknown-id throw that a foreign link'
        + ' row legitimately produces',
      )
      return true
    },
    'a build that registers a connector it cannot construct must fail at load, not at the first'
    + ' order push that needs the warehouse',
  )
})
