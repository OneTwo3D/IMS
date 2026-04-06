import type { Metadata } from 'next'
import { HardDrive, Clock, Cloud } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getSetting } from '@/app/actions/settings'
import { BackupRestore } from '@/components/settings/backup-restore'
import { BackupScheduleSettings } from '@/components/settings/backup-schedule'
import { BackupRemoteSettings } from '@/components/settings/backup-remote-settings'

export const metadata: Metadata = { title: 'Backup & Restore' }

export default async function BackupSettingsPage() {
  const [
    schedEnabled, schedDays, schedMax, schedUpload,
    s3Endpoint, s3Region, s3Bucket, s3AccessKey, s3SecretKey, s3Prefix,
    sftpHost, sftpPort, sftpUser, sftpPassword, sftpKey, sftpPath,
  ] = await Promise.all([
    getSetting('backup_schedule_enabled'),
    getSetting('backup_retention_days'),
    getSetting('backup_max_count'),
    getSetting('backup_auto_upload'),
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

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Backup &amp; Restore</h1>
        <p className="mt-1 text-sm text-muted-foreground">Database backups, scheduling, and remote storage.</p>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Backup &amp; Restore</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Create database backups, download them, or restore from a previous backup.
          Each backup is a full PostgreSQL dump that can be restored on any compatible server.
        </p>
        <BackupRestore />
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Backup Schedule</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Automatically create backups on a daily schedule. Old backups are purged based on
          retention days and maximum count (whichever is reached first).
        </p>
        <BackupScheduleSettings
          enabled={schedEnabled === 'true'}
          retentionDays={schedDays ?? '30'}
          maxCount={schedMax ?? '10'}
          autoUpload={schedUpload ?? ''}
        />
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Cloud className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Remote Backup Storage</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Configure S3-compatible storage or an SFTP server for off-site backup storage.
          Use the cloud/server icons on each backup to upload manually, or enable auto-upload
          in the schedule above.
        </p>
        <BackupRemoteSettings
          s3={{
            endpoint: s3Endpoint ?? '',
            region: s3Region ?? '',
            bucket: s3Bucket ?? '',
            accessKey: s3AccessKey ?? '',
            secretKey: s3SecretKey ?? '',
            prefix: s3Prefix ?? '',
          }}
          sftp={{
            host: sftpHost ?? '',
            port: sftpPort ?? '22',
            user: sftpUser ?? '',
            password: sftpPassword ?? '',
            privateKey: sftpKey ?? '',
            path: sftpPath ?? '',
          }}
        />
      </Card>
    </div>
  )
}
