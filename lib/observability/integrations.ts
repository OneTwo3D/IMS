/**
 * Default integrations that record payload CONTENT (prompts/responses, MCP content, console arguments)
 * independently of `dataCollection`. They are removed outright: error reports do not need them, and IMS
 * sends product text to an LLM. Names from the SDK's default integration lists (server, edge, browser);
 * the pattern also catches AI integrations a later SDK version may add.
 */
const CONTENT_CAPTURING = new Set([
  'Console',
  'LangChain',
  'LangGraph',
  'Mastra',
  'PiDurable',
  'VercelAI',
  'OpenAI',
  'Anthropic_AI',
  'Google_GenAI',
  'Mistral',
  'Groq',
  'TogetherAI',
  'McpServer',
])
const CONTENT_CAPTURING_PATTERN = /anthropic|openai|genai|langchain|langgraph|mastra|mistral|groq|together|mcp|vercelai|llm/i

export function dropContentCapturingIntegrations<T extends { name: string }>(defaults: T[]): T[] {
  return defaults.filter((i) => !CONTENT_CAPTURING.has(i.name) && !CONTENT_CAPTURING_PATTERN.test(i.name))
}
