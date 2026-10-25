import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Film,
  Image as ImageIcon,
  X,
} from 'lucide-react';
import { uploadManager, type UploadTask } from '../uploadManager';
import { formatBytes } from '../format';
import { Spinner } from './ui';

function TaskIcon({ kind }: { kind: UploadTask['kind'] }) {
  if (kind === 'photo') return <ImageIcon size={17} />;
  if (kind === 'video') return <Film size={17} />;
  return <FileText size={17} />;
}

function phaseLabel(task: UploadTask): string {
  switch (task.phase) {
    case 'preparing':
      return 'Preparing…';
    case 'uploading':
      return `${Math.round(task.progress * 100)}% · ${formatBytes(task.size)}`;
    case 'poster':
      return 'Creating video preview…';
    case 'finishing':
      return 'Finishing upload…';
    case 'processing':
      return 'Saving to your cloud…';
    case 'done':
      return 'Saved to your library';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return task.error || 'Upload failed';
    default:
      return '';
  }
}

function isActive(task: UploadTask): boolean {
  return ['preparing', 'uploading', 'poster', 'finishing', 'processing'].includes(task.phase);
}

export function UploadTray({ onNotify }: { onNotify: (message: string, kind?: 'success' | 'error' | 'info') => void }) {
  const tasks = useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const previousCount = useRef(0);

  useEffect(() => {
    if (tasks.length > previousCount.current && tasks.some((task) => task.phase === 'preparing')) {
      setCollapsed(false);
    }
    previousCount.current = tasks.length;
  }, [tasks]);

  if (tasks.length === 0) return null;

  const active = tasks.filter(isActive).length;
  const failed = tasks.filter((task) => task.phase === 'error').length;
  const done = tasks.filter((task) => task.phase === 'done').length;
  const finished = tasks.filter((task) => task.phase === 'done' || task.phase === 'cancelled').length;

  const summary = active > 0
    ? `${active} ${active === 1 ? 'upload' : 'uploads'} in progress${failed > 0 ? ` · ${failed} failed` : ''}`
    : failed > 0
      ? `${failed} ${failed === 1 ? 'upload needs' : 'uploads need'} attention`
      : done > 0
        ? `${done} ${done === 1 ? 'upload' : 'uploads'} saved`
        : 'Uploads';

  const retry = async (task: UploadTask) => {
    try {
      await uploadManager.retry(task.key);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not retry this upload.', 'error');
    }
  };

  const cancel = async (task: UploadTask) => {
    try {
      await uploadManager.cancel(task.key);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not cancel this upload.', 'error');
    }
  };

  return (
    <aside className={`upload-tray${collapsed ? ' is-collapsed' : ''}`} aria-label="Uploads">
      <header className="upload-tray-head">
        <div className="upload-tray-title">
          <span className={`upload-pulse${active > 0 ? ' is-active' : ''}`} aria-hidden="true">
            {active > 0 ? <Spinner size={14} /> : failed > 0 ? <AlertCircle size={15} /> : <Check size={15} />}
          </span>
          <div>
            <strong>Uploads</strong>
            <span>{summary}</span>
          </div>
        </div>
        <div className="upload-tray-actions">
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand uploads' : 'Minimize uploads'}
            title={collapsed ? 'Expand' : 'Minimize'}
          >
            {collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        </div>
      </header>

      {!collapsed ? (
        <>
          <div className="upload-list">
            {tasks.map((task) => {
              const percent = task.phase === 'done'
                ? 100
                : task.phase === 'processing'
                  ? 100
                  : Math.round(Math.max(task.progress, 0.01) * 100);
              return (
                <div key={task.key} className={`upload-row phase-${task.phase}`}>
                  <span className={`upload-row-icon kind-${task.kind}`}>
                    <TaskIcon kind={task.kind} />
                  </span>
                  <div className="upload-row-main">
                    <div className="upload-row-name" title={task.name}>
                      {task.name}
                    </div>
                    <div className="upload-row-status" title={phaseLabel(task)}>
                      {task.phase === 'uploading' || task.phase === 'processing' || task.phase === 'preparing' || task.phase === 'poster' || task.phase === 'finishing' ? (
                        <Spinner size={12} />
                      ) : task.phase === 'done' ? (
                        <Check size={12} />
                      ) : task.phase === 'error' ? (
                        <AlertCircle size={12} />
                      ) : null}
                      <span>{phaseLabel(task)}</span>
                    </div>
                    <div className="upload-progress" aria-hidden="true">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                  <div className="upload-row-actions">
                    {task.phase === 'error' ? (
                      <>
                        <button type="button" className="upload-action" onClick={() => void retry(task)}>
                          Retry
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          onClick={() => uploadManager.dismiss(task.key)}
                          aria-label="Dismiss failed upload"
                          title="Dismiss"
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : task.phase === 'done' || task.phase === 'cancelled' ? (
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        onClick={() => uploadManager.dismiss(task.key)}
                        aria-label="Remove from list"
                        title="Remove"
                      >
                        <X size={14} />
                      </button>
                    ) : task.phase === 'processing' ? (
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        onClick={() => uploadManager.dismiss(task.key)}
                        aria-label="Hide upload"
                        title="Hide"
                      >
                        <X size={14} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        onClick={() => void cancel(task)}
                        aria-label={`Cancel ${task.name}`}
                        title="Cancel"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {finished > 0 || failed > 0 ? (
            <footer className="upload-tray-foot">
              <button type="button" className="link-button" onClick={() => uploadManager.dismissFinished()}>
                Clear finished
              </button>
              {failed > 0 ? <span>{failed} needs attention</span> : <span>Safe to close this tab</span>}
            </footer>
          ) : (
            <footer className="upload-tray-foot">
              <span>Uploads continue on the server after they start.</span>
            </footer>
          )}
        </>
      ) : null}
    </aside>
  );
}
