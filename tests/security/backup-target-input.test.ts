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

test('IPv4-mapped / compatible / ULA IPv6 hosts and numeric IPv4 shorthands are refused', () => {
  for (const h of [
    'http://[::ffff:127.0.0.1]:9000', 'http://[::ffff:7f00:1]', 'http://[::ffff:a9fe:a9fe]/', 'http://[::ffff:169.254.169.254]',
    'http://[::127.0.0.1]', 'http://[fd00:ec2::254]', 'http://[fe80::1]', 'http://[::1]', 'http://[0:0:0:0:0:0:0:1]', 'http://[::]',
    'http://2130706433', 'http://0x7f.1', 'http://100.100.100.200',
  ]) {
    assert.match(validateBackupTargetValues({ backup_s3_endpoint: h }) ?? '', /not allowed/, h)
  }
  for (const h of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fd00:ec2::254', '0x7f000001', '127.1']) {
    assert.match(validateBackupTargetValues({ backup_sftp_host: h }) ?? '', /not allowed/, h)
  }
  // Ordinary destinations, including private LAN and public IPv6, stay allowed.
  assert.equal(validateBackupTargetValues({ backup_s3_endpoint: 'http://10.0.0.5:9000' }), null)
  assert.equal(validateBackupTargetValues({ backup_sftp_host: '2001:db8::1' }), null)
  assert.equal(validateBackupTargetValues({ backup_sftp_host: '::ffff:8.8.8.8' }), null)
  assert.equal(validateBackupTargetValues({ backup_sftp_host: 'backup.example.com' }), null)
})
