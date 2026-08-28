import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export async function withMcpClient(name: string, run: (client: Client) => Promise<void>) {
  const client = new Client({ name, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: process.cwd(),
    stderr: 'pipe',
  })
  await client.connect(transport)
  try {
    await run(client)
  } finally {
    await client.close()
  }
}
