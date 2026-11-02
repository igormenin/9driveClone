import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { ConnectedAccount, File, Folder } from '@prisma/client'
import { google } from 'googleapis'
import { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import { getAuthedGoogleClient, getGoogleRootParentId, removeGoogleDriveItem, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, createS3Client, deleteS3Object, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { normalizeHeaders } from './stream-google-file.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }

export class TransferError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
  }
}

/** Google-native files (Docs, Sheets...) have no binary content and cannot be copied byte-for-byte between accounts. */
function isGoogleNativeFile(file: Pick<File, 'mimeType'>) {
  return file.mimeType.startsWith('application/vnd.google-apps.')
}

async function syncQuota(account: Pick<ConnectedAccount, 'id' | 'provider'>) {
  if (account.provider === 's3') await syncS3Quota(account.id).catch(() => undefined)
  else await syncGoogleQuota(account.id).catch(() => undefined)
}

async function openSourceStream(file: FileWithAccount): Promise<Readable> {
  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId)
    const response = await createS3Client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
    if (!response.Body) throw new TransferError('TRANSFER_SOURCE_UNAVAILABLE', `Could not read "${file.name}" from source storage.`)
    return response.Body as Readable
  }
  const auth = await getAuthedGoogleClient(file.connectedAccount)
  const headers = normalizeHeaders(await auth.getRequestHeaders())
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`, { headers })
  if (!response.ok || !response.body) throw new TransferError('TRANSFER_SOURCE_UNAVAILABLE', `Could not read "${file.name}" from source Google Drive (${response.status}).`)
  return Readable.fromWeb(response.body as any)
}

/** Streams the content to the target account (memory only, never disk) and returns the new provider id. */
async function uploadToTarget(file: FileWithAccount, target: ConnectedAccount, targetFolder: Folder | null, body: Readable) {
  if (target.provider === 's3') {
    const config = await getS3ConfigForAccount(target.id, file.userId)
    const key = buildS3ObjectKey(config, file.userId, file.id, file.name)
    await uploadS3Object(config, key, body, file.mimeType)
    return key
  }
  const auth = await getAuthedGoogleClient(target)
  const drive = google.drive({ version: 'v3', auth })
  const parentId = targetFolder?.providerFolderId ?? await getGoogleRootParentId(target, targetFolder?.isExternal ?? false)
  const uploaded = await drive.files.create({
    requestBody: { name: file.name, parents: [parentId] },
    media: { mimeType: file.mimeType, body },
    fields: 'id',
  })
  if (!uploaded.data.id) throw new TransferError('TRANSFER_UPLOAD_FAILED', `Target Google Drive did not return an id for "${file.name}".`)
  return uploaded.data.id
}

async function removeFromTarget(target: ConnectedAccount, providerId: string) {
  try {
    if (target.provider === 's3') await deleteS3Object({ connectedAccountId: target.id, providerFileId: providerId } as FileWithAccount)
    else await removeGoogleDriveItem(target, providerId, false)
  } catch {
    // best-effort rollback of a partial copy
  }
}

export type TransferResult = { transferred: string[]; failed: Array<{ fileId: string; name?: string; code: string; message: string }> }

/**
 * Transfers files to another connected account. For each file: copy to target, update the DB row,
 * and only then remove from source. If anything fails before the DB update, the source is untouched.
 */
export async function transferFiles(userId: string, fileIds: string[], targetAccountId: string, targetFolderId: string | null): Promise<TransferResult> {
  const target = await prisma.connectedAccount.findFirst({ where: { id: targetAccountId, userId, status: 'connected' }, include: { storageAccount: true } })
  if (!target) throw new TransferError('TARGET_ACCOUNT_NOT_FOUND', 'Target storage account not found.', 404)

  let targetFolder: Folder | null = null
  if (targetFolderId) {
    targetFolder = await prisma.folder.findFirst({ where: { id: targetFolderId, userId, deletedAt: null, hiddenAt: null } })
    if (!targetFolder) throw new TransferError('TARGET_FOLDER_NOT_FOUND', 'Target folder not found.', 404)
    if (targetFolder.connectedAccountId !== target.id) throw new TransferError('TARGET_FOLDER_ACCOUNT_MISMATCH', 'Target folder belongs to a different storage account.')
  }

  const files = await prisma.file.findMany({ where: { id: { in: fileIds }, userId, status: 'active' }, include: { connectedAccount: true } })
  const result: TransferResult = { transferred: [], failed: [] }
  for (const id of fileIds) if (!files.some((file) => file.id === id)) result.failed.push({ fileId: id, code: 'FILE_NOT_FOUND', message: 'File not found.' })

  const toTransfer = files.filter((file) => {
    if (file.connectedAccountId === target.id) {
      result.failed.push({ fileId: file.id, name: file.name, code: 'SAME_ACCOUNT', message: 'File already belongs to the target account. Use move instead.' })
      return false
    }
    if (isGoogleNativeFile(file)) {
      result.failed.push({ fileId: file.id, name: file.name, code: 'NATIVE_GOOGLE_FILE', message: 'Google Docs/Sheets/Slides cannot be transferred between accounts.' })
      return false
    }
    return true
  })

  const totalBytes = toTransfer.reduce((sum, file) => sum + file.sizeBytes, 0n)
  const available = target.storageAccount?.availableBytes
  if (available !== null && available !== undefined && totalBytes > available) {
    throw new TransferError('TARGET_INSUFFICIENT_SPACE', 'Target account does not have enough free space for the selected files.')
  }

  const sourceAccounts = new Map<string, ConnectedAccount>()
  for (const file of toTransfer) {
    let newProviderId: string | null = null
    try {
      const body = await openSourceStream(file)
      newProviderId = await uploadToTarget(file, target, targetFolder, body)
      await prisma.file.update({
        where: { id: file.id },
        data: { connectedAccountId: target.id, provider: target.provider, providerFileId: newProviderId, folderId: targetFolder?.id ?? null, isExternal: targetFolder?.isExternal ?? false },
      })
    } catch (error) {
      if (newProviderId) await removeFromTarget(target, newProviderId)
      result.failed.push({ fileId: file.id, name: file.name, code: error instanceof TransferError ? error.code : 'TRANSFER_FAILED', message: error instanceof Error ? error.message : 'Transfer failed.' })
      continue
    }

    // Copy is committed; removing the source is best-effort (a leftover copy never loses data).
    try {
      if (file.provider === 's3') await deleteS3Object(file)
      else await removeGoogleDriveItem(file.connectedAccount, file.providerFileId, file.isExternal)
    } catch (error) {
      console.error('[transfer] source cleanup failed', { fileId: file.id, message: error instanceof Error ? error.message : 'unknown' })
    }
    sourceAccounts.set(file.connectedAccountId, file.connectedAccount)
    result.transferred.push(file.id)
    await createAuditLog(userId, 'TRANSFER_FILE', 'file', file.id, { name: file.name, from: file.connectedAccount.email, to: target.email, size: file.sizeBytes.toString() })
  }

  for (const account of sourceAccounts.values()) await syncQuota(account)
  if (result.transferred.length > 0) await syncQuota(target)
  return result
}

/** Mirrors an in-app folder move in Google Drive (same account only). Best-effort: logical move is always kept. */
export async function moveGoogleFileParent(file: FileWithAccount, folderId: string | null) {
  if (file.provider !== 'google_drive') return
  try {
    const folder = folderId ? await prisma.folder.findFirst({ where: { id: folderId, userId: file.userId } }) : null
    if (folder && folder.connectedAccountId && folder.connectedAccountId !== file.connectedAccountId) return
    const newParentId = folder?.providerFolderId ?? await getGoogleRootParentId(file.connectedAccount, file.isExternal)
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    const current = await drive.files.get({ fileId: file.providerFileId, fields: 'parents' })
    const previous = (current.data.parents ?? []).filter((id) => id !== newParentId)
    if (previous.length === 0 && (current.data.parents ?? []).includes(newParentId)) return
    await drive.files.update({ fileId: file.providerFileId, addParents: newParentId, removeParents: previous.join(',') || undefined, fields: 'id' })
  } catch (error) {
    console.error('[move] google parent update failed', { fileId: file.id, message: error instanceof Error ? error.message : 'unknown' })
  }
}
