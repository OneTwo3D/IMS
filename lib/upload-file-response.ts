import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { NextResponse } from 'next/server'

export async function uploadFileResponse(filepath: string, headers: HeadersInit): Promise<NextResponse> {
  await stat(filepath)
  return new NextResponse(Readable.toWeb(createReadStream(filepath)) as ReadableStream<Uint8Array>, {
    headers,
  })
}
