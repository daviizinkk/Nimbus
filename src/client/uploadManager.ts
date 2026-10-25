import type { ItemDTO, ItemKind } from '../../shared/types';
import {
  api,
  uploadFileBody,
  uploadPoster,
  type UploadInitResponse,
} from './api';

export type UploadPhase =
  | 'preparing'
  | 'uploading'
  | 'poster'
  | 'finishing'
  | 'processing'
  | 'done'
  | 'error'
  | 'cancelled';

export interface UploadTask {
  key: string;
  itemId: string | null;
  file: File;
  name: string;
  size: number;
  mime: string;
  kind: ItemKind;
  /** Files uploaded while browsing a folder remember their destination. */
  folderId: string | null;
  phase: UploadPhase;
  progress: number;
  error: string | null;
  completed: boolean;
  createdAt: number;
}

type Listener = () => void;

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'ogv', '3gp', 'mpeg', 'mpg', 'ts',
]);

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function guessMime(file: File): string {
  if (file.type) return file.type;
  const ext = extensionOf(file.name);
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    heic: 'image/heic',
    heif: 'image/heif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    pdf: 'application/pdf',
    zip: 'application/zip',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
  };
  return map[ext] ?? 'application/octet-stream';
}

function kindOf(file: File, mime: string): ItemKind {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(extensionOf(file.name))) return 'video';
  return 'file';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while uploading.';
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface VideoInfo {
  width: number | null;
  height: number | null;
  duration: number | null;
  poster: Blob | null;
}

/**
 * Reads video metadata and captures a lightweight JPEG poster from the first
 * moments of the clip. Poster generation is best-effort: a codec the browser
 * cannot decode still uploads normally, just without a thumbnail.
 */
function inspectVideo(file: File): Promise<VideoInfo> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    let poster: Blob | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      const info: VideoInfo = {
        width: video.videoWidth > 0 ? video.videoWidth : null,
        height: video.videoHeight > 0 ? video.videoHeight : null,
        duration:
          Number.isFinite(video.duration) && video.duration > 0
            ? Math.round(video.duration * 1000) / 1000
            : null,
        poster,
      };
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // Ignore.
      }
      URL.revokeObjectURL(url);
      resolve(info);
    };

    const timer = window.setTimeout(finish, 12_000);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onerror = finish;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const target = Math.min(Math.max(duration * 0.1, 0.1), 1.5);
      video.onseeked = () => {
        try {
          const maxWidth = 1280;
          const scale = video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
          const width = Math.max(1, Math.round(video.videoWidth * scale));
          const height = Math.max(1, Math.round(video.videoHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) {
            finish();
            return;
          }
          context.drawImage(video, 0, 0, width, height);
          canvas.toBlob(
            (blob) => {
              poster = blob;
              finish();
            },
            'image/jpeg',
            0.82,
          );
        } catch {
          finish();
        }
      };
      try {
        video.currentTime = target;
      } catch {
        finish();
      }
    };
    video.src = url;
    video.load();
  });
}

class UploadManager {
  private tasks: UploadTask[] = [];
  private snapshot: UploadTask[] = [];
  private listeners = new Set<Listener>();
  private running = new Set<string>();
  private controllers = new Map<string, AbortController>();
  private removalTimers = new Map<string, number>();
  private live = new Map<string, VideoInfo>();
  private progressAt = new Map<string, number>();
  private maxConcurrent = 2;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UploadTask[] => this.snapshot;

  addFiles(files: File[] | FileList, folderId: string | null = null): number {
    const list = Array.from(files);
    if (list.length === 0) return 0;
    let added = 0;
    for (const file of list) {
      const mime = guessMime(file);
      const kind = kindOf(file, mime);
      const task: UploadTask = {
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        itemId: null,
        file,
        name: file.name || 'Untitled',
        size: file.size,
        mime,
        kind,
        folderId: kind === 'file' ? folderId : null,
        phase: 'preparing',
        progress: 0,
        error: null,
        completed: false,
        createdAt: Date.now(),
      };
      this.tasks.push(task);
      added += 1;
    }
    this.emit();
    this.pump();
    return added;
  }

  dismiss(key: string): void {
    const task = this.tasks.find((entry) => entry.key === key);
    if (task && (task.phase === 'uploading' || task.phase === 'preparing' || task.phase === 'finishing')) return;
    this.remove(key);
  }

  dismissFinished(): void {
    this.tasks = this.tasks.filter((task) => task.phase !== 'done' && task.phase !== 'cancelled');
    this.emit();
  }

  async cancel(key: string): Promise<void> {
    const task = this.tasks.find((entry) => entry.key === key);
    if (!task) return;
    if (task.phase === 'done' || task.phase === 'error' || task.phase === 'cancelled') {
      this.remove(key);
      return;
    }
    this.patch(key, { phase: 'cancelled', error: null });
    const controller = this.controllers.get(key);
    controller?.abort();
    if (task.itemId) {
      await api.cancelUpload(task.itemId).catch(() => {
        // The server may already be processing the completed upload.
      });
    }
    window.setTimeout(() => this.remove(key), 2_500);
    window.dispatchEvent(new CustomEvent('nimbus:library-changed'));
  }

  async retry(key: string): Promise<void> {
    const task = this.tasks.find((entry) => entry.key === key);
    if (!task || task.phase !== 'error') return;

    if (task.completed && task.itemId) {
      this.patch(key, { phase: 'processing', error: null, progress: 1 });
      try {
        await api.retryUpload(task.itemId);
        const controller = new AbortController();
        this.controllers.set(key, controller);
        this.running.add(key);
        await this.pollServer(key, task.itemId, controller.signal);
      } catch (error) {
        this.patch(key, { phase: 'error', error: errorMessage(error) });
      } finally {
        this.running.delete(key);
        this.controllers.delete(key);
        this.pump();
      }
      return;
    }

    if (task.itemId) {
      await api.cancelUpload(task.itemId).catch(() => {});
    }
    this.patch(key, {
      phase: 'preparing',
      error: null,
      progress: 0,
      itemId: null,
      completed: false,
    });
    this.pump();
  }

  private emit(): void {
    this.snapshot = this.tasks.slice();
    for (const listener of this.listeners) listener();
  }

  private patch(key: string, patch: Partial<UploadTask>): void {
    let changed = false;
    this.tasks = this.tasks.map((task) => {
      if (task.key !== key) return task;
      changed = true;
      return { ...task, ...patch };
    });
    if (changed) this.emit();
  }

  private remove(key: string): void {
    const timer = this.removalTimers.get(key);
    if (timer) {
      window.clearTimeout(timer);
      this.removalTimers.delete(key);
    }
    this.tasks = this.tasks.filter((task) => task.key !== key);
    this.live.delete(key);
    this.progressAt.delete(key);
    this.emit();
  }

  private pump(): void {
    while (this.running.size < this.maxConcurrent) {
      const next = this.tasks.find(
        (task) => task.phase === 'preparing' && !this.running.has(task.key),
      );
      if (!next) return;
      this.running.add(next.key);
      void this.run(next.key).finally(() => {
        this.running.delete(next.key);
        this.controllers.delete(next.key);
        this.pump();
      });
    }
  }

  private async run(key: string): Promise<void> {
    const task = this.tasks.find((entry) => entry.key === key);
    if (!task) return;

    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.patch(key, { phase: 'preparing', error: null, progress: 0 });

    try {
      let videoInfo: VideoInfo | null = null;
      if (task.kind === 'video') {
        videoInfo = await inspectVideo(task.file);
        this.live.set(key, videoInfo);
      }
      if (controller.signal.aborted) return;

      const init: UploadInitResponse = await api.initUpload({
        name: task.name,
        size: task.size,
        mime: task.mime,
        takenAt: task.file.lastModified || Date.now(),
        folderId: task.folderId,
      });
      if (controller.signal.aborted) {
        await api.cancelUpload(init.id).catch(() => {});
        return;
      }
      this.patch(key, { itemId: init.id, phase: 'uploading', progress: 0.01 });

      await uploadFileBody(
        init.uploadUrl,
        task.file,
        (loaded, total) => {
          const ratio = total > 0 ? loaded / total : 0;
          const now = Date.now();
          const last = this.progressAt.get(key) ?? 0;
          if (now - last < 120 && loaded < total) return;
          this.progressAt.set(key, now);
          this.patch(key, { progress: Math.min(0.97, 0.01 + ratio * 0.94) });
        },
        controller.signal,
      );

      if (videoInfo?.poster) {
        this.patch(key, { phase: 'poster', progress: 0.98 });
        await uploadPoster(init.posterUrl, videoInfo.poster, controller.signal);
      }

      this.patch(key, { phase: 'finishing', progress: 0.99 });
      const result = await api.completeUpload(init.id, {
        width: videoInfo?.width ?? null,
        height: videoInfo?.height ?? null,
        duration: videoInfo?.duration ?? null,
      });
      this.patch(key, {
        itemId: result.item.id,
        phase: 'processing',
        progress: 1,
        completed: true,
      });
      window.dispatchEvent(new CustomEvent('nimbus:library-changed'));

      await this.pollServer(key, init.id, controller.signal);
    } catch (error) {
      const current = this.tasks.find((entry) => entry.key === key);
      if (controller.signal.aborted || current?.phase === 'cancelled') {
        return;
      }
      this.patch(key, { phase: 'error', error: errorMessage(error) });
      window.dispatchEvent(new CustomEvent('nimbus:library-changed'));
    } finally {
      this.live.delete(key);
    }
  }

  private async pollServer(key: string, itemId: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 240; attempt++) {
      await wait(attempt === 0 ? 1_200 : attempt < 8 ? 1_800 : 3_500, signal);
      let item: ItemDTO;
      try {
        item = (await api.getItem(itemId)).item;
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (item.status === 'ready') {
        this.patch(key, { phase: 'done', progress: 1, error: null, completed: true });
        window.dispatchEvent(
          new CustomEvent('nimbus:item-ready', { detail: { item } }),
        );
        window.dispatchEvent(new CustomEvent('nimbus:library-changed'));
        const timer = window.setTimeout(() => this.remove(key), 7_000);
        this.removalTimers.set(key, timer);
        return;
      }
      if (item.status === 'error') {
        this.patch(key, {
          phase: 'error',
          error: item.error || 'The cloud provider rejected this file.',
          completed: true,
        });
        return;
      }
      this.patch(key, { phase: 'processing', progress: 1 });
    }
    throw new Error('The upload is taking longer than expected. Check the library again in a moment.');
  }
}

export const uploadManager = new UploadManager();

/** Recursively expands dropped folders into a flat list of files. */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => Boolean(entry));

  if (entries.length === 0) return Array.from(dataTransfer.files);

  const files: File[] = [];

  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(
          (value) => resolve(value),
          () => resolve(null),
        );
      });
      if (file) files.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = (): Promise<FileSystemEntry[]> =>
        new Promise((resolve) => {
          reader.readEntries(
            (batch) => resolve(batch),
            () => resolve([]),
          );
        });
      let batch = await readBatch();
      while (batch.length > 0) {
        for (const child of batch) await walk(child);
        batch = await readBatch();
      }
    }
  }

  for (const entry of entries) await walk(entry);
  return files.length > 0 ? files : Array.from(dataTransfer.files);
}
