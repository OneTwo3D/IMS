import type { Metadata } from 'next'
import Link from 'next/link'
import { HardDrive, Clock, Cloud } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { getSetting } from '@/app/actions/settings'
import { BackupRestore } from '@/components/settings/backup-restore'
import { BackupScheduleSettings } from '@/components/settings/backup-schedule'
import { BackupRemoteSettings } from '@/components/settings/backup-remote-settings'

export const metadata: Metadata = { title: 'Backup & Restore' }

const TABS = [
  { key: 'backup', label: 'Backup & Restore', icon: HardDrive },
  { key: 'scheduler', label: 'Scheduler', icon: Clock },
  { key: 'storage', label: 'Storage', icon: Cloud },
] as const

type Tab = (typeof TABS)[number]['key']

export default async function BackupSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = typeof params.tab === 'string' ? params.tab : undefined
  const activeTab: Tab = TABS.some((t) => t.key === raw) ? (raw as Tab) : 'backup'

  const [restoreData, scheduleData, storageData] = await Promise.all([
    activeTab === 'backup' ? true : null,
    activeTab === 'scheduler' ? loadSchedule() : null,
    activeTab === 'storage' ? loadStorage() : null,
  ])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Backup &amp; Restore</h1>
        <p className="mt-1 text-sm text-muted-foreground">Database backups, scheduling, and remote storage.</p>
      </div>

      <div className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = tab.key === activeTab
          return (
            <Link
              key={tab.key}
              href={`/settings/backup?tab=${tab.key}`}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </Link>
          )
        })}
      </div>

      {activeTab === 'backup' && restoreData && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            Create database backups, download them, or restore from a previous backup.
            Each backup is a full PostgreSQL dump that can be restored on any compatible server.
          </p>
          <BackupRestore />
        </Card>
      )}

      {activeTab === 'scheduler' && scheduleData && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            Automatically create backups on a daily schedule. Old backups are purged based on
            retention days and maximum count (whichever is reached first).
          </p>
          <BackupScheduleSettings
            enabled={scheduleData.enabled}
            retentionDays={scheduleData.retentionDays}
            maxCount={scheduleData.maxCount}
            autoUpload={scheduleData.autoUpload}
          />
        </Card>
      )}

      {activeTab === 'storage' && storageData && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            Configure S3-compatible storage or an SFTP server for off-site backup storage.
            Use the cloud/server icons on each backup to upload manually, or enable auto-upload
            in the scheduler.
          </p>
          <BackupRemoteSettings
            s3={storageData.s3}
            sftp={storageData.sftp}
          />
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data loaders — only called for the active tab
// ---------------------------------------------------------------------------

async function loadSchedule() {
  const [schedEnabled, schedDays, schedMax, schedUpload] = await Promise.all([
    getSetting('backup_schedule_enabled'),
    getSetting('backup_retention_days'),
    getSetting('backup_max_count'),
    getSetting('backup_auto_upload'),
  ])
  return {
    enabled: schedEnabled === 'true',
    retentionDays: schedDays ?? '30',
    maxCount: schedMax ?? '10',
    autoUpload: schedUpload ?? '',
  }
}

function maskSecret(value: string | null | undefined): { masked: string; hasValue: boolean } {
  if (!value) return { masked: '', hasValue: false }
  return { masked: value.substring(0, 4) + '****', hasValue: true }
}

async function loadStorage() {
  const [
    s3Endpoint, s3Region, s3Bucket, s3AccessKey, s3SecretKey, s3Prefix,
    sftpHost, sftpPort, sftpUser, sftpPassword, sftpKey, sftpPath,
  ] = await Promise.all([
    getSetting('backup_s3_endpoint'),
    getSetting('backup_s3_region'),
    getSetting('backup_s3_bucket'),
    getSetting('backup_s3_access_key'),
    getSetting('backup_s3_secret_key'),
    getSetting('backup_s3_prefix'),
    getSetting('backup_sftp_host'),
    getSetting('backup_sftp_port'),
    getSetting('backup_sftp_user'),
    getSetting('backup_sftp_password'),
    getSetting('backup_sftp_private_key'),
    getSetting('backup_sftp_path'),
  ])

  const s3SecretMasked = maskSecret(s3SecretKey)
  const sftpPasswordMasked = maskSecret(sftpPassword)
  const sftpKeyMasked = maskSecret(sftpKey)

  return {
    s3: {
      endpoint: s3Endpoint ?? '',
      region: s3Region ?? '',
      bucket: s3Bucket ?? '',
      accessKey: s3AccessKey ?? '',
      secretKey: s3SecretMasked.masked,
      secretKeyConfigured: s3SecretMasked.hasValue,
      prefix: s3Prefix ?? '',
    },
    sftp: {
      host: sftpHost ?? '',
      port: sftpPort ?? '22',
      user: sftpUser ?? '',
      password: sftpPasswordMasked.masked,
      passwordConfigured: sftpPasswordMasked.hasValue,
      privateKey: sftpKeyMasked.masked,
      privateKeyConfigured: sftpKeyMasked.hasValue,
      path: sftpPath ?? '',
    },
  }
}
