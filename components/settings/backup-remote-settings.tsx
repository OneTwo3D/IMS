'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check, Cloud, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { setSetting } from '@/app/actions/settings'

type Props = {
  s3: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; secretKeyConfigured: boolean; prefix: string }
  sftp: { host: string; port: string; user: string; password: string; passwordConfigured: boolean; privateKey: string; privateKeyConfigured: boolean; hostFingerprint: string; path: string }
}

export function BackupRemoteSettings({ s3, sftp }: Props) {
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState<string | null>(null)

  const [s3State, setS3] = useState(s3)
  const [sftpState, setSftp] = useState(sftp)

  function showSaved(key: string) { setSaved(key); setTimeout(() => setSaved(null), 2000) }

  function isMasked(value: string): boolean {
    return value.includes('****')
  }

  function hasCustomS3Endpoint(endpoint: string): boolean {
    return endpoint.trim().length > 0
  }

  function hasChangedSftpTarget(): boolean {
    return (
      sftpState.host.trim() !== sftp.host.trim() ||
      sftpState.port.trim() !== sftp.port.trim() ||
      sftpState.user.trim() !== sftp.user.trim() ||
      sftpState.hostFingerprint.trim() !== sftp.hostFingerprint.trim()
    )
  }

  function handleSaveS3() {
    if (
      hasCustomS3Endpoint(s3State.endpoint) &&
      !window.confirm(
        `This will send backups to the custom S3 endpoint:\n\n${s3State.endpoint.trim()}\n\nOnly continue if you trust this storage target and intend to use a non-AWS endpoint.`,
      )
    ) {
      return
    }

    startTransition(async () => {
      const ops = [
        setSetting('backup_s3_endpoint', s3State.endpoint),
        setSetting('backup_s3_region', s3State.region),
        setSetting('backup_s3_bucket', s3State.bucket),
        setSetting('backup_s3_access_key', s3State.accessKey),
        setSetting('backup_s3_prefix', s3State.prefix),
      ]
      // Only save secret if user replaced the masked value
      if (!isMasked(s3State.secretKey)) {
        ops.push(setSetting('backup_s3_secret_key', s3State.secretKey))
      }
      await Promise.all(ops)
      showSaved('s3')
    })
  }

  function handleSaveSftp() {
    if (
      hasChangedSftpTarget() &&
      !window.confirm(
        `This will change the SFTP backup target to:\n\nHost: ${sftpState.host.trim() || '(empty)'}\nPort: ${sftpState.port.trim() || '22'}\nUser: ${sftpState.user.trim() || '(empty)'}\nFingerprint: ${sftpState.hostFingerprint.trim() || '(empty)'}\n\nOnly continue if this is the intended backup server.`,
      )
    ) {
      return
    }

    startTransition(async () => {
      const ops = [
        setSetting('backup_sftp_host', sftpState.host),
        setSetting('backup_sftp_port', sftpState.port),
        setSetting('backup_sftp_user', sftpState.user),
        setSetting('backup_sftp_host_fingerprint', sftpState.hostFingerprint),
        setSetting('backup_sftp_path', sftpState.path),
      ]
      // Only save secrets if user replaced the masked values
      if (!isMasked(sftpState.password)) {
        ops.push(setSetting('backup_sftp_password', sftpState.password))
      }
      if (!isMasked(sftpState.privateKey)) {
        ops.push(setSetting('backup_sftp_private_key', sftpState.privateKey))
      }
      await Promise.all(ops)
      showSaved('sftp')
    })
  }

  return (
    <div className="space-y-6">
      {/* S3 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Cloud className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">S3 Compatible Storage</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Works with AWS S3, MinIO, Backblaze B2, Cloudflare R2, DigitalOcean Spaces, etc.
        </p>
        <p className="text-[11px] text-amber-700 mb-3">
          Saving a custom endpoint sends backups to that remote storage target. Confirm the hostname before using anything other than default AWS S3.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Endpoint (optional — leave blank for AWS S3)</Label>
            <Input value={s3State.endpoint} onChange={(e) => setS3((p) => ({ ...p, endpoint: e.target.value }))} className="h-9" placeholder="https://s3.eu-west-1.amazonaws.com" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Region</Label>
            <Input value={s3State.region} onChange={(e) => setS3((p) => ({ ...p, region: e.target.value }))} className="h-9" placeholder="eu-west-1" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Bucket</Label>
            <Input value={s3State.bucket} onChange={(e) => setS3((p) => ({ ...p, bucket: e.target.value }))} className="h-9" placeholder="my-backups" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Access Key</Label>
            <Input value={s3State.accessKey} onChange={(e) => setS3((p) => ({ ...p, accessKey: e.target.value }))} className="h-9" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Secret Key</Label>
            <Input
              type="password"
              value={s3State.secretKey}
              onChange={(e) => setS3((p) => ({ ...p, secretKey: e.target.value }))}
              onFocus={(e) => { if (isMasked(e.target.value)) setS3((p) => ({ ...p, secretKey: '' })) }}
              placeholder={s3.secretKeyConfigured ? 'Configured — enter new value to change' : ''}
              className="h-9"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Path Prefix (optional)</Label>
            <Input value={s3State.prefix} onChange={(e) => setS3((p) => ({ ...p, prefix: e.target.value }))} className="h-9" placeholder="ims/backups" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Button size="sm" onClick={handleSaveS3} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save S3 Settings
          </Button>
          {saved === 's3' && <span className="text-sm text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>}
        </div>
      </div>

      <div className="border-t" />

      {/* SFTP */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Server className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">SFTP Server</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Supports password and private key (certificate) authentication.
        </p>
        <p className="text-[11px] text-amber-700 mb-3">
          Changing the SFTP host or fingerprint changes where production backups are sent. Verify both values before saving.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
          <div className="space-y-1.5">
            <Label className="text-xs">Host</Label>
            <Input value={sftpState.host} onChange={(e) => setSftp((p) => ({ ...p, host: e.target.value }))} className="h-9" placeholder="backup.example.com" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Port</Label>
            <Input value={sftpState.port} onChange={(e) => setSftp((p) => ({ ...p, port: e.target.value }))} className="h-9" placeholder="22" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Username</Label>
            <Input value={sftpState.user} onChange={(e) => setSftp((p) => ({ ...p, user: e.target.value }))} className="h-9" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Password (if not using key)</Label>
            <Input
              type="password"
              value={sftpState.password}
              onChange={(e) => setSftp((p) => ({ ...p, password: e.target.value }))}
              onFocus={(e) => { if (isMasked(e.target.value)) setSftp((p) => ({ ...p, password: '' })) }}
              placeholder={sftp.passwordConfigured ? 'Configured — enter new value to change' : ''}
              className="h-9"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Private Key (PEM format — paste the full key including BEGIN/END lines)</Label>
            <Textarea
              value={sftpState.privateKey}
              onChange={(e) => setSftp((p) => ({ ...p, privateKey: e.target.value }))}
              onFocus={(e) => { if (isMasked(e.currentTarget.value)) setSftp((p) => ({ ...p, privateKey: '' })) }}
              className="text-xs font-mono min-h-[80px]"
              placeholder={sftp.privateKeyConfigured ? 'Configured — paste new key to change' : '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Host Fingerprint</Label>
            <Input
              value={sftpState.hostFingerprint}
              onChange={(e) => setSftp((p) => ({ ...p, hostFingerprint: e.target.value }))}
              className="h-9 font-mono text-xs"
              placeholder="SHA256:base64fingerprint or md5 hex"
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              Required. Pins the SFTP server identity and rejects wrong-host or MITM connections.
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Remote Path</Label>
            <Input value={sftpState.path} onChange={(e) => setSftp((p) => ({ ...p, path: e.target.value }))} className="h-9" placeholder="/backups/ims" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Button size="sm" onClick={handleSaveSftp} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save SFTP Settings
          </Button>
          {saved === 'sftp' && <span className="text-sm text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>}
        </div>
      </div>
    </div>
  )
}
