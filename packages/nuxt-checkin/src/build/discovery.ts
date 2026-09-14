import { readFile } from 'node:fs/promises'
import ts from 'typescript'

/** IDs stay static so duplicates fail before server code executes. */
export async function readCheckId(file: string): Promise<string> {
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(ts.isExportAssignment)
  const call = declaration?.expression
  if (!call || !ts.isCallExpression(call) || !call.arguments[0] || !ts.isObjectLiteralExpression(call.arguments[0]))
    throw new Error(`Check file must default-export a factory call with a literal ID: ${file}`)
  const property = call.arguments[0].properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source).replace(/['"]/g, '') === 'id')
  if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer))
    throw new Error(`Check file requires a literal ID: ${file}`)
  const id = property.initializer.text
  if (!/^[\w.-]+$/.test(id))
    throw new Error(`Check file has an invalid ID: ${file}`)
  return id
}
