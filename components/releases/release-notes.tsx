import { ScrollText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { CURRENT_RELEASE, RELEASES } from '@/lib/releases'

/** Read-only release notes. Shared by the admin System Settings tab and the all-roles /help/releases page. */
export function ReleaseNotes() {
  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Current Release</h2>
        </div>
        <div className="space-y-3">
          <div>
            <p className="text-lg font-semibold">
              Version {CURRENT_RELEASE.version}
            </p>
            <p className="text-sm text-muted-foreground">
              {CURRENT_RELEASE.title} · {CURRENT_RELEASE.date}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{CURRENT_RELEASE.summary}</p>
          <div>
            <p className="text-sm font-medium">User-facing changes</p>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {CURRENT_RELEASE.userHighlights.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </div>
          {CURRENT_RELEASE.operatorActions && CURRENT_RELEASE.operatorActions.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40" data-testid="release-operator-actions">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Before or after updating: operator actions</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-200">
                {CURRENT_RELEASE.operatorActions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-sm font-medium">Versioning policy</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Releases follow an x.y.z scheme. Increment x for breaking changes, y for user-facing non-breaking changes, and z for backend-only non-breaking changes with no direct user impact.
            </p>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Release History</h2>
        </div>
        <div className="space-y-4">
          {RELEASES.map((release) => (
            <div key={release.version} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="font-medium">Version {release.version}</p>
                <span className="text-sm text-muted-foreground">{release.date}</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{release.title}</p>
              <p className="mt-3 text-sm">{release.userMessage}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
