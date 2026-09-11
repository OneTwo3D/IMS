/**
 * THE SECOND-CONNECTOR SEAM, DRIVEN THROUGH THE REAL UI (o3d-remove-shiphero round 6, Codex HIGH 1).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM tests/wms-second-connector-seam-production.test.ts. That
 * file proves the two UI FACADES dispatch to whichever connector is active and hand back a DTO
 * keyed by it. Codex's round-5 finding was that the facades are not where production decides what
 * an operator sees: `app/(dashboard)/sync/wms-sync-panel.tsx` read the DTO, matched one id, and
 * rendered `null` for every other — underneath a header naming the connector and beside a card
 * reading CONFIGURED. A second connector got a blank configuration screen that looks like a
 * working one. The onboarding step had the same shape, under an enable switch that was ON.
 *
 * That is the fourth consecutive round in which a seam proved a property ONE LAYER SHORT of where
 * production decides. So this file starts at the facade and ends at the MARKUP: it registers
 * `acme-wms`, makes it the active connector, calls the REAL server actions, and feeds their real
 * output into the REAL components. The assertions are about what an operator reads.
 *
 * WHAT IS MOCKED, AND WHY THAT IS NOT CHEATING. The registry's contents and which plugin is
 * enabled — the one thing a second connector's existence changes — plus the session, and the two
 * Mintsoft modules the connector-specific arms import statically (they are never rendered here;
 * stubbing them keeps a routing bug from reaching real server actions instead of failing an
 * assertion). The components, the facades and the panel registry are the shipped code, unmodified.
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { ACME_WMS_ID, ACME_WMS_LABEL } from './helpers/fictitious-wms-connector.ts'
import { mountClientComponent } from './fixtures/render-client-component.ts'
import * as realTypes from '../lib/connectors/wms/types.ts'
import * as realPlugins from '../lib/integration-plugins.ts'
import * as realRegistry from '../lib/connectors/wms/registry.ts'
import type { WmsConnectorHooks } from '../lib/connectors/wms/connector-hooks.ts'
import type { WmsConnectorId } from '../lib/connectors/wms/types.ts'
// Type-only, so neither module is loaded before the mocks below are installed.
import type { WmsConnectorPanel } from '../app/(dashboard)/sync/wms-sync-panel.tsx'
import type { WmsConnectorConnectionForm } from '../components/onboarding/wms-onboarding-connection.tsx'

/** What Acme's /sync panel and onboarding form hand back. Opaque to the generic facades by design. */
const ACME_PANEL = { warehouses: ['ACME-WH-1'], lastSyncAt: null }
const ACME_FORM = { endpoint: 'https://acme.example/api', account: 'acme-ops' }

const acmeHooks: WmsConnectorHooks = {
  syncDashboard: async () => ({ getDashboardData: async () => ({ configured: true, panel: ACME_PANEL }) }),
  onboarding: async () => ({ getConnectionData: async () => ({ configured: true, form: ACME_FORM }) }),
}

let hooks: Record<string, WmsConnectorHooks> = { [ACME_WMS_ID]: acmeHooks }
let labels: Record<string, string> = { mintsoft: 'Mintsoft', [ACME_WMS_ID]: ACME_WMS_LABEL }
let pluginState: Record<string, boolean> = { [ACME_WMS_ID]: true }

mock.module('@/lib/connectors/wms/types', {
  namedExports: {
    ...realTypes,
    WMS_CONNECTOR_IDS: ['mintsoft', ACME_WMS_ID],
    isWmsConnectorId: (value: string | null | undefined) => value === 'mintsoft' || value === ACME_WMS_ID,
  },
})
mock.module('@/lib/integration-plugins', {
  namedExports: { ...realPlugins, getIntegrationPluginState: async () => pluginState },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    ...realRegistry,
    getWmsConnectorHooks: (id: string) => hooks[id] ?? {},
    findWmsConnectorLabel: (id: string) => labels[id] ?? null,
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'u1', role: 'ADMIN' }),
    requireAuth: async () => ({ id: 'u1', role: 'ADMIN' }),
    getCurrentUser: async () => ({ id: 'u1', role: 'ADMIN' }),
  },
})
// The connector-specific arms this file never renders. Stubbed so a routing bug fails an assertion
// here instead of reaching the real Mintsoft server actions (and the database behind them).
mock.module('@/app/(dashboard)/sync/mintsoft-client', {
  namedExports: { MintsoftClient: function MintsoftClient() { return null } },
})
mock.module('@/app/actions/mintsoft-sync', {
  namedExports: { saveMintsoftConnectionSettings: async () => ({ success: true }) },
})

/**
 * The visible text of a render.
 *
 * Read off the MARKUP, not off the element tree: the unsupported states are function components,
 * and `textOf` walks props and so stops at a component boundary — it would report only the header
 * and quietly agree that the body is empty, which is the exact failure this file exists to catch.
 */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const noop = () => {}
const withStepUp = async <T,>(run: () => Promise<T>): Promise<T> => run()

// ---------------------------------------------------------------------------------------------
// THE /sync PANEL
// ---------------------------------------------------------------------------------------------

test('seam/ui: the /sync panel tells the operator a registered connector has no screen, and does not render blank', async () => {
  const wmsSync = await import('../app/actions/wms-sync.ts')
  const { WmsSyncPanel } = await import('../app/(dashboard)/sync/wms-sync-panel.tsx')

  // The REAL facade, with `acme-wms` enabled and configured.
  const data = await wmsSync.getWmsSyncDashboardData()
  assert.notEqual(data, null)
  assert.equal(data!.connectorId, ACME_WMS_ID)
  assert.equal(data!.configured, true, 'the card beside this panel reads CONFIGURED off exactly this')

  const mounted = mountClientComponent(WmsSyncPanel, {
    connectorId: ACME_WMS_ID as WmsConnectorId,
    data,
    onBack: noop,
  })
  const { html } = mounted.render()
  const text = visibleText(html)

  // BEFORE THE FIX: everything below the header was `null`. The operator saw a back link, the
  // connector's name, "Configure the WMS connection…", and then nothing at all.
  assert.match(html, /data-wms-panel-state="no-panel"/, 'the missing panel is a RENDERED state, not an absence')
  assert.match(text, /no configuration screen/i, 'and it says what is missing')
  assert.match(text, new RegExp(ACME_WMS_ID), 'naming the connector id an operator would report')

  // And it must not tell somebody with a live connection to go and re-enter their credentials.
  assert.match(text, /set up and running/i)
  assert.doesNotMatch(text, /is not set up yet/i)
})

test('seam/ui: a connector WITH a panel but no payload is told apart from one with no panel', async () => {
  const wmsSync = await import('../app/actions/wms-sync.ts')
  const { WmsSyncPanel } = await import('../app/(dashboard)/sync/wms-sync-panel.tsx')

  const previous = hooks
  hooks = { [ACME_WMS_ID]: {} }
  try {
    // A connector that declares no dashboard hook: the facade answers with an EMPTY payload map
    // and `configured: false`, which is a different thing from "this build has no panel".
    const data = await wmsSync.getWmsSyncDashboardData()
    assert.deepEqual(data!.connectorData, {})

    // Rendered for the SHIPPED connector, which does have a panel, so the miss is the payload.
    const mounted = mountClientComponent(WmsSyncPanel, {
      connectorId: 'mintsoft' as WmsConnectorId,
      data: { ...data!, connectorId: 'mintsoft' as WmsConnectorId },
      onBack: noop,
    })
    const { html } = mounted.render()
    assert.match(html, /data-wms-panel-state="no-data"/)
    assert.match(visibleText(html), /returned no configuration data/i)
    assert.match(visibleText(html), /is not set up yet/i, 'and an unconfigured connector is not described as running')
  } finally {
    hooks = previous
  }
})

test('seam/ui: opening a SECOND enabled connector says why it has no panel, instead of doing nothing', async () => {
  // The /sync dashboard used to require the DTO to belong to the card that was clicked; a second
  // enabled connector's card therefore fell through to the grid. The click did nothing, and said
  // nothing about why.
  const wmsSync = await import('../app/actions/wms-sync.ts')
  const { WmsSyncPanel } = await import('../app/(dashboard)/sync/wms-sync-panel.tsx')

  const data = await wmsSync.getWmsSyncDashboardData()
  const mounted = mountClientComponent(WmsSyncPanel, {
    connectorId: 'mintsoft' as WmsConnectorId,
    data,
    onBack: noop,
  })
  const { html } = mounted.render()
  assert.match(html, /data-wms-panel-state="not-active"/)
  assert.match(visibleText(html), /not the active WMS connector/i)
  assert.match(visibleText(html), new RegExp(ACME_WMS_LABEL), 'and it names the one that IS active')
})

test('seam/ui: with NO WMS connector enabled the panel still explains itself', async () => {
  const { WmsSyncPanel } = await import('../app/(dashboard)/sync/wms-sync-panel.tsx')
  const mounted = mountClientComponent(WmsSyncPanel, {
    connectorId: 'mintsoft' as WmsConnectorId,
    data: null,
    onBack: noop,
  })
  const { html } = mounted.render()
  assert.match(html, /data-wms-panel-state="not-active"/, 'a null DTO renders a state, never nothing')
})

test('seam/ui: the SHIPPED connector still renders its own panel', async () => {
  // The negative that keeps the rest honest: a fix that showed the unsupported notice to everybody
  // would pass every assertion above.
  const { WmsSyncPanel } = await import('../app/(dashboard)/sync/wms-sync-panel.tsx')
  const mounted = mountClientComponent(WmsSyncPanel, {
    connectorId: 'mintsoft' as WmsConnectorId,
    data: {
      connectorId: 'mintsoft' as WmsConnectorId,
      connectorLabel: 'Mintsoft',
      configured: true,
      connectorData: { mintsoft: { anything: true } } as Partial<Record<WmsConnectorId, unknown>>,
    },
    onBack: noop,
  })
  const { html } = mounted.render()
  assert.doesNotMatch(html, /data-wms-panel-state/, 'no unsupported state for a connector that has a panel')
  assert.doesNotMatch(visibleText(html), /no configuration screen/i)
})

// ---------------------------------------------------------------------------------------------
// THE ONBOARDING CONNECTION STEP
// ---------------------------------------------------------------------------------------------

async function renderOnboarding(overrides: Record<string, unknown> = {}) {
  const wmsOnboarding = await import('../app/actions/wms-onboarding.ts')
  const { WmsOnboardingConnection } = await import('../components/onboarding/wms-onboarding-connection.tsx')
  const data = await wmsOnboarding.getWmsOnboardingConnectionData()
  const mounted = mountClientComponent(WmsOnboardingConnection, {
    data,
    enabled: true,
    busy: false,
    availableOrderLookupConnectors: [],
    withStepUp,
    onToggle: noop,
    onBusyChange: noop,
    onConnected: noop,
    onError: noop,
    ...overrides,
  } as never)
  return { data, ...mounted.render() }
}

test('seam/ui: the onboarding step tells the operator a registered connector has no setup form', async () => {
  const { data, html } = await renderOnboarding()
  assert.equal(data.connectorId, ACME_WMS_ID)
  assert.equal(data.configured, true, 'the wizard ticks this step off exactly this value')

  // BEFORE THE FIX: an enable switch that was ON, a ticked step, and nothing underneath.
  assert.match(html, /data-wms-connection-state="no-form"/)
  assert.match(visibleText(html), /no setup form/i)
  assert.match(visibleText(html), /already set up/i, 'a live connection is never described as missing credentials')
  assert.doesNotMatch(visibleText(html), /is not set up, and cannot be set up/i)
})

test('seam/ui: an onboarding connector with no connection payload is told apart from one with no form', async () => {
  const previous = hooks
  hooks = { [ACME_WMS_ID]: {} }
  try {
    const { data, html } = await renderOnboarding()
    assert.deepEqual(data.connectorData, {}, 'the facade claims nothing for a connector that ran nothing')
    assert.match(html, /data-wms-connection-state="no-form"/)
    assert.match(visibleText(html), new RegExp(ACME_WMS_LABEL), 'still named from the registry')
  } finally {
    hooks = previous
  }
})

test('seam/ui: a DISABLED WMS connector renders no form and no notice', async () => {
  // The switch is off: there is nothing to configure and nothing to complain about. The
  // unsupported notice must not become ambient noise on a page where the connector is simply off.
  const { html } = await renderOnboarding({ enabled: false })
  assert.doesNotMatch(html, /data-wms-connection-state/)
})

// ---------------------------------------------------------------------------------------------
// THE COMPILE-TIME HALF — a registered connector with no panel must not reach the runtime at all
// ---------------------------------------------------------------------------------------------

test('seam/ui: the panel and form registries are TOTAL over the connector id union', async () => {
  const panelModule = await import('../app/(dashboard)/sync/wms-sync-panel.tsx')

  // Every registered connector has a card AND a panel, derived from the same record — so the
  // Integrations grid cannot silently omit one.
  assert.deepEqual(
    panelModule.WMS_PANEL_ENTRIES.map((entry) => entry.id),
    ['mintsoft'],
    'this build ships one WMS panel, and the grid lists exactly the panels that exist',
  )
  for (const entry of panelModule.WMS_PANEL_ENTRIES) {
    assert.equal(typeof entry.label, 'string')
    assert.equal(typeof entry.description, 'string')
    assert.equal(typeof entry.render, 'function')
  }

  const formModule = await import('../components/onboarding/wms-onboarding-connection.tsx')

  // THE COMPILE-TIME ASSERTIONS, and there are two because the obvious one proves the wrong thing.
  //
  // (1) NO KEY MAY BE MISSING. Assigning the record to a mapped type over the WHOLE union fails if
  //     the record is `Partial<…>` or is missing an entry, so a connector id added to
  //     `WMS_CONNECTOR_IDS` with no panel written for it stops `tsc`. This file then does not
  //     compile, which IS the detection — there is no assertion to run.
  const totalPanels: { [K in WmsConnectorId]: WmsConnectorPanel } = panelModule.WMS_PANELS
  const totalForms: { [K in WmsConnectorId]: WmsConnectorConnectionForm } = formModule.WMS_CONNECTION_FORMS
  assert.ok(totalPanels && totalForms)

  // (2) THE KEY TYPE MAY NOT BE WIDENED. (1) alone is satisfied by `Record<string, …>`, which
  //     accepts every id and therefore guarantees nothing — the first attempt at this assertion was
  //     exactly that mistake, and a mutation that widened the record stayed green. Indexing with an
  //     id the union does not contain must be a TYPE ERROR; if it ever compiles, the record has
  //     stopped being a statement about which connectors exist.
  // @ts-expect-error o3d-remove-shiphero r6 (Codex HIGH 1): `acme-wms` is not a registered id, so
  // it is not indexable. Widening WMS_PANELS to `Record<string, …>` makes this line legal.
  assert.equal(panelModule.WMS_PANELS['acme-wms'], undefined)
  // @ts-expect-error o3d-remove-shiphero r6 (Codex HIGH 1): the same, for the onboarding forms.
  assert.equal(formModule.WMS_CONNECTION_FORMS['acme-wms'], undefined)
})
