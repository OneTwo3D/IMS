import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE_FILE_PATTERN = /^route\.(?:ts|tsx|js|jsx|mjs|cjs)$/

export async function discoverApiRouteFiles(apiDir = path.join(process.cwd(), 'app', 'api')): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
        return
      }
      if (entry.isFile() && ROUTE_FILE_PATTERN.test(entry.name)) {
        files.push(entryPath)
      }
    }))
  }

  await walk(apiDir)
  return files.sort()
}

export function apiRoutePathFromFile(filePath: string, apiDir = path.join(process.cwd(), 'app', 'api')): string {
  const relative = path.relative(apiDir, filePath)
  const segments = relative.split(path.sep).filter(Boolean)
  const fileName = segments.pop()
  if (!fileName || !ROUTE_FILE_PATTERN.test(fileName)) {
    throw new Error(`Not a Next.js route file: ${filePath}`)
  }

  const route = segments
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')))
    .filter((segment) => !segment.startsWith('@'))
    .join('/')

  return `/api/${route}`
}

export async function discoverApiRoutePaths(apiDir = path.join(process.cwd(), 'app', 'api')): Promise<string[]> {
  const files = await discoverApiRouteFiles(apiDir)
  return files.map((file) => apiRoutePathFromFile(file, apiDir)).sort()
}

async function main(): Promise<void> {
  const routes = await discoverApiRoutePaths()
  for (const route of routes) {
    console.log(route)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
