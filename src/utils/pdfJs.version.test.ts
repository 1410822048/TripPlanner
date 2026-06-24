/// <reference types="node" />
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import rootPackageJson from '../../package.json?raw'
import workerPackageJson from '../../workers/ocr/package.json?raw'

type PackageJson = {
  version?:      string
  dependencies?: Record<string, string>
}

const require = createRequire(import.meta.url)

function parsePackageJson(raw: string): PackageJson {
  return JSON.parse(raw) as PackageJson
}

function resolvePackageJsonFrom(fromPackage: string, targetPackage: string): PackageJson {
  const fromPackageJsonPath = require.resolve(`${fromPackage}/package.json`)
  const fromRequire = createRequire(fromPackageJsonPath)
  return fromRequire(`${targetPackage}/package.json`) as PackageJson
}

describe('pdf.js dependency pairing', () => {
  it('keeps react-pdf runtime pdf.js and both pdfjs-dist installs on the same exact pair', () => {
    const rootPkg              = parsePackageJson(rootPackageJson)
    const workerPkg            = parsePackageJson(workerPackageJson)
    const reactPdfPdfjsDistPkg = resolvePackageJsonFrom('react-pdf', 'pdfjs-dist')

    expect(workerPkg.dependencies?.['pdfjs-dist']).toBe(rootPkg.dependencies?.['pdfjs-dist'])
    expect(reactPdfPdfjsDistPkg.version).toBe(rootPkg.dependencies?.['pdfjs-dist'])
    expect(rootPkg.dependencies?.['react-pdf']).not.toMatch(/^[~^]/)
    expect(rootPkg.dependencies?.['pdfjs-dist']).not.toMatch(/^[~^]/)
  })
})
