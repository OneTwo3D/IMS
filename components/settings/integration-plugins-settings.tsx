'use client'

import { useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { saveIntegrationPluginState } from '@/app/actions/settings'
import { resolvePluginSelectionSaveView } from '@/lib/domain/integrations/plugin-save-outcome'
import type { IntegrationPluginDescriptor } from '@/lib/domain/integrations/plugin-catalog'
import {
  buildIntegrationPluginState,
  type IntegrationPluginId,
  type IntegrationPluginState,
} from '@/lib/integration-plugin-keys'

/**
 * THE PLUGIN SWITCHES, ONE PER REGISTERED PLUGIN (o3d-m0ad, o3d-remove-shiphero round 8 HIGH 2).
 *
 * This screen used to take five named boolean props, hold five `useState` hooks, render five
 * hard-written `<Switch>` blocks, and assemble its selection with two `as IntegrationPluginState`
 * casts. Every one of those five was a place a SIXTH registered connector would be missing, and the
 * casts are what made the absence invisible: without them the object literals would not have
 * satisfied `IntegrationPluginState` and `tsc` would have named the missing member.
 *
 * So the switches are now DATA. `plugins` comes from the registry-derived catalogue
 * (lib/domain/integrations/plugin-catalog.ts), built on the server because the WMS registry cannot
 * be imported into a client bundle, and the selection is a `Record<IntegrationPluginId, boolean>`
 * built by `buildIntegrationPluginState` — which walks the id union rather than listing it. There
 * is no cast left, and no member for a connector to be missing from.
 */
type Props = {
  /** Every registered plugin, with its copy and its server-rendered value. */
  plugins: IntegrationPluginDescriptor[]
}

export function IntegrationPluginsSettings({ plugins }: Props) {
  const [isPending, startTransition] = useTransition()

  /**
   * What the switches showed before this page's session of edits — the server-rendered selection.
   *
   * A rollback target has to be a selection the DATABASE is known to have held, and the only one
   * this screen can name is the one it was rendered with. Using the pre-click switch values instead
   * would restore an intermediate the database never saw.
   */
  const rendered = new Map(plugins.map((plugin) => [plugin.id, plugin.enabled]))
  const previous: IntegrationPluginState = buildIntegrationPluginState((id) => rendered.get(id) ?? false)

  const [selection, setSelection] = useState<IntegrationPluginState>(previous)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  /** Saved, but the scheduler is behind. Not an error — see handleSave. */
  const [schedulerWarning, setSchedulerWarning] = useState('')

  function setPlugin(id: IntegrationPluginId, value: boolean) {
    setSelection((current) => ({ ...current, [id]: value }))
  }

  function handleSave() {
    setSaved(false)
    setError('')
    setSchedulerWarning('')

    // What is on screen right now — the operator's request. On the ONE outcome that committed
    // nothing (`refused`) the resolver replaces this with `previous`; on every other outcome the
    // switches stay where they are, or move to what the server read back under the lock.
    const requested = selection

    startTransition(async () => {
      // ONE decision, made by the SAME resolver the onboarding wizard uses (o3d-osl8 round 8,
      // finding 2). Round 7 fixed the classification in the wizard and cross-ported only the
      // warning here, so this screen kept its own copy of the rule — and that copy still reported
      // a COMMITTED write as a failed save whenever the scheduler step threw rather than returning:
      // the save landed in the catch below and printed a bare red error, which reads as "nothing
      // happened" and invites a retry of a write that is already stored. The rule now has one
      // implementation and no per-screen presentation parameter, because the two screens do not
      // need different presentation — only different switches to apply it to.
      //
      // The scheduler reconciliation is no longer called from here at all: it is a post-commit step
      // of the write, so it happens inside the action, under the guard that classifies it.
      const view = await (async () => {
        try {
          // ONE atomic, connector-selection-locked write (o3d-osl8 round 5, finding 2). This used
          // to be five parallel setSetting calls, so switching accounting connectors was observable
          // mid-flight as both-off or both-on — and a concurrent orphan cancel could discard the
          // incoming connector's queue from inside that window.
          //
          // THE WHOLE SELECTION, not a listed subset (o3d-m0ad): the payload used to name five
          // members, so a registered connector's switch could have existed and still not been sent.
          const result = await saveIntegrationPluginState(requested)
          return resolvePluginSelectionSaveView({ attempt: { kind: 'result', result }, requested, previous })
        } catch (e) {
          // A REJECTION, which is not a refusal: a permission gate throwing, a transaction
          // aborting, or a transport failure that lost the reply after the write committed. The
          // resolver keeps the switches where they are and says the outcome is unknown.
          return resolvePluginSelectionSaveView({ attempt: { kind: 'rejected', error: e }, requested, previous })
        }
      })()

      setSelection(view.plugins)
      setError(view.error)
      setSchedulerWarning(view.schedulerWarning)
      if (view.committed) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    })
  }

  return (
    <div className="space-y-5">
      {/* An UNAVAILABLE plugin only reaches this list while it is switched ON (see the catalogue),
          and the only move it may make is off: `value && plugin.available` cannot turn one on, so
          the screen cannot ask for a write the server would refuse. */}
      {plugins.map((plugin) => (
        <label key={plugin.id} className="flex items-start gap-3 cursor-pointer">
          <Switch
            checked={selection[plugin.id]}
            disabled={!plugin.available && !selection[plugin.id]}
            onCheckedChange={(value) => setPlugin(plugin.id, value && plugin.available)}
          />
          <div>
            <div className="text-sm font-medium">{plugin.label}</div>
            <p className="text-xs text-muted-foreground">{plugin.description}</p>
          </div>
        </label>
      ))}

      <div className="flex items-center gap-2 pt-2 border-t">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save &amp; Apply
        </Button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
      {/* Amber, not destructive, and worded as "saved, but": the selection above is durable and the
          switches show it. Only the scheduler is behind. */}
      {schedulerWarning && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{schedulerWarning}</p>
      )}
    </div>
  )
}
