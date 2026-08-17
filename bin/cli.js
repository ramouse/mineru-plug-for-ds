#!/usr/bin/env node
'use strict'
// mineru-dsh-plugin CLI — one-command install/uninstall/status.
// Pure Node, zero dependencies, cross-platform (junction on Windows,
// symlink elsewhere).
//
//   mineru-dsh-plugin            # install (idempotent; re-runs update)
//   mineru-dsh-plugin uninstall  # remove patch entries + junctions
//   mineru-dsh-plugin uninstall --purge  # also delete the mirrored copy
//   mineru-dsh-plugin status     # show what is installed
//   mineru-dsh-plugin --install-dir <path>  # force a DSH install root

const fs = require('fs')
const path = require('path')
const os = require('os')

const ROW_DIR = 'mineru-plugin' // the junction/symlink name the loader resolves
const MIRROR_DIR_NAME = 'mineru-dsh-plugin'

function log(step, msg) { console.log(`[${step}] ${msg}`) }
function fail(msg) { console.error(`[FAIL] ${msg}`); process.exit(1) }

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function packageRoot() {
  // bin/cli.js -> package root (repo root or npm install dir)
  return path.resolve(__dirname, '..')
}

function mirrorDir() {
  return path.join(dshHome(), 'plugins', MIRROR_DIR_NAME)
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

function mirror() {
  const root = packageRoot()
  const mirror = mirrorDir()
  copyDir(path.join(root, 'packages', ROW_DIR), path.join(mirror, 'packages', ROW_DIR))
  copyDir(path.join(root, 'tools', 'mineru'), path.join(mirror, 'tools', 'mineru'))
  return mirror
}

function candidateRoots(installDir) {
  const c = []
  if (installDir) {
    c.push(installDir)
    c.push(path.join(installDir, 'node_modules'))
  }
  const home = dshHome()
  c.push(path.join(home, 'profiles', 'node_modules'))
  c.push(path.join(home, 'profiles', 'web', 'node_modules'))
  c.push(path.join('E:', 'ds harness', 'deepseek-harness', 'node_modules'))
  const seen = new Set()
  return c.filter((p) => {
    if (!p || seen.has(p)) return false
    seen.add(p)
    return fs.existsSync(path.join(p, '@deepseek-ai'))
  })
}

function patchFiles() {
  const profiles = path.join(dshHome(), 'profiles')
  const out = []
  if (!fs.existsSync(profiles)) return out
  for (const name of fs.readdirSync(profiles)) {
    const f = path.join(profiles, name, 'cordis.patch.yml')
    if (fs.existsSync(f)) out.push(f)
  }
  return out
}

function patchBlock(projectDir, dataDir) {
  const lines = [
    '# MinerU document parsing plugin (installed by mineru-dsh-plugin)',
    '- insert:',
    '    - id: mineru-plugin',
    '      name: mineru-plugin',
    '      config:',
    `        projectDir: ${projectDir}`,
  ]
  if (dataDir) lines.push(`        dataDir: ${dataDir}`)
  lines.push('')
  return lines.join('\n')
}

function addPatchEntry(file, projectDir, dataDir) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/)
  let inMineru = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*name:\s*mineru-plugin\s*$/.test(lines[i])) inMineru = true
    if (inMineru && /^\s*projectDir:/.test(lines[i])) {
      lines[i] = '        projectDir: ' + projectDir
      // Ensure a dataDir line right after projectDir (upsert when present).
      if (dataDir) {
        if (i + 1 < lines.length && /^\s*dataDir:/.test(lines[i + 1])) {
          lines[i + 1] = '        dataDir: ' + dataDir
        } else {
          lines.splice(i + 1, 0, '        dataDir: ' + dataDir)
        }
      }
      fs.writeFileSync(file, lines.join('\n'), 'utf8')
      return 'updated'
    }
  }
  if (raw.includes('mineru-plugin')) return 'present'
  const clean = raw.trimEnd()
  if (clean.trim() === '[]' || clean.trim() === '') {
    fs.writeFileSync(file, patchBlock(projectDir, dataDir).trimEnd() + '\n', 'utf8')
  } else {
    fs.writeFileSync(file, clean + '\n\n' + patchBlock(projectDir, dataDir), 'utf8')
  }
  return 'added'
}

function removePatchEntry(file) {
  if (!fs.existsSync(file)) return
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const out = []
  let skipping = false
  for (const line of lines) {
    if (!skipping && /^\s*-\s*insert:\s*$/.test(line)) { skipping = true; continue }
    if (skipping) {
      // next top-level patch entry ends the insert block we own
      if (/^- /.test(line)) { skipping = false; out.push(line); continue }
      if (/^\s*$/.test(line)) { skipping = false; continue }
      continue // drop the mineru row lines
    }
    if (line.includes('installed by') && line.includes('mineru')) continue // our comment
    out.push(line)
  }
  fs.writeFileSync(file, out.join('\n').trimEnd() + '\n', 'utf8')
}

function ensureLink(link, target) {
  try { fs.lstatSync(link) } catch (e) {
    if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction')
    else fs.symlinkSync(target, link, 'dir')
    return true
  }
  // Exists: re-point it when the target moved (e.g. mirror path changed).
  try {
    const current = fs.realpathSync(link)
    const wanted = fs.realpathSync(target)
    if (path.resolve(current).toLowerCase() !== path.resolve(wanted).toLowerCase()) {
      removeLink(link)
      if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction')
      else fs.symlinkSync(target, link, 'dir')
      return true
    }
  } catch (e) {
    removeLink(link)
    if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction')
    else fs.symlinkSync(target, link, 'dir')
    return true
  }
  return false
}

function removeLink(link) {
  try { fs.lstatSync(link) } catch (e) { return }
  fs.rmSync(link, { recursive: true, force: true })
}

function main() {
  const args = process.argv.slice(2)
  const cmd = args.find((a) => ['install', 'uninstall', 'status'].includes(a)) || 'install'
  const installDirIdx = args.indexOf('--install-dir')
  const installDir = installDirIdx !== -1 ? args[installDirIdx + 1] : null
  const dataDirIdx = args.indexOf('--data-dir')
  const dataDirFlag = dataDirIdx !== -1 ? args[dataDirIdx + 1] : null
  const purge = args.includes('--purge')
  const root = packageRoot()

  // Data directory default = the plugin's install location: the repo itself
  // when installed from a checkout (git), otherwise the stable mirror.
  function defaultDataDir() {
    if (dataDirFlag) return path.resolve(dataDirFlag)
    if (fs.existsSync(path.join(root, '.git'))) return root
    return mirrorDir()
  }

  if (!fs.existsSync(path.join(root, 'packages', ROW_DIR, 'index.js'))) {
    fail(`package layout not found under ${root} (expected packages/mineru-plugin/)`)
  }

  if (cmd === 'status') {
    log('status', `package root: ${root}`)
    const mirror = mirrorDir()
    log('status', `mirror: ${mirror} ${fs.existsSync(mirror) ? '(present)' : '(absent)'}`)
    const roots = candidateRoots(installDir)
    for (const r of roots) {
      const link = path.join(r, ROW_DIR)
      log('status', `junction: ${link} ${fs.existsSync(link) ? '(present)' : '(absent)'}`)
    }
    if (roots.length === 0) log('status', 'no DSH resolution root detected (pass --install-dir)')
    for (const f of patchFiles()) {
      log('status', `patch: ${f} ${fs.readFileSync(f, 'utf8').includes('mineru-plugin') ? '(has entry)' : '(no entry)'}`)
    }
    return
  }

  const roots = candidateRoots(installDir)
  if (roots.length === 0) {
    fail('no DSH install detected (no node_modules with @deepseek-ai). Pass --install-dir.')
  }

  if (cmd === 'uninstall') {
    for (const f of patchFiles()) { removePatchEntry(f); log('uninstall', `patch entry removed: ${f}`) }
    for (const r of roots) {
      removeLink(path.join(r, ROW_DIR))
      log('uninstall', `junction removed: ${path.join(r, ROW_DIR)}`)
    }
    if (purge) {
      const m = mirrorDir()
      if (fs.existsSync(m)) { fs.rmSync(m, { recursive: true, force: true }); log('uninstall', `mirror removed: ${m}`) }
    }
    log('uninstall', 'done')
    return
  }

  // install
  const mirrorPath = mirror()
  log('install', `mirrored package to ${mirrorPath}`)
  for (const r of roots) {
    const link = path.join(r, ROW_DIR)
    const created = ensureLink(link, path.join(mirrorPath, 'packages', ROW_DIR))
    log('install', `${created ? 'junction created' : 'junction present'}: ${link}`)
  }
  const dataPath = defaultDataDir()
  fs.mkdirSync(dataPath, { recursive: true })
  const patchCount = patchFiles().length
  for (const f of patchFiles()) {
    const result = addPatchEntry(f, mirrorPath, dataPath)
    log('install', `patch entry ${result}: ${f}`)
  }
  if (patchCount === 0) log('install', 'WARN: no profile patch file found (cordis.patch.yml)')
  log('install', `data directory (uploads/outputs): ${dataPath}`)
  log('install', 'done. Restart DSH once; the plugin then loads globally for every session.')
  console.log('  Tools appear in new sessions immediately after restart; the browser panel needs the restart + page refresh.')
  console.log('  Uninstall: mineru-dsh-plugin uninstall [--purge]')
}

main()
