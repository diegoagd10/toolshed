import { relative } from 'node:path'
import { type Context, definePlugin, defineRule, type ESTree } from 'vite-plus/lint/plugins'

const testFile = /\.test\.ts$/
const integrationFile = /\.integration\.test\.ts$/
const unitFile = /\.unit\.test\.ts$/
const unitReason = /^\s*unit-test-reason:\s*\S/
const testRunners = /^(vite-plus\/test|vitest|node:test|bun:test|@jest\/globals)$/
const entryPoint = /^\.\.?\/app\.js$/

function pathOf(context: Context) {
  return relative(context.cwd, context.filename)
}

function nestDecorator(name: string, allowed: RegExp, expected: string) {
  return defineRule({
    meta: { type: 'problem' },
    create(context) {
      const locals = new Set<string>()
      return {
        ImportDeclaration(node) {
          if (node.source.value !== '@nestjs/common') return
          for (const specifier of node.specifiers) {
            if (specifier.type !== 'ImportSpecifier') continue
            const { imported } = specifier
            const original = imported.type === 'Literal' ? imported.value : imported.name
            if (original === name) locals.add(specifier.local.name)
          }
        },
        Decorator(node) {
          if (allowed.test(pathOf(context))) return
          const { expression } = node
          const target = expression.type === 'CallExpression' ? expression.callee : expression
          const matches = target.type === 'Identifier'
            ? locals.has(target.name)
            : target.type === 'MemberExpression' &&
              target.property.type === 'Identifier' &&
              target.property.name === name
          if (matches) {
            context.report({ node, message: `@${name} classes belong in ${expected}.` })
          }
        },
      }
    },
  })
}

const noRecord = defineRule({
  meta: { type: 'problem' },
  create(context) {
    const message = 'Declare a class or model type with named properties instead of a Record or index signature.'
    return {
      TSTypeReference(node) {
        if (node.typeName.type === 'Identifier' && node.typeName.name === 'Record') {
          context.report({ node, message })
        }
      },
      TSIndexSignature(node) {
        context.report({ node, message })
      },
    }
  },
})

const integrationTests = defineRule({
  meta: { type: 'problem' },
  create(context) {
    const path = pathOf(context)
    const isTest = testFile.test(path)
    const isIntegration = integrationFile.test(path)

    function checkImport(node: ESTree.Node, source: string) {
      if (!isTest && testRunners.test(source)) {
        context.report({
          node,
          message: 'Tests belong in *.integration.test.ts files.',
        })
      }
      if (isIntegration && source.startsWith('.') && !entryPoint.test(source)) {
        context.report({
          node,
          message: 'An integration test goes through app.js or the built server, not through internal modules.',
        })
      }
    }

    return {
      Program(node) {
        if (!isTest || isIntegration) return
        if (!unitFile.test(path)) {
          context.report({ node, message: 'Name the file *.integration.test.ts.' })
          return
        }
        const [first] = context.sourceCode.getAllComments()
        if (!first || first.start > node.start || !unitReason.test(first.value)) {
          context.report({
            node,
            message: 'Write an integration test. If it cannot reach a path, start the file with "// unit-test-reason: <which path and why>".',
          })
        }
      },
      ImportDeclaration(node) {
        if (node.importKind !== 'type') checkImport(node, node.source.value)
      },
      ExportNamedDeclaration(node) {
        if (node.source && node.exportKind !== 'type') checkImport(node, node.source.value)
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type') checkImport(node, node.source.value)
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          checkImport(node, node.source.value)
        }
      },
      MemberExpression(node) {
        if (!isIntegration) return
        if (node.object.type !== 'Identifier' || node.property.type !== 'Identifier') return
        if (!['vi', 'mock'].includes(node.object.name)) return
        if (!['mock', 'doMock', 'spyOn', 'module', 'method'].includes(node.property.name)) return
        context.report({ node, message: 'An integration test does not mock modules.' })
      },
    }
  },
})

export default definePlugin({
  meta: { name: 'toolshed' },
  rules: {
    'controller-file': nestDecorator(
      'Controller',
      /^src\/[^/]+\/controller\.ts$/,
      'src/<feature>/controller.ts',
    ),
    'module-file': nestDecorator(
      'Module',
      /^src\/[^/]+\/modules\.ts$/,
      'src/<feature>/modules.ts',
    ),
    'no-record': noRecord,
    'integration-tests': integrationTests,
  },
})
