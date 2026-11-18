import assert from 'node:assert/strict'
import test from 'node:test'
import { credentialsFollowChangedTarget, validateBackupTargetValues } from '../../lib/domain/settings/backup-target-input.ts'

test('endpoint and host validation', () => {
  assert.equal(validateBackupTargetValues({ backup_s3_endpoint: 'https://s3.eu-west-1.amazonaws.com' }), null)
  assert.match(validateBackupTargetValues({ backup_s3_endpoint: 'https://u:p@host/' }) ?? '', /credentials/)
  assert.match(validateBackupTargetValues({ backup_s3_endpoint: 'ftp://host' }) ?? '', /http/)
  assert.match(validateBackupTargetValues({ backup_s3_endpoint: 'http://127.0.0.1:9000' }) ?? '', /not allowed/)
  assert.match(validateBackupTargetValues({ backup_sftp_host: '169.254.169.254' }) ?? '', /not allowed/)
  assert.match(validateBackupTargetValues({ backup_sftp_host: 'a@b' }) ?? '', /bare hostname/)
  assert.match(validateBackupTargetValues({ backup_sftp_port: '99999' }) ?? '', /port/)
})

test('a stored credential cannot follow a changed destination', () => {
  const current = { backup_sftp_host: 'a.example.com', backup_sftp_password: 'pw', backup_s3_endpoint: '', backup_s3_secret_key: 'sk' }
  assert.match(credentialsFollowChangedTarget(current, { backup_sftp_host: 'evil.example.com' }) ?? '', /Re-enter the SFTP/)
  assert.equal(credentialsFollowChangedTarget(current, { backup_sftp_host: 'evil.example.com', backup_sftp_password: 'new' }), null)
  assert.equal(credentialsFollowChangedTarget(current, { backup_sftp_host: 'a.example.com' }), null)
  assert.match(credentialsFollowChangedTarget(current, { backup_s3_endpoint: 'https://evil.example.com' }) ?? '', /Re-enter the S3/)
})
