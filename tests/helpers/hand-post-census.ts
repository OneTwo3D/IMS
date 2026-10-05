import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

import { AFTER_DECLINE_STEP, HAND_POST_INSTRUCTION_PATTERN, LEDGER_CHECK_FIRST, MARK_REMEDY_TAIL, PAYMENT_POSTING_TYPES, UPDATE_POSTING_TYPES, handPostStepFor, withHandPostSafety } from '@/lib/domain/accounting/hand-post-instruction'

/**
 * o3d-1e7sl Codex round 16 - the structural census helpers, shared by the corpus test (operator-wording-universal) and the sink test
 * (posting-refusal-mark-handled), which feeds the RAW remedies through the real `recordAccountingPostingRefusal`.
 */
const ROOT = process.cwd()
export const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

/** The string-literal contents of a source file (comments stripped): where operator-visible text lives. */
export function stringLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[0])
}

// an instruction to TAKE / HOLD the claim for the hand posting ("take a fresh claim and mark it handled" is the claim for the MARK, not for posting)
export const CLAIM_PHRASE = /\b(take|hold|holding|under)\b[^.]{0,40}\bclaim\b(?! and mark)|take (it|the posting|this posting) for hand posting|Take for hand posting/i
export const LEDGER_CHECK_PHRASE = /check whether the current version is already in the accounting system|check the ledger|check for that document|check the accounting system|identify the posting type before any ledger work/i
export const PROHIBITION = /\b(do not|don't|never|must not|not to|not going to|nothing here authorises|is not offered)\b/i
// a sentence that DESCRIBES a state ("an operator is settling this by hand", "posted by hand") is not an instruction
export const DESCRIPTION = /\b(are|is|was|were|been|being) (settling|settled|posted|entered|typed|raised|recorded)\b|\b(took|taken|take) (this|it|a refused)|\bposted by hand\b|\bsettled BY HAND\b|\bBY HAND\b\./

/** The sentences of `text` that are instructions with no ledger check AND hand-post claim before them (preamble sentences carry both themselves). */
export function unsafeInstructionSentences(text: string): string[] {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  const out: string[] = []
  sentences.forEach((sentence, i) => {
    if (!HAND_POST_INSTRUCTION_PATTERN.test(sentence) || PROHIBITION.test(sentence) || DESCRIPTION.test(sentence)) return
    const before = `${sentences.slice(Math.max(0, i - 3), i).join(' ')} ${sentence}`
    if (CLAIM_PHRASE.test(before) && LEDGER_CHECK_PHRASE.test(before)) return
    out.push(sentence.slice(0, 160))
  })
  return out
}

/** Static text of a TypeScript expression (a remedy value): literals, templates, `+`, ternaries (both branches) and the known shared constants / builders. */
export function remedyTexts(node: ts.Expression): string[] {
  const cross = (a: string[], b: string[]) => a.flatMap((x) => b.map((y) => x + y))
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isParenthesizedExpression(node)) return remedyTexts(node.expression)
  if (ts.isTemplateExpression(node)) return node.templateSpans.reduce((acc, span) => cross(cross(acc, remedyTexts(span.expression)), [span.literal.text]), [node.head.text])
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return cross(remedyTexts(node.left), remedyTexts(node.right))
  if (ts.isConditionalExpression(node)) return [...remedyTexts(node.whenTrue), ...remedyTexts(node.whenFalse)]
  if (ts.isIdentifier(node)) {
    if (node.text === 'MARK_REMEDY_TAIL') return [MARK_REMEDY_TAIL]
    if (node.text === 'LEDGER_CHECK_FIRST') return [LEDGER_CHECK_FIRST]
    if (node.text === 'AFTER_DECLINE_STEP') return [AFTER_DECLINE_STEP]
    return ['<dynamic>']
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === 'handPostStepFor') {
      const arg = node.arguments[0]
      return [handPostStepFor(arg && (ts.isPropertyAccessExpression(arg) || ts.isIdentifier(arg)) ? undefined : arg && ts.isStringLiteral(arg) ? arg.text : undefined), ...[...UPDATE_POSTING_TYPES, ...PAYMENT_POSTING_TYPES, 'SALES_INVOICE'].map((t) => handPostStepFor(t))]
    }
    if (node.expression.text === 'withHandPostSafety' && node.arguments[0]) return remedyTexts(node.arguments[0]).map(withHandPostSafety)
  }
  return ['<dynamic>']
}

export function walkSources(): string[] {
  const walkAll = (dir: string): string[] => readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name)
    if (name === 'generated' || name === 'node_modules' || name === '.next') return []
    return statSync(path.join(ROOT, rel)).isDirectory() ? walkAll(rel) : /\.(ts|tsx)$/.test(name) ? [rel] : []
  })
  return ['app', 'lib', 'components'].flatMap((d) => { try { return walkAll(d) } catch { return [] } })
}

/** The `remedy` / `operatorRemedy` values of every refusing site in the tree, evaluated to their static texts (each passed through the sink guard). */
export function remedyCorpus(options: { sink?: boolean } = {}): Array<{ source: string; text: string }> {
  const sink = options.sink ?? true
  const out: Array<{ source: string; text: string }> = []
  for (const file of walkSources()) {
    const source = read(file)
    if (!/\bremedy\b|operatorRemedy/.test(source)) continue
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && (node.name.text === 'remedy' || node.name.text === 'operatorRemedy')) {
        for (const t of remedyTexts(node.initializer)) if (t !== '<dynamic>') out.push({ source: `${file}: remedy`, text: sink ? withHandPostSafety(t) : t })
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return out
}

