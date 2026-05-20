import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output, exit } from 'node:process'

const WORKFLOW_OPTIONS = [
  {
    key: 'sales-order',
    label: 'Sales Order Workflow',
    baseSpecs: [
      'e2e/sales-management.spec.ts',
      'e2e/sales-fulfillment.spec.ts',
      'e2e/navigation-detail.spec.ts',
      'e2e/regressions.spec.ts',
    ],
    integrationSpecs: [
      'e2e/woocommerce.spec.ts',
      'e2e/xero.spec.ts',
    ],
  },
  {
    key: 'purchase-order',
    label: 'Purchase Order Workflow',
    baseSpecs: [
      'e2e/operations.spec.ts',
    ],
    integrationSpecs: [
      'e2e/xero.spec.ts',
    ],
  },
  {
    key: 'stock-movement',
    label: 'Stock Movement Workflow',
    baseSpecs: [
      'e2e/workflows.spec.ts',
      'e2e/operations.spec.ts',
    ],
    integrationSpecs: [
      'e2e/woocommerce-existing-product.spec.ts',
      'e2e/woocommerce-product-types.spec.ts',
      'e2e/stock-sync-drift.spec.ts',
    ],
  },
  {
    key: 'product',
    label: 'Product Workflow',
    baseSpecs: [
      'e2e/workflows.spec.ts',
      'e2e/admin-workflows.spec.ts',
    ],
    integrationSpecs: [
      'e2e/woocommerce.spec.ts',
      'e2e/woocommerce-existing-product.spec.ts',
      'e2e/woocommerce-product-types.spec.ts',
    ],
  },
  {
    key: 'configuration',
    label: 'Configuration Changes Workflow',
    baseSpecs: [
      'e2e/admin-workflows.spec.ts',
      'e2e/backup-notifications.spec.ts',
      'e2e/navigation-detail.spec.ts',
      'e2e/route-coverage.spec.ts',
      'e2e/security-workflows.spec.ts',
    ],
    integrationSpecs: [
      'e2e/stock-sync-drift.spec.ts',
      'e2e/woocommerce.spec.ts',
    ],
  },
]

async function promptForWorkflowSelection(rl) {
  output.write('\nSelect a Playwright workflow suite:\n')
  for (const [index, option] of WORKFLOW_OPTIONS.entries()) {
    output.write(`${index + 1}. ${option.label}\n`)
  }

  while (true) {
    const answer = (await rl.question('\nEnter a number (1-5): ')).trim()
    const selectedIndex = Number(answer)
    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= WORKFLOW_OPTIONS.length) {
      return WORKFLOW_OPTIONS[selectedIndex - 1]
    }
    output.write('Invalid selection. Choose a number from 1 to 5.\n')
  }
}

async function promptForThirdPartyToggle(rl) {
  while (true) {
    const answer = (await rl.question('Activate 3rd party accounting / shopping channel workflow integration? (y/N): ')).trim().toLowerCase()
    if (!answer || answer === 'n' || answer === 'no') return false
    if (answer === 'y' || answer === 'yes') return true
    output.write('Invalid selection. Enter y or n.\n')
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const workflowArg = process.argv.find((arg) => arg.startsWith('--workflow='))
  const workflowKey = workflowArg?.slice('--workflow='.length)
  const includeIntegrationsArg = process.argv.includes('--integrations')
    ? true
    : (process.argv.includes('--no-integrations') ? false : undefined)
  const rl = createInterface({ input, output })

  let workflow
  let includeIntegrations
  try {
    if (workflowKey) {
      workflow = WORKFLOW_OPTIONS.find((option) => option.key === workflowKey)
      if (!workflow) {
        throw new Error(`Unknown E2E workflow "${workflowKey}". Valid options: ${WORKFLOW_OPTIONS.map((option) => option.key).join(', ')}`)
      }
    } else {
      workflow = await promptForWorkflowSelection(rl)
    }

    includeIntegrations = includeIntegrationsArg ?? (await promptForThirdPartyToggle(rl))
  } finally {
    rl.close()
  }

  const specs = Array.from(new Set([
    ...workflow.baseSpecs,
    ...(includeIntegrations ? workflow.integrationSpecs : []),
  ]))

  const env = {
    ...process.env,
    E2E_WC_ENABLED: includeIntegrations ? 'true' : 'false',
    E2E_XERO_ENABLED: includeIntegrations ? 'true' : 'false',
  }

  output.write('\nSelected workflow:\n')
  output.write(`${workflow.label}\n`)
  output.write(`3rd party integrations: ${includeIntegrations ? 'enabled' : 'disabled'}\n`)
  output.write('Specs:\n')
  for (const spec of specs) {
    output.write(`- ${spec}\n`)
  }

  if (dryRun) return

  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = ['playwright', 'test', ...specs]

  const child = spawn(command, args, {
    stdio: 'inherit',
    env,
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      output.write(`\nPlaywright terminated with signal ${signal}.\n`)
      exit(1)
    }
    exit(code ?? 1)
  })
}

main().catch((error) => {
  console.error(error)
  exit(1)
})
