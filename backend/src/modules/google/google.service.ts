import { google } from 'googleapis'
import type { ConnectedAccount, ProviderConfig } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

const googleDriveFolderMimeType = 'application/vnd.google-apps.folder'
const appFolderName = '9drive'

export function createOAuthClient(config: ProviderConfig) {
  return new google.auth.OAuth2(decryptText(config.clientIdEncrypted), decryptText(config.clientSecretEncrypted), config.redirectUri)
}

export async function getAuthedGoogleClient(account: ConnectedAccount) {
  if (!account.accessTokenEncrypted || !account.refreshTokenEncrypted || !account.tokenExpiresAt) throw new Error('Google account tokens are missing.')
  if (!account.providerConfigId) throw new Error('Google provider config is missing.')
  const config = await prisma.providerConfig.findUniqueOrThrow({ where: { id: account.providerConfigId } })
  const client = createOAuthClient(config)
  client.setCredentials({
    access_token: decryptText(account.accessTokenEncrypted),
    refresh_token: decryptText(account.refreshTokenEncrypted),
    expiry_date: account.tokenExpiresAt.getTime(),
  })

  if (account.tokenExpiresAt.getTime() < Date.now() + 60_000) {
    const result = await client.refreshAccessToken()
    const credentials = result.credentials
    if (credentials.access_token) {
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          accessTokenEncrypted: encryptText(credentials.access_token),
          tokenExpiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600_000),
        },
      })
      client.setCredentials(credentials)
    }
  }

  return client
}

export async function syncGoogleQuota(accountId: string) {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId } })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const about = await drive.about.get({ fields: 'storageQuota,user' })
  const quota = about.data.storageQuota
  const total = quota?.limit ? BigInt(quota.limit) : null
  const used = quota?.usage ? BigInt(quota.usage) : 0n
  return prisma.storageAccount.upsert({
    where: { connectedAccountId: accountId },
    create: {
      connectedAccountId: accountId,
      totalBytes: total,
      usedBytes: used,
      availableBytes: total === null ? null : total - used,
      trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
      lastSyncedAt: new Date(),
    },
    update: {
      totalBytes: total,
      usedBytes: used,
      availableBytes: total === null ? null : total - used,
      trashBytes: quota?.usageInDriveTrash ? BigInt(quota.usageInDriveTrash) : null,
      lastSyncedAt: new Date(),
    },
  })
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function ensureGoogleAppFolder(account: ConnectedAccount) {
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const queryName = escapeDriveQueryValue(appFolderName)
  const existing = await drive.files.list({
    q: `name = '${queryName}' and mimeType = '${googleDriveFolderMimeType}' and 'root' in parents and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 1,
  })
  const folderId = existing.data.files?.[0]?.id ?? (await drive.files.create({
    requestBody: { name: appFolderName, mimeType: googleDriveFolderMimeType, parents: ['root'] },
    fields: 'id',
  })).data.id

  if (!folderId) throw new Error('Failed to create Google Drive app folder.')
  return folderId
}

export type GoogleAppFolderSyncResult = {
  accountId: string
  created: number
  updated: number
  deleted: number
}

type DriveFileMetadata = {
  id: string
  name: string
  mimeType: string
  sizeBytes: bigint
  parentId: string
}

export async function syncGoogleAppFolderFiles(accountId: string, userId: string): Promise<GoogleAppFolderSyncResult> {
  const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId, provider: 'google_drive', status: 'connected' } })
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const appFolderId = await ensureGoogleAppFolder(account)

  const userFolders = await prisma.folder.findMany({
    where: { userId, connectedAccountId: account.id, deletedAt: null, isExternal: false },
    select: { id: true, providerFolderId: true }
  })
  const parentIds = [
    appFolderId,
    ...userFolders.map((f) => f.providerFolderId).filter((id): id is string => !!id)
  ]

  const driveFiles: DriveFileMetadata[] = []
  let pageToken: string | undefined

  const parentsQuery = parentIds.map((id) => `'${id}' in parents`).join(' or ')
  const q = `(${parentsQuery}) and mimeType != '${googleDriveFolderMimeType}' and trashed = false`

  do {
    const response = await drive.files.list({
      q,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType,size,parents)',
      pageSize: 1000,
      pageToken,
    })
    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name || !file.mimeType) continue
      const parentId = file.parents?.[0] ?? appFolderId
      driveFiles.push({ id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: BigInt(file.size ?? 0), parentId })
    }
    pageToken = response.data.nextPageToken ?? undefined
  } while (pageToken)

  const existingFiles = await prisma.file.findMany({ where: { userId, connectedAccountId: account.id, provider: 'google_drive' } })
  const existingByProviderId = new Map(existingFiles.map((file) => [file.providerFileId, file]))
  const driveFileIds = new Set(driveFiles.map((file) => file.id))
  let created = 0
  let updated = 0
  let deleted = 0

  const folderIdMap = new Map(userFolders.map((f) => [f.providerFolderId, f.id]))

  for (const driveFile of driveFiles) {
    const dbFolderId = driveFile.parentId === appFolderId ? null : (folderIdMap.get(driveFile.parentId) ?? null)
    const existing = existingByProviderId.get(driveFile.id)
    if (!existing) {
      await prisma.file.create({
        data: { userId, connectedAccountId: account.id, provider: 'google_drive', providerFileId: driveFile.id, name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, status: 'active', folderId: dbFolderId },
      })
      created += 1
      continue
    }

    // Files moved in Google Drive from outside into the 9drive tree become app-managed (no row is deleted, shares are kept).
    const needsUpdate = existing.isExternal || existing.name !== driveFile.name || existing.mimeType !== driveFile.mimeType || existing.sizeBytes !== driveFile.sizeBytes || existing.status !== 'active' || existing.deletedAt !== null || existing.folderId !== dbFolderId
    if (needsUpdate) {
      await prisma.file.update({
        where: { id: existing.id },
        data: { name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, status: 'active', deletedAt: null, folderId: dbFolderId, isExternal: false },
      })
      updated += 1
    }
  }

  // External (full_drive) files are reconciled only by syncGoogleExternalFiles; never touch them here.
  const missingActiveIds = existingFiles.filter((file) => !file.isExternal && file.status === 'active' && !driveFileIds.has(file.providerFileId)).map((file) => file.id)
  if (missingActiveIds.length > 0) {
    const result = await prisma.file.updateMany({ where: { id: { in: missingActiveIds }, userId }, data: { status: 'deleted', deletedAt: new Date() } })
    deleted = result.count
  }

  await syncGoogleQuota(account.id).catch(() => undefined)
  return { accountId: account.id, created, updated, deleted }
}

// ---------------------------------------------------------------------------
// Account access scope (app_folder | full_drive)
// ---------------------------------------------------------------------------

export const accessScopes = ['app_folder', 'full_drive'] as const
export type AccessScope = (typeof accessScopes)[number]

export function isFullDriveAccount(account: Pick<ConnectedAccount, 'accessScope'>) {
  return account.accessScope === 'full_drive'
}

/** Google parent used when an item has no app parent folder. External items live in Drive root; app items in `9drive`. */
export async function getGoogleRootParentId(account: ConnectedAccount, isExternal: boolean) {
  return isExternal ? 'root' : ensureGoogleAppFolder(account)
}

/**
 * Removes an item from Google Drive. External (full_drive) items are only moved to the Google trash
 * so the user can recover them from Google Drive; app-managed items keep the previous permanent delete.
 */
export async function removeGoogleDriveItem(account: ConnectedAccount, providerId: string, isExternal: boolean) {
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  if (isExternal) {
    await drive.files.update({ fileId: providerId, requestBody: { trashed: true } })
    return
  }
  try {
    await drive.files.delete({ fileId: providerId })
  } catch {
    await drive.files.update({ fileId: providerId, requestBody: { trashed: true } })
  }
}

export type AccessScopeChangeResult = {
  accessScope: AccessScope
  hiddenFiles: number
  hiddenFolders: number
  restoredFiles: number
  restoredFolders: number
  syncRecommended: boolean
}

/**
 * Changes the access scope of a Google account. This NEVER deletes anything (MySQL rows or Google Drive items):
 * - to app_folder: external items are only hidden (files status 'hidden', folders hiddenAt set);
 * - to full_drive: hidden external items are shown again. If external items already exist, a sync is recommended
 *   so files removed directly in Google Drive can be detected.
 */
export async function setAccountAccessScope(accountId: string, userId: string, accessScope: AccessScope): Promise<AccessScopeChangeResult> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId, provider: 'google_drive', status: 'connected' } })
    const result: AccessScopeChangeResult = { accessScope, hiddenFiles: 0, hiddenFolders: 0, restoredFiles: 0, restoredFolders: 0, syncRecommended: false }

    if (accessScope === 'app_folder') {
      result.hiddenFiles = (await tx.file.updateMany({ where: { userId, connectedAccountId: account.id, isExternal: true, status: 'active' }, data: { status: 'hidden' } })).count
      result.hiddenFolders = (await tx.folder.updateMany({ where: { userId, connectedAccountId: account.id, isExternal: true, hiddenAt: null }, data: { hiddenAt: new Date() } })).count
    } else {
      result.restoredFiles = (await tx.file.updateMany({ where: { userId, connectedAccountId: account.id, isExternal: true, status: 'hidden' }, data: { status: 'active' } })).count
      result.restoredFolders = (await tx.folder.updateMany({ where: { userId, connectedAccountId: account.id, isExternal: true, hiddenAt: { not: null } }, data: { hiddenAt: null } })).count
      const externalFiles = await tx.file.count({ where: { userId, connectedAccountId: account.id, isExternal: true } })
      const externalFolders = await tx.folder.count({ where: { userId, connectedAccountId: account.id, isExternal: true } })
      result.syncRecommended = externalFiles + externalFolders > 0
    }

    await tx.connectedAccount.update({ where: { id: account.id }, data: { accessScope } })
    return result
  })
}

type DriveListItem = { id: string; name: string; mimeType: string; sizeBytes: bigint; parentId: string | null }

async function listOwnedDriveItems(drive: ReturnType<typeof google.drive>, foldersOnly: boolean) {
  const items: DriveListItem[] = []
  const mimeFilter = foldersOnly ? `mimeType = '${googleDriveFolderMimeType}'` : `mimeType != '${googleDriveFolderMimeType}'`
  let pageToken: string | undefined
  do {
    const response = await drive.files.list({
      // "Shared with me" items are intentionally ignored for now.
      q: `${mimeFilter} and trashed = false and 'me' in owners`,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType,size,parents)',
      pageSize: 1000,
      pageToken,
    })
    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name || !file.mimeType) continue
      items.push({ id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: BigInt(file.size ?? 0), parentId: file.parents?.[0] ?? null })
    }
    pageToken = response.data.nextPageToken ?? undefined
  } while (pageToken)
  return items
}

/**
 * Imports/reconciles every owned Google Drive file and folder outside the `9drive` tree as external rows.
 * Items missing from Drive are soft-deleted only (files status 'deleted', folders deletedAt) and stay recoverable.
 */
async function syncGoogleExternalItems(account: ConnectedAccount, userId: string) {
  const auth = await getAuthedGoogleClient(account)
  const drive = google.drive({ version: 'v3', auth })
  const appFolderId = await ensureGoogleAppFolder(account)
  const rootId = (await drive.files.get({ fileId: 'root', fields: 'id' })).data.id ?? 'root'

  const driveFolders = await listOwnedDriveItems(drive, true)
  const driveFiles = await listOwnedDriveItems(drive, false)
  const driveFolderById = new Map(driveFolders.map((folder) => [folder.id, folder]))

  // Folders inside (or equal to) 9drive are managed by the app-folder sync.
  const insideAppTree = new Map<string, boolean>()
  const isInsideAppTree = (folderId: string | null): boolean => {
    const visited: string[] = []
    let current = folderId
    let inside = false
    while (current) {
      if (current === appFolderId) { inside = true; break }
      const cached = insideAppTree.get(current)
      if (cached !== undefined) { inside = cached; break }
      if (visited.includes(current)) break
      visited.push(current)
      current = driveFolderById.get(current)?.parentId ?? null
    }
    for (const id of visited) insideAppTree.set(id, inside)
    return inside
  }

  const dbFolders = await prisma.folder.findMany({ where: { userId, connectedAccountId: account.id, providerFolderId: { not: null } } })
  const appManagedFolderIds = new Set(dbFolders.filter((folder) => !folder.isExternal).map((folder) => folder.providerFolderId!))
  const externalFolderByProviderId = new Map(dbFolders.filter((folder) => folder.isExternal).map((folder) => [folder.providerFolderId!, folder]))
  const dbIdByProviderFolderId = new Map(dbFolders.filter((folder) => folder.deletedAt === null).map((folder) => [folder.providerFolderId!, folder.id]))

  let created = 0
  let updated = 0
  let deleted = 0

  // Pass 1: create/refresh external folders (parent resolved in pass 2).
  const externalDriveFolders = driveFolders.filter((folder) => folder.id !== appFolderId && !appManagedFolderIds.has(folder.id) && !isInsideAppTree(folder.id))
  for (const driveFolder of externalDriveFolders) {
    const existing = externalFolderByProviderId.get(driveFolder.id)
    if (!existing) {
      const createdFolder = await prisma.folder.create({
        data: { userId, connectedAccountId: account.id, provider: 'google_drive', providerFolderId: driveFolder.id, name: driveFolder.name, isExternal: true },
      })
      dbIdByProviderFolderId.set(driveFolder.id, createdFolder.id)
      created += 1
      continue
    }
    dbIdByProviderFolderId.set(driveFolder.id, existing.id)
    if (existing.name !== driveFolder.name || existing.deletedAt !== null || existing.hiddenAt !== null) {
      await prisma.folder.update({ where: { id: existing.id }, data: { name: driveFolder.name, deletedAt: null, hiddenAt: null } })
      updated += 1
    }
  }

  const resolveParent = (parentId: string | null) => (!parentId || parentId === rootId ? null : dbIdByProviderFolderId.get(parentId) ?? null)

  // Pass 2: parents.
  for (const driveFolder of externalDriveFolders) {
    const dbId = dbIdByProviderFolderId.get(driveFolder.id)
    if (!dbId) continue
    const parentId = resolveParent(driveFolder.parentId)
    const existing = externalFolderByProviderId.get(driveFolder.id)
    if (existing && existing.parentId === parentId) continue
    await prisma.folder.update({ where: { id: dbId }, data: { parentId: parentId === dbId ? null : parentId } })
  }

  const listedExternalFolderIds = new Set(externalDriveFolders.map((folder) => folder.id))
  const missingFolderIds = dbFolders.filter((folder) => folder.isExternal && folder.deletedAt === null && !listedExternalFolderIds.has(folder.providerFolderId!)).map((folder) => folder.id)
  if (missingFolderIds.length > 0) {
    deleted += (await prisma.folder.updateMany({ where: { id: { in: missingFolderIds }, userId }, data: { deletedAt: new Date() } })).count
  }

  // Files
  const dbFiles = await prisma.file.findMany({ where: { userId, connectedAccountId: account.id, provider: 'google_drive' } })
  const appManagedFileIds = new Set(dbFiles.filter((file) => !file.isExternal).map((file) => file.providerFileId))
  const externalFileByProviderId = new Map(dbFiles.filter((file) => file.isExternal).map((file) => [file.providerFileId, file]))
  const externalDriveFiles = driveFiles.filter((file) => !appManagedFileIds.has(file.id) && file.parentId !== appFolderId && !isInsideAppTree(file.parentId))

  const toCreate: Array<{ userId: string; connectedAccountId: string; provider: string; providerFileId: string; name: string; mimeType: string; sizeBytes: bigint; status: string; folderId: string | null; isExternal: boolean }> = []
  for (const driveFile of externalDriveFiles) {
    const folderId = resolveParent(driveFile.parentId)
    const existing = externalFileByProviderId.get(driveFile.id)
    if (!existing) {
      toCreate.push({ userId, connectedAccountId: account.id, provider: 'google_drive', providerFileId: driveFile.id, name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, status: 'active', folderId, isExternal: true })
      continue
    }
    // Files trashed inside the app (status 'deleted') are not resurrected; they can be restored from the app trash.
    const nextStatus = existing.status === 'hidden' ? 'active' : existing.status
    if (existing.name !== driveFile.name || existing.mimeType !== driveFile.mimeType || existing.sizeBytes !== driveFile.sizeBytes || existing.folderId !== folderId || existing.status !== nextStatus) {
      await prisma.file.update({ where: { id: existing.id }, data: { name: driveFile.name, mimeType: driveFile.mimeType, sizeBytes: driveFile.sizeBytes, folderId, status: nextStatus } })
      updated += 1
    }
  }
  for (let index = 0; index < toCreate.length; index += 500) {
    created += (await prisma.file.createMany({ data: toCreate.slice(index, index + 500) })).count
  }

  const listedExternalFileIds = new Set(externalDriveFiles.map((file) => file.id))
  const missingFileIds = dbFiles.filter((file) => file.isExternal && file.status === 'active' && !listedExternalFileIds.has(file.providerFileId)).map((file) => file.id)
  if (missingFileIds.length > 0) {
    deleted += (await prisma.file.updateMany({ where: { id: { in: missingFileIds }, userId }, data: { status: 'deleted', deletedAt: new Date() } })).count
  }

  return { created, updated, deleted }
}

/** Syncs one Google account according to its access scope. Response shape is the same for both scopes. */
export async function syncGoogleAccount(accountId: string, userId: string): Promise<GoogleAppFolderSyncResult> {
  const appResult = await syncGoogleAppFolderFiles(accountId, userId)
  const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId, provider: 'google_drive', status: 'connected' } })
  if (!isFullDriveAccount(account)) return appResult

  const external = await syncGoogleExternalItems(account, userId)
  return {
    accountId,
    created: appResult.created + external.created,
    updated: appResult.updated + external.updated,
    deleted: appResult.deleted + external.deleted,
  }
}
