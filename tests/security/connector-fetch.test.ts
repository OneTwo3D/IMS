import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import test from 'node:test'

import { connectorFetch } from '../../lib/security/connector-fetch.ts'
import { validateExternalResolvedAddress } from '../../lib/security/external-url-safety.ts'

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        resolve(address.port)
        return
      }
      reject(new Error('Test server did not bind to a TCP port'))
    })
    server.on('error', reject)
  })
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

test('connectorFetch rejects DNS results that resolve to blocked private addresses', async () => {
  await assert.rejects(
    connectorFetch('https://store.example.test/wp-json/wc/v3/products', {}, {
      connectorName: 'WooCommerce',
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
    }),
    /WooCommerce URL resolved to a blocked loopback, link-local, private, or metadata network address/,
  )
})

test('connectorFetch rejects mixed public and blocked DNS results', async () => {
  await assert.rejects(
    connectorFetch('https://store.example.test/wp-json/wc/v3/products', {}, {
      connectorName: 'WooCommerce',
      lookup: async () => [
        { address: '203.0.113.10', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    }),
    /WooCommerce URL resolved to a blocked loopback, link-local, private, or metadata network address/,
  )
})

test('connectorFetch follows redirects and revalidates each hop', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/final' })
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })
  const port = await listen(server)

  try {
    const response = await connectorFetch(`http://127.0.0.1:${port}/redirect`, {}, {
      connectorName: 'Connector',
      allowE2eLocalHttp: true,
      env: { E2E_TEST_MODE: '1' },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  } finally {
    await close(server)
  }
})

test('connectorFetch rejects redirects to blocked resolved addresses', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { Location: 'https://redirect.example.test/private' })
    response.end()
  })
  const port = await listen(server)

  try {
    await assert.rejects(
      connectorFetch(`http://127.0.0.1:${port}/redirect`, {}, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: { E2E_TEST_MODE: '1' },
        lookup: async (hostname) => {
          if (hostname === 'redirect.example.test') return [{ address: '10.0.0.5', family: 4 }]
          return [{ address: '127.0.0.1', family: 4 }]
        },
      }),
      /Connector URL resolved to a blocked loopback, link-local, private, or metadata network address/,
    )
  } finally {
    await close(server)
  }
})

test('connectorFetch applies default timeout when caller does not provide a signal', async () => {
  const heldResponses: ServerResponse[] = []
  const server = createServer((_request, response) => {
    heldResponses.push(response)
    // Hold the socket open until the connector timeout aborts the request.
  })
  const port = await listen(server)

  try {
    await assert.rejects(
      connectorFetch(`http://127.0.0.1:${port}/slow`, {}, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: {
          E2E_TEST_MODE: '1',
          CONNECTOR_FETCH_TIMEOUT_MS: '20',
        },
      }),
      /Connector request timed out after 20ms/,
    )
  } finally {
    for (const response of heldResponses) response.destroy()
    await close(server)
  }
})

test('connectorFetch applies default timeout when caller supplies a signal', async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    }, 60)
  })
  const port = await listen(server)

  try {
    await assert.rejects(
      connectorFetch(`http://127.0.0.1:${port}/delayed`, {
        signal: AbortSignal.timeout(1_000),
      }, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: {
          E2E_TEST_MODE: '1',
          CONNECTOR_FETCH_TIMEOUT_MS: '5',
        },
      }),
      /Connector request timed out after 5ms/,
    )
  } finally {
    await close(server)
  }
})

test('connectorFetch preserves caller abort reasons', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })
  const port = await listen(server)

  try {
    await assert.rejects(
      connectorFetch(`http://127.0.0.1:${port}/aborted`, {
        signal: AbortSignal.abort('user_cancel'),
      }, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: { E2E_TEST_MODE: '1' },
      }),
      /user_cancel/,
    )
  } finally {
    await close(server)
  }
})

test('connectorFetch rejects responses that exceed the configured byte cap', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('too large')
  })
  const port = await listen(server)

  try {
    await assert.rejects(
      connectorFetch(`http://127.0.0.1:${port}/large`, {}, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: {
          E2E_TEST_MODE: '1',
          CONNECTOR_FETCH_MAX_RESPONSE_BYTES: '4',
        },
      }),
      /Connector response exceeded 4 bytes/,
    )
  } finally {
    await close(server)
  }
})

test('connectorFetch allows responses exactly at the configured byte cap', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('1234')
  })
  const port = await listen(server)

  try {
    const response = await connectorFetch(`http://127.0.0.1:${port}/exact`, {}, {
      connectorName: 'Connector',
      allowE2eLocalHttp: true,
      env: {
        E2E_TEST_MODE: '1',
        CONNECTOR_FETCH_MAX_RESPONSE_BYTES: '4',
      },
    })

    assert.equal(response.status, 200)
    assert.equal(await response.text(), '1234')
  } finally {
    await close(server)
  }
})

test('connectorFetch rejects multi-chunk responses after the byte cap is exceeded', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.write('123')
    response.end('456')
  })
  const port = await listen(server)

  try {
    await assert.rejects(
      connectorFetch(`http://127.0.0.1:${port}/chunked`, {}, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: {
          E2E_TEST_MODE: '1',
          CONNECTOR_FETCH_MAX_RESPONSE_BYTES: '5',
        },
      }),
      /Connector response exceeded 5 bytes/,
    )
  } finally {
    await close(server)
  }
})

test('connectorFetch rejects oversized declared content-length before buffering the body', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Length': '6',
      'Content-Type': 'text/plain',
    })
    response.write('1')
  })
  const port = await listen(server)

  try {
    await assert.rejects(
      connectorFetch(`http://127.0.0.1:${port}/declared-large`, {}, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: {
          E2E_TEST_MODE: '1',
          CONNECTOR_FETCH_MAX_RESPONSE_BYTES: '5',
        },
      }),
      /Connector declared content-length 6 exceeds 5 bytes/,
    )
  } finally {
    await close(server)
  }
})

test('connectorFetch falls back to default limits for invalid env values', async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('accepted')
    }, 25)
  })
  const port = await listen(server)
  const invalidValues = ['abc', '-5', '0', '  ', '5ms', '1e1', '4.5']

  try {
    for (const invalidValue of invalidValues) {
      const response = await connectorFetch(`http://127.0.0.1:${port}/fallback`, {}, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: {
          E2E_TEST_MODE: '1',
          CONNECTOR_FETCH_TIMEOUT_MS: invalidValue,
          CONNECTOR_FETCH_MAX_RESPONSE_BYTES: invalidValue,
        },
      })

      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'accepted')
    }
  } finally {
    await close(server)
  }
})

test('connectorFetch applies one timeout budget across redirects', async () => {
  const heldResponses: ServerResponse[] = []
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      setTimeout(() => {
        response.writeHead(302, { Location: '/slow' })
        response.end()
      }, 15)
      return
    }
    heldResponses.push(response)
  })
  const port = await listen(server)

  try {
    await assert.rejects(
      connectorFetch(`http://127.0.0.1:${port}/redirect`, {}, {
        connectorName: 'Connector',
        allowE2eLocalHttp: true,
        env: {
          E2E_TEST_MODE: '1',
          CONNECTOR_FETCH_TIMEOUT_MS: '20',
        },
      }),
      /Connector request timed out after 20ms/,
    )
  } finally {
    for (const response of heldResponses) response.destroy()
    await close(server)
  }
})

test('resolved private addresses can be explicitly allowlisted', () => {
  assert.deepEqual(
    validateExternalResolvedAddress('10.0.0.5', {
      connectorName: 'Connector',
      env: { CONNECTOR_PRIVATE_IP_ALLOWLIST: '10.0.0.5,192.168.10.0/24' },
    }),
    { ok: true },
  )

  assert.deepEqual(
    validateExternalResolvedAddress('192.168.10.77', {
      connectorName: 'Connector',
      env: { CONNECTOR_PRIVATE_IP_ALLOWLIST: '10.0.0.5,192.168.10.0/24' },
    }),
    { ok: true },
  )

  assert.deepEqual(
    validateExternalResolvedAddress('192.168.11.77', {
      connectorName: 'Connector',
      env: { CONNECTOR_PRIVATE_IP_ALLOWLIST: '10.0.0.5,192.168.10.0/24' },
    }),
    {
      ok: false,
      error: 'Connector URL resolved to a blocked loopback, link-local, private, or metadata network address.',
    },
  )

  assert.deepEqual(
    validateExternalResolvedAddress('169.254.169.254', {
      connectorName: 'Connector',
      env: { CONNECTOR_PRIVATE_IP_ALLOWLIST: '169.254.169.254' },
    }),
    {
      ok: false,
      error: 'Connector URL resolved to a blocked loopback, link-local, private, or metadata network address.',
    },
  )
})
