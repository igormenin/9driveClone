import {
  Folder,
  FolderOpen,
  Folders,
  Files,
  FileText,
  FileImage,
  FileVideo,
  FileMusic,
  FileCode,
  FileArchive,
  Briefcase,
  Archive,
  Cloud,
  CloudUpload,
  CloudDownload,
  HardDrive,
  Database,
  Server,
  Image,
  Images,
  Video,
  Film,
  Music,
  Headphones,
  Code,
  Terminal,
  Package,
  Box,
  BookOpen,
  Notebook,
  GraduationCap,
  Receipt,
  Wallet,
  ChartColumn,
  Calendar,
  Clock,
  Users,
  UserCheck,
  Share2,
  Lock,
  Shield,
  Star,
  Heart,
  Rocket,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FolderItem } from '@/data/drive-data'

const legacyColorMap: Record<string, string> = {
  'text-blue-500': '#3b82f6',
  'text-lime-500': '#84cc16',
  'text-cyan-400': '#22d3ee',
  'text-yellow-400': '#facc15',
  'text-orange-500': '#f97316',
}

export const defaultFolderColor = '#3b82f6'
export const defaultFolderIconName = 'folder'
export const defaultFolderIconUrl = defaultFolderIconName

export const folderIconComponents: Record<string, LucideIcon> = {
  'folder': Folder,
  'folder-open': FolderOpen,
  'folders': Folders,
  'files': Files,
  'file-text': FileText,
  'file-image': FileImage,
  'file-video': FileVideo,
  'file-music': FileMusic,
  'file-code': FileCode,
  'file-archive': FileArchive,
  'briefcase': Briefcase,
  'archive': Archive,
  'cloud': Cloud,
  'cloud-upload': CloudUpload,
  'cloud-download': CloudDownload,
  'hard-drive': HardDrive,
  'database': Database,
  'server': Server,
  'image': Image,
  'images': Images,
  'video': Video,
  'film': Film,
  'music': Music,
  'headphones': Headphones,
  'code': Code,
  'terminal': Terminal,
  'package': Package,
  'box': Box,
  'book-open': BookOpen,
  'notebook': Notebook,
  'graduation-cap': GraduationCap,
  'receipt': Receipt,
  'wallet': Wallet,
  'chart-column': ChartColumn,
  'calendar': Calendar,
  'clock': Clock,
  'users': Users,
  'user-check': UserCheck,
  'share-2': Share2,
  'lock': Lock,
  'shield': Shield,
  'star': Star,
  'heart': Heart,
  'rocket': Rocket,
  'sparkles': Sparkles,
}

export const folderIconOptions = [
  { label: 'Folder', key: 'folder' },
  { label: 'Folder Open', key: 'folder-open' },
  { label: 'Folders', key: 'folders' },
  { label: 'Files', key: 'files' },
  { label: 'File Text', key: 'file-text' },
  { label: 'File Image', key: 'file-image' },
  { label: 'File Video', key: 'file-video' },
  { label: 'File Music', key: 'file-music' },
  { label: 'File Code', key: 'file-code' },
  { label: 'File Archive', key: 'file-archive' },
  { label: 'Briefcase', key: 'briefcase' },
  { label: 'Archive', key: 'archive' },
  { label: 'Cloud', key: 'cloud' },
  { label: 'Cloud Upload', key: 'cloud-upload' },
  { label: 'Cloud Download', key: 'cloud-download' },
  { label: 'Hard Drive', key: 'hard-drive' },
  { label: 'Database', key: 'database' },
  { label: 'Server', key: 'server' },
  { label: 'Image', key: 'image' },
  { label: 'Images', key: 'images' },
  { label: 'Video', key: 'video' },
  { label: 'Film', key: 'film' },
  { label: 'Music', key: 'music' },
  { label: 'Headphones', key: 'headphones' },
  { label: 'Code', key: 'code' },
  { label: 'Terminal', key: 'terminal' },
  { label: 'Package', key: 'package' },
  { label: 'Box', key: 'box' },
  { label: 'Book Open', key: 'book-open' },
  { label: 'Notebook', key: 'notebook' },
  { label: 'Graduation Cap', key: 'graduation-cap' },
  { label: 'Receipt', key: 'receipt' },
  { label: 'Wallet', key: 'wallet' },
  { label: 'Chart', key: 'chart-column' },
  { label: 'Calendar', key: 'calendar' },
  { label: 'Clock', key: 'clock' },
  { label: 'Users', key: 'users' },
  { label: 'User Check', key: 'user-check' },
  { label: 'Share', key: 'share-2' },
  { label: 'Lock', key: 'lock' },
  { label: 'Shield', key: 'shield' },
  { label: 'Star', key: 'star' },
  { label: 'Heart', key: 'heart' },
  { label: 'Rocket', key: 'rocket' },
  { label: 'Sparkles', key: 'sparkles' },
].map((item) => ({ ...item, url: item.key }))

export const folderColorOptions = ['#3b82f6', '#84cc16', '#22d3ee', '#facc15', '#f97316', '#ef4444', '#a855f7', '#14b8a6']

export function normalizeFolderColor(color?: string | null) {
  if (color?.startsWith('#')) return color
  return legacyColorMap[color ?? ''] ?? defaultFolderColor
}

export function parseFolderIconKey(iconUrl?: string | null): string {
  if (!iconUrl) return 'folder'
  // If it's a direct icon key, e.g. "folder-open"
  if (folderIconComponents[iconUrl]) return iconUrl
  // If it's an Iconify URL like "https://api.iconify.design/lucide/folder-open.svg" or "lucide:folder-open.svg"
  const match = iconUrl.match(/lucide[:/]([a-z0-9-]+)\.svg/i)
  if (match && match[1] && folderIconComponents[match[1]]) {
    return match[1]
  }
  return 'folder'
}

export function FolderVisual({ folder, className, iconClassName }: { folder: Pick<FolderItem, 'color' | 'iconUrl'>; className?: string; iconClassName?: string }) {
  const color = normalizeFolderColor(folder.color)
  const iconKey = parseFolderIconKey(folder.iconUrl)
  const IconComponent = folderIconComponents[iconKey] || Folder

  return (
    <span className={cn('inline-flex items-center justify-center', className)}>
      <IconComponent
        className={cn('h-full w-full', iconClassName)}
        style={{ color }}
      />
    </span>
  )
}
