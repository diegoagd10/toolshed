import type { CoverageReportOptions } from 'monocart-coverage-reports'

const options: CoverageReportOptions = {
  name: 'toolshed',
  reports: ['console-details'],
  outputDir: './coverage',
  v8Ignore: false,
  all: './src',
  entryFilter: (entry) => entry.url.endsWith('/dist/main.js'),
  sourceFilter: (path) => path.startsWith('src/') && !path.endsWith('.test.ts'),
  onEnd: (results) => {
    const metrics = ['lines', 'branches', 'functions', 'statements'] as const
    const missing = metrics.filter((name) => results?.summary[name]?.pct !== 100)
    if (missing.length === 0) return
    console.error(`coverage: ${missing.join(', ')} below 100%`)
    process.exitCode = 1
  },
}

export default options
