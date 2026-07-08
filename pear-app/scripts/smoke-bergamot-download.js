#!/usr/bin/env node
// Standalone Bergamot download smoke test.
//
// What it does (docs-first):
//   1. Hits GET http://localhost:3700/qvac/models expecting the F12 endpoint
//      to return the bergamot-en-it entry with a `vocabUrl` field (added in
//      today's registry patch).
//   2. Downloads model.enit.intgemm.alphas.bin.gz and vocab.enit.spm.gz from
//      Mozilla's production storage bucket.
//   3. Runs `translate.js`'s `downloadAndVerify` on both, which internally
//      calls `maybeGunzip` before writing to disk. The write path is the
//      exact path used by createTranslator() at boot in the pear-app.
//   4. Asserts the SHA-256 of the inflated model bytes matches Mozilla's
//      `uncompressedHash` (encoded in our qvac-models.json notes so we know
//      inflation completed cleanly).
//   5. Prints file sizes so we can eyeball ratios; leaves output under
//      `./.smoke-bergamot/`.
//
// Runs under plain Node with `bare-zlib` remapped to Node's `zlib` via the
// _tryRequire fallback in translate.js. Nothing here talks to the SDK plugin;
// this smoke test only verifies download + inflate + digest are healthy.
//
// Usage: node pear-app/scripts/smoke-bergamot-download.js

'use strict'

const path = require('path')
const fs = require('fs')
const { _internal } = require('../bare/translate.js')

const OUT_DIR = path.resolve(__dirname, '..', '.smoke-bergamot')
const BACKEND_URL = process.env.CURVA_BACKEND_URL || 'http://localhost:3700'
const PAIR = 'bergamot-en-it'
const EXPECTED_UNCOMPRESSED = '248f47568788ecc351da7e5e07064d4153b4f71e011364ae2c931ffeec4d1cc2'

function log (msg, extra) {
  const line = extra ? `${msg}  ${JSON.stringify(extra)}` : msg
  console.log('[smoke]', line)
}

async function main () {
  // -- 1. Fetch catalog ----------------------------------------------------
  log('fetching catalog', { url: BACKEND_URL + '/qvac/models' })
  const resp = await fetch(BACKEND_URL + '/qvac/models').catch((err) => {
    throw new Error('backend fetch failed: ' + err.message)
  })
  if (!resp.ok) throw new Error('backend HTTP ' + resp.status)
  const catalog = await resp.json()
  const entry = (catalog?.data?.models || []).find((m) => m.id === PAIR)
  if (!entry) throw new Error('bergamot-en-it missing from catalog')
  if (!entry.downloadUrl) throw new Error('bergamot-en-it downloadUrl missing')
  if (!entry.vocabUrl) throw new Error('bergamot-en-it vocabUrl missing (registry patch not applied)')
  log('catalog entry ok', {
    downloadUrl: entry.downloadUrl.slice(-40),
    vocabUrl: entry.vocabUrl.slice(-40),
    size: entry.size
  })

  // -- 2. Prepare output dir ----------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const modelPath = path.join(OUT_DIR, PAIR)
  const vocabPath = modelPath + '.vocab.spm'
  for (const p of [modelPath, vocabPath]) {
    try { fs.unlinkSync(p) } catch { /* ignore */ }
  }

  // -- 3. Download + gunzip model -----------------------------------------
  log('downloading model')
  const startedModel = Date.now()
  await _internal.downloadAndVerify({
    url: entry.downloadUrl,
    destPath: modelPath,
    expectedDigest: EXPECTED_UNCOMPRESSED, // uncompressed sha256 per qvac-models.json notes
    expectedSize: null,
    fetchImpl: fetch,
    fsUse: fs,
    onProgress: (b, total) => {
      if (total > 0 && Math.random() < 0.1) {
        process.stderr.write('.')
      }
    }
  })
  process.stderr.write('\n')
  const modelStat = fs.statSync(modelPath)
  log('model landed', {
    bytes: modelStat.size,
    ms: Date.now() - startedModel
  })
  if (modelStat.size < 30_000_000) {
    throw new Error('inflated model looks too small: ' + modelStat.size)
  }

  // -- 4. Download + gunzip vocab -----------------------------------------
  log('downloading vocab')
  const startedVocab = Date.now()
  await _internal.downloadAndVerify({
    url: entry.vocabUrl,
    destPath: vocabPath,
    expectedDigest: null, // Mozilla doesn't publish an uncompressed vocab hash
    expectedSize: null,
    fetchImpl: fetch,
    fsUse: fs,
    onProgress: () => {}
  })
  const vocabStat = fs.statSync(vocabPath)
  log('vocab landed', {
    bytes: vocabStat.size,
    ms: Date.now() - startedVocab
  })
  if (vocabStat.size < 100_000) {
    throw new Error('inflated vocab looks too small: ' + vocabStat.size)
  }

  // -- 5. Post-condition summary ------------------------------------------
  const modelHead = fs.readFileSync(modelPath).slice(0, 4)
  log('model head bytes', {
    hex: Buffer.from(modelHead).toString('hex')
  })
  // Sentencepiece models start with a leading '\x00\x01' pattern; not fully
  // reliable across versions but a soft check we didn't accidentally leave a
  // gzip file on disk (which would start with 0x1f 0x8b).
  const vocabHead = fs.readFileSync(vocabPath).slice(0, 4)
  log('vocab head bytes', {
    hex: Buffer.from(vocabHead).toString('hex')
  })
  if (vocabHead[0] === 0x1f && vocabHead[1] === 0x8b) {
    throw new Error('vocab is still gzipped — maybeGunzip did not run')
  }
  if (modelHead[0] === 0x1f && modelHead[1] === 0x8b) {
    throw new Error('model is still gzipped — maybeGunzip did not run')
  }

  log('OK — smoke passed')
  log('artefacts', { model: modelPath, vocab: vocabPath })
}

main().catch((err) => {
  console.error('[smoke] FAIL', err.stack || err.message)
  process.exit(1)
})
